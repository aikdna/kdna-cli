// Ed25519 signing and verification — registry, revocation, key management
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
  const identityDir = process.env.KDNA_IDENTITY_DIR || path.join(os.homedir(), '.kdna', 'identity');
  const privateKeyPath = path.join(identityDir, 'kdna.key');
  const publicKeyPath = path.join(identityDir, 'kdna.pub');
  if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
    throw new Error('No identity found. Run: kdna identity init --name "Your Name"');
  }
  return {
    privatePem: fs.readFileSync(privateKeyPath, 'utf8'),
    publicPem: fs.readFileSync(publicKeyPath, 'utf8'),
    publicKeyPem: fs.readFileSync(publicKeyPath, 'utf8'),
  };
}

function computeFingerprint(publicKeyPem) {
  return `ed25519:${crypto.createHash('sha256').update(Buffer.from(publicKeyPem)).digest('hex').slice(0, 12)}`;
}

module.exports = { signPayload, verifyPayload, loadIdentityKeys, computeFingerprint };
