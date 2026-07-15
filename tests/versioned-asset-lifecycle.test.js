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
  const v1 = buildAsset(root, '1.0.0');
  const v2 = buildAsset(root, '1.1.0');

  const installV1 = run(['install', v1.asset, '--yes', '--json'], { env, cwd: project });
  assert.ok(installV1.ok, installV1.stderr);

  const installV2 = run(['install', v2.asset, '--yes', '--json'], { env, cwd: project });
  assert.ok(installV2.ok, installV2.stderr);

  // Replace the v3 index with a v2 record that omits v1 while leaving v1's
  // immutable directory and receipt on disk. A read must recover the orphan,
  // and the next write must persist both versions.
  const indexPath = path.join(kdnaHome, 'index.json');
  const current = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const legacyEntry = current.packages[NAME].versions['1.1.0'];
  writeJson(indexPath, { version: 2, packages: { [NAME]: legacyEntry } });

  const inspectLegacyPin = run(['inspect', `${NAME}@1.0.0`, '--json'], { env, cwd: project });
  assert.ok(inspectLegacyPin.ok, inspectLegacyPin.stderr);
  assert.equal(JSON.parse(inspectLegacyPin.stdout).version, '1.0.0');

  const reactivateV2 = run(['install', v2.asset, '--yes', '--json'], { env, cwd: project });
  assert.ok(reactivateV2.ok, reactivateV2.stderr);
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
  const inspectV1 = run(['inspect', `${NAME}@1.0.0`, '--json'], { env, cwd: project });
  assert.ok(inspectBase.ok, inspectBase.stderr);
  assert.ok(inspectV1.ok, inspectV1.stderr);
  assert.equal(JSON.parse(inspectBase.stdout).version, '1.1.0');
  assert.equal(JSON.parse(inspectV1.stdout).version, '1.0.0');

  const plannedV1 = run(
    [
      'plan-use',
      `${NAME}@1.0.0`,
      '--task=Review the pinned lifecycle.',
      '--budget=offline-audit',
      '--as=json',
    ],
    { env, cwd: project },
  );
  assert.ok(plannedV1.ok, plannedV1.stderr);
  const plan = JSON.parse(plannedV1.stdout);
  assert.equal(plan.asset_ref.version, '1.0.0');
  assert.equal(plan.asset_ref.digest, sha256(v1.asset));
  assert.equal(plan.load_plan_ref.status, 'ready');

  const usedV1 = run(
    [
      'use',
      `${NAME}@1.0.0`,
      '--task=Review the pinned lifecycle.',
      '--runner=mock:default',
      '--budget=offline-audit',
      '--as=trace',
    ],
    { env, cwd: project },
  );
  assert.ok(usedV1.ok, usedV1.stderr);
  const trace = JSON.parse(usedV1.stdout);
  assert.equal(trace.asset_identity.version, '1.0.0');
  assert.equal(trace.asset_identity.digest, sha256(v1.asset));

  const removeV2 = run(['remove', `${NAME}@1.1.0`], { env, cwd: project });
  assert.ok(removeV2.ok, removeV2.stderr);
  assert.match(removeV2.stdout, /@example\/versioned-review@1\.1\.0/);
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
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Asset not found/);
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

  const blocked = run(['use', NAME, '--task=Review the tampered asset.', '--runner=mock:default'], {
    env,
    cwd: project,
  });
  assert.equal(blocked.code, 3);
  assert.match(blocked.stderr, /LoadPlan is blocked/);
});

test('atomic index failure leaves the old index intact and recovers the committed asset', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const v1 = buildAsset(root, '1.0.0');
  const v2 = buildAsset(root, '1.1.0');
  const installV1 = run(['install', v1.asset, '--yes', '--json'], { env, cwd: project });
  assert.ok(installV1.ok, installV1.stderr);

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
            sourcePath: v2.asset,
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
    assert.equal(recovered.asset_digest, sha256(v2.asset));
    store.writeIndex(store.readIndex());
  });

  const persisted = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.deepEqual(Object.keys(persisted.packages[NAME].versions).sort(), ['1.0.0', '1.1.0']);
});

