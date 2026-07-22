/**
 * secret-store.test.js — Tests for the cross-platform SecretStore (B7).
 *
 * These tests exercise the file backend (cross-platform) and the env
 * backend. The macOS keychain backend is not unit-tested here (no
 * macOS CI); it's verified manually.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Clear the require cache for the secret-store module so that
 * changes to KDNA_HOME / KDNA_SECRET_STORE_BACKEND take effect
 * (the module's _internals.backend getter reads them lazily on each
 * call, but `require` itself returns the same instance).
 */
function freshSecretStore() {
  // Clear the cache for both secret-store AND paths, because
  // secret-store.js does `const PATHS = require('./paths')` at module
  // load time and PATHS captures USER_KDNA_DIR from process.env at that
  // moment. If we don't clear paths too, tests that change KDNA_HOME
  // see stale paths.
  delete require.cache[require.resolve('../src/secret-store')];
  delete require.cache[require.resolve('../src/paths')];
  return require('../src/secret-store');
}

function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = value;
  // The async fn() below needs to see the env var AFTER the test runner
  // has set it. Using Promise.resolve().then() forces a microtask
  // boundary so the change is visible to subsequent code in the test
  // (and avoids the setImmediate ESLint no-undef issue).
  return Promise.resolve().then(async () => {
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
  });
}

test('file backend: set / get / list / delete round-trip', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-secret-store-'));
  await withEnv('KDNA_HOME', tmpHome, async () => {
    await withEnv('KDNA_SECRET_STORE_BACKEND', 'file', async () => {
      const ss = freshSecretStore();
      await ss.set('api-token', 'secret-value-123');
      const v = await ss.get('api-token');
      assert.equal(v, 'secret-value-123');
      const list = await ss.list();
      assert.ok(
        list.includes('api-token'),
        `expected 'api-token' in list, got ${JSON.stringify(list)}`,
      );
      // Permissions check: file should be 0600
      const p = path.join(tmpHome, 'secrets', 'api-token');
      const st = fs.statSync(p);
      assert.equal(
        st.mode & 0o777,
        0o600,
        `file mode should be 0600, got ${(st.mode & 0o777).toString(8)}`,
      );
      await ss.delete('api-token');
      assert.equal(await ss.get('api-token'), null, 'get after delete should be null');
    });
  });
  fs.rmSync(tmpHome, { recursive: true });
});

test('file backend: get returns null for missing secrets', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-secret-store-'));
  await withEnv('KDNA_HOME', tmpHome, async () => {
    await withEnv('KDNA_SECRET_STORE_BACKEND', 'file', async () => {
      const ss = freshSecretStore();
      assert.equal(await ss.get('does-not-exist'), null);
    });
  });
  fs.rmSync(tmpHome, { recursive: true });
});

test('file backend: encodes secret names with non-alphanumeric characters', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-secret-store-'));
  await withEnv('KDNA_HOME', tmpHome, async () => {
    await withEnv('KDNA_SECRET_STORE_BACKEND', 'file', async () => {
      const ss = freshSecretStore();
      await ss.set('npm:token@aikdna', 'value-1');
      assert.equal(await ss.get('npm:token@aikdna'), 'value-1');
      // Verify the on-disk file name does not contain : or @
      const dir = path.join(tmpHome, 'secrets');
      const files = fs.readdirSync(dir);
      assert.equal(files.length, 1);
      assert.ok(!files[0].includes(':'), `filename should not contain ':', got ${files[0]}`);
      assert.ok(!files[0].includes('@'), `filename should not contain '@', got ${files[0]}`);
      await ss.delete('npm:token@aikdna');
    });
  });
  fs.rmSync(tmpHome, { recursive: true });
});

test('env backend: get reads from process.env, set/delete throw', async () => {
  await withEnv('KDNA_SECRET_STORE_BACKEND', 'env', async () => {
    await withEnv('KDNA_TEST_SECRET', 'env-secret-value', async () => {
      const ss = freshSecretStore();
      assert.equal(await ss.get('KDNA_TEST_SECRET'), 'env-secret-value');
      await assert.rejects(() => ss.set('KDNA_TEST_SECRET', 'new'), {
        name: 'SecretStoreError',
        code: 'PERMISSION_DENIED',
      });
      await assert.rejects(() => ss.delete('KDNA_TEST_SECRET'), {
        name: 'SecretStoreError',
        code: 'PERMISSION_DENIED',
      });
    });
  });
});

