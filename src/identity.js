/**
 * KDNA Identity — Ed25519 key pair management + asset sign/verify (Story 19)
 *
 * Commands (top-level in cli.js; subcommand dispatch in cmds/identity.js):
 *   identity init                     Generate Ed25519 key pair
 *   identity show [--json]            Display public key in PEM, hex, and base64
 *   identity export [--out <file>]    Backup private key (passphrase-encrypted)
 *   identity import <file>            Restore from backup
 *
 * Top-level commands:
 *   sign <asset> [--sig <path>]      Detached Ed25519 signature over the asset digest
 *   verify <asset> [--key <path>]     Verify the signature against a public key
 *
 * Design contract (Story 19 brief + RFC-0018 R4.3 cross-reference):
 *   - Each author generates their own key pair. The CLI never registers the
 *     key with a central authority. KDNA Inc. holds NO private keys.
 *   - Consumers decide trust. The CLI never says "official", "trusted",
 *     "verified", or "recommended" about a signed asset. It only says
 *     "signature is cryptographically valid against key X" — what to do
 *     with that fact is the consumer's decision.
 *   - The signature is detached. It is written alongside the asset
 *     (<asset>.ed25519.sig by default) and does not modify the .kdna
 *     container in place.
 *   - The signature covers kdna.json + payload.kdnab + checksums.json (if
 *     present). Deterministic per-file SHA-256 then a final SHA-256 over
 *     the three digests concatenated. This is the asset digest.
 *   - No new npm dependencies. Uses Node.js built-in crypto.
 *
 * Story 19 closes the identity layer. The next story (Story 20) is
 * revocation lifecycle, which depends on this signature primitive but
 * does not modify it.
 *
 * Path migration (Story 19):
 *   The pre-Story-19 path was `~/.kdna/identity/kdna.{key,pub}`.
 *   The new path is `~/.kdna/keys/ed25519.{key,pub}`. Backward compat:
 *   `init` checks the old path FIRST. If an old key exists, it is
 *   NOT overwritten; the user is told to run `kdna identity export`
 *   + re-import, or to remove the old directory. The new path is
 *   used for all new identities and all sign/verify operations.
 *
 * `KDNA_IDENTITY_DIR` env var still overrides the directory for
 * CI / test purposes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EXIT } = require('./cmds/_common');

const IDENTITY_DIR =
  process.env.KDNA_IDENTITY_DIR ||
  path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna', 'keys');

const OLD_IDENTITY_DIR =
  process.env.KDNA_OLD_IDENTITY_DIR ||
  path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna', 'identity');

const PRIVATE_KEY_PATH = path.join(IDENTITY_DIR, 'ed25519.key');
const PUBLIC_KEY_PATH = path.join(IDENTITY_DIR, 'ed25519.pub');

const SIGNATURE_ALG = 'ed25519';
const SIGNATURE_VERSION = '1';
const SIGNATURE_SUFFIX = '.ed25519.sig';

function error(msg, code = EXIT.VALIDATION_FAILED) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

// ─── Key Generation ────────────────────────────────────────────────────

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

function deriveBuyerId(publicKeyPem) {
  return crypto.createHash('sha256').update(publicKeyPem).digest('hex').substring(0, 16);
}

function fingerprint(publicKeyPem) {
  return crypto.createHash('sha256').update(publicKeyPem).digest('hex').substring(0, 12);
}

/**
 * Extract the raw 32-byte Ed25519 public key from a SPKI PEM.
 * Returns a Buffer of length 32.
 */
function rawPublicKey(publicKeyPem) {
  const keyObj = crypto.createPublicKey({
    key: publicKeyPem,
    format: 'pem',
    type: 'spki',
  });
  const der = keyObj.export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI wraps the raw 32-byte key with a 12-byte algorithm header.
  // The raw key is the last 32 bytes of the SPKI DER.
  return Buffer.from(der.subarray(der.length - 32));
}

// ─── Init / Show / Export / Import ─────────────────────────────────────

function cmdIdentityInit() {
  if (fs.existsSync(PRIVATE_KEY_PATH)) {
    const pub = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
    const id = deriveBuyerId(pub);
    const fp = fingerprint(pub);
    const hex = rawPublicKey(pub).toString('hex');
    const b64 = rawPublicKey(pub).toString('base64');
    console.log(`Identity already exists.`);
    console.log(`  Buyer ID:           ${id}`);
    console.log(`  Fingerprint:        ${fp}`);
    console.log(`  Public key (hex):   ${hex}`);
    console.log(`  Public key (b64):   ${b64}`);
    console.log(`  Public key (PEM):   ${PUBLIC_KEY_PATH}`);
    console.log(`  Private key:        ${PRIVATE_KEY_PATH} (chmod 600)`);
    return;
  }

  // Backward compat: if an old-style identity exists in ~/.kdna/identity/,
  // refuse to overwrite silently. The user must export + re-init explicitly.
  const oldPriv = path.join(OLD_IDENTITY_DIR, 'kdna.key');
  const oldPub = path.join(OLD_IDENTITY_DIR, 'kdna.pub');
  if (fs.existsSync(oldPriv) || fs.existsSync(oldPub)) {
    console.error(`An older-style identity exists at ${OLD_IDENTITY_DIR}.`);
    console.error(`Story 19 uses the new path ${IDENTITY_DIR}.`);
    console.error(`To migrate, run:  kdna identity export --out backup.age`);
    console.error(`Then remove the old directory and run:  kdna identity init`);
    process.exit(EXIT.INPUT_ERROR);
  }

  fs.mkdirSync(IDENTITY_DIR, { recursive: true, mode: 0o700 });

  const { publicKey, privateKey } = generateKeyPair();

  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, { mode: 0o644 });

  const id = deriveBuyerId(publicKey);
  const fp = fingerprint(publicKey);
  const hex = rawPublicKey(publicKey).toString('hex');
  const b64 = rawPublicKey(publicKey).toString('base64');

  console.log(`Identity created.`);
  console.log(`  Buyer ID:           ${id}`);
  console.log(`  Fingerprint:        ${fp}`);
  console.log(`  Public key (hex):   ${hex}`);
  console.log(`  Public key (b64):   ${b64}`);
  console.log(`  Public key (PEM):   ${PUBLIC_KEY_PATH}`);
  console.log(`  Private key:        ${PRIVATE_KEY_PATH} (chmod 600)`);
  console.log(``);
  console.log(`  Backup your private key immediately:`);
  console.log(`    kdna identity export --out kdna-identity-backup.age`);
}

