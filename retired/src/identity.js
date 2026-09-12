/**
 * KDNA identity key management.
 *
 * The current Preview exposes only identity initialization and public identity
 * inspection. Asset sign/verify/revoke has no current container contract, and
 * the legacy private-key backup format did not provide authenticated
 * encryption; those public entry points are intentionally absent.
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

function error(message, code = EXIT.VALIDATION_FAILED) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

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

function rawPublicKey(publicKeyPem) {
  const key = crypto.createPublicKey({
    key: publicKeyPem,
    format: 'pem',
    type: 'spki',
  });
  const der = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(der.subarray(der.length - 32));
}

function identityDetails(publicKeyPem) {
  const raw = rawPublicKey(publicKeyPem);
  return {
    algorithm: SIGNATURE_ALG,
    pubkey_pem: publicKeyPem.trim(),
    pubkey_hex: raw.toString('hex'),
    pubkey_base64: raw.toString('base64'),
    buyer_id: deriveBuyerId(publicKeyPem),
    fingerprint: fingerprint(publicKeyPem),
    public_key_path: PUBLIC_KEY_PATH,
    private_key_exists: fs.existsSync(PRIVATE_KEY_PATH),
  };
}

function printIdentity(details, alreadyExists) {
  if (alreadyExists) console.log('Identity already exists.');
  console.log(`Buyer ID:           ${details.buyer_id}`);
  console.log(`Fingerprint:        ${details.fingerprint}`);
  console.log(`Public key (hex):   ${details.pubkey_hex}`);
  console.log(`Public key (b64):   ${details.pubkey_base64}`);
  console.log(`Public key (PEM):   ${PUBLIC_KEY_PATH}`);
  console.log(
    `Private key:        ${PRIVATE_KEY_PATH} ${details.private_key_exists ? '(exists)' : '(MISSING!)'}`,
  );
}

function cmdIdentityInit() {
  if (fs.existsSync(PRIVATE_KEY_PATH)) {
    if (!fs.existsSync(PUBLIC_KEY_PATH)) {
      error(`Private identity exists but public key is missing: ${PUBLIC_KEY_PATH}`);
    }
    printIdentity(identityDetails(fs.readFileSync(PUBLIC_KEY_PATH, 'utf8')), true);
    return;
  }

  const oldPrivate = path.join(OLD_IDENTITY_DIR, 'kdna.key');
  const oldPublic = path.join(OLD_IDENTITY_DIR, 'kdna.pub');
  if (fs.existsSync(oldPrivate) || fs.existsSync(oldPublic)) {
    error(
      `A legacy identity exists at ${OLD_IDENTITY_DIR}. ` +
        'Automatic migration is outside the current Preview contract.',
      EXIT.INPUT_ERROR,
    );
  }

  fs.mkdirSync(IDENTITY_DIR, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPair();
  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600, flag: 'wx' });
  try {
    fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, { mode: 0o644, flag: 'wx' });
  } catch (writeError) {
    fs.rmSync(PRIVATE_KEY_PATH, { force: true });
    throw writeError;
  }
  printIdentity(identityDetails(publicKey), false);
}

function cmdIdentityShow(jsonMode = false) {
  if (!fs.existsSync(PUBLIC_KEY_PATH)) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: 'No identity found. Run: kdna identity init' }));
      process.exit(EXIT.INPUT_ERROR);
    }
    error('No identity found. Run: kdna identity init', EXIT.INPUT_ERROR);
  }

  const details = identityDetails(fs.readFileSync(PUBLIC_KEY_PATH, 'utf8'));
  if (jsonMode) {
    console.log(JSON.stringify(details));
    return;
  }
  printIdentity(details, false);
}

module.exports = {
  cmdIdentityInit,
  cmdIdentityShow,
  rawPublicKey,
  PRIVATE_KEY_PATH,
  PUBLIC_KEY_PATH,
  IDENTITY_DIR,
  OLD_IDENTITY_DIR,
  fingerprint,
  deriveBuyerId,
};
