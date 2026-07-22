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
