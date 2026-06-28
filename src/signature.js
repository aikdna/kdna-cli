// Ed25519 signing and verification — registry, revocation, key management
//
// Story 19 path migration: this module previously used the old path
// `~/.kdna/identity/kdna.{key,pub}`. The canonical implementation is
// now in `src/identity.js` and the new path is `~/.kdna/keys/ed25519.{key,pub}`.
// This file is preserved for compatibility with older code paths; new
// callers should use `require('./identity')` directly.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

function signPayload(payload, privateKeyPem) {
  if (typeof payload === 'string') payload = Buffer.from(payload, 'utf8');
  const sig = crypto.sign(null, payload, privateKeyPem);
  return `ed25519:${sig.toString('hex')}`;
}

function verifyPayload(payload, signature, publicKeyPem) {
  if (typeof payload === 'string') payload = Buffer.from(payload, 'utf8');
  if (typeof signature === 'string' && signature.startsWith('ed25519:')) {
    signature = Buffer.from(signature.slice(8), 'hex');
  }
  return crypto.verify(null, payload, publicKeyPem, signature);
}

function loadIdentityKeys() {
  // Story 19: prefer the new path. Fall back to the old path so
  // pre-Story-19 identities still load (so users can re-export).
  const newDir = process.env.KDNA_IDENTITY_DIR || path.join(os.homedir(), '.kdna', 'keys');
  const oldDir = path.join(os.homedir(), '.kdna', 'identity');
  const candidates = [
    { dir: newDir, priv: 'ed25519.key', pub: 'ed25519.pub' },
    { dir: oldDir, priv: 'kdna.key', pub: 'kdna.pub' },
  ];
  for (const c of candidates) {
    const priv = path.join(c.dir, c.priv);
    const pub = path.join(c.dir, c.pub);
    if (fs.existsSync(priv) && fs.existsSync(pub)) {
      return {
        privatePem: fs.readFileSync(priv, 'utf8'),
        publicPem: fs.readFileSync(pub, 'utf8'),
        publicKeyPem: fs.readFileSync(pub, 'utf8'),
      };
    }
  }
  throw new Error('No identity found. Run: kdna identity init');
}

function computeFingerprint(publicKeyPem) {
  return `ed25519:${crypto.createHash('sha256').update(Buffer.from(publicKeyPem)).digest('hex').slice(0, 12)}`;
}

module.exports = { signPayload, verifyPayload, loadIdentityKeys, computeFingerprint };