test('backend selection: KDNA_SECRET_STORE_BACKEND overrides default', async () => {
  await withEnv('KDNA_SECRET_STORE_BACKEND', 'file', async () => {
    const ss = freshSecretStore();
    assert.equal(ss._internals.backend, 'file');
  });
  await withEnv('KDNA_SECRET_STORE_BACKEND', 'env', async () => {
    const ss = freshSecretStore();
    assert.equal(ss._internals.backend, 'env');
  });
});

test('pass backend sends secret values over stdin and supports sync round-trip', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-pass-backend-'));
  const bin = path.join(tmp, 'bin');
  const store = path.join(tmp, 'store');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  const fakePass = path.join(bin, 'pass');
  fs.writeFileSync(
    fakePass,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.FAKE_PASS_STORE;
const entry = args[args.length - 1] || '';
const file = path.join(root, Buffer.from(entry).toString('hex'));
if (args[0] === 'ls') process.exit(0);
if (args[0] === 'insert') { fs.writeFileSync(file, fs.readFileSync(0, 'utf8')); process.exit(0); }
if (args[0] === 'show') { if (!fs.existsSync(file)) process.exit(1); process.stdout.write(fs.readFileSync(file)); process.exit(0); }
if (args[0] === 'rm') { if (!fs.existsSync(file)) process.exit(1); fs.unlinkSync(file); process.exit(0); }
process.exit(2);
`,
    { mode: 0o700 },
  );

  const previous = { PATH: process.env.PATH, FAKE_PASS_STORE: process.env.FAKE_PASS_STORE };
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.FAKE_PASS_STORE = store;
  try {
    await withEnv('KDNA_SECRET_STORE_BACKEND', 'pass', async () => {
      const ss = freshSecretStore();
      await ss.set('entitlement/device-key', 'private-value');
      assert.equal(await ss.get('entitlement/device-key'), 'private-value');
      assert.equal(ss.getSync('entitlement/device-key'), 'private-value');
      ss.setSync('entitlement/device-key', 'rotated-value');
      assert.equal(ss.getSync('entitlement/device-key'), 'rotated-value');
      ss.deleteSync('entitlement/device-key');
      assert.equal(ss.getSync('entitlement/device-key'), null);
    });
  } finally {
    if (previous.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = previous.PATH;
    if (previous.FAKE_PASS_STORE === undefined) delete process.env.FAKE_PASS_STORE;
    else process.env.FAKE_PASS_STORE = previous.FAKE_PASS_STORE;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('backend selection: defaults to an encrypted system backend when available', () => {
  delete process.env.KDNA_SECRET_STORE_BACKEND;
  const ss = freshSecretStore();
  if (os.platform() === 'darwin') {
    assert.equal(ss._internals.backend, 'keychain');
  } else {
    assert.ok(['secret-service', 'pass', 'file'].includes(ss._internals.backend));
  }
});

test('macOS keychain backend writes secrets through the stdin helper, never argv', async (t) => {
  if (os.platform() !== 'darwin') {
    t.skip('macOS-only integration test');
    return;
  }
  if (process.env.CI) {
    t.skip('CI keychains cannot display ACL prompts; behavior is covered by local verification');
    return;
  }
  process.env.KDNA_SECRET_STORE_BACKEND = 'keychain';
  const ss = freshSecretStore();
  const name = `helper-test-${process.pid}`;
  const value = 'secret-via-stdin-helper-printable-abc123';
  try {
    await ss.set(name, value);
    assert.equal(await ss.get(name), value);
    assert.equal(typeof ss._internals.keychainHelperAvailable === 'function'
      ? ss._internals.keychainHelperAvailable()
      : 'helper-api-missing', true);
  } finally {
    await ss.delete(name);
    assert.equal(await ss.get(name), null);
  }
});