function cmdIdentityShow(jsonMode = false) {
  if (!fs.existsSync(PUBLIC_KEY_PATH)) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: 'No identity found. Run: kdna identity init' }));
      process.exit(EXIT.INPUT_ERROR);
    }
    error('No identity found. Run: kdna identity init', EXIT.INPUT_ERROR);
  }

  const pub = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
  const id = deriveBuyerId(pub);
  const fp = fingerprint(pub);
  const raw = rawPublicKey(pub);
  const hex = raw.toString('hex');
  const b64 = raw.toString('base64');

  if (jsonMode) {
    console.log(
      JSON.stringify({
        algorithm: SIGNATURE_ALG,
        pubkey_pem: pub.trim(),
        pubkey_hex: hex,
        pubkey_base64: b64,
        buyer_id: id,
        fingerprint: fp,
        public_key_path: PUBLIC_KEY_PATH,
        private_key_exists: fs.existsSync(PRIVATE_KEY_PATH),
      }),
    );
    process.exit(EXIT.OK);
  }

  console.log(`Buyer ID:           ${id}`);
  console.log(`Fingerprint:        ${fp}`);
  console.log(`Public key (hex):   ${hex}`);
  console.log(`Public key (b64):   ${b64}`);
  console.log(`Public key (PEM):   ${PUBLIC_KEY_PATH}`);
  console.log(
    `Private key:        ${PRIVATE_KEY_PATH} ${fs.existsSync(PRIVATE_KEY_PATH) ? '(exists)' : '(MISSING!)'}`,
  );
}

function cmdIdentityExport(outFile) {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    error('No private key found. Run: kdna identity init');
  }

  const outPath = path.resolve(outFile || 'kdna-identity-backup.age');
  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  rl.question('Enter passphrase (or leave empty to abort): ', (passphrase) => {
    rl.close();
    if (!passphrase) {
      console.log('Aborted.');
      process.exit(0);
    }

    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

    const header = JSON.stringify({
      alg: 'pbkdf2+aes-256-cbc',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
    });
    const headerB64 = Buffer.from(header).toString('base64');

    const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);

    const output = `-----BEGIN KDNA IDENTITY BACKUP-----\n${headerB64}\n${encrypted.toString('base64')}\n-----END KDNA IDENTITY BACKUP-----\n`;

    fs.writeFileSync(outPath, output, { mode: 0o600 });
    console.log(`Identity exported to: ${outPath}`);
    console.log(`  Keep this file safe. It is encrypted with your passphrase.`);
    process.exit(0);
  });
}

function cmdIdentityImport(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) error(`File not found: ${abs}`);

  const content = fs.readFileSync(abs, 'utf8');
  const match = content.match(
    /-----BEGIN KDNA IDENTITY BACKUP-----\n(.+?)\n(.+?)\n-----END KDNA IDENTITY BACKUP-----/s,
  );
  if (!match) error('Invalid backup file format.');

  const header = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  if (header.alg !== 'pbkdf2+aes-256-cbc') error(`Unsupported algorithm: ${header.alg}`);

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  rl.question('Enter passphrase: ', (passphrase) => {
    rl.close();
    if (!passphrase) {
      console.log('Aborted.');
      process.exit(0);
    }

    const salt = Buffer.from(header.salt, 'base64');
    const iv = Buffer.from(header.iv, 'base64');
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

    try {
      const encrypted = Buffer.from(match[2], 'base64');
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
        'utf8',
      );

      fs.mkdirSync(IDENTITY_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(PRIVATE_KEY_PATH, decrypted, { mode: 0o600 });

      const privateKeyObj = crypto.createPrivateKey({
        key: decrypted,
        format: 'pem',
        type: 'pkcs8',
      });
      const publicKey = crypto
        .createPublicKey(privateKeyObj)
        .export({ type: 'spki', format: 'pem' });
      fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, { mode: 0o644 });

      const id = deriveBuyerId(publicKey);
      console.log(`Identity restored.`);
      console.log(`  Buyer ID:  ${id}`);
    } catch {
      console.log('Error: Incorrect passphrase or corrupted backup.');
      process.exit(1);
    }
    process.exit(0);
  });
}

// ─── Sign / Verify (Story 19) ──────────────────────────────────────────

/**
 * Load the asset's protected entries (kdna.json, payload.kdnab,
 * checksums.json) into a Buffer concatenation of SHA-256 digests.
 *
 * Supports both .kdna containers and v1 source directories. The
 * signature is bound to the *content* of these three entries, not
 * to the container format. Same content → same digest → same
 * signature regardless of whether the asset is shipped as a
 * .kdna zip or a source dir.
 *
 * @param {string} abs - absolute path to the asset
 * @returns {{
 *   kind: 'container' | 'source-dir',
 *   kdnaJson: Buffer,
 *   payload: Buffer,
 *   checksums: Buffer|null,
 *   assetDigestHex: string,
 *   assetDigestBytes: Buffer
 * }}
 */
