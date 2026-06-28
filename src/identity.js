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
      console.log(
        JSON.stringify({ error: 'No identity found. Run: kdna identity init' }),
      );
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
    if (!layout.map['payload.kdnab']) throw new Error(`.kdna container missing payload.kdnab: ${abs}`);
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
  // consumer's decision, not the CLI's.
  if (!opts.keyPath) {
    return {
      status: 'no-key',
      reason: 'no key provided; cannot determine trust',
      assetDigest: loaded.assetDigestHex,
      signerPublicKeyHex: sigRecord.public_key_hex,
      signerPublicKeyBase64: sigRecord.public_key_base64,
      fingerprint: sigRecord.public_key_fingerprint,
      keyFingerprint: null,
      sigPath,
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

  return {
    status: 'valid',
    reason: 'signature verifies',
    assetDigest: loaded.assetDigestHex,
    signerPublicKeyHex: sigRecord.public_key_hex,
    signerPublicKeyBase64: sigRecord.public_key_base64,
    fingerprint: sigRecord.public_key_fingerprint,
    keyFingerprint: providedKeyFp,
    sigPath,
  };
}

function detectKeyFormat(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('-----BEGIN ')) return 'pem';
  // Assume base64 SPKI DER otherwise.
  return 'der';
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
        console.log(`  Sign with:  kdna verify <asset> --key <pubkey.pem>`);
        break;
      case 'error':
      default:
        console.error(`Error: ${result.reason}`);
        break;
    }
  }
  // Exit codes:
  //   0 — valid (signature verifies against provided key)
  //   1 — invalid (signature is wrong OR asset is modified)
  //   2 — no key provided (informational; the CLI just printed the
  //       signer's pubkey and refused to make a trust claim)
  //   3 — error (file not found, key unparseable, etc.)
  if (result.status === 'valid') process.exit(EXIT.OK);
  if (result.status === 'invalid') process.exit(EXIT.VALIDATION_FAILED);
  if (result.status === 'no-key') process.exit(2);
  process.exit(EXIT.PROVIDER_ERROR);
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
  fingerprint,
  deriveBuyerId,
};
