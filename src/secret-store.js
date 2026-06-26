/**
 * secret-store.js — KDNA SecretStore v1 (B7)
 *
 * A cross-platform secret storage abstraction. Backends:
 *
 *   - 'keychain' (default on macOS): uses the macOS Keychain via the
 *     `security` CLI. Each secret is stored as a generic-password item
 *     under the `service` 'aikdna-kdna'. This is the recommended
 *     backend on macOS — the OS handles encryption at rest, app
 *     sandboxing, and Touch ID / AppleScript authorization.
 *
 *   - 'file' (default on Linux/Windows and CI): secrets are stored
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
 * (process.platform === 'darwin') and 'file' elsewhere.
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
 * Security note: the file backend is NOT encrypted on disk in this
 * initial implementation. It exists so that Linux/CI users can
 * exercise the SecretStore API surface. The macOS keychain backend
 * is the only fully-encrypted option. A future revision may encrypt
 * the file backend with a passphrase-derived key (Argon2id + AES-GCM).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const PATHS = require('./paths');

const SERVICE_NAME = 'aikdna-kdna';
const FILE_BACKEND_DIR = path.join(PATHS.root, 'secrets');

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
  return 'file';
}

function keychainAvailable() {
  if (os.platform() !== 'darwin') return false;
  try {
    execFileSync('which', ['security'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ensureFileBackendDir() {
  fs.mkdirSync(FILE_BACKEND_DIR, { recursive: true, mode: 0o700 });
}

const backends = {
  keychain: {
    async get(name) {
      if (!keychainAvailable()) {
        throw new SecretStoreError('BACKEND_UNAVAILABLE',
          'macOS Keychain backend requested but `security` CLI not available');
      }
      try {
        const out = execFileSync('security', [
          'find-generic-password',
          '-s', SERVICE_NAME,
          '-a', name,
          '-w',
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return out.trimEnd();
      } catch (e) {
        // security exits with code 44 when item not found
        if (e.status === 44 || /SecKeychainSearchCopyMatch/.test(e.stderr || '')) {
          return null;
        }
        throw new SecretStoreError('PERMISSION_DENIED', e.stderr || e.message);
      }
    },
    async set(name, value) {
      if (!keychainAvailable()) {
        throw new SecretStoreError('BACKEND_UNAVAILABLE', 'macOS Keychain not available');
      }
      // -U updates in place if exists, otherwise adds
      execFileSync('security', [
        'add-generic-password',
        '-a', name,
        '-s', SERVICE_NAME,
        '-w', value,
        '-U',
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    },
    async delete(name) {
      if (!keychainAvailable()) {
        throw new SecretStoreError('BACKEND_UNAVAILABLE', 'macOS Keychain not available');
      }
      try {
        execFileSync('security', [
          'delete-generic-password',
          '-a', name,
          '-s', SERVICE_NAME,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        if (e.status === 44) return; // not found → idempotent delete
        throw new SecretStoreError('PERMISSION_DENIED', e.stderr || e.message);
      }
    },
    async list() {
      // The `security` CLI doesn't have a clean "list items in a
      // service" command without dumping the whole keychain. Use the
      // -g (grep) form with the service name; parse the labels.
      if (!keychainAvailable()) {
        throw new SecretStoreError('BACKEND_UNAVAILABLE', 'macOS Keychain not available');
      }
      try {
        const out = execFileSync('security', [
          'dump-keychain',
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
            if (m) { names.push(m[1]); break; }
            if (lines[j].includes('keychain:')) break;
          }
        }
        return names;
      } catch (e) {
        throw new SecretStoreError('PERMISSION_DENIED', e.stderr || e.message);
      }
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
        return fs.readdirSync(FILE_BACKEND_DIR)
          .filter(f => !f.startsWith('.'))
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
      throw new SecretStoreError('PERMISSION_DENIED',
        'env backend is read-only; inject secrets via the environment');
    },
    async delete() {
      throw new SecretStoreError('PERMISSION_DENIED',
        'env backend is read-only; cannot delete env vars');
    },
    async list() {
      return Object.keys(process.env).filter(k => k.startsWith('KDNA_SECRET_'));
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

const activeBackend = pickBackend();

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
  get(name) { return withBackend(b => b.get(name)); },

  /**
   * @param {string} name
   * @param {string} value
   * @returns {Promise<void>}
   */
  set(name, value) { return withBackend(b => b.set(name, value)); },

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  delete(name) { return withBackend(b => b.delete(name)); },

  /**
   * @returns {Promise<string[]>} — list of secret names (not values)
   */
  list() { return withBackend(b => b.list()); },

  // Expose for tests
  _internals: {
    get backend() { return pickBackend(); },
    backends,
    encodeName,
    decodeName,
    keychainAvailable,
  },

  SecretStoreError,
};
