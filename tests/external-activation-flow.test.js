const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const cbor = require('cbor-x');
const core = require('@aikdna/kdna-core');

test(
  'browser device activation installs a verified grant without logging key material',
  {
    skip:
      typeof core.encryptExternalGrantEntry !== 'function'
        ? 'requires the RFC-0019 Core release'
        : false,
  },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-device-flow-'));
    const previous = {
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
      '../src/cmds/trace',
      '../src/cmds/license',
    ])
      delete require.cache[require.resolve(id)];

    const domain = '@fixture/device-flow';
    const source = path.join(home, 'source');
    const assetFile = path.join(home, 'device-flow.kdna');
    fs.mkdirSync(source, { recursive: true });
    const manifest = {
      format_version: '0.1.0',
      asset_id: 'kdna:fixture:device-flow',
      asset_uid: 'urn:uuid:00190000-0000-4000-8000-000000000003',
      name: domain,
      asset_type: 'fixture',
      title: 'Device Flow Fixture',
      version: '1.0.0',
      judgment_version: '1.0.0',
      created_at: '2026-07-13T00:00:00Z',
      updated_at: '2026-07-13T00:00:00Z',
      creator: { name: 'Test' },
      compatibility: {
        min_loader_version: '0.18.1',
        profile: 'kdna.payload.judgment',
        profile_version: '0.1.0',
      },
      payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: true },
      access: 'licensed',
      entitlement: { profile: 'account', offline: true, revocable: true },
      encryption: {
        profile: core.EXTERNAL_ENVELOPE_PROFILE,
        profile_version: core.EXTERNAL_GRANT_CONTRACT_VERSION,
        encrypted_entries: ['payload.kdnab'],
        key_grant_profile: core.EXTERNAL_GRANT_PROFILE,
      },
    };
    const root = Buffer.alloc(32, 0x61);
    const envelope = core.encryptExternalGrantEntry(
      cbor.encode({
        profile: 'kdna.payload.judgment',
        profile_version: '0.1.0',
        core: {
          highest_question: 'Is this device authorized?',
          axioms: [],
          boundaries: [],
        },
        patterns: [],
        scenarios: [],
        cases: [],
        reasoning: { self_check: [], failure_modes: [] },
      }),
      {
        manifest,
        issuerRootKey: root,
        keyRef: 'assetkey:fixture:device-flow:1.0.0',
        issuerKeyId: 'fixture-root-v1',
        iv: Buffer.alloc(12, 0x62),
      },
    );
    fs.writeFileSync(path.join(source, 'mimetype'), core.MIMETYPE);
    fs.writeFileSync(path.join(source, 'kdna.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(source, 'payload.kdnab'), core.encodeExternalEnvelope(envelope));
    const checksums = core.buildChecksums(source);
    fs.writeFileSync(path.join(source, 'checksums.json'), JSON.stringify(checksums));
    core.pack(source, assetFile);
    const assetDigest = core.computeAssetDigest(fs.readFileSync(assetFile));

    const issuer = crypto.generateKeyPairSync('ed25519');
    const issuerPublic = issuer.publicKey.export({ format: 'jwk' });
    let activation;
    const server = http.createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const input = JSON.parse(raw);
        if (request.url === '/api/v1/device-activations') {
          activation = {
            id: 'act_fixture_01',
            challenge: 'challenge_fixture_01',
            devicePublicKey: input.device_public_key,
            deviceSigningPublicKey: input.device_signing_public_key,
          };
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              activation_id: activation.id,
              challenge: activation.challenge,
              user_code: 'TEST-CODE',
              verification_uri: 'https://example.invalid/activate?code=TEST-CODE',
              expires_at: new Date(Date.now() + 60000).toISOString(),
              interval: 1,
            }),
          );
          return;
        }
        if (request.url === `/api/v1/device-activations/${activation.id}/poll`) {
          const signature = Buffer.from(input.signature.slice('ed25519:'.length), 'base64url');
          const signed = { ...input };
          delete signed.signature;
          const publicKey = crypto.createPublicKey({
            key: {
              kty: 'OKP',
              crv: 'Ed25519',
              x: activation.deviceSigningPublicKey.slice('ed25519:'.length),
            },
            format: 'jwk',
          });
          assert.equal(
            crypto.verify(null, Buffer.from(core.canonicalJson(signed)), publicKey, signature),
            true,
          );
          const grant = core.createExternalKeyGrant({
            issuerRootKey: root,
            issuerSigningPrivateKey: issuer.privateKey,
            signingKeyId: 'fixture-signing-v1',
            issuer: 'https://example.invalid',
            entitlementId: 'ent_fixture_01',
            accountId: 'acct_fixture_01',
            deviceId: 'dev_fixture_01',
            devicePublicKey: activation.devicePublicKey,
            deviceSigningPublicKey: activation.deviceSigningPublicKey,
            manifest,
            envelope,
            assetDigest,
            refreshAfter: new Date(Date.now() + 86400000),
            offlineGraceUntil: new Date(Date.now() + 172800000),
            expiresAt: new Date(Date.now() + 259200000),
          });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              status: 'complete',
              account_id: 'acct_fixture_01',
              device_id: 'dev_fixture_01',
              grant,
              issuer_public_keys: { 'fixture-signing-v1': `ed25519:${issuerPublic.x}` },
            }),
          );
          return;
        }
        response.writeHead(404).end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const output = [];
    const originalLog = console.log;
    console.log = (...values) => output.push(values.join(' '));
    try {
      const { port } = server.address();
      const { cmdLicenseActivate } = require('../src/cmds/license');
      const result = await cmdLicenseActivate([
        domain,
        '--server',
        `http://127.0.0.1:${port}`,
        '--asset',
        assetFile,
        '--no-browser',
        '--json',
      ]);
      assert.equal(result.status, 'active');
      const packageStore = require('../src/package-store');
      packageStore.installAsset({ sourcePath: assetFile, name: domain, version: '1.0.0' });
      let discoveryText = '';
      const originalWrite = process.stdout.write;
      process.stdout.write = (chunk) => {
        discoveryText += String(chunk);
        return true;
      };
      try {
        require('../src/agent').cmdAvailable(['--json']);
      } finally {
        process.stdout.write = originalWrite;
      }
      const discovered = JSON.parse(discoveryText);
      assert.equal(discovered[0].name, domain);
      assert.equal(discovered[0].loadable, true);
      assert.equal(discovered[0].load_state, 'ready');

      const external = require('../src/external-entitlement');
      const metadata = fs.readFileSync(external.metadataPath(domain), 'utf8');
      const traceDir = path.join(home, 'traces');
      const traceFiles = fs.existsSync(traceDir) ? fs.readdirSync(traceDir) : [];
      const trace = traceFiles
        .map((file) => fs.readFileSync(path.join(traceDir, file), 'utf8'))
        .join('');
      const combined = `${output.join('\n')}\n${metadata}\n${trace}`;
      assert.doesNotMatch(combined, /wrapped_cek|device-agreement-private|device-signing-private/);
      assert.doesNotMatch(combined, /"signature"/);

      const session = external.loadExternalAuthorization(assetFile, manifest);
      const capsule = core.loadAuthorized(assetFile, {
        profile: 'compact',
        as: 'json',
        entitlement: session.entitlement,
        decryptEntry: session.decryptEntry,
      });
      assert.equal(capsule.type, 'kdna.runtime-capsule');
      session.dispose();
    } finally {
      console.log = originalLog;
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