function loadAssetForSigning(abs) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`asset path not found: ${abs}`);
  }

  let kdnaJson = null;
  let payload = null;
  let checksums = null;
  let kind;

  if (stat.isDirectory()) {
    kind = 'source-dir';
    const kdnaPath = path.join(abs, 'kdna.json');
    const payloadPath = path.join(abs, 'payload.kdnab');
    const checksumsPath = path.join(abs, 'checksums.json');
    if (!fs.existsSync(kdnaPath)) throw new Error(`source dir missing kdna.json: ${abs}`);
    if (!fs.existsSync(payloadPath)) throw new Error(`source dir missing payload.kdnab: ${abs}`);
    kdnaJson = fs.readFileSync(kdnaPath);
    payload = fs.readFileSync(payloadPath);
    if (fs.existsSync(checksumsPath)) checksums = fs.readFileSync(checksumsPath);
  } else if (stat.isFile()) {
    kind = 'container';
    // Use core's reader to extract entries.
    // Lazy import: keep this file usable without core (e.g. tests can
    // mock the path).
    let core;
    try {
      core = require('@aikdna/kdna-core');
    } catch (e) {
      throw new Error(`Cannot load @aikdna/kdna-core: ${e.message}`);
    }
    if (typeof core.readV1Layout !== 'function') {
      throw new Error('@aikdna/kdna-core does not export readV1Layout');
    }
    const layout = core.readV1Layout(abs);
    if (!layout || !layout.map) throw new Error(`unreadable .kdna container: ${abs}`);
    if (!layout.map['kdna.json']) throw new Error(`.kdna container missing kdna.json: ${abs}`);
    if (!layout.map['payload.kdnab'])
      throw new Error(`.kdna container missing payload.kdnab: ${abs}`);
    kdnaJson = layout.map['kdna.json'];
    payload = layout.map['payload.kdnab'];
    if (layout.map['checksums.json']) checksums = layout.map['checksums.json'];
  } else {
    throw new Error(`asset path is neither file nor directory: ${abs}`);
  }

  // Compute the asset digest: SHA-256 of the three per-file digests
  // concatenated in a deterministic order. checksums is replaced with
  // an all-zero hash of the same length when absent (so the digest
  // shape is the same regardless of presence).
  const dKdna = crypto.createHash('sha256').update(kdnaJson).digest();
  const dPayload = crypto.createHash('sha256').update(payload).digest();
  const dChecksums = checksums
    ? crypto.createHash('sha256').update(checksums).digest()
    : Buffer.alloc(32, 0);

  const assetDigest = crypto
    .createHash('sha256')
    .update(Buffer.concat([dKdna, dPayload, dChecksums]))
    .digest();

  return {
    kind,
    kdnaJson,
    payload,
    checksums,
    assetDigestHex: `sha256:${assetDigest.toString('hex')}`,
    assetDigestBytes: assetDigest,
  };
}

/**
 * Sign an asset with the local Ed25519 key. Writes a detached
 * signature to <asset>.ed25519.sig (or --sig <path>).
 *
 * @param {string} assetPath - absolute path to .kdna container or v1 source dir
 * @param {object} [opts]
 * @param {string} [opts.sigPath] - override the default signature file path
 * @param {boolean} [opts.json]   - emit JSON output (for tooling)
 * @returns {{
 *   sigPath: string,
 *   fingerprint: string,
 *   assetDigest: string,
 *   publicKeyHex: string,
 *   publicKeyBase64: string,
 *   signatureBase64: string
 * }}
 */
function signAsset(assetPath, opts = {}) {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    throw new Error('No identity found. Run: kdna identity init');
  }
  const privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  const privateKeyObj = crypto.createPrivateKey({
    key: privateKeyPem,
    format: 'pem',
    type: 'pkcs8',
  });
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);
  const publicKeyPem = publicKeyObj.export({ type: 'spki', format: 'pem' });
  const publicKeyRaw = rawPublicKey(publicKeyPem);

  const fp = fingerprint(publicKeyPem);

  const loaded = loadAssetForSigning(assetPath);
  // Ed25519 in Node.js signs arbitrary bytes (the message). We sign
  // the asset digest bytes directly — equivalent to signing the
  // canonical serialization "kdna-envelope-aead-v1\n<digest>" but
  // simpler and just as verifiable.
  const sigBytes = crypto.sign(null, loaded.assetDigestBytes, privateKeyObj);

  // Default signature path: <asset>.ed25519.sig
  let sigPath = opts.sigPath;
  if (!sigPath) {
    sigPath = `${assetPath}${SIGNATURE_SUFFIX}`;
  }

  const sigRecord = {
    version: SIGNATURE_VERSION,
    algorithm: SIGNATURE_ALG,
    asset_path: assetPath,
    asset_kind: loaded.kind,
    public_key_fingerprint: fp,
    public_key_hex: publicKeyRaw.toString('hex'),
    public_key_base64: publicKeyRaw.toString('base64'),
    asset_digest: loaded.assetDigestHex,
    asset_digest_inputs: {
      kdna_json_sha256: crypto.createHash('sha256').update(loaded.kdnaJson).digest('hex'),
      payload_kdnab_sha256: crypto.createHash('sha256').update(loaded.payload).digest('hex'),
      checksums_json_sha256: loaded.checksums
        ? crypto.createHash('sha256').update(loaded.checksums).digest('hex')
        : null,
    },
    signed_at: new Date().toISOString(),
    signature_base64: sigBytes.toString('base64'),
  };

  fs.writeFileSync(sigPath, JSON.stringify(sigRecord, null, 2) + '\n', { mode: 0o644 });

  return {
    sigPath,
    fingerprint: fp,
    assetDigest: loaded.assetDigestHex,
    publicKeyHex: publicKeyRaw.toString('hex'),
    publicKeyBase64: publicKeyRaw.toString('base64'),
    signatureBase64: sigBytes.toString('base64'),
    sigRecord,
  };
}

/**
 * Load and validate a signature record. Returns the parsed JSON
 * object or throws. The signature is a JSON document; we do not
 * trust the fields until we have verified the Ed25519 signature
 * itself.
 */
function loadSignature(sigPath) {
  if (!fs.existsSync(sigPath)) {
    throw new Error(`signature file not found: ${sigPath}`);
  }
  const raw = fs.readFileSync(sigPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`signature file is not valid JSON: ${e.message}`);
  }
  if (parsed.algorithm !== SIGNATURE_ALG) {
    throw new Error(
      `unsupported signature algorithm: ${parsed.algorithm} (expected ${SIGNATURE_ALG})`,
    );
  }
  if (!parsed.signature_base64 || !parsed.asset_digest) {
    throw new Error('signature record missing required fields (signature_base64, asset_digest)');
  }
  return parsed;
}

