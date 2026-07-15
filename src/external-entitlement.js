/**
 * RFC-0019 account/device entitlement storage and runtime authorization.
 *
 * Private device keys and signed grants live only in SecretStore. The JSON
 * metadata file contains public keys, opaque IDs, status, and secret references.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const core = require('@aikdna/kdna-core');
const secretStore = require('./secret-store');
const PATHS = require('./paths');
const { resolveAsset } = require('./package-store');

const PROFILE = 'kdna.entitlement.external-key';
const PROFILE_VERSION = '0.1.0';
const ACTIVATION_PROOF_PROFILE = 'kdna.proof.device-activation';
const SYNC_PROOF_PROFILE = 'kdna.proof.device-sync';

class ExternalEntitlementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExternalEntitlementError';
    this.code = code;
  }
}

function safeName(domain) {
  return domain.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

function metadataPath(domain) {
  return path.join(PATHS.licenses, `${safeName(domain)}.json`);
}

function secretNames(domain) {
  const prefix = `entitlement/${safeName(domain)}`;
  return {
    agreementPrivate: `${prefix}/device-agreement-private`,
    signingPrivate: `${prefix}/device-signing-private`,
    grant: `${prefix}/grant`,
    issuerPublicKeys: `${prefix}/issuer-public-keys`,
    statusVersion: `${prefix}/status-version`,
    lastSeenAt: `${prefix}/last-seen-at`,
  };
}

function assertSecureSecretStore() {
  const backend = secretStore.backendName();
  if (['keychain', 'secret-service', 'pass'].includes(backend)) return;
  if (backend === 'memory' && process.env.NODE_ENV === 'test') return;
  throw new ExternalEntitlementError(
    'KDNA_SECRET_STORE_REQUIRED',
    'Account/device grants require macOS Keychain, Linux Secret Service, or an encrypted pass store; plaintext and environment backends are not permitted.',
  );
}

function readMetadata(domain) {
  const file = metadataPath(domain);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.profile === PROFILE ? value : null;
  } catch {
    throw new ExternalEntitlementError(
      'KDNA_GRANT_METADATA_INVALID',
      'installed entitlement metadata is invalid',
    );
  }
}

function writeMetadata(domain, metadata) {
  fs.mkdirSync(PATHS.licenses, { recursive: true, mode: 0o700 });
  const file = metadataPath(domain);
  fs.writeFileSync(file, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function prepareDevice(domain, label = null) {
  assertSecureSecretStore();
  const names = secretNames(domain);
  const existing = readMetadata(domain);
  if (
    existing?.device_public_key &&
    existing?.device_signing_public_key &&
    secretStore.getSync(names.agreementPrivate) &&
    secretStore.getSync(names.signingPrivate)
  ) {
    return {
      label: label || existing.device_label,
      agreement: {
        public_key: existing.device_public_key,
        private_key: secretStore.getSync(names.agreementPrivate),
      },
      signing: {
        public_key: existing.device_signing_public_key,
        private_key: secretStore.getSync(names.signingPrivate),
      },
    };
  }

  const keys = core.generateDeviceKeyPairs();
  secretStore.setSync(names.agreementPrivate, keys.agreement.private_key);
  secretStore.setSync(names.signingPrivate, keys.signing.private_key);
  writeMetadata(domain, {
    profile: PROFILE,
    domain,
    status: 'pending_activation',
    device_label: label || require('node:os').hostname(),
    device_public_key: keys.agreement.public_key,
    device_signing_public_key: keys.signing.public_key,
    grant_secret_ref: names.grant,
    installed_at: new Date().toISOString(),
  });
  return { label: label || require('node:os').hostname(), ...keys };
}

function rawPrivateKey(crv, privateValue, publicValue) {
  const d = privateValue.split(':', 2)[1];
  const x = publicValue.split(':', 2)[1];
  return crypto.createPrivateKey({ key: { kty: 'OKP', crv, d, x }, format: 'jwk' });
}

function activationProof({ activationId, challenge, device }) {
  const payload = {
    profile: ACTIVATION_PROOF_PROFILE,
    profile_version: PROFILE_VERSION,
    activation_id: activationId,
    challenge,
    device_public_key: device.agreement.public_key,
    device_signing_public_key: device.signing.public_key,
  };
  const key = rawPrivateKey('Ed25519', device.signing.private_key, device.signing.public_key);
  const signature = crypto.sign(null, Buffer.from(core.canonicalJson(payload), 'utf8'), key);
  return { ...payload, signature: `ed25519:${signature.toString('base64url')}` };
}

function syncProof({ entitlementId, deviceId, challenge, device }) {
  const payload = {
    profile: SYNC_PROOF_PROFILE,
    profile_version: PROFILE_VERSION,
    entitlement_id: entitlementId,
    device_id: deviceId,
    challenge,
    device_public_key: device.agreement.public_key,
    device_signing_public_key: device.signing.public_key,
  };
  const key = rawPrivateKey('Ed25519', device.signing.private_key, device.signing.public_key);
  const signature = crypto.sign(null, Buffer.from(core.canonicalJson(payload), 'utf8'), key);
  return { ...payload, signature: `ed25519:${signature.toString('base64url')}` };
}

function resolveAssetPath(domain, assetOption = null) {
  const resolved = resolveAsset(assetOption || domain);
  if (!resolved?.asset_path) {
    throw new ExternalEntitlementError(
      'KDNA_ASSET_NOT_FOUND',
      `Install the encrypted asset or pass --asset <path> before activating ${domain}.`,
    );
  }
  return resolved.asset_path;
}

function assetAuthorizationMaterial(assetPath) {
  const resolvedAssetPath = path.resolve(assetPath);
  const assetBytes = fs.readFileSync(resolvedAssetPath);
  const layout = core.readLayout(resolvedAssetPath);
  const checksums = layout.map['checksums.json']
    ? JSON.parse(layout.map['checksums.json'].toString('utf8'))
    : null;
  return {
    manifest: layout.manifest,
    checksums,
    envelope: layout.map['payload.kdnab'],
    assetDigest: core.computeAssetDigest(assetBytes),
  };
}

function installActivation({ domain, server, assetPath, response, device }) {
  assertSecureSecretStore();
  if (
    !response?.grant ||
    !response?.account_id ||
    !response?.device_id ||
    !response?.issuer_public_keys
  ) {
    throw new ExternalEntitlementError(
      'KDNA_ACTIVATION_RESPONSE_INVALID',
      'activation response is missing signed grant bindings',
    );
  }
  const material = assetAuthorizationMaterial(assetPath);
  const names = secretNames(domain);
  let issuerPublicKeys = response.issuer_public_keys;
  const pinnedKeys = secretStore.getSync(names.issuerPublicKeys);
  const storedStatusVersion = Number(secretStore.getSync(names.statusVersion) || 0);
  if (pinnedKeys) {
    try {
      issuerPublicKeys = JSON.parse(pinnedKeys);
    } catch {
      throw new ExternalEntitlementError(
        'KDNA_GRANT_ISSUER_UNKNOWN',
        'pinned issuer keys are invalid',
      );
    }
  }
  const session = core.authorizeExternalKeyGrant({
    grant: response.grant,
    issuerPublicKeys,
    manifest: material.manifest,
    expectedAssetDigest: material.assetDigest,
    envelope: material.envelope,
    deviceAgreementKey: device.agreement,
    expectedAccountId: response.account_id,
    expectedDeviceId: response.device_id,
    expectedDeviceSigningPublicKey: device.signing.public_key,
    minimumStatusVersion: storedStatusVersion || undefined,
    networkAvailable: true,
    allowOffline: true,
  });
  session.dispose();

  if (!pinnedKeys) secretStore.setSync(names.issuerPublicKeys, JSON.stringify(issuerPublicKeys));
  secretStore.setSync(names.grant, JSON.stringify(response.grant));
  secretStore.setSync(names.statusVersion, String(response.grant.status_version));
  secretStore.setSync(names.lastSeenAt, new Date().toISOString());
  const metadata = {
    profile: PROFILE,
    domain,
    server,
    account_id: response.account_id,
    entitlement_id: response.grant.entitlement_id,
    device_id: response.device_id,
    device_label: device.label,
    device_public_key: device.agreement.public_key,
    device_signing_public_key: device.signing.public_key,
    issuer_keys_secret_ref: names.issuerPublicKeys,
    grant_secret_ref: names.grant,
    status: response.grant.status,
    status_version: response.grant.status_version,
    refresh_after: response.grant.refresh_after,
    offline_grace_until: response.grant.offline_grace_until,
    expires_at: response.grant.expires_at,
    asset_digest: response.grant.asset.digest,
    installed_at: new Date().toISOString(),
  };
  return { metadata, file: writeMetadata(domain, metadata) };
}

function loadExternalAuthorization(assetPath, manifest, options = {}) {
  if (!['account', 'org'].includes(manifest?.entitlement?.profile)) return null;
  const domain = manifest.name || manifest.asset_id;
  const metadata = readMetadata(domain);
  if (!metadata || metadata.status === 'pending_activation') return null;
  assertSecureSecretStore();
  const names = secretNames(domain);
  const grantValue = secretStore.getSync(metadata.grant_secret_ref || names.grant);
  const agreementPrivate = secretStore.getSync(names.agreementPrivate);
  const issuerKeysValue = secretStore.getSync(
    metadata.issuer_keys_secret_ref || names.issuerPublicKeys,
  );
  const statusVersion = Number(secretStore.getSync(names.statusVersion));
  const lastSeenAt = secretStore.getSync(names.lastSeenAt);
  if (!grantValue || !agreementPrivate || !issuerKeysValue || !Number.isInteger(statusVersion)) {
    throw new ExternalEntitlementError(
      'KDNA_GRANT_NOT_INSTALLED',
      'device grant, issuer pins, or private key is missing from SecretStore',
    );
  }
  let grant;
  try {
    grant = JSON.parse(grantValue);
  } catch {
    throw new ExternalEntitlementError(
      'KDNA_GRANT_FORMAT_INVALID',
      'stored device grant is invalid',
    );
  }
  let issuerPublicKeys;
  try {
    issuerPublicKeys = JSON.parse(issuerKeysValue);
  } catch {
    throw new ExternalEntitlementError(
      'KDNA_GRANT_ISSUER_UNKNOWN',
      'pinned issuer keys are invalid',
    );
  }
  const material = assetAuthorizationMaterial(assetPath);
  const currentTime = options.now || new Date();
  const currentTimeMs = new Date(currentTime).getTime();
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : 0;
  if (lastSeenMs && currentTimeMs + 5 * 60 * 1000 < lastSeenMs) {
    throw new ExternalEntitlementError(
      'KDNA_AUTH_CLOCK_ROLLBACK',
      'system clock moved behind the last verified grant time',
    );
  }
  const session = core.authorizeExternalKeyGrant({
    grant,
    issuerPublicKeys,
    manifest: material.manifest,
    expectedAssetDigest: material.assetDigest,
    envelope: material.envelope,
    deviceAgreementKey: {
      public_key: metadata.device_public_key,
      private_key: agreementPrivate,
    },
    expectedAccountId: metadata.account_id,
    expectedDeviceId: metadata.device_id,
    expectedDeviceSigningPublicKey: metadata.device_signing_public_key,
    minimumStatusVersion: statusVersion,
    networkAvailable: options.networkAvailable === true,
    allowOffline: options.allowOffline !== false,
    now: currentTime,
  });
  if (!lastSeenMs || currentTimeMs > lastSeenMs)
    secretStore.setSync(names.lastSeenAt, new Date(currentTimeMs).toISOString());
  return session;
}

function removeExternalEntitlement(domain) {
  const names = secretNames(domain);
  for (const name of Object.values(names)) secretStore.deleteSync(name);
  try {
    fs.unlinkSync(metadataPath(domain));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function statusRecord(domain) {
  const metadata = readMetadata(domain);
  if (!metadata) return null;
  const expired = metadata.expires_at && Date.now() > Date.parse(metadata.expires_at);
  const valid = metadata.status === 'active' && !expired;
  return {
    domain,
    profile: metadata.profile,
    status: metadata.status,
    valid,
    issues: valid ? [] : [expired ? 'grant expired' : `grant status is ${metadata.status}`],
    entitlement_id: metadata.entitlement_id || null,
    device_id: metadata.device_id || null,
    device_label: metadata.device_label || null,
    refresh_after: metadata.refresh_after || null,
    offline_grace_until: metadata.offline_grace_until || null,
    expires_at: metadata.expires_at || null,
    server: metadata.server || null,
    machine_bound: true,
    require_machine_binding: true,
    revoked: metadata.status === 'revoked',
    file: metadataPath(domain),
  };
}

module.exports = {
  PROFILE,
  ExternalEntitlementError,
  metadataPath,
  secretNames,
  assertSecureSecretStore,
  readMetadata,
  prepareDevice,
  activationProof,
  syncProof,
  resolveAssetPath,
  assetAuthorizationMaterial,
  installActivation,
  loadExternalAuthorization,
  removeExternalEntitlement,
  statusRecord,
};
