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

test('backend selection: defaults to keychain on darwin, file elsewhere', () => {
  delete process.env.KDNA_SECRET_STORE_BACKEND;
  const ss = freshSecretStore();
  if (os.platform() === 'darwin') {
    assert.equal(ss._internals.backend, 'keychain');
  } else {
    assert.equal(ss._internals.backend, 'file');
  }
});