/**
 * Verify a signature against an asset, optionally using a provided
 * public key file. Returns a result object.
 *
 * @param {string} assetPath
 * @param {object} [opts]
 * @param {string} [opts.keyPath] - path to a PEM public key file
 * @param {string} [opts.sigPath] - override default signature path
 * @returns {{
 *   status: 'valid' | 'invalid' | 'no-key' | 'error',
 *   reason: string,
 *   assetDigest: string,
 *   signerPublicKeyHex: string,
 *   signerPublicKeyBase64: string,
 *   fingerprint: string,
 *   keyFingerprint: string|null,
 *   sigPath: string
 * }}
 */
function verifyAsset(assetPath, opts = {}) {
  let sigPath = opts.sigPath;
  if (!sigPath) {
    sigPath = `${assetPath}${SIGNATURE_SUFFIX}`;
  }
  if (!fs.existsSync(sigPath)) {
    return {
      status: 'error',
      reason: `signature file not found: ${sigPath}`,
      assetDigest: null,
      signerPublicKeyHex: null,
      signerPublicKeyBase64: null,
      fingerprint: null,
      keyFingerprint: null,
      sigPath,
    };
  }

  const sigRecord = loadSignature(sigPath);

  // Re-compute the asset digest and verify it matches the recorded digest.
  const loaded = loadAssetForSigning(assetPath);
  if (loaded.assetDigestHex !== sigRecord.asset_digest) {
    return {
      status: 'invalid',
      reason:
        `asset has been modified after signing\n` +
        `  recorded:   ${sigRecord.asset_digest}\n` +
        `  recomputed: ${loaded.assetDigestHex}`,
      assetDigest: loaded.assetDigestHex,
      signerPublicKeyHex: sigRecord.public_key_hex,
      signerPublicKeyBase64: sigRecord.public_key_base64,
      fingerprint: sigRecord.public_key_fingerprint,
      keyFingerprint: null,
      sigPath,
    };
  }

  // No key provided: surface the signer's pubkey. Trust is the
  // consumer's decision, not the CLI's. Story 20: also surface
  // the revocation info (informational; without --key the
  // exit code stays at 2 per the work-package contract).
  if (!opts.keyPath) {
    const revocation = checkRevocationForVerification(assetPath, sigRecord, opts);
    return {
      status: 'no-key',
      reason: 'no key provided; cannot determine trust',
      assetDigest: loaded.assetDigestHex,
      signerPublicKeyHex: sigRecord.public_key_hex,
      signerPublicKeyBase64: sigRecord.public_key_base64,
      fingerprint: sigRecord.public_key_fingerprint,
      keyFingerprint: null,
      sigPath,
      revocation: revocation
        ? {
            status: 'valid',
            revocation_path: revocation.revocationPath,
            revoked_at: revocation.record.revoked_at,
            reason: revocation.record.reason,
            fingerprint: revocation.record.fingerprint,
          }
        : null,
    };
  }

  if (!fs.existsSync(opts.keyPath)) {
    return {
      status: 'error',
      reason: `public key file not found: ${opts.keyPath}`,
      assetDigest: loaded.assetDigestHex,
      signerPublicKeyHex: sigRecord.public_key_hex,
      signerPublicKeyBase64: sigRecord.public_key_base64,
      fingerprint: sigRecord.public_key_fingerprint,
      keyFingerprint: null,
      sigPath,
    };
  }

  const keyRaw = fs.readFileSync(opts.keyPath, 'utf8');
  let publicKeyObj;
  try {
    publicKeyObj = crypto.createPublicKey({
      key: keyRaw,
      format: detectKeyFormat(keyRaw),
      type: 'spki',
    });
  } catch (e) {
    return {
      status: 'error',
      reason: `failed to parse public key: ${e.message}`,
      assetDigest: loaded.assetDigestHex,
      signerPublicKeyHex: sigRecord.public_key_hex,
      signerPublicKeyBase64: sigRecord.public_key_base64,
      fingerprint: sigRecord.public_key_fingerprint,
      keyFingerprint: null,
      sigPath,
    };
  }

  const sigBytes = Buffer.from(sigRecord.signature_base64, 'base64');
  const ok = crypto.verify(null, loaded.assetDigestBytes, publicKeyObj, sigBytes);
  const providedKeyPem = publicKeyObj.export({ type: 'spki', format: 'pem' });
  const providedKeyFp = fingerprint(providedKeyPem);

  if (!ok) {
    return {
      status: 'invalid',
      reason: 'signature does not verify against the provided public key',
      assetDigest: loaded.assetDigestHex,
      signerPublicKeyHex: sigRecord.public_key_hex,
      signerPublicKeyBase64: sigRecord.public_key_base64,
      fingerprint: sigRecord.public_key_fingerprint,
      keyFingerprint: providedKeyFp,
      sigPath,
    };
  }

  // Signature is cryptographically valid against the provided
  // key. Now check Story 20 revocation: was this signature
  // revoked by its author?
  const revocation = checkRevocationForVerification(assetPath, sigRecord, opts);
  if (revocation) {
    return {
      status: 'revoked',
      reason: 'signature was revoked by its author',
      assetDigest: loaded.assetDigestHex,
      signerPublicKeyHex: sigRecord.public_key_hex,
      signerPublicKeyBase64: sigRecord.public_key_base64,
      fingerprint: sigRecord.public_key_fingerprint,
      keyFingerprint: providedKeyFp,
      sigPath,
      revocation: {
        status: 'valid',
        revocation_path: revocation.revocationPath,
        revoked_at: revocation.record.revoked_at,
        reason: revocation.record.reason,
        fingerprint: revocation.record.fingerprint,
      },
    };
  }

  return {
    status: 'valid',
    reason: 'signature verifies',
    assetDigest: loaded.assetDigestHex,
    signerPublicKeyHex: sigRecord.public_key_hex,
    signerPublicKeyBase64: sigRecord.public_key_base64,
    fingerprint: sigRecord.public_key_fingerprint,
    keyFingerprint: providedKeyFp,
    sigPath,
    revocation: revocation
      ? {
          status: 'valid',
          revocation_path: revocation.revocationPath,
          revoked_at: revocation.record.revoked_at,
          reason: revocation.record.reason,
          fingerprint: revocation.record.fingerprint,
        }
      : null,
  };
}

