const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cbor = require('cbor-x');
const core = require('@aikdna/kdna-core');

test(
  'external entitlement keeps private keys and grant out of metadata and loads a Capsule',
  {
    skip:
      typeof core.encryptExternalGrantEntry !== 'function'
        ? 'requires the RFC-0019 Core release'
        : false,
  },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-external-'));
    const old = {
      KDNA_HOME: process.env.KDNA_HOME,
      KDNA_SECRET_STORE_BACKEND: process.env.KDNA_SECRET_STORE_BACKEND,
      NODE_ENV: process.env.NODE_ENV,
    };
    process.env.KDNA_HOME = home;
    process.env.KDNA_SECRET_STORE_BACKEND = 'memory';
    process.env.NODE_ENV = 'test';
    for (const id of [
      '../src/paths',
      '../src/secret-store',
      '../src/external-entitlement',
      '../src/package-store',
    ]) {
      delete require.cache[require.resolve(id)];
    }
    const external = require('../src/external-entitlement');
    const assetDir = path.join(home, 'asset');
    fs.mkdirSync(assetDir, { recursive: true });
    try {
      const manifest = {
        kdna_version: '1.0',
        asset_id: 'kdna:fixture:cli-external',
        asset_uid: 'urn:uuid:00190000-0000-4000-8000-000000000002',
        name: '@fixture/cli-external',
        asset_type: 'fixture',
        title: 'CLI External Fixture',
        version: '1.0.0',
        judgment_version: '1.0.0',
        created_at: '2026-07-13T00:00:00Z',
        updated_at: '2026-07-13T00:00:00Z',
        creator: { name: 'Test' },
        compatibility: { min_loader_version: '0.16.0', profile: 'judgment-profile-v1' },
        payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: true },
        access: 'licensed',
        entitlement: { profile: 'account', offline: true, revocable: true },
        encryption: {
          profile: core.EXTERNAL_ENVELOPE_PROFILE,
          encrypted_entries: ['payload.kdnab'],
          key_grant_profile: core.EXTERNAL_GRANT_PROFILE,
        },
      };
      const plaintext = Buffer.from(
        cbor.encode({
          profile: 'judgment-profile-v1',
          core: { highest_question: 'Can the CLI load this?', axioms: [] },
        }),
      );
      const root = Buffer.alloc(32, 0x51);
      const envelope = core.encryptExternalGrantEntry(plaintext, {
        manifest,
        issuerRootKey: root,
        keyRef: 'assetkey:fixture:cli-external:1.0.0',
        issuerKeyId: 'fixture-root-v1',
        iv: Buffer.alloc(12, 0x52),
      });
      fs.writeFileSync(path.join(assetDir, 'mimetype'), core.MIMETYPE);
      fs.writeFileSync(path.join(assetDir, 'kdna.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(assetDir, 'payload.kdnab'), core.encodeExternalEnvelope(envelope));
      const checksums = core.buildChecksums(assetDir);
      fs.writeFileSync(path.join(assetDir, 'checksums.json'), JSON.stringify(checksums));

      const device = external.prepareDevice(manifest.name, 'Test Device');
      const issuer = crypto.generateKeyPairSync('ed25519');
      const issuerPublic = issuer.publicKey.export({ format: 'jwk' });
      const grant = core.createExternalKeyGrant({
        issuerRootKey: root,
        issuerSigningPrivateKey: issuer.privateKey,
        signingKeyId: 'fixture-signing-v1',
        issuer: 'https://fixture.invalid',
        entitlementId: 'ent_cli_01',
        accountId: 'acct_cli_01',
        deviceId: 'dev_cli_01',
        devicePublicKey: device.agreement.public_key,
        deviceSigningPublicKey: device.signing.public_key,
        manifest,
        envelope,
        assetDigest: checksums.asset_digest,
        issuedAt: new Date('2026-07-13T00:00:00Z'),
        refreshAfter: new Date('2027-07-13T00:00:00Z'),
        offlineGraceUntil: new Date('2027-07-14T00:00:00Z'),
        expiresAt: new Date('2027-07-15T00:00:00Z'),
      });
      external.installActivation({
        domain: manifest.name,
        server: 'https://fixture.invalid',
        assetPath: assetDir,
        response: {
          status: 'complete',
          account_id: 'acct_cli_01',
          device_id: 'dev_cli_01',
          issuer_public_keys: { 'fixture-signing-v1': `ed25519:${issuerPublic.x}` },
          grant,
        },
        device,
      });

      const metadataText = fs.readFileSync(external.metadataPath(manifest.name), 'utf8');
      assert.equal(metadataText.includes('wrapped_cek'), false);
      assert.equal(metadataText.includes(device.agreement.private_key), false);
      assert.equal(metadataText.includes(grant.signature), false);
      assert.equal(metadataText.includes('issuer_public_keys'), false);

      const session = external.loadExternalAuthorization(assetDir, manifest, { now: new Date() });
      const capsule = core.loadAuthorized(assetDir, {
        profile: 'compact',
        as: 'json',
        entitlement: session.entitlement,
        decryptEntry: session.decryptEntry,
      });
      assert.equal(capsule.type, 'kdna.context.capsule');
      assert.equal(JSON.stringify(capsule).includes('wrapped_cek'), false);
      session.dispose();
      const names = external.secretNames(manifest.name);
      const secretStore = require('../src/secret-store');
      secretStore.setSync(names.statusVersion, '2');
      assert.throws(
        () => external.loadExternalAuthorization(assetDir, manifest, { now: new Date() }),
        (error) => error.code === 'KDNA_GRANT_ROLLBACK_DETECTED',
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
