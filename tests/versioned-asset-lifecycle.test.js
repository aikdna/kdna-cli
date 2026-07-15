const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildChecksums, pack } = require('@aikdna/kdna-core');
const { compareExactVersions, parseName, selectRegistryEntry } = require('../src/registry');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'minimal');
const NAME = '@example/versioned-review';
const CORE_ENTRY = process.env.KDNA_CORE_SOURCE_ROOT
  ? path.join(path.resolve(process.env.KDNA_CORE_SOURCE_ROOT), 'src', 'index.js')
  : require.resolve('@aikdna/kdna-core');

function run(args, { env, cwd } = {}) {
  try {
    return {
      ok: true,
      code: 0,
      stdout: execFileSync('node', [CLI, ...args], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, ...(env || {}) },
        cwd: cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      stderr: '',
    };
  } catch (error) {
    return {
      ok: false,
      code: error.status,
      stdout: (error.stdout || '').toString(),
      stderr: (error.stderr || '').toString(),
    };
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-versioned-lifecycle-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const kdnaHome = path.join(home, '.kdna');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return {
    root,
    kdnaHome,
    project,
    env: { HOME: home, KDNA_HOME: kdnaHome, KDNA_PROJECT_ROOT: project },
  };
}

function buildAsset(root, version, name = NAME) {
  const source = path.join(root, `source-${version}`);
  fs.cpSync(FIXTURE, source, { recursive: true });
  const manifestPath = path.join(source, 'kdna.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const [scope, ident] = name.split('/');
  manifest.name = name;
  manifest.asset_id = `kdna:${scope.slice(1)}:${ident}`;
  manifest.version = version;
  manifest.judgment_version = version;
  writeJson(manifestPath, manifest);
  writeJson(path.join(source, 'checksums.json'), buildChecksums(source));
  const asset = path.join(root, `versioned-review-${version}.kdna`);
  pack(source, asset);
  return { source, asset };
}

function runAsync(args, { env, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...(env || {}) },
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function currentAgentHost(root) {
  const host = path.join(root, 'current-agent-host.js');
  fs.writeFileSync(
    host,
    `'use strict';
const core = require(${JSON.stringify(CORE_ENTRY)});
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const request = core.parseRuntimeContractJson(Buffer.concat(chunks));
  const digest = core.computeCapsuleDeliveryDigest(request.capsule);
  process.stdout.write(JSON.stringify({
    protocol: request.protocol,
    protocol_version: request.protocol_version,
    request_id: request.request_id,
    runtime_receipt: {
      type: 'kdna.agent-host.runtime-receipt',
      contract_version: '0.1.0',
      capsule_version: '0.1.0',
      capsule_digest_profile: 'kdna.canonicalization.runtime-capsule-jcs',
      capsule_digest_profile_version: '0.1.0',
      sender_capsule_delivery_digest: request.runtime_contract.capsule_delivery_digest,
      host_recomputed_capsule_delivery_digest: digest,
      echoed_capsule_delivery_digest: digest,
      capsule_delivery_comparison: 'matched',
      capsule_schema_validation: 'passed',
      asset_id_correlation: 'matched',
      provider_execution_status: 'completed',
      semantic_consumption: { state: 'not_observed', basis: null },
      model_identity: { value: null, basis: 'not_observed' },
      usage: {
        elapsed_ms: 1,
        elapsed_basis: 'host_monotonic',
        tokens_used: null,
        model_calls: null,
        basis: 'not_observed'
      }
    },
    outcome: {
      judgment: { answer: 'Pinned asset consumed.', reasoning: [], confidence: null },
      usage: null
    }
  }));
});
`,
  );
  const descriptor = path.join(root, 'current-agent-host-capabilities.json');
  writeJson(descriptor, {
    type: 'kdna.cli.agent-host-registration',
    protocol_version: '0.1.0',
    process: { command: process.execPath, args: [host] },
    capabilities: {
      type: 'kdna.agent-host-capabilities',
      protocol_version: '0.1.0',
      capability_basis: 'registered_descriptor',
      host_protocols: ['kdna.agent-host'],
      capsule_versions: ['0.1.0'],
      capsule_digest_profiles: ['kdna.canonicalization.runtime-capsule-jcs'],
      capsule_digest_profile_versions: ['0.1.0'],
    },
  });
  return { host, descriptor };
}

function withFreshPackageStore(env, callback) {
  const previous = {
    HOME: process.env.HOME,
    KDNA_HOME: process.env.KDNA_HOME,
    KDNA_PROJECT_ROOT: process.env.KDNA_PROJECT_ROOT,
  };
  Object.assign(process.env, env);
  const storeModule = require.resolve('../src/package-store');
  const pathsModule = require.resolve('../src/paths');
  delete require.cache[storeModule];
  delete require.cache[pathsModule];
  try {
    return callback(require('../src/package-store'));
  } finally {
    delete require.cache[storeModule];
    delete require.cache[pathsModule];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withFreshInstallModule(env, callback) {
  const previous = {
    HOME: process.env.HOME,
    KDNA_HOME: process.env.KDNA_HOME,
    KDNA_PROJECT_ROOT: process.env.KDNA_PROJECT_ROOT,
  };
  Object.assign(process.env, env);
  const modules = ['../src/install', '../src/package-store', '../src/paths'].map((name) =>
    require.resolve(name),
  );
  for (const modulePath of modules) delete require.cache[modulePath];
  try {
    return callback(require('../src/install'));
  } finally {
    for (const modulePath of modules) delete require.cache[modulePath];
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('parseName accepts exact version pins and rejects ranges or incomplete versions', () => {
  assert.deepEqual(parseName(`${NAME}@1.2.3`), {
    scope: '@example',
    ident: 'versioned-review',
    full: NAME,
    version: '1.2.3',
    reference: `${NAME}@1.2.3`,
    wasShort: false,
  });
  assert.equal(parseName(`${NAME}@^1.2.3`), null);
  assert.equal(parseName(`${NAME}@1.2`), null);
  assert.equal(parseName(`${NAME}@1.2.3-01`), null);
});

test('registry version selection follows full SemVer precedence and skips yanked releases', () => {
  assert.ok(compareExactVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0);
  assert.ok(compareExactVersions('1.0.0-beta.10', '1.0.0') < 0);
  assert.equal(compareExactVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.ok(
    compareExactVersions('999999999999999999999999.0.0', '999999999999999999999998.9.9') > 0,
  );

  const selected = selectRegistryEntry([
    { name: NAME, version: '1.0.0-beta.10' },
    { name: NAME, version: '1.0.0' },
    { name: NAME, version: '2.0.0', yanked: true },
    { name: NAME, version: '1.0.1' },
    { name: NAME, version: '1.0.0-beta.2' },
  ]);
  assert.equal(selected.version, '1.0.1');
  assert.equal(
    selectRegistryEntry([
      { name: NAME, version: '1.0.0', yanked: true },
      { name: NAME, version: '2.0.0', yanked: true },
    ]),
    null,
  );
  assert.equal(
    selectRegistryEntry([
      { name: NAME, version: 'latest' },
      { name: NAME, version: 'not-semver' },
    ]),
    null,
  );
  assert.equal(
    selectRegistryEntry([{ name: NAME, version: '2.0.0', yanked: true }], '2.0.0').version,
    '2.0.0',
  );
});

test('version-aware install, migration, inspect, plan, use, remove and rollback', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const initialAsset = buildAsset(root, '1.0.0');
  const updatedAsset = buildAsset(root, '1.1.0');

  const installInitial = run(['install', initialAsset.asset, '--yes', '--json'], {
    env,
    cwd: project,
  });
  assert.ok(installInitial.ok, installInitial.stderr);

  const installUpdated = run(['install', updatedAsset.asset, '--yes', '--json'], {
    env,
    cwd: project,
  });
  assert.ok(installUpdated.ok, installUpdated.stderr);

  // Replace the current index with a predecessor record that omits the older
  // installed version while leaving its immutable directory and receipt on disk.
  // A read must recover the orphan, and the next write must persist both versions.
  const indexPath = path.join(kdnaHome, 'index.json');
  const current = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const predecessorRecord = current.packages[NAME].versions['1.1.0'];
  writeJson(indexPath, { version: 2, packages: { [NAME]: predecessorRecord } });

  const inspectLegacyPin = run(['inspect', `${NAME}@1.0.0`, '--json'], { env, cwd: project });
  assert.ok(inspectLegacyPin.ok, inspectLegacyPin.stderr);
  assert.equal(JSON.parse(inspectLegacyPin.stdout).version, '1.0.0');

  const reactivateUpdated = run(['install', updatedAsset.asset, '--yes', '--json'], {
    env,
    cwd: project,
  });
  assert.ok(reactivateUpdated.ok, reactivateUpdated.stderr);
  const migrated = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(migrated.version, 3);
  assert.equal(migrated.packages[NAME].active_version, '1.1.0');
  assert.deepEqual(Object.keys(migrated.packages[NAME].versions).sort(), ['1.0.0', '1.1.0']);

  const listed = run(['list', '--json'], { env, cwd: project });
  assert.ok(listed.ok, listed.stderr);
  assert.deepEqual(
    JSON.parse(listed.stdout).map(({ version, active }) => ({ version, active })),
    [
      { version: '1.0.0', active: false },
      { version: '1.1.0', active: true },
    ],
  );

  const inspectBase = run(['inspect', NAME, '--json'], { env, cwd: project });
  const inspectPinned = run(['inspect', `${NAME}@1.0.0`, '--json'], { env, cwd: project });
  assert.ok(inspectBase.ok, inspectBase.stderr);
  assert.ok(inspectPinned.ok, inspectPinned.stderr);
  assert.equal(JSON.parse(inspectBase.stdout).version, '1.1.0');
  assert.equal(JSON.parse(inspectPinned.stdout).version, '1.0.0');

  const plannedPinned = run(
    [
      'plan-use',
      `${NAME}@1.0.0`,
      '--task=Review the pinned lifecycle.',
      '--budget=offline-audit',
      '--as=json',
    ],
    { env, cwd: project },
  );
  assert.ok(plannedPinned.ok, plannedPinned.stderr);
  const plan = JSON.parse(plannedPinned.stdout);
  assert.equal(plan.asset_ref.version, '1.0.0');
  assert.equal(plan.asset_ref.expected_digests.asset.value, sha256(initialAsset.asset));
  assert.equal(plan.type, 'kdna.consumption-plan');
  assert.equal(plan.contract_version, '0.1.0');

  const agentHost = currentAgentHost(root);
  const usedPinned = run(
    [
      'use',
      `${NAME}@1.0.0`,
      '--task=Review the pinned lifecycle.',
      '--runner=cli:default',
      `--agent-host=${process.execPath}`,
      `--agent-host-arg=${agentHost.host}`,
      `--agent-host-capabilities=${agentHost.descriptor}`,
      '--budget=offline-audit',
      '--as=trace',
    ],
    { env, cwd: project },
  );
  assert.ok(usedPinned.ok, usedPinned.stderr);
  const trace = JSON.parse(usedPinned.stdout);
  assert.equal(trace.asset_identity.version, '1.0.0');
  assert.equal(trace.digest_evidence.asset.value, sha256(initialAsset.asset));

  const removeUpdated = run(['remove', `${NAME}@1.1.0`], { env, cwd: project });
  assert.ok(removeUpdated.ok, removeUpdated.stderr);
  assert.match(removeUpdated.stdout, /@example\/versioned-review@1\.1\.0/);
  assert.ok(!fs.existsSync(path.dirname(migrated.packages[NAME].versions['1.1.0'].asset_path)));

  const afterRollback = run(['list', '--json'], { env, cwd: project });
  assert.ok(afterRollback.ok, afterRollback.stderr);
  assert.deepEqual(
    JSON.parse(afterRollback.stdout).map(({ version, active }) => ({ version, active })),
    [{ version: '1.0.0', active: true }],
  );
  const inspectRollback = run(['inspect', NAME, '--json'], { env, cwd: project });
  assert.equal(JSON.parse(inspectRollback.stdout).version, '1.0.0');

  const missing = run(['use', `${NAME}@9.9.9`, '--task=missing'], { env, cwd: project });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Installed packaged asset was not found/);
});

test('invalid local asset install fails closed unless explicitly overridden', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const { source } = buildAsset(root, '2.0.0');
  const payload = path.join(source, 'payload.kdnab');
  const bytes = fs.readFileSync(payload);
  bytes[bytes.length - 3] ^= 1;
  fs.writeFileSync(payload, bytes);
  const tampered = path.join(root, 'tampered.kdna');
  pack(source, tampered);

  const denied = run(['install', tampered, '--yes', '--json'], { env, cwd: project });
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /validation failed; refusing to install/);
  assert.ok(!fs.existsSync(path.join(kdnaHome, 'index.json')));

  const allowed = run(['install', tampered, '--yes', '--json', '--allow-unverified'], {
    env,
    cwd: project,
  });
  assert.ok(allowed.ok, allowed.stderr);
  const receipt = JSON.parse(allowed.stdout);
  assert.equal(receipt.verification.valid, false);
  assert.equal(receipt.verification.allow_unverified, true);

  const agentHost = currentAgentHost(root);
  const blocked = run(
    [
      'use',
      NAME,
      '--task=Review the tampered asset.',
      `--agent-host=${process.execPath}`,
      `--agent-host-arg=${agentHost.host}`,
      `--agent-host-capabilities=${agentHost.descriptor}`,
    ],
    { env, cwd: project },
  );
  assert.notEqual(blocked.code, 0);
  const blockedOutput = JSON.parse(blocked.stdout);
  assert.equal(blockedOutput.status, 'blocked');
  assert.equal(blockedOutput.trace.overall_status, 'blocked');
  assert.ok(blockedOutput.trace.errors.length > 0);
});

test('atomic index failure leaves the old index intact and recovers the committed asset', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const initialAsset = buildAsset(root, '1.0.0');
  const updatedAsset = buildAsset(root, '1.1.0');
  const installInitial = run(['install', initialAsset.asset, '--yes', '--json'], {
    env,
    cwd: project,
  });
  assert.ok(installInitial.ok, installInitial.stderr);

  const indexPath = path.join(kdnaHome, 'index.json');
  const oldIndex = fs.readFileSync(indexPath, 'utf8');
  withFreshPackageStore(env, (store) => {
    const originalRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === indexPath) throw new Error('injected index rename failure');
      return originalRename(source, destination);
    };
    try {
      assert.throws(
        () =>
          store.installAsset({
            sourcePath: updatedAsset.asset,
            name: NAME,
            version: '1.1.0',
            source: { type: 'test' },
          }),
        /injected index rename failure/,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(fs.readFileSync(indexPath, 'utf8'), oldIndex);
    assert.deepEqual(Object.keys(JSON.parse(oldIndex).packages[NAME].versions), ['1.0.0']);

    const recovered = store.getInstalled(`${NAME}@1.1.0`);
    assert.equal(recovered.version, '1.1.0');
    assert.equal(recovered.asset_digest, sha256(updatedAsset.asset));
    store.writeIndex(store.readIndex());
  });

  const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.deepEqual(Object.keys(persisted.packages[NAME].versions).sort(), ['1.0.0', '1.1.0']);
});

test('staging rename failure exposes neither a partial version nor a changed index', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const initialAsset = buildAsset(root, '1.0.0');
  const updatedAsset = buildAsset(root, '1.1.0');
  const installInitial = run(['install', initialAsset.asset, '--yes', '--json'], {
    env,
    cwd: project,
  });
  assert.ok(installInitial.ok, installInitial.stderr);

  const indexPath = path.join(kdnaHome, 'index.json');
  const oldIndex = fs.readFileSync(indexPath, 'utf8');
  const finalVersionDir = path.join(kdnaHome, 'packages', '@example', 'versioned-review', '1.1.0');
  withFreshPackageStore(env, (store) => {
    const originalRename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (destination === finalVersionDir) throw new Error('injected staging rename failure');
      return originalRename(source, destination);
    };
    try {
      assert.throws(
        () =>
          store.installAsset({
            sourcePath: updatedAsset.asset,
            name: NAME,
            version: '1.1.0',
            source: { type: 'test' },
          }),
        /injected staging rename failure/,
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(store.getInstalled(`${NAME}@1.1.0`), null);
  });

  assert.equal(fs.readFileSync(indexPath, 'utf8'), oldIndex);
  assert.equal(fs.existsSync(finalVersionDir), false);
  const versionParent = path.dirname(finalVersionDir);
  assert.equal(
    fs.readdirSync(versionParent).some((entry) => entry.startsWith('1.1.0.tmp-')),
    false,
  );
});

test('update --all continues after returned and thrown failures, then summarizes', () => {
  const { env } = makeEnv();
  const calls = [];
  const warnings = [];
  const logs = [];
  withFreshInstallModule(env, ({ cmdUpdateAll }) => {
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (message) => warnings.push(message);
    console.log = (message) => logs.push(message);
    try {
      const result = cmdUpdateAll({
        installed: [{ full: '@example/one' }, { full: '@example/two' }, { full: '@example/three' }],
        runUpdate(name) {
          calls.push(name);
          if (name.endsWith('/two')) return { ok: false, code: 7, stdout: '', stderr: 'denied' };
          if (name.endsWith('/three')) throw new Error('crashed');
          return { ok: true, code: 0, stdout: '', stderr: '' };
        },
        setExitCode: false,
      });
      assert.deepEqual(result, {
        total: 3,
        succeeded: 1,
        failed: 2,
        results: [
          { name: '@example/one', ok: true, code: 0 },
          { name: '@example/two', ok: false, code: 7 },
          { name: '@example/three', ok: false, code: 1 },
        ],
      });
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });
  assert.deepEqual(calls, ['@example/one', '@example/two', '@example/three']);
  assert.equal(warnings.length, 2);
  assert.match(logs.at(-1), /1\/3 completed, 2 failed/);
});

test('project-only update keeps the selected registry version in the project tier', () => {
  const { root, project, env } = makeEnv();
  const initialAsset = buildAsset(root, '1.0.0');
  const installed = run(['install', initialAsset.asset, '--yes', '--json', '--local'], {
    env,
    cwd: project,
  });
  assert.ok(installed.ok, installed.stderr);

  const requests = [];
  withFreshInstallModule(env, ({ cmdUpdate }) => {
    cmdUpdate(NAME, {
      resolver: {
        resolve: () => ({ entry: { name: NAME, version: '1.1.0' } }),
      },
      install: (reference, args) => requests.push({ reference, args }),
    });
  });
  assert.deepEqual(requests, [{ reference: `${NAME}@1.1.0`, args: ['--yes', '--local'] }]);
});

test('project tier remains the update target when a newer global version also exists', () => {
  const { root, project, env } = makeEnv();
  const globalNewerAsset = buildAsset(root, '2.0.0');
  const projectOlderAsset = buildAsset(root, '1.0.0');
  assert.ok(run(['install', globalNewerAsset.asset, '--yes', '--json'], { env, cwd: project }).ok);
  assert.ok(
    run(['install', projectOlderAsset.asset, '--yes', '--json', '--local'], {
      env,
      cwd: project,
    }).ok,
  );

  const requests = [];
  withFreshInstallModule(env, ({ cmdUpdate }) => {
    cmdUpdate(NAME, {
      resolver: {
        resolve: () => ({ entry: { name: NAME, version: '1.1.0' } }),
      },
      install: (reference, args) => requests.push({ reference, args }),
    });
  });
  assert.deepEqual(requests, [{ reference: `${NAME}@1.1.0`, args: ['--yes', '--local'] }]);
});

test('update never downgrades an installed version that is newer than the registry release', () => {
  const { root, project, env } = makeEnv();
  const newerInstalledAsset = buildAsset(root, '2.0.0');
  const installed = run(['install', newerInstalledAsset.asset, '--yes', '--json'], {
    env,
    cwd: project,
  });
  assert.ok(installed.ok, installed.stderr);

  const requests = [];
  withFreshInstallModule(env, ({ cmdUpdate }) => {
    cmdUpdate(NAME, {
      resolver: {
        resolve: () => ({ entry: { name: NAME, version: '1.1.0' } }),
      },
      install: (reference, args) => requests.push({ reference, args }),
    });
  });
  assert.deepEqual(requests, []);
});

test('tampered installed bytes make update and same-version reinstall fail closed', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const installedAsset = buildAsset(root, '1.0.0');
  const installed = run(['install', installedAsset.asset, '--yes', '--json'], {
    env,
    cwd: project,
  });
  assert.ok(installed.ok, installed.stderr);

  const index = JSON.parse(fs.readFileSync(path.join(kdnaHome, 'index.json'), 'utf8'));
  const installedPath = index.packages[NAME].versions['1.0.0'].asset_path;
  const bytes = fs.readFileSync(installedPath);
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  fs.writeFileSync(installedPath, bytes);

  const update = run(['update', NAME], { env, cwd: project });
  assert.equal(update.code, 1);
  assert.match(update.stderr, /failed integrity/);
  assert.match(update.stderr, /kdna remove @example\/versioned-review@1\.0\.0/);
  assert.doesNotMatch(update.stdout, /up to date/);

  const reinstall = run(['install', installedAsset.asset, '--yes', '--json'], {
    env,
    cwd: project,
  });
  assert.equal(reinstall.code, 1);
  assert.match(reinstall.stderr, /failed integrity/);
  assert.doesNotMatch(reinstall.stdout, /"installed":true/);
});

test('stale index writers merge committed versions and preserve the active version', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const initialAsset = buildAsset(root, '1.0.0');
  const updatedAsset = buildAsset(root, '1.1.0');
  assert.ok(run(['install', initialAsset.asset, '--yes', '--json'], { env, cwd: project }).ok);

  withFreshPackageStore(env, (store) => {
    const stale = store.readIndex();
    const installUpdated = run(['install', updatedAsset.asset, '--yes', '--json'], {
      env,
      cwd: project,
    });
    assert.ok(installUpdated.ok, installUpdated.stderr);
    store.writeIndex(stale);
  });

  const persisted = JSON.parse(fs.readFileSync(path.join(kdnaHome, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(persisted.packages[NAME].versions).sort(), ['1.0.0', '1.1.0']);
  assert.equal(persisted.packages[NAME].active_version, '1.1.0');
});

test('concurrent different-version installs serialize without losing either index entry', async () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const initialAsset = buildAsset(root, '1.0.0');
  const updatedAsset = buildAsset(root, '1.1.0');
  const [first, second] = await Promise.all([
    runAsync(['install', initialAsset.asset, '--yes', '--json'], { env, cwd: project }),
    runAsync(['install', updatedAsset.asset, '--yes', '--json'], { env, cwd: project }),
  ]);
  assert.ok(first.ok, first.stderr);
  assert.ok(second.ok, second.stderr);

  const persisted = JSON.parse(fs.readFileSync(path.join(kdnaHome, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(persisted.packages[NAME].versions).sort(), ['1.0.0', '1.1.0']);
  assert.ok(['1.0.0', '1.1.0'].includes(persisted.packages[NAME].active_version));
});

test('a dead stale index lock is recovered before installation', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const initialAsset = buildAsset(root, '1.0.0');
  const lockDir = path.join(kdnaHome, 'index.json.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  writeJson(path.join(lockDir, 'owner.json'), {
    pid: 999999,
    created_at: '2000-01-01T00:00:00.000Z',
  });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockDir, old, old);

  const installed = run(['install', initialAsset.asset, '--yes', '--json'], {
    env,
    cwd: project,
  });
  assert.ok(installed.ok, installed.stderr);
  assert.equal(fs.existsSync(lockDir), false);
});
