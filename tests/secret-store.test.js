/**
 * Tests for encrypted credential storage selection and transport.
 *
 * Compatibility backends are explicit and fail closed for writes. Tests use
 * the in-memory backend only with NODE_ENV=test.
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

test('explicit legacy file backend is migration-read-only and never writes plaintext', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-secret-store-'));
  await withEnv('KDNA_HOME', tmpHome, async () => {
    await withEnv('KDNA_SECRET_STORE_BACKEND', 'file', async () => {
      const legacyDirectory = path.join(tmpHome, 'secrets');
      fs.mkdirSync(legacyDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(legacyDirectory, 'legacy-name'), 'legacy-value\n', {
        mode: 0o600,
      });
      const ss = freshSecretStore();
      assert.equal(ss.backendName(), 'legacy-file-readonly');
      assert.deepEqual(ss.backendStatus(), {
        name: 'legacy-file-readonly',
        secure_for_secrets: false,
        writable: false,
        classification: 'legacy-readonly-migration',
      });
      assert.equal(await ss.get('legacy-name'), 'legacy-value');
      await assert.rejects(() => ss.set('new-name', 'must-not-reach-disk'), {
        name: 'SecretStoreError',
        code: 'BACKEND_UNAVAILABLE',
      });
      assert.equal(fs.existsSync(path.join(legacyDirectory, 'new-name')), false);
      await ss.delete('legacy-name');
      assert.equal(await ss.get('legacy-name'), null);
    });
  });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('memory backend is explicit, test-only, and leaves no filesystem bytes', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-secret-store-memory-'));
  await withEnv('KDNA_HOME', tmpHome, async () => {
    await withEnv('NODE_ENV', 'test', async () => {
      await withEnv('KDNA_SECRET_STORE_BACKEND', 'memory', async () => {
        const ss = freshSecretStore();
        await ss.set('test-value', 'memory-only');
        assert.equal(await ss.get('test-value'), 'memory-only');
        assert.deepEqual(await ss.list(), ['test-value']);
        await ss.delete('test-value');
        assert.equal(await ss.get('test-value'), null);
        assert.equal(fs.existsSync(path.join(tmpHome, 'secrets')), false);
      });
    });
  });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('memory backend refuses production use and unavailable backend fails closed', async () => {
  await withEnv('NODE_ENV', 'production', async () => {
    await withEnv('KDNA_SECRET_STORE_BACKEND', 'memory', async () => {
      const ss = freshSecretStore();
      await assert.rejects(() => ss.set('credential', 'value'), {
        name: 'SecretStoreError',
        code: 'BACKEND_UNAVAILABLE',
      });
    });
  });
  await withEnv('KDNA_SECRET_STORE_BACKEND', 'unavailable', async () => {
    const ss = freshSecretStore();
    await assert.rejects(() => ss.get('credential'), {
      name: 'SecretStoreError',
      code: 'BACKEND_UNAVAILABLE',
    });
  });
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
    assert.equal(ss._internals.backend, 'legacy-file-readonly');
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

test('backend selection defaults only to an encrypted system backend or unavailable', () => {
  delete process.env.KDNA_SECRET_STORE_BACKEND;
  const ss = freshSecretStore();
  if (os.platform() === 'darwin') {
    assert.equal(ss._internals.backend, 'keychain');
  } else {
    assert.ok(['secret-service', 'pass', 'unavailable'].includes(ss._internals.backend));
  }
  assert.notEqual(ss._internals.backend, 'legacy-file-readonly');
});

test('packaged authorization callers reject plaintext, env, and non-test memory backends', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    for (const backend of ['file', 'env', 'memory']) {
      await withEnv('KDNA_SECRET_STORE_BACKEND', backend, async () => {
        const secretStore = freshSecretStore();
        delete require.cache[require.resolve('../src/external-entitlement')];
        const externalEntitlement = require('../src/external-entitlement');
        assert.throws(() => externalEntitlement.assertSecureSecretStore(), (error) => {
          assert.equal(error.code, 'KDNA_SECRET_STORE_REQUIRED');
          assert.equal(secretStore.backendStatus().secure_for_secrets, false);
          return true;
        });
      });
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
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

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

test('keychain set refuses deterministically when the helper is missing and never touches the security CLI', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-noargv-'));
  try {
    const securityLog = path.join(tmp, 'security-calls.log');
    writeExecutable(
      path.join(tmp, 'security'),
      `#!/bin/sh\necho "$@" >> "${securityLog}"\nexit 1\n`,
    );
    process.env.KDNA_SECRET_STORE_BACKEND = 'keychain';
    process.env.KDNA_KEYCHAIN_HELPER_PATH = path.join(tmp, 'missing-helper');
    process.env.PATH = `${tmp}${path.delimiter}/usr/bin:/bin`;
    const ss = freshSecretStore();
    await assert.rejects(
      () => ss.set('any-name', 'any-secret'),
      (error) => {
        assert.equal(error.code, 'BACKEND_UNAVAILABLE');
        assert.match(error.message, /Xcode Command Line Tools/);
        assert.match(error.message, /refused/);
        return true;
      },
    );
    assert.equal(fs.existsSync(securityLog), false, 'security CLI must never be invoked');
  } finally {
    delete process.env.KDNA_KEYCHAIN_HELPER_PATH;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('keychain get refuses deterministically when the helper is missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-noargv-get-'));
  try {
    process.env.KDNA_SECRET_STORE_BACKEND = 'keychain';
    process.env.KDNA_KEYCHAIN_HELPER_PATH = path.join(tmp, 'missing-helper');
    const ss = freshSecretStore();
    await assert.rejects(() => ss.get('any-name'), (error) => {
      assert.equal(error.code, 'BACKEND_UNAVAILABLE');
      return true;
    });
  } finally {
    delete process.env.KDNA_KEYCHAIN_HELPER_PATH;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a hung helper fails closed with KEYCHAIN_TIMEOUT instead of hanging', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-hang-'));
  try {
    writeExecutable(path.join(tmp, 'hanging-helper'), '#!/bin/sh\nsleep 60\n');
    process.env.KDNA_SECRET_STORE_BACKEND = 'keychain';
    process.env.KDNA_KEYCHAIN_HELPER_PATH = path.join(tmp, 'hanging-helper');
    process.env.KDNA_KEYCHAIN_TIMEOUT_MS = '500';
    const ss = freshSecretStore();
    const started = Date.now();
    await assert.rejects(() => ss.set('any-name', 'any-secret'), (error) => {
      assert.equal(error.code, 'KEYCHAIN_TIMEOUT');
      assert.match(error.message, /refusing to hang/);
      return true;
    });
    assert.ok(Date.now() - started < 15_000, 'must fail fast, not hang');
  } finally {
    delete process.env.KDNA_KEYCHAIN_HELPER_PATH;
    delete process.env.KDNA_KEYCHAIN_TIMEOUT_MS;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a working helper round-trips via stdin without argv secrets (mock helper records argv)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-mock-helper-'));
  try {
    const argvLog = path.join(tmp, 'argv.log');
    writeExecutable(
      path.join(tmp, 'mock-helper'),
      `#!/bin/sh\necho "$@" >> "${argvLog}"\ncase "$1" in\n  set) cat > /dev/null; exit 0;;\n  get) exit 44;;\n  delete) exit 0;;\nesac\nexit 2\n`,
    );
    process.env.KDNA_SECRET_STORE_BACKEND = 'keychain';
    process.env.KDNA_KEYCHAIN_HELPER_PATH = path.join(tmp, 'mock-helper');
    const ss = freshSecretStore();
    const secret = 'super-secret-value-must-not-appear-in-argv';
    await ss.set('roundtrip', secret);
    assert.equal(await ss.get('roundtrip'), null);
    await ss.delete('roundtrip');
    const argv = fs.readFileSync(argvLog, 'utf8');
    assert.ok(!argv.includes(secret), 'secret must never appear in helper argv');
    assert.match(argv, /set aikdna-kdna roundtrip/);
    assert.match(argv, /delete aikdna-kdna roundtrip/);
  } finally {
    delete process.env.KDNA_KEYCHAIN_HELPER_PATH;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
