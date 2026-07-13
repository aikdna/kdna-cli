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
const http = require('http');
const https = require('https');
const { EXIT, error } = require('./_common');
const { recordTrace } = require('./trace');
const PATHS = require('../paths');
const external = require('../external-entitlement');
const IDENTITY_DIR = PATHS.identity;
const PRIVATE_KEY_PATH = path.join(IDENTITY_DIR, 'kdna.key');
const PUBLIC_KEY_PATH = path.join(IDENTITY_DIR, 'kdna.pub');

function machineFingerprint() {
  const os = require('os');
  const parts = [os.hostname(), os.userInfo().uid.toString(), os.platform(), os.arch()];
  try {
    const { execSync } = require('child_process');
    if (os.platform() === 'darwin') {
      const uuid = execSync('ioreg -d2 -c IOPlatformExpertDevice | grep IOPlatformUUID', {
        encoding: 'utf8',
        timeout: 3000,
      })
        .match(/"[A-F0-9-]{36}"/)?.[0]
        ?.replace(/"/g, '');
      if (uuid) parts.push(uuid);
    }
    if (os.platform() === 'linux') {
      try {
        const mid = fs.readFileSync('/etc/machine-id', 'utf8').trim();
        if (mid) parts.push(mid);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* non-critical */
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function createLicense(domain, options = {}) {
  return {
    version: '1.0',
    license_id: `lic_${crypto.randomBytes(8).toString('hex')}`,
    license_key: options.licenseKey || `KDNA-LIC-${crypto.randomBytes(18).toString('base64url')}`,
    domain,
    issued_to: options.issuedTo || 'licensee@example.com',
    issued_at: new Date().toISOString(),
    expires_at: options.expiresAt || null,
    max_agents: options.maxAgents || 1,
    require_machine_binding: options.requireMachineBinding !== false,
    require_online_check: !!options.requireOnlineCheck,
    offline_grace_days: options.offlineGraceDays || 7,
    allowed_agents: options.allowedAgents || ['claude_code', 'codex', 'opencode'],
  };
}

function signLicense(license, privateKeyPem) {
  const payload = { ...license };
  delete payload.signature;
  const data = JSON.stringify(payload, Object.keys(payload).sort());
  const sig = crypto.sign(null, Buffer.from(data), privateKeyPem);
  return { ...license, signature: `ed25519:${sig.toString('hex')}` };
}

function verifyLicenseSignature(license, publicKeyPem) {
  const signature = license.signature?.replace('ed25519:', '') || '';
  if (!signature) return false;
  const payload = { ...license };
  delete payload.signature;
  const data = JSON.stringify(payload, Object.keys(payload).sort());
  try {
    return crypto.verify(null, Buffer.from(data), publicKeyPem, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

function verifyLicense(license, _scopePubkey, fingerprint) {
  const issues = [];
  const now = new Date();
  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    issues.push('License has expired');
  }
  if (license.revoked === true || license.status === 'revoked') {
    issues.push('License has been revoked');
  }
  if (license.require_online_check) {
    const offlineUntil = license.offline_valid_until ? new Date(license.offline_valid_until) : null;
    if (!offlineUntil || Number.isNaN(offlineUntil.getTime()) || offlineUntil < now) {
      issues.push('License offline grace has expired');
    }
  }
  if (license.require_machine_binding) {
    if (!license.machine_fingerprint) {
      issues.push('License is not bound to this machine');
    } else if (license.machine_fingerprint !== fingerprint) {
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

function licenseServerType(server) {
  if (!server) return null;
  if (server.startsWith('file://')) return 'file';
  if (server.startsWith('/')) return 'local-file';
  try {
    return new URL(server).protocol.replace(':', '');
  } catch {
    return 'unknown';
  }
}

function recordLicenseTrace(action, license, extra = {}) {
  const fingerprint = machineFingerprint();
  const result = verifyLicense(license || {}, null, fingerprint);
  recordTrace({
    timestamp: new Date().toISOString(),
    event: 'license',
    action,
    agent: 'kdna-cli',
    domain: license?.domain || extra.domain || null,
    license_id: license?.license_id || extra.license_id || null,
    valid: result.valid,
    issues: result.issues,
    revoked: license?.revoked === true || license?.status === 'revoked',
    require_online_check: !!license?.require_online_check,
    offline_valid_until: license?.offline_valid_until || null,
    server_type: licenseServerType(
      extra.server || license?.activation_server || license?.license_server_url,
    ),
    synced: extra.synced,
    sync_error: extra.sync_error,
  });
}

function safeLicenseName(domain) {
  return domain.replace(/^@/, '').replace('/', '-');
}

function licensePathForDomain(domain) {
  return path.join(PATHS.licenses, `${safeLicenseName(domain)}.json`);
}

function readLicenseForDomain(domain) {
  const file = licensePathForDomain(domain);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listInstalledLicenses() {
  if (!fs.existsSync(PATHS.licenses)) return [];
  return fs
    .readdirSync(PATHS.licenses)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(PATHS.licenses, name);
      try {
        return { file, license: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function licenseKey(license) {
  return license?.license_key || license?.activation_key || license?.key || null;
}

function redactLicenseKey(text, key) {
  if (typeof text !== 'string') return text;
  if (!key) return text;
  return text.split(key).join('[redacted-license-key]');
}

function licenseDecryptOptionsForManifest(manifest) {
  const domain = manifest?.name || manifest?.asset_id;
  if (!domain) {
    return { ok: false, error: 'licensed asset missing manifest name' };
  }
  const license = readLicenseForDomain(domain);
  if (!license) {
    return { ok: false, error: `no installed license for ${domain}` };
  }
  if (license.domain !== domain) {
    return { ok: false, error: `installed license domain mismatch: ${license.domain}` };
  }
  const fingerprint = machineFingerprint();
  const result = verifyLicense(license, null, fingerprint);
  if (!result.valid) {
    return { ok: false, error: result.issues.join('; ') };
  }
  const key = licenseKey(license);
  if (!key) {
    return { ok: false, error: `installed license for ${domain} has no license_key` };
  }
  const { createLicensedDecryptEntry } = require('@aikdna/kdna-core');
  return {
    ok: true,
    license,
    decryptEntry: createLicensedDecryptEntry({
      licenseKey: key,
      machineFingerprint: license.machine_fingerprint || fingerprint,
    }),
  };
}

function argValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

function addOfflineLease(activation) {
  const days = activation.offline_grace_days || 7;
  const until = new Date();
  until.setDate(until.getDate() + days);
  return {
    ...activation,
    last_checked_at: new Date().toISOString(),
    offline_valid_until: activation.require_online_check
      ? until.toISOString()
      : activation.offline_valid_until || null,
  };
}

function normalizeActivation(domain, key, payload, server = null) {
  const source = payload.activation || payload.license || payload;
  if (source.ok === false || payload.ok === false) {
    throw new Error(source.error || payload.error || 'activation denied');
  }
  if (Array.isArray(payload.activations)) {
    const found = payload.activations.find(
      (entry) => entry.domain === domain && licenseKey(entry) === key,
    );
    if (!found) throw new Error('activation not found for domain/key');
    return normalizeActivation(domain, key, found, server);
  }
  if (source.domain && source.domain !== domain) {
    throw new Error(`activation domain mismatch: ${source.domain}`);
  }
  if (licenseKey(source) && licenseKey(source) !== key) {
    throw new Error('activation key mismatch');
  }
  const fingerprint = machineFingerprint();
  return addOfflineLease({
    version: source.version || '1.0',
    license_id: source.license_id || `lic_${crypto.randomBytes(8).toString('hex')}`,
    license_key: key,
    domain,
    issued_to: source.issued_to || source.email || null,
    issued_at: source.issued_at || new Date().toISOString(),
    expires_at: source.expires_at || null,
    status: source.status || 'active',
    revoked: source.revoked === true,
    require_machine_binding: source.require_machine_binding !== false,
    machine_fingerprint: source.machine_fingerprint || fingerprint,
    require_online_check: source.require_online_check !== false,
    offline_grace_days: source.offline_grace_days || 7,
    allowed_agents: source.allowed_agents || [
      'claude_code',
      'codex',
      'opencode',
      'cursor',
      'gemini',
    ],
    activation_server: server || source.activation_server || source.license_server_url || null,
  });
}

function readActivationFromFile(url, domain, key) {
  const filePath = url.startsWith('file://') ? new URL(url).pathname : url;
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return normalizeActivation(domain, key, payload, url);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'http:' ? http : https;
    const data = JSON.stringify(body);
    const req = client.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            reject(new Error(`activation server HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`activation server returned invalid JSON`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('activation server timeout')));
    req.write(data);
    req.end();
  });
}

async function requestActivation(domain, key, server) {
  if (!server) throw new Error('--server <url> is required for activation');
  if (server.startsWith('file://') || server.startsWith('/')) {
    return readActivationFromFile(server, domain, key);
  }
  const payload = await postJson(server, {
    domain,
    license_key: key,
    machine_fingerprint: machineFingerprint(),
    client: 'kdna-cli',
  });
  return normalizeActivation(domain, key, payload, server);
}

function writeInstalledLicense(license) {
  fs.mkdirSync(PATHS.licenses, { recursive: true });
  const dest = licensePathForDomain(license.domain);
  fs.writeFileSync(dest, JSON.stringify(license, null, 2) + '\n');
  return dest;
}

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
  if (!domain)
    error(
      'Usage: kdna license generate <domain> --to <email> [--expires <date>] [--max-agents <n>]',
      EXIT.INPUT_ERROR,
    );

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
  console.error('Save this license activation outside the .kdna asset under ~/.kdna/licenses/.');
  console.error('Share the license key with the licensee.');
}

function cmdLicenseVerify(args) {
  const jsonMode = args.includes('--json');
  const filtered = args.filter((a) => !a.startsWith('--'));
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
    console.log(
      JSON.stringify(
        {
          domain: license.domain,
          license_id: license.license_id,
          issued_to: license.issued_to,
          signature_valid: signatureValid,
          valid: result.valid,
          issues: result.issues,
          fingerprint: license.require_machine_binding ? fp : 'not required',
        },
        null,
        2,
      ),
    );
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
      result.issues.forEach((i) => console.log(`  ✗ ${i}`));
    } else {
      console.log('');
      console.log('✓ License valid');
    }
  }

  process.exit(result.valid && signatureValid ? EXIT.OK : EXIT.TRUST_FAILED);
}

function cmdLicenseBind(args) {
  const filtered = args.filter((a) => !a.startsWith('--'));
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

  const { privateKey } = readIdentity();
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
  const filtered = args.filter((a) => !a.startsWith('--'));
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

  const dest = writeInstalledLicense(license);
  recordLicenseTrace('install', license);

  console.log(`License installed for ${license.domain}`);
  console.log(`  License ID: ${license.license_id || 'unknown'}`);
  console.log(`  Saved to: ${dest}`);
  console.log('');
  console.log(`Now install the domain: kdna install ${license.domain}`);
}

async function cmdLicenseActivate(args = []) {
  const domain = args.find((arg) => !arg.startsWith('--'));
  const key = argValue(args, '--key') || argValue(args, '--license-key');
  const server = argValue(args, '--server');
  const jsonMode = args.includes('--json');
  if (!domain || !server) {
    error(
      'Usage: kdna license activate <domain> --server <url> [--asset <path>] [--credential-stdin] [--no-browser]',
      EXIT.INPUT_ERROR,
    );
  }

  if (!key) {
    return activateExternalGrant({ domain, server, args, jsonMode });
  }

  process.stderr.write(
    'Warning: --key is the legacy local-receipt flow and may be visible in shell history. ' +
      'Account/device assets use browser activation or --credential-stdin.\n',
  );

  let activation;
  try {
    activation = await requestActivation(domain, key, server);
  } catch (e) {
    error(`License activation failed: ${redactLicenseKey(e.message, key)}`, EXIT.TRUST_FAILED);
  }
  const dest = writeInstalledLicense(activation);
  recordLicenseTrace('activate', activation, { server });
  const record = licenseStatusRecord(activation, dest);
  if (jsonMode) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  console.log(`License activated for ${domain}`);
  console.log(`  License ID: ${activation.license_id}`);
  console.log(`  Status: ${record.valid ? 'valid' : 'invalid'}`);
  if (activation.offline_valid_until) {
    console.log(`  Offline valid until: ${activation.offline_valid_until}`);
  }
  console.log(`  Saved to: ${dest}`);
}

function accountApiUrl(server, resource) {
  const base = server.replace(/\/+$/, '');
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('activation server must use HTTP or HTTPS');
  const apiBase = base.endsWith('/api') ? base : `${base}/api`;
  return `${apiBase}/v1/${resource.replace(/^\/+/, '')}`;
}

function postAccountJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === 'http:' ? http : https;
    const data = JSON.stringify(body);
    const req = client.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('error', () => reject(new Error('activation server response is invalid')));
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            res.destroy(new Error('activation server response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          let payload = null;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* generic below */ }
          if (res.statusCode >= 400) {
            const code = payload?.error?.code || payload?.code || 'request_rejected';
            reject(new Error(`activation server rejected the request (HTTP ${res.statusCode}, ${code})`));
            return;
          }
          if (!payload) return reject(new Error('activation server returned invalid JSON'));
          resolve(payload);
        });
      },
    );
    req.on('error', () => reject(new Error('activation server is unavailable')));
    req.on('timeout', () => req.destroy(new Error('activation server timed out')));
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activateExternalGrant({ domain, server, args, jsonMode }) {
  const assetPath = external.resolveAssetPath(domain, argValue(args, '--asset'));
  const device = external.prepareDevice(domain, argValue(args, '--device-label'));
  let activationCredential = null;
  if (args.includes('--credential-stdin')) {
    if (process.stdin.isTTY) {
      error('--credential-stdin requires the one-time credential to be piped on stdin.', EXIT.INPUT_ERROR);
    }
    activationCredential = fs.readFileSync(0, 'utf8').trim();
    if (!activationCredential) error('No activation credential was received on stdin.', EXIT.INPUT_ERROR);
  }

  const created = await postAccountJson(accountApiUrl(server, 'device-activations'), {
    asset_id: domain,
    device_label: device.label,
    device_public_key: device.agreement.public_key,
    device_signing_public_key: device.signing.public_key,
    client: 'kdna-cli',
    ...(activationCredential ? { activation_credential: activationCredential } : {}),
  });
  activationCredential = null;
  if (!created.activation_id || !created.challenge || !created.verification_uri) {
    throw new Error('activation server response is missing device authorization fields');
  }
  const verificationUrl = new URL(created.verification_uri);
  const localHttp = verificationUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(verificationUrl.hostname);
  if (verificationUrl.protocol !== 'https:' && !localHttp) {
    throw new Error('device verification URI must use HTTPS (or local HTTP for development)');
  }
  const proof = external.activationProof({
    activationId: created.activation_id,
    challenge: created.challenge,
    device,
  });

  if (!args.includes('--no-browser')) {
    try {
      const { spawn } = require('node:child_process');
      const child = spawn('open', [created.verification_uri], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch { /* user can open the printed URL */ }
  }
  if (!jsonMode) {
    console.log(`Open: ${created.verification_uri}`);
    if (created.user_code) console.log(`Device code: ${created.user_code}`);
    console.log('Waiting for account authorization…');
  }

  const expiresAt = Date.parse(created.expires_at || new Date(Date.now() + 10 * 60 * 1000));
  const intervalMs = Math.max(1000, Math.min(10000, Number(created.interval || 2) * 1000));
  let completed;
  while (Date.now() < expiresAt) {
    const polled = await postAccountJson(
      accountApiUrl(server, `device-activations/${encodeURIComponent(created.activation_id)}/poll`),
      proof,
    );
    if (polled.status === 'complete') {
      completed = polled;
      break;
    }
    if (polled.status === 'denied' || polled.status === 'expired') {
      throw new Error(`device activation ${polled.status}`);
    }
    await sleep(polled.status === 'slow_down' ? intervalMs * 2 : intervalMs);
  }
  if (!completed) throw new Error('device activation expired before authorization completed');

  const installed = external.installActivation({
    domain,
    server,
    assetPath,
    response: completed,
    device,
  });
  recordTrace({
    timestamp: new Date().toISOString(),
    event: 'account_entitlement',
    action: 'activate',
    agent: 'kdna-cli',
    domain,
    entitlement_id: installed.metadata.entitlement_id,
    device_id: installed.metadata.device_id,
    status: installed.metadata.status,
    server_type: licenseServerType(server),
  });
  const record = external.statusRecord(domain);
  if (jsonMode) console.log(JSON.stringify(record, null, 2));
  else {
    console.log(`Account entitlement activated for ${domain}`);
    console.log(`  Status: ${record.status}`);
    console.log(`  Device: ${record.device_label || record.device_id}`);
    console.log(`  Refresh after: ${record.refresh_after}`);
    console.log(`  Offline grace until: ${record.offline_grace_until}`);
  }
  return record;
}

async function syncOneLicense(entry, serverOverride = null) {
  const license = entry.license;
  if (license?.profile === external.PROFILE) {
    return syncExternalEntitlement(license.domain, serverOverride);
  }
  const key = licenseKey(license);
  const server = serverOverride || license.activation_server || license.license_server_url || null;
  if (!license.domain || !key || !server) {
    return {
      ...licenseStatusRecord(license, entry.file),
      synced: false,
      sync_error: 'missing domain, license key, or activation server',
    };
  }
  try {
    const activation = await requestActivation(license.domain, key, server);
    const merged = {
      ...license,
      ...activation,
      license_key: key,
      activation_server: server,
    };
    fs.writeFileSync(entry.file, JSON.stringify(merged, null, 2) + '\n');
    recordLicenseTrace('sync', merged, { server, synced: true });
    return { ...licenseStatusRecord(merged, entry.file), synced: true };
  } catch (e) {
    const syncError = redactLicenseKey(e.message, key);
    recordLicenseTrace('sync', license, { server, synced: false, sync_error: syncError });
    return {
      ...licenseStatusRecord(license, entry.file),
      synced: false,
      sync_error: syncError,
    };
  }
}

async function syncExternalEntitlement(domain, serverOverride = null) {
  const metadata = external.readMetadata(domain);
  if (!metadata?.entitlement_id || !metadata?.device_id) {
    return { ...(external.statusRecord(domain) || { domain }), synced: false, sync_error: 'activation metadata is incomplete' };
  }
  const server = serverOverride || metadata.server;
  if (!server) return { ...external.statusRecord(domain), synced: false, sync_error: 'activation server is missing' };
  try {
    const device = external.prepareDevice(domain, metadata.device_label);
    const challenge = await postAccountJson(
      accountApiUrl(server, `entitlements/${encodeURIComponent(metadata.entitlement_id)}/sync/challenge`),
      { device_id: metadata.device_id, device_signing_public_key: device.signing.public_key },
    );
    if (!challenge?.challenge) throw new Error('sync challenge is missing');
    const response = await postAccountJson(
      accountApiUrl(server, `entitlements/${encodeURIComponent(metadata.entitlement_id)}/sync`),
      external.syncProof({
        entitlementId: metadata.entitlement_id,
        deviceId: metadata.device_id,
        challenge: challenge.challenge,
        device,
      }),
    );
    if (response.status === 'revoked' || response.status === 'expired') {
      const grantName = metadata.grant_secret_ref || external.secretNames(domain).grant;
      require('../secret-store').deleteSync(grantName);
      fs.writeFileSync(
        external.metadataPath(domain),
        `${JSON.stringify({ ...metadata, status: response.status, synced_at: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600 },
      );
      return { ...external.statusRecord(domain), synced: true };
    }
    const assetPath = external.resolveAssetPath(domain);
    external.installActivation({ domain, server, assetPath, response, device });
    return { ...external.statusRecord(domain), synced: true };
  } catch (error) {
    return { ...external.statusRecord(domain), synced: false, sync_error: error.message };
  }
}

async function cmdLicenseSync(args = []) {
  const jsonMode = args.includes('--json');
  const server = argValue(args, '--server');
  const filtered = args.filter((arg) => !arg.startsWith('--') && arg !== server);
  const domain = filtered[0] || null;
  const entries = domain
    ? [{ file: licensePathForDomain(domain), license: readLicenseForDomain(domain) }].filter(
        (entry) => entry.license,
      )
    : listInstalledLicenses();
  const records = [];
  for (const entry of entries) records.push(await syncOneLicense(entry, server));
  if (jsonMode) {
    console.log(JSON.stringify(domain ? records[0] || null : records, null, 2));
    return;
  }
  if (!records.length) {
    console.log(domain ? `No installed license for ${domain}.` : 'No installed KDNA licenses.');
    return;
  }
  for (const record of records) {
    console.log(`${record.domain || '(unknown)'}  ${record.license_id || '(no license_id)'}`);
    console.log(`  Sync: ${record.synced ? 'ok' : 'failed'}`);
    console.log(`  Status: ${record.valid ? 'valid' : 'invalid'}`);
    if (record.sync_error) console.log(`  Error: ${record.sync_error}`);
  }
}

function licenseStatusRecord(license, file) {
  if (license?.profile === external.PROFILE) {
    return external.statusRecord(license.domain) || {
      domain: license.domain,
      profile: external.PROFILE,
      status: 'invalid',
      valid: false,
      issues: ['entitlement metadata is unavailable'],
      file,
    };
  }
  const fingerprint = machineFingerprint();
  const result = verifyLicense(license, null, fingerprint);
  return {
    domain: license.domain || null,
    license_id: license.license_id || null,
    issued_to: license.issued_to || null,
    valid: result.valid,
    issues: result.issues,
    require_machine_binding: !!license.require_machine_binding,
    machine_bound: !license.require_machine_binding || license.machine_fingerprint === fingerprint,
    expires_at: license.expires_at || null,
    revoked: license.revoked === true || license.status === 'revoked',
    file,
  };
}

function cmdLicenseStatus(args = []) {
  const jsonMode = args.includes('--json');
  const filtered = args.filter((a) => !a.startsWith('--'));
  const domain = filtered[0] || null;
  const entries = domain
    ? [{ file: licensePathForDomain(domain), license: readLicenseForDomain(domain) }].filter(
        (entry) => entry.license,
      )
    : listInstalledLicenses();
  const records = entries.map((entry) => licenseStatusRecord(entry.license, entry.file));

  if (jsonMode) {
    console.log(JSON.stringify(domain ? records[0] || null : records, null, 2));
    return;
  }

  if (!records.length) {
    console.log(domain ? `No installed license for ${domain}.` : 'No installed KDNA licenses.');
    return;
  }
  for (const record of records) {
    console.log(`${record.domain || '(unknown)'}  ${record.license_id || '(no license_id)'}`);
    console.log(`  Status: ${record.valid ? 'valid' : 'invalid'}`);
    if (record.issued_to) console.log(`  Issued to: ${record.issued_to}`);
    if (record.expires_at) console.log(`  Expires: ${record.expires_at}`);
    console.log(`  Machine bound: ${record.machine_bound ? 'yes' : 'no'}`);
    if (record.issues.length) {
      console.log(`  Issues: ${record.issues.join('; ')}`);
    }
    console.log(`  File: ${record.file}`);
  }
}

module.exports = {
  cmdLicenseGenerate,
  cmdLicenseVerify,
  cmdLicenseBind,
  cmdLicenseShow,
  cmdLicenseInstall,
  cmdLicenseStatus,
  cmdLicenseActivate,
  cmdLicenseSync,
  licenseDecryptOptionsForManifest,
  licensePathForDomain,
  machineFingerprint,
  redactLicenseKey,
  verifyLicense,
  postAccountJson,
};
