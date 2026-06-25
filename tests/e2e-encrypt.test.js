/**
 * e2e-encrypt.test.js — KDNA encrypt/decrypt round-trip tests.
 * Proves: demo --password → pack → load (correct pw) / load (no pw) / load (wrong pw).
 *
 * Requires @aikdna/kdna-core with decryptProtectedEntry + encryptProtectedEntry support (B4+).
 * CI skips these tests until kdna-core with B4 is published to npm.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Gate: skip if installed kdna-core lacks B4 decryption primitives
let HAS_B4_CORE = false;
try {
  const core = require('@aikdna/kdna-core');
  HAS_B4_CORE = typeof core.decryptProtectedEntry === 'function'
    && typeof core.encryptProtectedEntry === 'function';
} catch { /* core not installed or outdated */ }
if (!HAS_B4_CORE) {
  console.log('# SKIP e2e-encrypt: kdna-core lacks B4 decryption primitives — requires core with decryptProtectedEntry');
  process.exit(0);
}

const cliBin = path.join(__dirname, '..', 'src', 'cli.js');

let tmpDir, demoDir, kdnaFile;
const password = 'test-password-2026';

function runCli(args) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test.before(() => {
  const { mkdtempSync } = require('node:fs');
  tmpDir = mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-e2e-encrypt-'));
  demoDir = path.join(tmpDir, 'demo');
  kdnaFile = path.join(tmpDir, 'demo.kdna');

  // Create encrypted demo
  const r = runCli(['demo', 'minimal', demoDir, '--password', password]);
  assert.equal(r.status, 0, `demo failed: ${r.stderr}`);
  assert.ok(fs.existsSync(path.join(demoDir, 'payload.kdnab')), 'payload.kdnab missing');

  // Verify payload is NOT plaintext JSON
  const payloadRaw = fs.readFileSync(path.join(demoDir, 'payload.kdnab'), 'utf8');
  assert.ok(
    payloadRaw.includes('"profile":') && payloadRaw.includes('"kdna-password-protected-v1"'),
    'payload should be an encrypted envelope, not plaintext JSON',
  );

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
  const r = runCli(['load', kdnaFile, '--password=' + password, '--profile=compact', '--as=json']);
  assert.equal(r.status, 0, `load should succeed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'loaded');
  assert.ok(out.available_profiles.length > 0, 'should have available profiles');
});

test('load encrypted asset with correct password as prompt', () => {
  const r = runCli(['load', kdnaFile, '--password=' + password, '--profile=compact', '--as=prompt']);
  assert.equal(r.status, 0, `load prompt should succeed: ${r.stderr}`);
  assert.ok(r.stdout.length > 0, 'prompt output should not be empty');
});

// ─── Negative: no password ──────────────────────────────────────────────

test('load encrypted asset without password fails', () => {
  const r = runCli(['load', kdnaFile, '--profile=compact', '--as=json']);
  assert.notEqual(r.status, 0, 'load without password should fail');
  assert.ok(
    r.stderr.includes('password') || r.stderr.includes('decryption') || r.stderr.includes('KDNA_AUTH_PASSWORD'),
    `expected password-related error: ${r.stderr}`,
  );
});

// ─── Negative: wrong password ───────────────────────────────────────────

test('load encrypted asset with wrong password fails', () => {
  const r = runCli(['load', kdnaFile, '--password=wrong-password', '--profile=compact', '--as=json']);
  assert.notEqual(r.status, 0, 'load with wrong password should fail');
  assert.ok(
    r.stderr.includes('decrypt') || r.stderr.includes('KDNA_DECRYPT_FAILED') || r.stderr.includes('failed'),
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
  checksums.payload_digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  fs.writeFileSync(checksumsPath, JSON.stringify(checksums, null, 2));

  // Pack tampered asset
  const tamperedKdna = path.join(tmpDir, 'tampered.kdna');
  const r2 = runCli(['pack', tamperedDir, tamperedKdna]);
  assert.equal(r2.status, 0, `pack failed: ${r2.stderr}`);

  // Try to load — should fail on checksum mismatch
  const r = runCli(['load', tamperedKdna, '--password=' + password, '--profile=compact', '--as=json']);
  assert.notEqual(r.status, 0, 'tampered checksum should fail');
  assert.ok(
    r.stderr.includes('checksum') || r.stderr.includes('invalid') || r.stderr.includes('block'),
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

test('plan-load encrypted asset with --has-password shows ready', () => {
  const r = runCli(['plan-load', kdnaFile, '--has-password']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.state, 'ready');
  assert.equal(out.can_load_now, true);
});
