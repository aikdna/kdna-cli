// KDNA Key Derivation Parameters — canonical reference
// Per RFC-0008 and RFC-0009, these parameters MUST be used for all KDF operations.

const core = require('@aikdna/kdna-core');

const IDENTITY_BACKUP_PROFILE = 'kdna.encryption.identity-backup';
const KDF_PARAMS = {
  [core.PASSWORD_PROTECTED_PROFILE]: {
    algorithm: 'Argon2id',
    version: 0x13,
    memoryCostKiB: 65536, // 64 MiB
    timeCost: 3, // 3 iterations
    parallelism: 4, // 4 lanes
    saltLength: 32, // 256-bit random salt
    hashLength: 32, // 256-bit derived key
    tagLength: 16, // AES-256-GCM authentication tag
  },
  [core.LICENSED_ENTRY_PROFILE]: {
    algorithm: 'HKDF-SHA256',
    info: core.LICENSED_ENTRY_PROFILE,
    salt: null, // No salt — deterministic from master key
    keyLength: 32, // 256-bit AES key
    wrapAlgorithm: 'AES-256-KW',
    wireTagSize: 16, // Tag prepended to ciphertext in wire format
    contentEncryption: 'AES-256-GCM',
  },
  [IDENTITY_BACKUP_PROFILE]: {
    algorithm: 'PBKDF2-SHA256',
    iterations: 100000,
    keyLength: 32, // 256-bit AES key
    ivLength: 16, // 128-bit random IV
    encryption: 'AES-256-CBC',
  },
};

function validateParameters(profile) {
  const params = KDF_PARAMS[profile];
  if (!params)
    throw new Error(
      `Unknown KDF profile: ${profile}. Valid: ${Object.keys(KDF_PARAMS).join(', ')}`,
    );
  return params;
}

module.exports = { IDENTITY_BACKUP_PROFILE, KDF_PARAMS, validateParameters };
