/**
 * discovery-install-hardening.test.js — U0 hardening:
 *
 *   1. `kdna available` is discovery, not loading: it enumerates installed
 *      candidates and emits LoadPlan-level metadata only. It must not call
 *      loadAuthorized or project any judgment payload content.
 *   2. `kdna install` never moves an existing active_version; the active
 *      version is only set when a package has none yet.
 *   3. Curl download paths (install + safe-archive) accept https: URLs only;
 *      file:/ftp:/javascript: and malformed URLs are refused before any
 *      network or filesystem fetch.
 *
 * Run: node --test tests/discovery-install-hardening.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { buildChecksums, pack } = require('@aikdna/kdna-core');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const CURRENT_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'minimal');
const { assertHttpsDownloadUrl } = require('../src/cmds/_common');
const { downloadAndExtractKdna } = require('../src/safe-archive');

function run(args, opts = {}) {
  try {
    return {
      ok: true,
      code: 0,
      stdout: execFileSync('node', [CLI, ...args], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, ...(opts.env || {}) },
        cwd: opts.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
    };
  } catch (e) {
    return {
      ok: false,
      code: e.status,
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || '').toString(),
    };
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function buildAsset(tmpRoot, name, version = '0.1.0') {
  const source = path.join(tmpRoot, 'src-' + name.replace(/[@/]/g, '_') + '-' + version);
  fs.cpSync(CURRENT_FIXTURE, source, { recursive: true });
  const manifestPath = path.join(source, 'kdna.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const [scope, ident] = name.split('/');
  Object.assign(manifest, {
    name,
    asset_id: `kdna:${scope.slice(1)}:${ident}`,
    title: `${name} test asset`,
    version,
    judgment_version: version,
  });
  writeJson(manifestPath, manifest);
  writeJson(path.join(source, 'checksums.json'), buildChecksums(source));

  const asset = path.join(tmpRoot, name.replace(/[@/]/g, '_') + '-' + version + '.kdna');
  pack(source, asset);
  return asset;
}

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-u0-hardening-'));
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  return {
    root,
    proj,
    env: {
      ...process.env,
      HOME: home,
      KDNA_HOME: path.join(home, '.kdna'),
    },
  };
}

// ─── 1. kdna available: discovery never loads ───────────────────────────────

test('cmdAvailable never calls loadAuthorized and emits no payload projection', () => {
  const { root, env } = makeEnv();
  const home = env.KDNA_HOME;
  const asset = buildAsset(root, '@aikdna/discovery-probe', '1.0.0');

  const previousHome = process.env.KDNA_HOME;
  process.env.KDNA_HOME = home;

  const corePath = require.resolve('@aikdna/kdna-core');
  const realCore = require(corePath);
  let loadAuthorizedCalls = 0;
  const wrapped = {
    ...realCore,
    loadAuthorized(...args) {
      loadAuthorizedCalls += 1;
      return realCore.loadAuthorized(...args);
    },
    load(...args) {
      loadAuthorizedCalls += 1;
      return realCore.loadAuthorized(...args);
    },
    loadAsset(...args) {
      loadAuthorizedCalls += 1;
      return realCore.loadAuthorized(...args);
    },
  };

  const moduleIds = [
    '../src/paths',
    '../src/package-store',
    '../src/external-entitlement',
    '../src/agent',
    '../src/cmds/trace',
  ];
  const cached = new Map();
  for (const id of moduleIds) {
    const resolved = require.resolve(id);
    cached.set(resolved, require.cache[resolved]);
    delete require.cache[resolved];
  }
  const originalCoreExports = require.cache[corePath].exports;
  require.cache[corePath].exports = wrapped;

  let stdout = '';
  const originalWrite = process.stdout.write;
  try {
    const packageStore = require('../src/package-store');
    packageStore.installAsset({
      sourcePath: asset,
      name: '@aikdna/discovery-probe',
      version: '1.0.0',
    });

    process.stdout.write = (chunk) => {
      stdout += String(chunk);
      return true;
    };
    require('../src/agent').cmdAvailable(['--json']);
  } finally {
    process.stdout.write = originalWrite;
    require.cache[corePath].exports = originalCoreExports;
    for (const id of moduleIds) {
      const resolved = require.resolve(id);
      delete require.cache[resolved];
      if (cached.get(resolved)) require.cache[resolved] = cached.get(resolved);
    }
    if (previousHome === undefined) delete process.env.KDNA_HOME;
    else process.env.KDNA_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.equal(loadAuthorizedCalls, 0, 'discovery must not call loadAuthorized');
  const domains = JSON.parse(stdout);
  assert.equal(domains.length, 1);
  assert.equal(domains[0].name, '@aikdna/discovery-probe');
  assert.equal(domains[0].loaded, false, 'output must record that no load was performed');
  assert.equal(domains[0].loadable, true);
  assert.equal(domains[0].load_state, 'ready');
  assert.equal('applies_when' in domains[0], false);
  assert.equal('does_not_apply_when' in domains[0], false);
  assert.equal('failure_risks' in domains[0], false);
});

test('kdna available human output states that no content was loaded', () => {
  const { root, proj, env } = makeEnv();
  const asset = buildAsset(root, '@aikdna/discovery-human', '1.0.0');
  const installed = run(['install', asset, '--yes', '--allow-unverified'], { env, cwd: proj });
  assert.ok(installed.ok, `install failed: ${installed.stderr}\n${installed.stdout}`);

  const available = run(['available'], { env, cwd: proj });
  assert.ok(available.ok, `available failed: ${available.stderr}`);
  assert.match(available.stdout, /@aikdna\/discovery-human/);
  assert.match(available.stdout, /Discovery only — no content was loaded\./);
  assert.match(available.stdout, /kdna load <name>/);

  fs.rmSync(root, { recursive: true, force: true });
});

// ─── 2. install preserves an existing active_version ────────────────────────

test('install sets the active version only when none exists yet', () => {
  const { root, proj, env } = makeEnv();
  const first = buildAsset(root, '@aikdna/activation', '1.0.0');
  const second = buildAsset(root, '@aikdna/activation', '1.1.0');
  const indexPath = path.join(env.KDNA_HOME, 'index.json');

  const installFirst = run(['install', first, '--yes', '--allow-unverified'], { env, cwd: proj });
  assert.ok(installFirst.ok, `first install failed: ${installFirst.stderr}`);
  let index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(index.packages['@aikdna/activation'].active_version, '1.0.0');

  const installSecond = run(['install', second, '--yes', '--allow-unverified'], {
    env,
    cwd: proj,
  });
  assert.ok(installSecond.ok, `second install failed: ${installSecond.stderr}`);
  assert.match(
    installSecond.stdout,
    /Active version unchanged: @aikdna\/activation stays on 1\.0\.0\./,
  );

  index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(
    index.packages['@aikdna/activation'].active_version,
    '1.0.0',
    'installing a newer version must not move the active version',
  );
  assert.deepEqual(Object.keys(index.packages['@aikdna/activation'].versions).sort(), [
    '1.0.0',
    '1.1.0',
  ]);

  // Reinstalling an already-present version also keeps the active version.
  const reinstallFirst = run(['install', first, '--yes', '--allow-unverified'], {
    env,
    cwd: proj,
  });
  assert.ok(reinstallFirst.ok, `reinstall failed: ${reinstallFirst.stderr}`);
  index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(index.packages['@aikdna/activation'].active_version, '1.0.0');

  fs.rmSync(root, { recursive: true, force: true });
});

// ─── 3. curl download paths accept https: only ──────────────────────────────

test('assertHttpsDownloadUrl rejects non-https and malformed URLs', () => {
  const rejected = [
    'file:///etc/passwd',
    'file://localhost/etc/passwd',
    'ftp://example.invalid/asset.kdna',
    'javascript:alert(1)',
    'http://example.invalid/asset.kdna',
    '//example.invalid/asset.kdna',
    'not-a-url',
    '',
  ];
  for (const url of rejected) {
    assert.throws(() => assertHttpsDownloadUrl(url), /refusing to download/, url);
  }
  assert.equal(assertHttpsDownloadUrl('https://example.invalid/asset.kdna').protocol, 'https:');
});

test('downloadAndExtractKdna refuses a file: URL before any download runs', () => {
  let downloadCalled = false;
  assert.throws(
    () =>
      downloadAndExtractKdna('file:///etc/passwd', path.join(os.tmpdir(), 'kdna-never-created'), {
        downloadFile() {
          downloadCalled = true;
        },
      }),
    /refusing to download: only https: URLs are allowed/,
  );
  assert.equal(downloadCalled, false, 'the downloader must not run for a refused URL');
});

test('kdna install refuses a registry entry whose asset_url is file:', () => {
  const { root, proj, env } = makeEnv();
  const registryDir = path.join(env.KDNA_HOME, 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  writeJson(path.join(registryDir, 'domains.json'), {
    schema_version: '3.0',
    registry_version: '3.0.0-test',
    updated: '2026-07-22T00:00:00Z',
    trust: {
      model: 'kdna.registry.snapshot',
      snapshot: {
        registry_version: '3.0.0-test',
        generated_at: '2026-07-22T00:00:00Z',
        expires_at: '2099-01-01T00:00:00Z',
      },
      timestamp: {
        generated_at: '2026-07-22T00:00:00Z',
        expires_at: '2099-01-01T00:00:00Z',
      },
      revocations: [],
    },
    scopes: {
      '@aikdna': {
        type: 'official',
        trust_pubkey: 'ed25519:test',
        registry_url: null,
        verified: true,
      },
    },
    domains: [
      {
        name: '@aikdna/poisoned',
        type: 'domain',
        version: '0.1.0',
        status: 'experimental',
        access: 'public',
        description: 'Registry entry with a poisoned download URL.',
        asset_url: 'file:///etc/passwd',
        asset_digest: `sha256:${'1'.repeat(64)}`,
        signature: 'ed25519:test',
        release_status: 'published_signed',
        author: { name: 'Test', id: 'test', pubkey: 'ed25519:test' },
        yanked: false,
      },
    ],
  });

  const install = run(['install', '@aikdna/poisoned', '--yes'], { env, cwd: proj });
  assert.equal(install.ok, false, 'install must refuse a file: asset_url');
  assert.match(install.stderr, /only https: URLs are allowed/);

  fs.rmSync(root, { recursive: true, force: true });
});

// ─── 4. curl transport: redirect downgrades and credentialed URLs ───────────
//
// These tests do NOT stop at URL parsing: a recording curl shim on PATH
// proves that every CLI-owned fetch (install download, safe-archive
// download, canonical + custom-scope registry fetches, registry signature
// fetch) really executes curl with `--proto =https --proto-redir =https`,
// and simulates redirect scenarios the way libcurl behaves under those
// flags.

const FIXTURE_ORIGIN = 'https://fixture.invalid';
const REDIRECT_HTTPS_ORIGIN = 'https://redirect-https.invalid';
const DOWNGRADE_HTTP_ORIGIN = 'https://downgrade-http.invalid';
const DOWNGRADE_FTP_ORIGIN = 'https://downgrade-ftp.invalid';

// A PATH shim for `curl` that (a) appends its argv, one argument per line,
// to KDNA_CURL_SHIM_ARGV_LOG, (b) refuses to run at all unless the HTTPS
// protocol-pinning flags are present, and (c) emulates libcurl under
// `--proto-redir =https`: an HTTPS->HTTP or HTTPS->FTP redirect fails
// client-side, while HTTPS->HTTPS redirects and direct fetches are served
// from KDNA_ARCHIVE_FIXTURE_DIR by URL basename.
function transportCurlShimDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-transport-curl-shim-'));
  const script = `#!/bin/sh
if [ -n "$KDNA_CURL_SHIM_ARGV_LOG" ]; then
  printf '%s\\n' "$@" >> "$KDNA_CURL_SHIM_ARGV_LOG"
fi
proto_ok=0
redir_ok=0
prev=""
out=""
url=""
for arg in "$@"; do
  if [ "$prev" = "--proto" ] && [ "$arg" = "=https" ]; then proto_ok=1; fi
  if [ "$prev" = "--proto-redir" ] && [ "$arg" = "=https" ]; then redir_ok=1; fi
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
  url="$arg"
done
if [ "$proto_ok" != "1" ] || [ "$redir_ok" != "1" ]; then
  echo "curl shim: missing HTTPS protocol pinning flags" >&2
  exit 99
fi
case "$url" in
  ${DOWNGRADE_HTTP_ORIGIN}/*)
    echo 'curl: (1) Protocol "http" not supported or disabled in libcurl' >&2
    exit 1
    ;;
  ${DOWNGRADE_FTP_ORIGIN}/*)
    echo 'curl: (1) Protocol "ftp" not supported or disabled in libcurl' >&2
    exit 1
    ;;
  ${FIXTURE_ORIGIN}/*|${REDIRECT_HTTPS_ORIGIN}/*)
    name="\${url##*/}"
    src="$KDNA_ARCHIVE_FIXTURE_DIR/$name"
    if [ -f "$src" ]; then
      if [ -n "$out" ]; then
        /bin/cp "$src" "$out"
        exit $?
      fi
      /bin/cat "$src"
      exit $?
    fi
    ;;
