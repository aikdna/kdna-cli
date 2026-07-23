'use strict';

const fs = require('node:fs');
const path = require('node:path');

const core = require('@aikdna/kdna-core');
const localStatePaths = require('./local-state-paths');
const secretStore = require('./secret-store');

const PROFILE = 'kdna.entitlement.external-key';

class RuntimeEntitlementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeEntitlementError';
    this.code = code;
  }
}

function safeName(domain) {
  return domain.replace(/^@/u, '').replace(/[^A-Za-z0-9._-]+/gu, '-');
}

function metadataPath(domain) {
  return path.join(localStatePaths.licenses, `${safeName(domain)}.json`);
}

function secretNames(domain) {
  const prefix = `entitlement/${safeName(domain)}`;
  return {
    agreementPrivate: `${prefix}/device-agreement-private`,
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
  throw new RuntimeEntitlementError(
    'KDNA_SECRET_STORE_REQUIRED',
    'Account/device grants require an approved encrypted secret backend.',
  );
}

function readMetadata(domain) {
  const file = metadataPath(domain);
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.profile === PROFILE ? value : null;
  } catch {
    throw new RuntimeEntitlementError(
      'KDNA_GRANT_METADATA_INVALID',
      'Installed entitlement metadata is invalid.',
    );
  }
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
    throw new RuntimeEntitlementError(
      'KDNA_GRANT_NOT_INSTALLED',
      'The required device grant or private key is unavailable.',
    );
  }

  let grant;
  let issuerPublicKeys;
  try {
    grant = JSON.parse(grantValue);
    issuerPublicKeys = JSON.parse(issuerKeysValue);
  } catch {
    throw new RuntimeEntitlementError(
      'KDNA_GRANT_FORMAT_INVALID',
      'Stored device authorization material is invalid.',
    );
  }

  const material = assetAuthorizationMaterial(assetPath);
  const currentTime = options.now || new Date();
  const currentTimeMs = new Date(currentTime).getTime();
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : 0;
  if (lastSeenMs && currentTimeMs + 5 * 60 * 1000 < lastSeenMs) {
    throw new RuntimeEntitlementError(
      'KDNA_AUTH_CLOCK_ROLLBACK',
      'The system clock moved behind the last verified grant time.',
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
  if (!lastSeenMs || currentTimeMs > lastSeenMs) {
    secretStore.setSync(names.lastSeenAt, new Date(currentTimeMs).toISOString());
  }
  return session;
}

module.exports = {
  RuntimeEntitlementError,
  loadExternalAuthorization,
};