function detectKeyFormat(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('-----BEGIN ')) return 'pem';
  // Assume base64 SPKI DER otherwise.
  return 'der';
}

// ─── Revocation (Story 20) ───────────────────────────────────────────────

const REVOCATION_RELATIVE_PATH = path.join('signatures', 'revocation.ed25519.json');
const REVOCATION_VERSION = '1';

// Ed25519 SubjectPublicKeyInfo (SPKI) DER prefix. The full SPKI
// is 12 bytes of DER header followed by the 32-byte raw public
// key. We use this to reconstruct a full SPKI from the raw 32
// bytes that Story 19 stores in signature records (and that we
// also store in revocation records) so verification can import
// it as a public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawPublicKeyToSpkiDer(rawPubKey) {
  if (!Buffer.isBuffer(rawPubKey)) rawPubKey = Buffer.from(rawPubKey);
  if (rawPubKey.length !== 32) {
    throw new Error(`expected 32-byte raw Ed25519 public key, got ${rawPubKey.length}`);
  }
  return Buffer.concat([ED25519_SPKI_PREFIX, rawPubKey]);
}

/**
 * Deterministic JSON serialization for signing. Object keys are
 * sorted lexicographically; arrays preserve their order. This is
 * the same approach the v1 spec uses for content digests.
 */
function STABLE_STRINGIFY(value) {
  if (Array.isArray(value)) {
    return `[${value.map(STABLE_STRINGIFY).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${STABLE_STRINGIFY(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compute the canonical revocation-record default path for an
 * asset. Same rule for source dirs and .kdna files: the path is
 * `<asset-base>/signatures/revocation.ed25519.json`. For a
 * .kdna file, the base is the file's "sibling dir" — i.e. the
 * directory next to `<file>.signatures/`. For a source dir, the
 * base is the dir itself.
 */
function revocationPathFor(assetPath) {
  let stat;
  try {
    stat = fs.statSync(assetPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    return path.join(assetPath, REVOCATION_RELATIVE_PATH);
  }
  if (stat.isFile()) {
    // For a file, put `signatures/` next to the file. e.g.
    // /path/to/asset.kdna → /path/to/asset.kdna.signatures/
    return `${assetPath}.${REVOCATION_RELATIVE_PATH}`;
  }
  return null;
}

/**
 * Compute the SHA-256 of a buffer and return `sha256:<hex>`.
 */
function sha256Tagged(buf) {
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
}

/**
 * Sign a revocation record. Returns the revocation record (a
 * plain object) and writes it to the canonical revocation path
 * for the asset. The signature is over the canonical JSON
 * serialization of the body (everything except signature_base64).
 *
 * Reuses Story 19 primitives:
 *   - loadAssetForSigning (asset digest)
 *   - rawPublicKey (32-byte public key extraction)
 *   - fingerprint (12-char key fingerprint)
 *   - crypto.sign / crypto.verify (Ed25519)
 *
 * Story 20 design contract (from the work package):
 *   1. Author revokes own signature. The revocation is signed
 *      with the author's private key.
 *   2. Revocation is additive. The .ed25519.sig file is NOT
 *      deleted or modified.
 *   3. The CLI never says "official", "trusted", "verified", or
 *      "recommended". The CLI just says "signature was revoked
 *      by its author" with the reason (if any). What the
 *      consumer does with that information is the consumer's
 *      decision.
 *   4. No central revocation authority. Revocation is local;
 *      anyone with the author's public key can verify that the
 *      revocation was signed by the same key.
 *
 * @param {string} assetPath - absolute path to the asset
 * @param {object} [opts]
 * @param {string} [opts.reason] - optional human-readable reason
 * @param {string} [opts.revocationPath] - override the default
 *   revocation file path
 * @param {boolean} [opts.force] - overwrite an existing
 *   revocation file (default: refuse)
 * @returns {{
 *   revocationPath: string,
 *   revocationRecord: object,
 *   fingerprint: string,
 *   assetDigest: string
 * }}
 */
function signRevocation(assetPath, opts = {}) {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    throw new Error('No identity found. Run: kdna identity init');
  }
  if (!fs.existsSync(assetPath)) {
    throw new Error(`asset path not found: ${assetPath}`);
  }

  // The .ed25519.sig file must already exist. The revocation
  // references it; without a signature there is nothing to revoke.
  const sigPath = opts.sigPath || `${assetPath}${SIGNATURE_SUFFIX}`;
  if (!fs.existsSync(sigPath)) {
    throw new Error(
      `signature file not found: ${sigPath}\n` +
        `Run: kdna sign ${assetPath}  before:  kdna revoke ${assetPath}`,
    );
  }
  const sigRecord = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
  if (sigRecord.algorithm !== SIGNATURE_ALG) {
    throw new Error(
      `unsupported signature algorithm: ${sigRecord.algorithm} (expected ${SIGNATURE_ALG})`,
    );
  }

  // Determine the revocation output path
  const revocationPath = opts.revocationPath || revocationPathFor(assetPath);
  if (!revocationPath) {
    throw new Error(`cannot determine revocation path for ${assetPath}`);
  }
  if (fs.existsSync(revocationPath) && !opts.force) {
    throw new Error(
      `revocation file already exists: ${revocationPath}\n` +
        `Use --force to overwrite (the old revocation is destroyed).`,
    );
  }

  // Author keys (from ~/.kdna/keys/)
  const privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  const privateKeyObj = crypto.createPrivateKey({
    key: privateKeyPem,
    format: 'pem',
    type: 'pkcs8',
  });
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);
  const publicKeyPem = publicKeyObj.export({ type: 'spki', format: 'pem' });
  const publicKeyRaw = rawPublicKey(publicKeyPem);
  const fp = fingerprint(publicKeyPem);

  // Cross-check: the signature file's claimed public key MUST
  // match the local identity. Otherwise, the user is trying to
  // revoke a signature that wasn't theirs to begin with.
  if (sigRecord.public_key_hex !== publicKeyRaw.toString('hex')) {
    throw new Error(
      `the .ed25519.sig file at ${sigPath} was not signed by the\n` +
        `local identity (public key mismatch). Only the original\n` +
        `author can revoke a signature. To revoke a foreign\n` +
        `signature, the original author's private key must be loaded.`,
    );
  }

  // Compute the digest of the .ed25519.sig file (this is what
  // binds the revocation to the specific sig, not just to the
  // author key). If the author re-signs later, the new sig has
  // a different digest and the old revocation does not apply.
  const sigBytes = fs.readFileSync(sigPath);
  const revokedSigDigest = sha256Tagged(sigBytes);

  // Re-compute the asset digest at revocation time. If the
  // asset has changed since the original signature, the
  // revocation's asset_digest will differ from the sig's, and
  // verify will catch that.
  const loaded = loadAssetForSigning(assetPath);

  // Build the revocation body (canonical shape, sorted keys
  // when serialized).
  const body = {
    version: REVOCATION_VERSION,
    revoked_signature_path: sigPath,
    revoked_signature_digest: revokedSigDigest,
    asset_path: assetPath,
    asset_kind: loaded.kind,
    asset_digest: loaded.assetDigestHex,
    asset_digest_inputs: {
      kdna_json_sha256: crypto.createHash('sha256').update(loaded.kdnaJson).digest('hex'),
      payload_kdnab_sha256: crypto.createHash('sha256').update(loaded.payload).digest('hex'),
      checksums_json_sha256: loaded.checksums
        ? crypto.createHash('sha256').update(loaded.checksums).digest('hex')
        : null,
    },
    public_key_hex: publicKeyRaw.toString('hex'),
    public_key_base64: publicKeyRaw.toString('base64'),
    fingerprint: fp,
    revoked_at: new Date().toISOString(),
    reason: opts.reason || null,
  };

  // Sign the canonical body. The signature is over the body
  // bytes, NOT over the record (which contains the signature
  // itself — that would be circular). The body is the
  // authorization claim; the signature proves it came from the
  // holder of `public_key_hex`.
  const bodyBytes = Buffer.from(STABLE_STRINGIFY(body), 'utf8');
  const sigOfBody = crypto.sign(null, bodyBytes, privateKeyObj);

  const record = {
    ...body,
    signature_base64: sigOfBody.toString('base64'),
  };

  // Make sure the parent directory exists (for .kdna files,
  // the parent is a sibling dir like `<file>.signatures/`).
  fs.mkdirSync(path.dirname(revocationPath), { recursive: true });
  fs.writeFileSync(revocationPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o644 });

  return {
    revocationPath,
    revocationRecord: record,
    fingerprint: fp,
    assetDigest: loaded.assetDigestHex,
  };
}

