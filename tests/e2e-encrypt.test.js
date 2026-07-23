/**
 * e2e-encrypt.test.js — KDNA encrypt/decrypt round-trip tests.
 * Proves: password-stdin demo → pack → load (correct / missing / wrong password).
 *
 * Requires the current @aikdna/kdna-core encrypted-envelope APIs.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const core = require('@aikdna/kdna-core');

const cliBin = path.join(__dirname, '..', 'src', 'cli.js');

let tmpDir, demoDir, kdnaFile;
const password = 'test-password-2026';

function runCli(args, input) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
}

function runWithPassword(args, value) {
  return runCli([...args, '--password-stdin'], `${value}\n`);
}

test.before(() => {
  const { mkdtempSync } = require('node:fs');
  tmpDir = mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-e2e-encrypt-'));
  demoDir = path.join(tmpDir, 'demo');
  kdnaFile = path.join(tmpDir, 'demo.kdna');

  // Create encrypted demo
  const r = runWithPassword(['demo', 'minimal', demoDir], password);
  assert.equal(r.status, 0, `demo failed: ${r.stderr}`);
  assert.ok(fs.existsSync(path.join(demoDir, 'payload.kdnab')), 'payload.kdnab missing');

  // Verify the current CBOR encrypted-envelope contract through Core's public
  // decoder/profile validator. Do not duplicate the wire parser in CLI tests.
  const manifest = JSON.parse(fs.readFileSync(path.join(demoDir, 'kdna.json'), 'utf8'));
  const encryptedPayload = fs.readFileSync(path.join(demoDir, 'payload.kdnab'));
  assert.equal(manifest.payload.encoding, 'cbor');
  assert.equal(manifest.payload.encrypted, true);
  assert.equal(manifest.encryption.profile, core.PASSWORD_PROTECTED_PROFILE);
  assert.equal(manifest.encryption.profile_version, core.ENCRYPTION_PROFILE_VERSION);
  assert.deepEqual(manifest.encryption.encrypted_entries, ['payload.kdnab']);
  const decryptedPayload = core.decryptProtectedEntry(encryptedPayload, {
    entryName: 'payload.kdnab',
    manifest,
    password,
  });
  assert.ok(Buffer.isBuffer(decryptedPayload));
  assert.ok(decryptedPayload.length > 0, 'Core should decode and decrypt the encrypted payload');

  // Pack
  const r2 = runCli(['pack', demoDir, kdnaFile]);
  assert.equal(r2.status, 0, `pack failed: ${r2.stderr}`);
  assert.ok(fs.existsSync(kdnaFile), 'packed .kdna missing');
});

test.after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Happy path ──────────────────────────────────────────────────────────

test('load encrypted asset with correct password returns content', () => {
  const r = runWithPassword(['load', kdnaFile, '--profile=compact', '--as=json'], password);
  assert.equal(r.status, 0, `load should succeed: ${r.stderr}`);
  const capsule = JSON.parse(r.stdout);
  assert.equal(capsule.type, 'kdna.runtime-capsule');
  assert.equal(capsule.contract_version, '0.1.0');
  assert.equal(capsule.asset.asset_id, 'kdna:example:deployment-review');
  assert.equal(capsule.asset.version, '1.0.0');
  assert.equal(capsule.asset.judgment_version, '1.0.0');
  for (const name of ['asset', 'content', 'runtime_entry_set']) {
    assert.match(capsule.digests[name].value, /^sha256:[0-9a-f]{64}$/);
  }
  assert.equal(capsule.digests.runtime_entry_set.comparison.state, 'matched');
  assert.equal(
    capsule.digests.runtime_entry_set.comparison.expected,
    capsule.digests.runtime_entry_set.value,
  );
  assert.equal(capsule.profile, 'compact');
  assert.ok(capsule.context.axioms.length > 0, 'compact judgment context should not be empty');
});

test('load encrypted asset with correct password as prompt', () => {
  const r = runWithPassword(['load', kdnaFile, '--profile=compact', '--as=prompt'], password);
  assert.equal(r.status, 0, `load prompt should succeed: ${r.stderr}`);
  assert.ok(r.stdout.length > 0, 'prompt output should not be empty');
});

// ─── Negative: no password ──────────────────────────────────────────────

test('load encrypted asset without password fails', () => {
  const r = runCli(['load', kdnaFile, '--profile=compact', '--as=json']);
  assert.notEqual(r.status, 0, 'load without password should fail');
  assert.ok(
    r.stderr.includes('password') ||
      r.stderr.includes('decryption') ||
      r.stderr.includes('KDNA_AUTH_PASSWORD'),
    `expected password-related error: ${r.stderr}`,
  );
});

// ─── Negative: wrong password ───────────────────────────────────────────

test('load encrypted asset with wrong password fails', () => {
  const r = runWithPassword(['load', kdnaFile, '--profile=compact', '--as=json'], 'wrong-password');
  assert.notEqual(r.status, 0, 'load with wrong password should fail');
  assert.ok(
    r.stderr.includes('decrypt') ||
      r.stderr.includes('KDNA_DECRYPT_FAILED') ||
      r.stderr.includes('failed'),
    `expected decrypt-failure error: ${r.stderr}`,
  );
});

// ─── Negative: tampered checksum ──────────────────────────────────────

test('tampered checksum fails to load', () => {
  const tamperedDir = path.join(tmpDir, 'tampered');
  fs.mkdirSync(tamperedDir, { recursive: true });

  // Copy original demo files
  for (const f of fs.readdirSync(demoDir)) {
    fs.copyFileSync(path.join(demoDir, f), path.join(tamperedDir, f));
  }

  // Tamper with checksums.json to make payload_digest invalid
  const checksumsPath = path.join(tamperedDir, 'checksums.json');
  const checksums = JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
  checksums.payload_digest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  fs.writeFileSync(checksumsPath, JSON.stringify(checksums, null, 2));

  // Pack tampered asset
  const tamperedKdna = path.join(tmpDir, 'tampered.kdna');
  const r2 = runCli(['pack', tamperedDir, tamperedKdna]);
  assert.equal(r2.status, 0, `pack failed: ${r2.stderr}`);

  // Try to load — should fail on checksum mismatch
  const r = runWithPassword(['load', tamperedKdna, '--profile=compact', '--as=json'], password);
  assert.notEqual(r.status, 0, 'tampered checksum should fail');
  assert.ok(
    r.stderr.includes('checksum') ||
      r.stderr.includes('invalid') ||
      r.stderr.includes('block') ||
      r.stderr.includes('failed safely'),
    `expected checksum-related failure: ${r.stderr}`,
  );
});

// ─── validate + plan-load on encrypted asset ────────────────────────────

test('validate encrypted asset returns overall_valid=true', () => {
  const r = runCli(['validate', kdnaFile]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.overall_valid, true);
});

test('plan-load encrypted asset without password shows needs_password', () => {
  const r = runCli(['plan-load', kdnaFile]);
  assert.equal(r.status, 3, r.stderr); // exit 3 = blocking
  const out = JSON.parse(r.stdout);
  assert.equal(out.access, 'licensed');
  assert.equal(out.state, 'needs_password');
  assert.equal(out.can_load_now, false);
});

test('plan-load encrypted asset with --has-password remains unverified', () => {
  const r = runCli(['plan-load', kdnaFile, '--has-password']);
  assert.equal(r.status, 3, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.state, 'needs_password');
  assert.equal(out.can_load_now, false);
  assert.ok(out.issues.some((issue) => issue.code === 'KDNA_AUTH_PASSWORD_UNVERIFIED'));
});