esac
echo "curl shim: cannot fetch $url" >&2
exit 22
`;
  fs.writeFileSync(path.join(dir, 'curl'), script, { mode: 0o755 });
  return dir;
}

// Run fn with the transport curl shim first on PATH (in-process), restoring
// the environment afterwards. Returns whatever fn returns. fn receives
// { fixtureDir, logFile }.
function withTransportShim(fn) {
  const shimDir = transportCurlShimDir();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-transport-fixtures-'));
  const logFile = path.join(fixtureDir, 'curl-argv.log');
  const saved = {
    PATH: process.env.PATH,
    KDNA_ARCHIVE_FIXTURE_DIR: process.env.KDNA_ARCHIVE_FIXTURE_DIR,
    KDNA_CURL_SHIM_ARGV_LOG: process.env.KDNA_CURL_SHIM_ARGV_LOG,
  };
  process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;
  process.env.KDNA_ARCHIVE_FIXTURE_DIR = fixtureDir;
  process.env.KDNA_CURL_SHIM_ARGV_LOG = logFile;
  try {
    return fn({ fixtureDir, logFile });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function assertCurlArgvPinned(logFile) {
  const log = fs.readFileSync(logFile, 'utf8');
  assert.ok(
    log.includes('--proto\n=https\n'),
    `curl argv must pin the initial protocol to https:\n${log}`,
  );
  assert.ok(
    log.includes('--proto-redir\n=https\n'),
    `curl argv must pin the redirect protocol to https:\n${log}`,
  );
  return log;
}

// Require a fresh copy of src/registry.js (it captures HOME and
// KDNA_REGISTRY_URL at module load) and restore both the environment and
// the require cache afterwards.
function freshRegistryModule({ home, registryUrl }) {
  const savedHome = process.env.HOME;
  const savedUrl = process.env.KDNA_REGISTRY_URL;
  process.env.HOME = home;
  if (registryUrl === undefined) delete process.env.KDNA_REGISTRY_URL;
  else process.env.KDNA_REGISTRY_URL = registryUrl;
  const id = require.resolve('../src/registry');
  const cached = require.cache[id];
  delete require.cache[id];
  const mod = require(id);
  return {
    mod,
    restore() {
      delete require.cache[id];
      if (cached) require.cache[id] = cached;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUrl === undefined) delete process.env.KDNA_REGISTRY_URL;
      else process.env.KDNA_REGISTRY_URL = savedUrl;
    },
  };
}

function registryDocument(domains) {
  return {
    schema_version: '3.0',
    registry_version: '3.0.0-transport-test',
    updated: '2026-07-22T00:00:00Z',
    trust: {
      model: 'kdna.registry.snapshot',
      root: {
        keys: [{ scheme: 'ed25519', keyid: 'test-root', pubkey: 'ed25519:test' }],
      },
      snapshot: {
        registry_version: '3.0.0-transport-test',
        generated_at: '2026-07-22T00:00:00Z',
        expires_at: '2099-01-01T00:00:00Z',
      },
      timestamp: {
        generated_at: '2026-07-22T00:00:00Z',
        expires_at: '2099-01-01T00:00:00Z',
      },
      revocations: [],
    },
    scopes: {
      '@aikdna': {
        type: 'official',
        trust_pubkey: 'ed25519:test',
        registry_url: null,
        verified: true,
      },
    },
    domains,
  };
}

function registryDomainEntry(name, version, assetUrl, assetDigest) {
  return {
    name,
    type: 'domain',
    version,
    status: 'experimental',
    access: 'public',
    description: 'Transport hardening test entry.',
    asset_url: assetUrl,
    asset_digest: assetDigest,
    signature: 'ed25519:test',
    release_status: 'published_signed',
    author: { name: 'Test', id: 'test', pubkey: 'ed25519:test' },
    yanked: false,
  };
}

test('assertHttpsDownloadUrl rejects credentialed URLs without echoing them', () => {
  const rejected = [
    'https://user@example.invalid/asset.kdna',
    'https://user:pass@example.invalid/asset.kdna',
    'https://:pass@example.invalid/asset.kdna',
  ];
  for (const url of rejected) {
    assert.throws(
      () => assertHttpsDownloadUrl(url),
      (err) => {
        assert.match(err.message, /embedded credentials/);
        assert.ok(!err.message.includes('user'), err.message);
        assert.ok(!err.message.includes('pass'), err.message);
        assert.ok(!err.message.includes('example.invalid'), err.message);
        return true;
      },
      url,
    );
  }
  assert.throws(
    () => assertHttpsDownloadUrl('https://user:pass@'),
    (err) => {
      assert.match(err.message, /not a valid URL/);
      assert.ok(!err.message.includes('pass'), err.message);
      return true;
    },
  );
});

test('archive download path: credentialed URL refused before curl runs', () => {
  withTransportShim(({ logFile }) => {
    let downloadCalled = false;
    assert.throws(
      () =>
        downloadAndExtractKdna(
          'https://user:pass@fixture.invalid/asset.kdna',
          path.join(os.tmpdir(), 'kdna-never-created-credentialed'),
          {
            downloadFile() {
              downloadCalled = true;
            },
          },
        ),
      /embedded credentials/,
    );
    assert.equal(downloadCalled, false);

    // The built-in curl downloader must also refuse before spawning curl.
    assert.throws(
      () =>
        downloadAndExtractKdna(
          'https://user:pass@fixture.invalid/asset.kdna',
          path.join(os.tmpdir(), 'kdna-never-created-credentialed-2'),
        ),
      /embedded credentials/,
    );
    assert.equal(fs.existsSync(logFile), false, 'curl must not run for a credentialed URL');
  });
});

test('archive download path: HTTPS->HTTPS redirect works, HTTP/FTP redirects blocked', () => {
  withTransportShim(({ fixtureDir, logFile }) => {
    const archive = buildAsset(fixtureDir, '@aikdna/transport-archive', '1.0.0');
    const archiveName = path.basename(archive);

    const destination = path.join(fixtureDir, 'extracted');
    downloadAndExtractKdna(`${REDIRECT_HTTPS_ORIGIN}/${archiveName}`, destination);
    assert.equal(fs.existsSync(path.join(destination, 'mimetype')), true);

    for (const [label, origin] of [
      ['HTTPS->HTTP redirect', DOWNGRADE_HTTP_ORIGIN],
      ['HTTPS->FTP redirect', DOWNGRADE_FTP_ORIGIN],
    ]) {
      const blocked = path.join(fixtureDir, `blocked-${origin.slice(8)}`);
      assert.throws(
        () => downloadAndExtractKdna(`${origin}/${archiveName}`, blocked),
        /Protocol ".*" not supported|Command failed/,
        label,
      );
      assert.equal(fs.existsSync(blocked), false, label);
    }

    const log = assertCurlArgvPinned(logFile);
    assert.ok(log.includes(`${REDIRECT_HTTPS_ORIGIN}/${archiveName}`));
    assert.ok(log.includes(`${DOWNGRADE_HTTP_ORIGIN}/${archiveName}`));
    assert.ok(log.includes(`${DOWNGRADE_FTP_ORIGIN}/${archiveName}`));
  });
});

test('kdna install download path: HTTPS->HTTPS redirect installs, downgrade redirect fails', () => {
  const { root, proj, env } = makeEnv();
  const shimDir = transportCurlShimDir();
  const logFile = path.join(root, 'curl-argv.log');
  const asset = buildAsset(root, '@aikdna/transport-install', '1.0.0');
  const assetName = path.basename(asset);
  const digest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(asset)).digest('hex')}`;
  const registryDir = path.join(env.KDNA_HOME, 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  const shimEnv = {
    ...env,
    PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
    KDNA_ARCHIVE_FIXTURE_DIR: root,
    KDNA_CURL_SHIM_ARGV_LOG: logFile,
    KDNA_REGISTRY_URL: '',
  };

  try {
    // HTTPS -> HTTPS redirect: the full install succeeds.
    writeJson(
      path.join(registryDir, 'domains.json'),
      registryDocument([
        registryDomainEntry(
          '@aikdna/transport-install',
          '1.0.0',
          `${REDIRECT_HTTPS_ORIGIN}/${assetName}`,
          digest,
        ),
      ]),
    );
    const installed = run(['install', '@aikdna/transport-install', '--yes'], {
      env: shimEnv,
      cwd: proj,
    });
    assert.ok(installed.ok, `install failed: ${installed.stderr}\n${installed.stdout}`);
    assert.match(installed.stdout, /Installed @aikdna\/transport-install@1\.0\.0/);

    // HTTPS -> HTTP redirect: curl is invoked with the pinning flags and the
    // downgrade is blocked client-side.
    writeJson(
      path.join(registryDir, 'domains.json'),
      registryDocument([
        registryDomainEntry(
          '@aikdna/transport-install',
          '1.0.0',
          `${DOWNGRADE_HTTP_ORIGIN}/${assetName}`,
          digest,
        ),
      ]),
    );
    const downgraded = run(['install', '@aikdna/transport-install', '--yes'], {
      env: shimEnv,
      cwd: proj,
    });
    assert.equal(downgraded.ok, false, 'install must fail when the redirect downgrades');
    assert.match(downgraded.stderr, /Failed to download/);
    assert.match(downgraded.stderr, /Protocol "http" not supported/);

    // Credentialed URL: refused before curl runs, and the error must not
    // echo the credentials.
    writeJson(
      path.join(registryDir, 'domains.json'),
      registryDocument([
        registryDomainEntry(
          '@aikdna/transport-install',
          '1.0.0',
          `https://user:pass@fixture.invalid/${assetName}`,
          digest,
        ),
      ]),
    );
    const credentialed = run(['install', '@aikdna/transport-install', '--yes'], {
      env: shimEnv,
      cwd: proj,
    });
    assert.equal(credentialed.ok, false, 'install must refuse a credentialed asset_url');
    assert.match(credentialed.stderr, /embedded credentials/);
    assert.ok(!credentialed.stderr.includes('user:pass'), credentialed.stderr);

    const log = assertCurlArgvPinned(logFile);
    assert.ok(log.includes(`${REDIRECT_HTTPS_ORIGIN}/${assetName}`));
    assert.ok(log.includes(`${DOWNGRADE_HTTP_ORIGIN}/${assetName}`));
    assert.ok(!log.includes('user:pass'), 'curl must never be invoked with a credentialed URL');
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('registry fetch path: canonical registry, signature fetch, and redirect downgrades', () => {
  withTransportShim(({ fixtureDir, logFile }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-transport-home-'));
    try {
      writeJson(
        path.join(fixtureDir, 'registry.json'),
        registryDocument([
          registryDomainEntry(
            '@aikdna/transport-registry',
            '1.0.0',
            `${FIXTURE_ORIGIN}/transport-registry.kdna`,
            `sha256:${'2'.repeat(64)}`,
          ),
        ]),
      );

      // Happy path: registry.json is fetched, the .sig sidecar fetch is
      // attempted through the same pinned curl path, and domains load.
      const happy = freshRegistryModule({
        home,
        registryUrl: `${FIXTURE_ORIGIN}/registry.json`,
      });
      try {
        const domains = happy.mod.loadRegistry({ allowNetwork: true, refresh: true });
        assert.equal(domains.length, 1);
        assert.equal(domains[0].name, '@aikdna/transport-registry');
      } finally {
        happy.restore();
      }
      let log = assertCurlArgvPinned(logFile);
      assert.ok(log.includes(`${FIXTURE_ORIGIN}/registry.json`));
      assert.ok(
        log.includes(`${FIXTURE_ORIGIN}/registry.sig`),
        'the signature sidecar fetch must also go through the pinned curl path',
      );

      // HTTPS -> HTTP redirect on the registry endpoint: blocked. A fresh
      // home guarantees no cache fallback can mask the failed fetch.
      fs.rmSync(logFile);
      const downgradeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-transport-home-'));
      const downgraded = freshRegistryModule({
        home: downgradeHome,
        registryUrl: `${DOWNGRADE_HTTP_ORIGIN}/registry.json`,
      });
      try {
        assert.throws(() => downgraded.mod.fetchRegistry(), /Protocol "http" not supported/);
        assert.deepEqual(downgraded.mod.loadRegistry({ allowNetwork: true, refresh: true }), []);
      } finally {
        downgraded.restore();
      }
      log = assertCurlArgvPinned(logFile);
      assert.ok(log.includes(`${DOWNGRADE_HTTP_ORIGIN}/registry.json`));

      // Non-https and credentialed registry endpoints: refused before curl.
      fs.rmSync(downgradeHome, { recursive: true, force: true });
      fs.rmSync(logFile);
      for (const registryUrl of [
        'http://fixture.invalid/registry.json',
        'ftp://fixture.invalid/registry.json',
        'https://user:pass@fixture.invalid/registry.json',
      ]) {
        const refused = freshRegistryModule({ home, registryUrl });
        try {
          assert.throws(() => refused.mod.fetchRegistry(), /refusing to download/, registryUrl);
        } finally {
          refused.restore();
        }
      }
      assert.equal(
        fs.existsSync(logFile),
        false,
        'curl must not run for refused registry endpoints',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

test('registry fetch path: custom scope registries are pinned and downgrades blocked', () => {
  withTransportShim(({ logFile }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-transport-scope-home-'));
    try {
      fs.mkdirSync(path.join(home, '.kdna'), { recursive: true });
      writeJson(path.join(home, '.kdna', 'config.json'), {
        default_scope: '@aikdna',
        registries: {
          '@custom': { url: `${DOWNGRADE_HTTP_ORIGIN}/custom.json` },
          '@plainhttp': 'http://fixture.invalid/plain.json',
        },
      });
      const { mod, restore } = freshRegistryModule({ home, registryUrl: '' });
      try {
        const resolver = new mod.RegistryResolver({ allowNetwork: true, refresh: true });
        assert.throws(
          () => resolver.resolve('@custom/thing'),
          /Cannot load registry for scope @custom/,
        );
        assert.throws(
          () => resolver.resolve('@plainhttp/thing'),
          /Cannot load registry for scope @plainhttp/,
        );
      } finally {
        restore();
      }
      const log = assertCurlArgvPinned(logFile);
      assert.ok(log.includes(`${DOWNGRADE_HTTP_ORIGIN}/custom.json`));
      assert.ok(
        !log.includes('http://fixture.invalid/plain.json'),
        'curl must not run for a plain-http custom scope registry',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