/**
 * Load a revocation record. Returns the parsed record or null
 * if no revocation file exists at the canonical path. Throws
 * on file exists but malformed.
 */
function loadRevocation(assetPath, opts = {}) {
  const revocationPath = opts.revocationPath || revocationPathFor(assetPath);
  if (!revocationPath || !fs.existsSync(revocationPath)) {
    return { revocationPath: revocationPath || null, record: null };
  }
  let raw;
  try {
    raw = fs.readFileSync(revocationPath, 'utf8');
  } catch (e) {
    throw new Error(`failed to read revocation file: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`revocation file is not valid JSON: ${e.message}`);
  }
  if (parsed.algorithm && parsed.algorithm !== SIGNATURE_ALG) {
    throw new Error(
      `unsupported revocation algorithm: ${parsed.algorithm} (expected ${SIGNATURE_ALG})`,
    );
  }
  if (parsed.version !== REVOCATION_VERSION) {
    throw new Error(
      `unsupported revocation version: ${parsed.version} (expected ${REVOCATION_VERSION})`,
    );
  }
  return { revocationPath, record: parsed };
}

/**
 * Verify a revocation record. The revocation is valid if:
 *   1. The revocation record is well-formed (loadRevocation).
 *   2. The revocation's signature verifies against the
 *      `public_key_hex` declared in the record body.
 *   3. The `public_key_hex` matches the local identity (so the
 *      caller knows the revocation was signed by the same key
 *      that signed the original).
 *   4. The `asset_digest` matches the current asset (or the
 *      caller can compare it themselves).
 *   5. The `revoked_signature_digest` matches the current
 *      .ed25519.sig file (so the revocation binds to the
 *      specific sig, not just to the asset).
 *
 * Returns an object with `status` (one of 'valid', 'mismatch',
 * 'invalid', 'error') and reason.
 */
function verifyRevocation(assetPath, opts = {}) {
  let loaded;
  try {
    loaded = loadRevocation(assetPath, opts);
  } catch (e) {
    return {
      status: 'error',
      reason: e.message,
      revocationPath: null,
      record: null,
    };
  }
  if (!loaded.record) {
    return {
      status: 'absent',
      reason: 'no revocation file at the canonical path',
      revocationPath: loaded.revocationPath,
      record: null,
    };
  }
  const record = loaded.record;
  const { signature_base64, ...body } = record;
  if (!signature_base64) {
    return {
      status: 'error',
      reason: 'revocation record missing signature_base64',
      revocationPath: loaded.revocationPath,
      record,
    };
  }

  // The key check: verify the revocation signature against
  // the declared public key. If the key in the record does
  // not match the local identity, the revocation is not
  // authoritative for THIS consumer (they have not chosen to
  // trust that key). The CLI returns 'mismatch' rather than
  // 'valid' so the caller can decide.
  let recordPublicKey;
  try {
    // The stored `public_key_hex` is the raw 32-byte Ed25519
    // public key (same format as Story 19 signature records).
    // Wrap it in a full SPKI DER so Node's createPublicKey can
    // import it.
    const rawPub = Buffer.from(record.public_key_hex, 'hex');
    recordPublicKey = crypto.createPublicKey({
      key: rawPublicKeyToSpkiDer(rawPub),
      format: 'der',
      type: 'spki',
    });
  } catch (e) {
    return {
      status: 'error',
      reason: `failed to parse revocation public key: ${e.message}`,
      revocationPath: loaded.revocationPath,
      record,
    };
  }
  const localPublicKeyPem = fs.existsSync(PUBLIC_KEY_PATH)
    ? fs.readFileSync(PUBLIC_KEY_PATH, 'utf8')
    : null;
  const localPublicKeyRaw = localPublicKeyPem ? rawPublicKey(localPublicKeyPem) : null;
  const recordPublicKeyRaw = Buffer.from(record.public_key_hex, 'hex');
  const keyMatchesLocal = localPublicKeyRaw ? localPublicKeyRaw.equals(recordPublicKeyRaw) : null;

  // Verify the revocation signature over the canonical body.
  const bodyBytes = Buffer.from(STABLE_STRINGIFY(body), 'utf8');
  const sigBytes = Buffer.from(signature_base64, 'base64');
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, bodyBytes, recordPublicKey, sigBytes);
  } catch (e) {
    return {
      status: 'error',
      reason: `failed to verify revocation signature: ${e.message}`,
      revocationPath: loaded.revocationPath,
      record,
      key_matches_local: keyMatchesLocal,
    };
  }
  if (!sigOk) {
    return {
      status: 'invalid',
      reason: 'revocation signature does not verify',
      revocationPath: loaded.revocationPath,
      record,
      key_matches_local: keyMatchesLocal,
    };
  }

  // Cross-check: does the revocation reference the current
  // .ed25519.sig file? If the author re-signed, the old
  // revocation doesn't apply to the new sig.
  const sigPath = opts.sigPath || `${assetPath}${SIGNATURE_SUFFIX}`;
  let currentSigDigest = null;
  if (fs.existsSync(sigPath)) {
    currentSigDigest = sha256Tagged(fs.readFileSync(sigPath));
  }

  return {
    status: 'valid',
    reason: 'revocation is cryptographically valid',
    revocationPath: loaded.revocationPath,
    record,
    key_matches_local: keyMatchesLocal,
    current_signature_digest: currentSigDigest,
    references_current_signature: currentSigDigest === record.revoked_signature_digest,
  };
}

/**
 * Called by verifyAsset. If a valid revocation exists for the
 * current .ed25519.sig, returns the revocation info so the
 * caller can surface it. Returns null if no revocation applies.
 *
 * Cross-check: only returns the revocation if it was signed by
 * the SAME public key that signed the original signature.
 * This is the "different signers cannot revoke each other's
 * signatures" rule from the work package.
 */
function checkRevocationForVerification(assetPath, sigRecord, opts = {}) {
  if (!sigRecord || !sigRecord.public_key_hex) {
    return null;
  }
  const result = verifyRevocation(assetPath, opts);
  if (result.status !== 'valid') return null;
  if (result.record.public_key_hex !== sigRecord.public_key_hex) {
    // Revocation is by a different key — does not apply.
    return null;
  }
  if (!result.references_current_signature) {
    // Revocation references a different .ed25519.sig (likely
    // the author re-signed after revoking). The current sig
    // is fresh.
    return null;
  }
  return result;
}

// ─── CLI command wrappers ─────────────────────────────────────────────

/**
 * Build the revocation path for a target (CLI helper).
 */
function resolveRevocationPath(target, opts = {}) {
  if (opts.revocationPath) return path.resolve(opts.revocationPath);
  return revocationPathFor(path.resolve(target));
}

// ─── CLI command wrappers ─────────────────────────────────────────────

function cmdSign(args) {
  const target = args.filter((a) => !a.startsWith('--'))[0];
  if (!target) {
    error('Usage: kdna sign <asset> [--sig <path>] [--json]', EXIT.INPUT_ERROR);
  }
  const abs = path.resolve(target);
  const sigIdx = args.indexOf('--sig');
  const sigPath = sigIdx >= 0 ? path.resolve(args[sigIdx + 1]) : null;
  const json = args.includes('--json');
  try {
    const result = signAsset(abs, { sigPath });
    if (json) {
      console.log(
        JSON.stringify(
          {
            sig_path: result.sigPath,
            fingerprint: result.fingerprint,
            asset_digest: result.assetDigest,
            public_key_hex: result.publicKeyHex,
            public_key_base64: result.publicKeyBase64,
            signature_base64: result.signatureBase64,
            signed_at: result.sigRecord.signed_at,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`Signed: ${result.sigPath}`);
    console.log(`  Asset digest:   ${result.assetDigest}`);
    console.log(`  Key fingerprint: ${result.fingerprint}`);
    console.log(`  Public key (hex): ${result.publicKeyHex}`);
  } catch (e) {
    error(e.message, EXIT.VALIDATION_FAILED);
  }
}

function cmdVerify(args) {
  const target = args.filter((a) => !a.startsWith('--'))[0];
  if (!target) {
    error(
      'Usage: kdna verify <asset> [--key <pubkey-path>] [--sig <path>] [--json]',
      EXIT.INPUT_ERROR,
    );
  }
  const abs = path.resolve(target);
  const keyIdx = args.indexOf('--key');
  const keyPath = keyIdx >= 0 ? path.resolve(args[keyIdx + 1]) : null;
  const sigIdx = args.indexOf('--sig');
  const sigPath = sigIdx >= 0 ? path.resolve(args[sigIdx + 1]) : null;
  const json = args.includes('--json');

  const result = verifyAsset(abs, { keyPath, sigPath });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    switch (result.status) {
      case 'valid':
        console.log(`Signature is valid.`);
        console.log(`  Asset digest:    ${result.assetDigest}`);
        console.log(`  Key fingerprint: ${result.fingerprint}`);
        console.log(`  Signed with key: ${result.keyFingerprint}`);
        break;
      case 'revoked':
        console.error(`Signature is REVOKED by its author.`);
        if (result.revocation && result.revocation.reason) {
          console.error(`  Reason:           ${result.revocation.reason}`);
        }
        console.error(`  Revoked at:       ${result.revocation && result.revocation.revoked_at}`);
        console.error(
          `  Revocation file:  ${result.revocation && result.revocation.revocation_path}`,
        );
        console.error(`  Signer fingerprint: ${result.fingerprint}`);
        break;
      case 'invalid':
        console.error(`Signature is INVALID.`);
        console.error(`  ${result.reason}`);
        console.error(`  Signer's key fingerprint: ${result.fingerprint}`);
        break;
      case 'no-key':
        console.log(`No key provided; cannot determine trust.`);
        console.log(`  Asset digest:           ${result.assetDigest}`);
        console.log(`  Signer fingerprint:     ${result.fingerprint}`);
        console.log(`  Signer public key hex:  ${result.signerPublicKeyHex}`);
        console.log(`  Signer public key b64:  ${result.signerPublicKeyBase64}`);
        if (result.revocation) {
          console.log(``);
          console.log(`  Note: a revocation record exists at:`);
          console.log(`    ${result.revocation.revocation_path}`);
          if (result.revocation.reason) {
            console.log(`    reason: ${result.revocation.reason}`);
          }
          console.log(`    revoked_at: ${result.revocation.revoked_at}`);
        }
        console.log(``);
        console.log(`  Sign with:  kdna verify <asset> --key <pubkey.pem>`);
        break;
      case 'error':
      default:
        console.error(`Error: ${result.reason}`);
        break;
    }
  }
  // Exit codes:
  //   0 — valid (signature verifies against provided key, no revocation)
  //   1 — invalid (signature is wrong OR asset is modified)
  //   2 — no key provided (informational; the CLI just printed the
  //       signer's pubkey and refused to make a trust claim)
  //   3 — error (file not found, key unparseable, etc.)
  //   4 — revoked (Story 20: signature is valid but author revoked it)
  if (result.status === 'valid') process.exit(EXIT.OK);
  if (result.status === 'invalid') process.exit(EXIT.VALIDATION_FAILED);
  if (result.status === 'no-key') process.exit(2);
  if (result.status === 'revoked') process.exit(4);
  process.exit(EXIT.PROVIDER_ERROR);
}

