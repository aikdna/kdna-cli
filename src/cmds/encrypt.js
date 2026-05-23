/**
 * KDNA Encryption — Encrypted container format (.kdnae) for licensed domains.
 *
 * .kdnae extends .kdna with AES-256-GCM encryption on KDNA JSON files.
 * The kdna.json manifest and license.json stay in plaintext for discovery.
 *
 * Encryption key is derived via PBKDF2 from:
 *   license_key + machine_fingerprint
 *
 * This module provides pure-crypto functions (no filesystem I/O).
 * File operations are in domain.js (pack/unpack) and install.js.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 96-bit IV for GCM
const TAG_LENGTH = 16; // 128-bit auth tag
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 600000;
const KEY_LENGTH = 32; // AES-256

// Files in a .kdna container that get encrypted (JSON content only)
const ENCRYPTED_FILES = [
  'KDNA_Core.json',
  'KDNA_Patterns.json',
  'KDNA_Scenarios.json',
  'KDNA_Cases.json',
  'KDNA_Reasoning.json',
  'KDNA_Evolution.json',
];

// Files that always stay in plaintext
const PLAINTEXT_FILES = ['kdna.json', 'license.json', 'README.md', 'LICENSE', 'signature.json'];

function isEncryptable(filename) {
  return ENCRYPTED_FILES.includes(filename);
}

// ─── Machine Fingerprint ────────────────────────────────────────────────

function machineFingerprint() {
  const os = require('os');
  const parts = [os.hostname(), os.userInfo().uid.toString(), os.platform(), os.arch()];
  // Try to get hardware UUID on macOS
  try {
    const { execSync } = require('child_process');
    if (os.platform() === 'darwin') {
      const uuid = execSync('ioreg -d2 -c IOPlatformExpertDevice | grep IOPlatformUUID', {
        encoding: 'utf8',
        timeout: 3000,
      }).match(/"[A-F0-9-]{36}"/)?.[0]?.replace(/"/g, '');
      if (uuid) parts.push(uuid);
    }
    if (os.platform() === 'linux') {
      try {
        const mid = require('fs').readFileSync('/etc/machine-id', 'utf8').trim();
        if (mid) parts.push(mid);
      } catch { /* ignore */ }
    }
  } catch { /* non-critical */ }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ─── Key Derivation ─────────────────────────────────────────────────────

function deriveKey(licenseKey, fingerprint) {
  const salt = crypto.createHash('sha256').update(fingerprint || machineFingerprint()).digest();
  return crypto.pbkdf2Sync(licenseKey, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
}

// ─── Encrypt / Decrypt ──────────────────────────────────────────────────

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv (16) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(encryptedData, key) {
  if (encryptedData.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid encrypted data: too short');
  }
  const iv = encryptedData.subarray(0, IV_LENGTH);
  const tag = encryptedData.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = encryptedData.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ─── Encrypted Container Detection ──────────────────────────────────────

function isEncryptedContainer(filePath) {
  return filePath.endsWith('.kdnae');
}

// ─── License File ──────────────────────────────────────────────────────

function createLicense(domain, options = {}) {
  const {
    issuedTo = 'licensee@example.com',
    expiresAt = null,       // ISO date or null for perpetual
    maxAgents = 1,
    requireMachineBinding = true,
    requireOnlineCheck = false,
    offlineGraceDays = 7,
  } = options;

  const license = {
    version: '1.0',
    license_id: `lic_${crypto.randomBytes(8).toString('hex')}`,
    domain,
    issued_to: issuedTo,
    issued_at: new Date().toISOString(),
    expires_at: expiresAt,
    max_agents: maxAgents,
    require_machine_binding: requireMachineBinding,
    require_online_check: requireOnlineCheck,
    offline_grace_days: offlineGraceDays,
    allowed_agents: options.allowedAgents || ['claude_code', 'codex', 'opencode'],
  };

  return license;
}

function verifyLicense(license, scopePubkey, fingerprint) {
  const issues = [];

  // Check expiration
  if (license.expires_at) {
    if (new Date(license.expires_at) < new Date()) {
      issues.push('License has expired');
    }
  }

  // Check machine binding
  if (license.require_machine_binding) {
    if (license.machine_fingerprint && license.machine_fingerprint !== fingerprint) {
      issues.push('Machine fingerprint mismatch');
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    domain: license.domain,
    license_id: license.license_id,
    issued_to: license.issued_to,
  };
}

function signLicense(license, privateKeyPem) {
  const { signature: _, ...payload } = license;
  const data = JSON.stringify(payload, Object.keys(payload).sort());
  // Use crypto.sign() for Ed25519 (supported via PEM keys)
  const sig = crypto.sign(null, Buffer.from(data), privateKeyPem);
  license.signature = `ed25519:${sig.toString('hex')}`;
  return license;
}

function verifyLicenseSignature(license, publicKeyPem) {
  const signature = license.signature?.replace('ed25519:', '') || '';
  if (!signature) return false;
  const { signature: _, ...payload } = license;
  const data = JSON.stringify(payload, Object.keys(payload).sort());
  try {
    return crypto.verify(null, Buffer.from(data), publicKeyPem, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

module.exports = {
  encrypt,
  decrypt,
  deriveKey,
  machineFingerprint,
  isEncryptable,
  isEncryptedContainer,
  createLicense,
  verifyLicense,
  signLicense,
  verifyLicenseSignature,
  ENCRYPTED_FILES,
  PLAINTEXT_FILES,
};
