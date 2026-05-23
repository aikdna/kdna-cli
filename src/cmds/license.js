/**
 * KDNA License — Generate, verify, and manage domain licenses.
 *
 * Commands:
 *   kdna license generate <domain> --to <email> [--expires <date>]
 *   kdna license verify <license.json>
 *   kdna license bind <license.json>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EXIT, error } = require('./_common');
const { createLicense, signLicense, verifyLicense, verifyLicenseSignature, machineFingerprint } = require('./encrypt');

const IDENTITY_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna', 'identity');
const PRIVATE_KEY_PATH = path.join(IDENTITY_DIR, 'kdna.key');
const PUBLIC_KEY_PATH = path.join(IDENTITY_DIR, 'kdna.pub');

function readIdentity() {
  if (!fs.existsSync(PRIVATE_KEY_PATH) || !fs.existsSync(PUBLIC_KEY_PATH)) {
    error('No identity found. Run: kdna identity init', EXIT.INPUT_ERROR);
  }
  return {
    privateKey: fs.readFileSync(PRIVATE_KEY_PATH, 'utf8'),
    publicKey: fs.readFileSync(PUBLIC_KEY_PATH, 'utf8'),
  };
}

function cmdLicenseGenerate(args) {
  const domain = args[0];
  if (!domain) error('Usage: kdna license generate <domain> --to <email> [--expires <date>] [--max-agents <n>]', EXIT.INPUT_ERROR);

  const emailIdx = args.indexOf('--to');
  const email = emailIdx >= 0 ? args[emailIdx + 1] : null;
  if (!email) error('--to <email> is required', EXIT.INPUT_ERROR);

  const expiresIdx = args.indexOf('--expires');
  const expiresAt = expiresIdx >= 0 ? args[expiresIdx + 1] : null;

  const agentsIdx = args.indexOf('--max-agents');
  const maxAgents = agentsIdx >= 0 ? parseInt(args[agentsIdx + 1], 10) : 1;

  const bindingIdx = args.includes('--no-binding');
  const requireBinding = !bindingIdx;

  const { privateKey, publicKey } = readIdentity();

  const license = createLicense(domain, {
    issuedTo: email,
    expiresAt,
    maxAgents,
    requireMachineBinding: requireBinding,
    allowedAgents: ['claude_code', 'codex', 'opencode', 'cursor', 'gemini'],
  });

  const signed = signLicense(license, privateKey);

  const pubkey = crypto.createHash('sha256').update(publicKey).digest('hex').substring(0, 12);
  signed.scope_pubkey_fingerprint = `ed25519:${pubkey}`;

  const saveIdx = args.indexOf('--save');
  const savePath = saveIdx >= 0 ? args[saveIdx + 1] : null;

  console.log(JSON.stringify(signed, null, 2));

  if (savePath) {
    fs.writeFileSync(savePath, JSON.stringify(signed, null, 2) + '\n');
    console.error(`Saved to: ${savePath}`);
  }

  console.error('');
  console.error(`License generated for ${domain}`);
  console.error(`  Issued to: ${email}`);
  console.error(`  License ID: ${signed.license_id}`);
  if (expiresAt) console.error(`  Expires: ${expiresAt}`);
  console.error(`  Machine binding: ${requireBinding ? 'required' : 'disabled'}`);
  console.error('');
  console.error('Save this JSON as license.json inside the .kdnae container.');
  console.error('Share the license key with the licensee.');
}

function cmdLicenseVerify(args) {
  const jsonMode = args.includes('--json');
  const filtered = args.filter(a => !a.startsWith('--'));
  const licensePath = filtered[0];
  if (!licensePath) error('Usage: kdna license verify <license.json>', EXIT.INPUT_ERROR);

  let license;
  try {
    license = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
  } catch {
    error(`Cannot read license file: ${licensePath}`, EXIT.INPUT_ERROR);
  }

  const { publicKey } = readIdentity();
  const signatureValid = verifyLicenseSignature(license, publicKey);
  const fp = machineFingerprint();
  const result = verifyLicense(license, publicKey, fp);

  if (jsonMode) {
    console.log(JSON.stringify({
      domain: license.domain,
      license_id: license.license_id,
      issued_to: license.issued_to,
      signature_valid: signatureValid,
      valid: result.valid,
      issues: result.issues,
      fingerprint: license.require_machine_binding ? fp : 'not required',
    }, null, 2));
  } else {
    console.log(`License: ${license.license_id}`);
    console.log(`Domain:  ${license.domain}`);
    console.log(`Issued:  ${license.issued_to}`);
    console.log(`Signature: ${signatureValid ? '✓ valid' : '✗ invalid'}`);
    if (license.expires_at) {
      const expired = new Date(license.expires_at) < new Date();
      console.log(`Expires: ${license.expires_at} ${expired ? '(EXPIRED)' : ''}`);
    }
    if (license.require_machine_binding) {
      console.log(`Machine binding: required`);
      console.log(`  Current fingerprint: ${fp}`);
    }
    if (result.issues.length) {
      console.log('');
      console.log('Issues:');
      result.issues.forEach(i => console.log(`  ✗ ${i}`));
    } else {
      console.log('');
      console.log('✓ License valid');
    }
  }

  process.exit(result.valid && signatureValid ? EXIT.OK : EXIT.TRUST_FAILED);
}

function cmdLicenseBind(args) {
  const filtered = args.filter(a => !a.startsWith('--'));
  const licensePath = filtered[0];
  if (!licensePath) error('Usage: kdna license bind <license.json>', EXIT.INPUT_ERROR);

  let license;
  try {
    license = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
  } catch {
    error(`Cannot read license file: ${licensePath}`, EXIT.INPUT_ERROR);
  }

  if (!license.require_machine_binding) {
    console.log('License does not require machine binding. No action needed.');
    process.exit(EXIT.OK);
  }

  const { privateKey, publicKey } = readIdentity();
  const fp = machineFingerprint();

  // Remove old signature before re-signing
  delete license.signature;
  license.machine_fingerprint = fp;
  license.bound_at = new Date().toISOString();

  const signed = signLicense(license, privateKey);
  fs.writeFileSync(licensePath, JSON.stringify(signed, null, 2) + '\n');
  console.log(`License bound to machine: ${fp}`);
  console.log(`Updated: ${licensePath}`);
}

function cmdLicenseShow(args) {
  const filtered = args.filter(a => !a.startsWith('--'));
  const licensePath = filtered[0];
  if (!licensePath) {
    const local = path.join(process.cwd(), 'license.json');
    if (fs.existsSync(local)) return cmdLicenseVerify([local, ...args.slice(1)]);
    error('Usage: kdna license show <license.json>', EXIT.INPUT_ERROR);
  }
  cmdLicenseVerify(args);
}

function cmdLicenseInstall(args) {
  const licensePath = args[0];
  if (!licensePath) error('Usage: kdna license install <license.json>', EXIT.INPUT_ERROR);

  let license;
  try {
    license = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
  } catch {
    error(`Cannot read license file: ${licensePath}`, EXIT.INPUT_ERROR);
  }

  if (!license.domain) error('License missing domain field', EXIT.INPUT_ERROR);

  const licenseDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna', 'licenses');
  fs.mkdirSync(licenseDir, { recursive: true });

  const safeName = license.domain.replace(/^@/, '').replace('/', '-');
  const dest = path.join(licenseDir, `${safeName}.json`);

  fs.writeFileSync(dest, JSON.stringify(license, null, 2) + '\n');

  console.log(`License installed for ${license.domain}`);
  console.log(`  License ID: ${license.license_id || 'unknown'}`);
  console.log(`  Saved to: ${dest}`);
  console.log('');
  console.log(`Now install the domain: kdna install ${license.domain}`);
}

module.exports = { cmdLicenseGenerate, cmdLicenseVerify, cmdLicenseBind, cmdLicenseShow, cmdLicenseInstall };
