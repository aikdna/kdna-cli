/**
 * secret-store.js — current KDNA SecretStore (B7)
 *
 * A cross-platform secret storage abstraction. Backends:
 *
 *   - 'keychain' (default on macOS): uses the macOS Keychain. All writes,
 *     reads, and deletes go through a small Swift helper (compiled once per
 *     source revision into ~/.kdna/bin, requiring the Xcode Command Line
 *     Tools) that receives secrets over stdin, so values never appear in
 *     process argv. Routing every operation through one helper binary also
 *     keeps keychain ACL prompts away: items created by the helper are read
 *     back by the same helper, not by the `security` CLI (a different
 *     signing identity whose access would trigger a GUI prompt). If the
 *     helper cannot be built or does not answer within its timeout, the
 *     operation is REFUSED with a diagnostic; there is deliberately no
 *     fallback that passes secrets through process argv.
 *     Note the CLI renders stored values containing non-printable bytes as
 *     hex on read; secrets stored by this backend are expected to be
 *     printable (PEM keys, JSON grants). Items are stored as
 *     generic-password entries under the `service` 'aikdna-kdna'.
 *
 *   - 'secret-service' (preferred on Linux desktops): uses libsecret's
 *     `secret-tool` and the active desktop keyring.
 *
 *   - 'pass' (Linux/headless): uses the GPG-encrypted standard password
 *     store. Secret values are written over stdin and never appear in argv.
 *
 *   - 'file' (fallback on Linux/Windows and CI): secrets are stored
 *     under `~/.kdna/secrets/<name>` with file permissions set to
 *     0600 (owner read/write only). The contents are stored as
 *     plaintext for now; an encrypted-on-disk format is a future
 *     extension. The file backend is the cross-platform fallback and
 *     is the default in non-macOS environments to avoid breaking CLI
 *     workflows in CI.
 *
 *   - 'env' (debug only): secrets are read from process.env.
 *     Write/delete are no-ops. Useful for CI / docker / k8s where
 *     secret injection is via env vars.
 *
 * The active backend is chosen by the `KDNA_SECRET_STORE_BACKEND`
 * environment variable. If unset, defaults to 'keychain' on macOS
 * (process.platform === 'darwin'), then an available encrypted Linux backend,
 * and finally 'file' for non-sensitive compatibility workflows.
 *
 * Interface (Promise-based to leave room for async Keychain APIs later):
 *
 *   get(name): Promise<string | null>
 *   set(name, value): Promise<void>
 *   delete(name): Promise<void>
 *   list(): Promise<string[]>
 *
 * Errors: SecretStoreError (with .code: 'NOT_FOUND' | 'BACKEND_UNAVAILABLE' | 'PERMISSION_DENIED').
 *
 * Security note: the file backend is NOT encrypted on disk. It exists
 * for non-sensitive compatibility workflows. Account/device grants
 * require an encrypted backend: macOS Keychain, Linux Secret Service,
 * or a GPG-backed standard password store. They explicitly reject the
 * plaintext file and environment backends.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const PATHS = require('./paths');

const SERVICE_NAME = 'aikdna-kdna';
const FILE_BACKEND_DIR = path.join(PATHS.root, 'secrets');
const memorySecrets = new Map();

class SecretStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretStoreError';
    this.code = code;
  }
}

function pickBackend() {
  const env = process.env.KDNA_SECRET_STORE_BACKEND;
  if (env) return env;
  if (os.platform() === 'darwin') return 'keychain';
  if (os.platform() === 'linux' && secretToolAvailable()) return 'secret-service';
  if (os.platform() === 'linux' && passAvailable()) return 'pass';
  return 'file';
}

function commandAvailable(command, args = ['--version']) {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function secretToolAvailable() {
  return (
    os.platform() === 'linux' &&
    Boolean(process.env.DBUS_SESSION_BUS_ADDRESS) &&
    commandAvailable('secret-tool', ['--version'])
  );
}

function passAvailable() {
  return os.platform() === 'linux' && commandAvailable('pass', ['ls']);
}

function securityCliAvailable() {
  if (os.platform() !== 'darwin') return false;
  try {
    execFileSync('which', ['security'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function keychainAvailable() {
  if (process.env.KDNA_KEYCHAIN_HELPER_PATH) {
    return fs.existsSync(process.env.KDNA_KEYCHAIN_HELPER_PATH);
  }
  if (os.platform() !== 'darwin') return false;
  return fs.existsSync(KEYCHAIN_HELPER_PATH) || resolveSwiftc() !== null;
}

const KEYCHAIN_HELPER_SOURCE = `import Foundation
import Security

let args = CommandLine.arguments
guard args.count >= 3 else {
    fputs("usage: helper <set|get|delete> <service> [account]\\n", stderr)
    exit(2)
}
let verb = args[1]
let service = args[2]
let account = args.count > 3 ? args[3] : ""

func baseQuery() -> [CFString: Any] {
    [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service,
        kSecAttrAccount: account,
    ]
}

switch verb {
case "set":
    let secret = FileHandle.standardInput.readDataToEndOfFile()
    guard !secret.isEmpty else { fputs("secret must not be empty\\n", stderr); exit(2) }
    SecItemDelete(baseQuery() as CFDictionary)
    var attributes = baseQuery()
    attributes[kSecValueData] = secret
    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else { fputs("SecItemAdd failed: \\(status)\\n", stderr); exit(1) }
case "get":
    var query = baseQuery()
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { exit(44) }
    guard status == errSecSuccess, let data = result as? Data else {
        fputs("SecItemCopyMatching failed: \\(status)\\n", stderr)
        exit(1)
    }
    FileHandle.standardOutput.write(data)
case "delete":
    let status = SecItemDelete(baseQuery() as CFDictionary)
    if status == errSecItemNotFound { exit(44) }
    guard status == errSecSuccess else { fputs("SecItemDelete failed: \\(status)\\n", stderr); exit(1) }
default:
    fputs("unknown verb\\n", stderr)
    exit(2)
}
`;

const KEYCHAIN_HELPER_ID = require('node:crypto')
  .createHash('sha256')
  .update(KEYCHAIN_HELPER_SOURCE)
  .digest('hex')
  .slice(0, 12);
const KEYCHAIN_HELPER_PATH =
  process.env.KDNA_KEYCHAIN_HELPER_PATH ||
  path.join(PATHS.root, 'bin', `kdna-keychain-helper-${KEYCHAIN_HELPER_ID}`);

const KEYCHAIN_OP_TIMEOUT_MS = Number.parseInt(
  process.env.KDNA_KEYCHAIN_TIMEOUT_MS || '30000',
  10,
);
const KEYCHAIN_COMPILE_TIMEOUT_MS = Number.parseInt(
  process.env.KDNA_KEYCHAIN_COMPILE_TIMEOUT_MS || '300000',
  10,
);

let keychainHelperState;

function resolveSwiftc() {
  for (const candidate of ['/usr/bin/swiftc']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    return execFileSync('xcrun', ['-f', 'swiftc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function keychainHelperAvailable() {
  if (keychainHelperState !== undefined) return keychainHelperState;
  try {
    if (!fs.existsSync(KEYCHAIN_HELPER_PATH)) {
      if (process.env.KDNA_KEYCHAIN_HELPER_PATH) {
        keychainHelperState = false;
        return false;
      }
      const swiftc = resolveSwiftc();
      if (!swiftc) {
        keychainHelperState = false;
        return false;
      }
      fs.mkdirSync(path.dirname(KEYCHAIN_HELPER_PATH), { recursive: true, mode: 0o700 });
      const tmp = `${KEYCHAIN_HELPER_PATH}.tmp-${process.pid}`;
      const srcTmp = `${tmp}.swift`;
      fs.writeFileSync(srcTmp, KEYCHAIN_HELPER_SOURCE, { mode: 0o600 });
      execFileSync(swiftc, ['-O', '-o', tmp, srcTmp], {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: KEYCHAIN_COMPILE_TIMEOUT_MS,
      });
      fs.unlinkSync(srcTmp);
      fs.renameSync(tmp, KEYCHAIN_HELPER_PATH);
      fs.chmodSync(KEYCHAIN_HELPER_PATH, 0o700);
    }
    keychainHelperState = true;
  } catch {
    keychainHelperState = false;
  }
  return keychainHelperState;
}

function keychainUnavailableError() {
  return new SecretStoreError(
    'BACKEND_UNAVAILABLE',
    'macOS Keychain helper unavailable: install the Xcode Command Line Tools ' +
      '(xcode-select --install) or select another backend via ' +
      'KDNA_SECRET_STORE_BACKEND. The operation was refused rather than ' +
      'falling back to passing the secret through process argv.',
  );
}

function runHelper(args, options = {}) {
  try {
    return execFileSync(KEYCHAIN_HELPER_PATH, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: KEYCHAIN_OP_TIMEOUT_MS,
      ...options,
    });
  } catch (e) {
    if (e.status === 44) return { notFound: true };
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') {
      throw new SecretStoreError(
        'KEYCHAIN_TIMEOUT',
        `macOS Keychain helper did not answer within ${KEYCHAIN_OP_TIMEOUT_MS}ms; ` +
          'refusing to hang on a keychain prompt that cannot be displayed.',
      );
    }
    throw new SecretStoreError('PERMISSION_DENIED', e.stderr || e.message);
  }
}

function keychainSet(name, value) {
  if (!keychainHelperAvailable()) throw keychainUnavailableError();
  const result = runHelper(['set', SERVICE_NAME, name], { input: value });
  if (result.notFound) throw new SecretStoreError('PERMISSION_DENIED', 'helper rejected the write');
}

function keychainGet(name) {
  if (!keychainHelperAvailable()) throw keychainUnavailableError();
  const result = runHelper(['get', SERVICE_NAME, name], { encoding: 'utf8' });
  if (result.notFound) return null;
  return result;
}

function keychainDelete(name) {
  if (!keychainHelperAvailable()) throw keychainUnavailableError();
  runHelper(['delete', SERVICE_NAME, name]);
}

function ensureFileBackendDir() {
  fs.mkdirSync(FILE_BACKEND_DIR, { recursive: true, mode: 0o700 });
}

function passEntry(name) {
  return `${SERVICE_NAME}/${encodeName(name)}`;
}

const secureCommandBackends = {
  'secret-service': {
    get(name) {
      try {
        return (
          execFileSync('secret-tool', ['lookup', 'service', SERVICE_NAME, 'account', name], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trimEnd() || null
        );
      } catch (error) {
        if (error.status === 1 && !(error.stderr || '').trim()) return null;
        throw new SecretStoreError('BACKEND_UNAVAILABLE', 'Linux Secret Service is unavailable');
      }
    },
    set(name, value) {
      try {
        execFileSync(
          'secret-tool',
          ['store', `--label=KDNA ${name}`, 'service', SERVICE_NAME, 'account', name],
          { input: value, stdio: ['pipe', 'ignore', 'pipe'] },
        );
      } catch {
        throw new SecretStoreError('PERMISSION_DENIED', 'Linux Secret Service refused the secret');
      }
    },
    delete(name) {
      try {
        execFileSync('secret-tool', ['clear', 'service', SERVICE_NAME, 'account', name], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error) {
        if (error.status !== 1)
          throw new SecretStoreError('PERMISSION_DENIED', 'Linux Secret Service refused deletion');
      }
    },
    list() {
      // Secret Service intentionally has no safe cross-collection list API.
      return [];
    },
  },
  pass: {
    get(name) {
      try {
        return (
          execFileSync('pass', ['show', passEntry(name)], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trimEnd() || null
        );
      } catch (error) {
        if (error.status === 1) return null;
        throw new SecretStoreError(
          'BACKEND_UNAVAILABLE',
          'The encrypted pass store is unavailable',
        );
      }
    },
    set(name, value) {
      try {
        execFileSync('pass', ['insert', '--multiline', '--force', passEntry(name)], {
          input: `${value}\n`,
          stdio: ['pipe', 'ignore', 'pipe'],
        });
      } catch {
        throw new SecretStoreError(
          'PERMISSION_DENIED',
          'The encrypted pass store refused the secret',
        );
      }
    },
    delete(name) {
      try {
        execFileSync('pass', ['rm', '--force', passEntry(name)], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (error) {
        if (error.status !== 1)
          throw new SecretStoreError(
            'PERMISSION_DENIED',
            'The encrypted pass store refused deletion',
          );
      }
    },
    list() {
      return [];
    },
  },
};

const backends = {
  keychain: {
    async get(name) {
      if (!keychainAvailable()) {
        throw new SecretStoreError(
          'BACKEND_UNAVAILABLE',
          'macOS Keychain backend requested but `security` CLI not available',
        );
      }
      return keychainGet(name);
    },
    async set(name, value) {
      if (!keychainAvailable()) {
        throw keychainUnavailableError();
      }
      keychainSet(name, value);
    },
    async delete(name) {
      if (!keychainAvailable()) {
        throw keychainUnavailableError();
      }
      keychainDelete(name);
    },
    async list() {
      // The `security` CLI doesn't have a clean "list items in a
      // service" command without dumping the whole keychain. Use the
      // -g (grep) form with the service name; parse the labels.
      if (!securityCliAvailable()) {
        throw new SecretStoreError('BACKEND_UNAVAILABLE', 'macOS Keychain not available');
      }
      try {
        const out = execFileSync('security', ['dump-keychain'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Each item is a series of lines, the first being
        //    "keychain: ..." (we want to skip these)
        // Entries have:
        //    "    0x... <service-name>"  (svce field) — we want 'aikdna-kdna'
        //    "    \"acct=<account-name>\"" — the value of -a (our secret name)
        const names = [];
        const lines = out.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes(`"svce"<blob>="${SERVICE_NAME}"`)) continue;
          // Search forward for the acct= field in this entry
          for (let j = i; j < Math.min(i + 50, lines.length); j++) {
            const m = lines[j].match(/"acct"<blob>="([^"]+)"/);
            if (m) {
              names.push(m[1]);
              break;
            }
            if (lines[j].includes('keychain:')) break;
          }
        }
        return names;
      } catch (e) {
        throw new SecretStoreError('PERMISSION_DENIED', e.stderr || e.message);
      }
    },
  },

  'secret-service': {
    async get(name) {
      return secureCommandBackends['secret-service'].get(name);
    },
    async set(name, value) {
      secureCommandBackends['secret-service'].set(name, value);
    },
    async delete(name) {
      secureCommandBackends['secret-service'].delete(name);
    },
    async list() {
      return secureCommandBackends['secret-service'].list();
    },
  },

  pass: {
    async get(name) {
      return secureCommandBackends.pass.get(name);
    },
    async set(name, value) {
      secureCommandBackends.pass.set(name, value);
    },
    async delete(name) {
      secureCommandBackends.pass.delete(name);
    },
    async list() {
      return secureCommandBackends.pass.list();
    },
  },

  file: {
    async get(name) {
      ensureFileBackendDir();
      const p = path.join(FILE_BACKEND_DIR, encodeName(name));
      if (!fs.existsSync(p)) return null;
      try {
        return fs.readFileSync(p, 'utf8').replace(/\n$/, '');
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw new SecretStoreError('PERMISSION_DENIED', e.message);
      }
    },
    async set(name, value) {
      ensureFileBackendDir();
      const p = path.join(FILE_BACKEND_DIR, encodeName(name));
      fs.writeFileSync(p, value + '\n', { mode: 0o600 });
    },
    async delete(name) {
      const p = path.join(FILE_BACKEND_DIR, encodeName(name));
      try {
        fs.unlinkSync(p);
      } catch (e) {
        if (e.code === 'ENOENT') return; // idempotent
        throw new SecretStoreError('PERMISSION_DENIED', e.message);
      }
    },
    async list() {
      ensureFileBackendDir();
      try {
        return fs
          .readdirSync(FILE_BACKEND_DIR)
          .filter((f) => !f.startsWith('.'))
          .map(decodeName);
      } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw new SecretStoreError('PERMISSION_DENIED', e.message);
      }
    },
  },

  env: {
    async get(name) {
      const v = process.env[name];
      return v === undefined ? null : v;
    },
    async set() {
      throw new SecretStoreError(
        'PERMISSION_DENIED',
        'env backend is read-only; inject secrets via the environment',
      );
    },
    async delete() {
      throw new SecretStoreError(
        'PERMISSION_DENIED',
        'env backend is read-only; cannot delete env vars',
      );
    },
    async list() {
      return Object.keys(process.env).filter((k) => k.startsWith('KDNA_SECRET_'));
    },
  },

  memory: {
    async get(name) {
      return memorySecrets.has(name) ? memorySecrets.get(name) : null;
    },
    async set(name, value) {
      memorySecrets.set(name, value);
    },
    async delete(name) {
      memorySecrets.delete(name);
    },
    async list() {
      return [...memorySecrets.keys()].sort();
    },
  },
};

function encodeName(name) {
  // Encode any non-alphanumeric character so the file name is
  // filesystem-safe across platforms (Windows forbids some chars).
  return name.replace(/[^a-zA-Z0-9._-]/g, (c) => '_' + c.charCodeAt(0).toString(16) + '_');
}

function decodeName(encoded) {
  return encoded.replace(/_([0-9a-f]+)_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function syncBackend() {
  const backend = pickBackend();
  if (backend === 'keychain') {
    return {
      get(name) {
        if (!keychainAvailable())
          throw keychainUnavailableError();
        return keychainGet(name);
      },
      set(name, value) {
        keychainSet(name, value);
      },
      delete(name) {
        keychainDelete(name);
      },
    };
  }
  if (backend === 'memory') {
    return {
      get: (name) => (memorySecrets.has(name) ? memorySecrets.get(name) : null),
      set: (name, value) => memorySecrets.set(name, value),
      delete: (name) => memorySecrets.delete(name),
    };
  }
  if (backend === 'secret-service' || backend === 'pass') {
    return secureCommandBackends[backend];
  }
  if (backend === 'env') {
    return {
      get: (name) => process.env[name] ?? null,
      set() {
        throw new SecretStoreError('PERMISSION_DENIED', 'env backend is read-only');
      },
      delete() {
        throw new SecretStoreError('PERMISSION_DENIED', 'env backend is read-only');
      },
    };
  }
  if (backend === 'file') {
    return {
      get(name) {
        ensureFileBackendDir();
        const p = path.join(FILE_BACKEND_DIR, encodeName(name));
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\n$/, '') : null;
      },
      set(name, value) {
        ensureFileBackendDir();
        fs.writeFileSync(path.join(FILE_BACKEND_DIR, encodeName(name)), value + '\n', {
          mode: 0o600,
        });
      },
      delete(name) {
        try {
          fs.unlinkSync(path.join(FILE_BACKEND_DIR, encodeName(name)));
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      },
    };
  }
  throw new SecretStoreError('BACKEND_UNAVAILABLE', `Unknown backend: ${backend}`);
}

async function withBackend(fn) {
  // Re-pick the backend on every call so that setting
  // KDNA_SECRET_STORE_BACKEND at runtime (e.g. in tests) takes effect.
  const backend = pickBackend();
  if (!backends[backend]) {
    throw new SecretStoreError('BACKEND_UNAVAILABLE', `Unknown backend: ${backend}`);
  }
  return fn(backends[backend]);
}

module.exports = {
  /**
   * @param {string} name — secret identifier (e.g. 'npm-token', 'openai-api-key')
   * @returns {Promise<string | null>} — the stored value, or null if not found
   */
  get(name) {
    return withBackend((b) => b.get(name));
  },

  /**
   * @param {string} name
   * @param {string} value
   * @returns {Promise<void>}
   */
  set(name, value) {
    return withBackend((b) => b.set(name, value));
  },

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  delete(name) {
    return withBackend((b) => b.delete(name));
  },

  /**
   * @returns {Promise<string[]>} — list of secret names (not values)
   */
  list() {
    return withBackend((b) => b.list());
  },

  getSync(name) {
    return syncBackend().get(name);
  },

  setSync(name, value) {
    return syncBackend().set(name, value);
  },

  deleteSync(name) {
    return syncBackend().delete(name);
  },

  backendName() {
    return pickBackend();
  },

  // Expose for tests
  _internals: {
    get backend() {
      return pickBackend();
    },
    backends,
    encodeName,
    decodeName,
    keychainAvailable,
    keychainHelperAvailable,
    securityCliAvailable,
    secretToolAvailable,
    passAvailable,
    memorySecrets,
  },

  SecretStoreError,
};