function cmdRevoke(args) {
  const target = args.filter((a) => !a.startsWith('--'))[0];
  if (!target) {
    error(
      'Usage: kdna revoke <asset> [--reason "..."] [--revocation <path>] [--force] [--json]',
      EXIT.INPUT_ERROR,
    );
  }
  const abs = path.resolve(target);
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx >= 0 && args[reasonIdx + 1] ? args[reasonIdx + 1] : null;
  const revIdx = args.indexOf('--revocation');
  const revocationPath = revIdx >= 0 ? path.resolve(args[revIdx + 1]) : null;
  const force = args.includes('--force');
  const json = args.includes('--json');
  try {
    const result = signRevocation(abs, { reason, revocationPath, force });
    if (json) {
      console.log(
        JSON.stringify(
          {
            revocation_path: result.revocationPath,
            fingerprint: result.fingerprint,
            asset_digest: result.assetDigest,
            revoked_at: result.revocationRecord.revoked_at,
            reason: result.revocationRecord.reason,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`Revoked: ${result.revocationPath}`);
    console.log(`  Revoked signature: ${result.revocationRecord.revoked_signature_path}`);
    console.log(`  Revoked at:        ${result.revocationRecord.revoked_at}`);
    console.log(`  Asset digest:      ${result.assetDigest}`);
    console.log(`  Key fingerprint:   ${result.fingerprint}`);
    if (result.revocationRecord.reason) {
      console.log(`  Reason:            ${result.revocationRecord.reason}`);
    }
  } catch (e) {
    error(e.message, EXIT.VALIDATION_FAILED);
  }
}

function cmdRevocation(args) {
  const sub = args[0];
  if (sub !== 'status') {
    error('Usage: kdna revocation status <asset> [--json]', EXIT.INPUT_ERROR);
  }
  const target = args[1];
  if (!target) {
    error('Usage: kdna revocation status <asset> [--json]', EXIT.INPUT_ERROR);
  }
  const abs = path.resolve(target);
  const json = args.includes('--json');
  const result = verifyRevocation(abs);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.status === 'absent') {
    console.log(`No revocation at: ${result.revocationPath || '<canonical path>'}`);
    return;
  }
  if (result.status === 'error') {
    console.error(`Error: ${result.reason}`);
    return;
  }

  const r = result.record;
  console.log(`Revocation: ${result.revocationPath}`);
  console.log(`  Status:           ${result.status}`);
  console.log(`  Revoked signature: ${r.revoked_signature_path}`);
  console.log(`  Revoked at:        ${r.revoked_at}`);
  console.log(`  Asset digest:      ${r.asset_digest}`);
  console.log(`  Key fingerprint:   ${r.fingerprint}`);
  if (r.reason) console.log(`  Reason:            ${r.reason}`);
  console.log(`  References current sig: ${result.references_current_signature}`);
  console.log(`  Matches local identity:  ${result.key_matches_local}`);
}

module.exports = {
  // Existing commands (Story 19 path migration + show format change)
  cmdIdentityInit,
  cmdIdentityShow,
  cmdIdentityExport,
  cmdIdentityImport,
  // New commands (Story 19)
  cmdSign,
  cmdVerify,
  signAsset,
  verifyAsset,
  loadAssetForSigning,
  loadSignature,
  rawPublicKey,
  // Constants / paths
  PRIVATE_KEY_PATH,
  PUBLIC_KEY_PATH,
  IDENTITY_DIR,
  OLD_IDENTITY_DIR,
  SIGNATURE_ALG,
  SIGNATURE_VERSION,
  SIGNATURE_SUFFIX,
  REVOCATION_RELATIVE_PATH,
  fingerprint,
  deriveBuyerId,
  signRevocation,
  verifyRevocation,
  loadRevocation,
  checkRevocationForVerification,
  cmdRevoke,
  cmdRevocation,
  STABLE_STRINGIFY,
};