test('staging rename failure exposes neither a partial version nor a changed index', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const v1 = buildAsset(root, '1.0.0');
  const v2 = buildAsset(root, '1.1.0');
  const installV1 = run(['install', v1.asset, '--yes', '--json'], { env, cwd: project });
  assert.ok(installV1.ok, installV1.stderr);

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
            sourcePath: v2.asset,
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
  const v1 = buildAsset(root, '1.0.0');
  const installed = run(['install', v1.asset, '--yes', '--json', '--local'], {
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
  const globalV2 = buildAsset(root, '2.0.0');
  const projectV1 = buildAsset(root, '1.0.0');
  assert.ok(run(['install', globalV2.asset, '--yes', '--json'], { env, cwd: project }).ok);
  assert.ok(
    run(['install', projectV1.asset, '--yes', '--json', '--local'], { env, cwd: project }).ok,
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
  const v2 = buildAsset(root, '2.0.0');
  const installed = run(['install', v2.asset, '--yes', '--json'], { env, cwd: project });
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
  const v1 = buildAsset(root, '1.0.0');
  const installed = run(['install', v1.asset, '--yes', '--json'], { env, cwd: project });
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

  const reinstall = run(['install', v1.asset, '--yes', '--json'], { env, cwd: project });
  assert.equal(reinstall.code, 1);
  assert.match(reinstall.stderr, /failed integrity/);
  assert.doesNotMatch(reinstall.stdout, /"installed":true/);
});

test('stale index writers merge committed versions and preserve the active version', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const v1 = buildAsset(root, '1.0.0');
  const v2 = buildAsset(root, '1.1.0');
  assert.ok(run(['install', v1.asset, '--yes', '--json'], { env, cwd: project }).ok);

  withFreshPackageStore(env, (store) => {
    const stale = store.readIndex();
    const installV2 = run(['install', v2.asset, '--yes', '--json'], { env, cwd: project });
    assert.ok(installV2.ok, installV2.stderr);
    store.writeIndex(stale);
  });

  const persisted = JSON.parse(fs.readFileSync(path.join(kdnaHome, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(persisted.packages[NAME].versions).sort(), ['1.0.0', '1.1.0']);
  assert.equal(persisted.packages[NAME].active_version, '1.1.0');
});

test('concurrent different-version installs serialize without losing either index entry', async () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const v1 = buildAsset(root, '1.0.0');
  const v2 = buildAsset(root, '1.1.0');
  const [first, second] = await Promise.all([
    runAsync(['install', v1.asset, '--yes', '--json'], { env, cwd: project }),
    runAsync(['install', v2.asset, '--yes', '--json'], { env, cwd: project }),
  ]);
  assert.ok(first.ok, first.stderr);
  assert.ok(second.ok, second.stderr);

  const persisted = JSON.parse(fs.readFileSync(path.join(kdnaHome, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(persisted.packages[NAME].versions).sort(), ['1.0.0', '1.1.0']);
  assert.ok(['1.0.0', '1.1.0'].includes(persisted.packages[NAME].active_version));
});

test('a dead stale index lock is recovered before installation', () => {
  const { root, kdnaHome, project, env } = makeEnv();
  const v1 = buildAsset(root, '1.0.0');
  const lockDir = path.join(kdnaHome, 'index.json.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  writeJson(path.join(lockDir, 'owner.json'), {
    pid: 999999,
    created_at: '2000-01-01T00:00:00.000Z',
  });
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockDir, old, old);

  const installed = run(['install', v1.asset, '--yes', '--json'], { env, cwd: project });
  assert.ok(installed.ok, installed.stderr);
  assert.equal(fs.existsSync(lockDir), false);
});
