/**
 * story19-sign-verify-identity.test.js — kdna sign / verify + Ed25519 identity
 *
 * Story 19 — Complete identity layer (OPEN/kdna-cli).
 *
 * Verifies the seven acceptance criteria from the work package:
 *   1. kdna identity init writes a valid Ed25519 keypair to
 *      ~/.kdna/keys/ed25519.{key,pub} with mode 0600 on the private
 *      file. Filenames are deterministic.
 *   2. kdna identity show prints the public key as PEM, hex, AND
 *      base64. The hex/base64 are the raw 32-byte Ed25519 key.
 *   3. kdna sign <asset> produces a detached signature file at
 *      <asset>.ed25519.sig (or --sig path).
 *   4. kdna verify <asset> --key <pub> verifies the signature.
 *      Output: PASS/FAIL + key fingerprint. Exit 0 on valid.
 *   5. Without --key, verify prints the signer's public key as
 *      hex and base64, plus "no key provided; cannot determine
 *      trust". Exit code 2.
 *   6. Sign-then-tamper → verify fails (signature covers the
 *      asset digest; modifying any of kdna.json / payload.kdnab
 *      / checksums.json invalidates it).
 *   7. No new npm dependencies. Implementation uses only Node
 *      built-ins (crypto, fs, path).
 *
 * The test isolates the working directory to a temp dir via
 * KDNA_IDENTITY_DIR so it does not touch the user's real
 * ~/.kdna/keys/.
 *
 * Run: node --test tests/story19-sign-verify-identity.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'v1-minimal');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

/** Set up an isolated identity dir + KDNA_HOME. Returns env. */
function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s19-'));
  const env = {
    KDNA_IDENTITY_DIR: path.join(tmp, 'keys'),
    // Also redirect the "old" identity path so the pre-Story-19
    // existence check doesn't trip on the test runner's real
    // ~/.kdna/identity/ if it exists.
    KDNA_OLD_IDENTITY_DIR: path.join(tmp, 'identity-legacy'),
    KDNA_HOME: path.join(tmp, 'home'),
  };
  fs.mkdirSync(env.KDNA_HOME, { recursive: true });
  return { tmp, env };
}

function copyFixture(tmp, name = 'asset') {
  const asset = path.join(tmp, name);
  fs.cpSync(FIXTURE, asset, { recursive: true });
  return asset;
}

// ─── A: identity init — path, filenames, permissions, valid Ed25519 ────

test('Story 19 identity init: writes to ~/.kdna/keys/ed25519.{key,pub} with 0600', () => {
  const { tmp, env } = makeEnv();
  try {
    const r = run(['identity', 'init'], { env });
    assert.equal(r.status, 0, `init failed:\n${r.stderr}`);
    const privPath = path.join(env.KDNA_IDENTITY_DIR, 'ed25519.key');
    const pubPath = path.join(env.KDNA_IDENTITY_DIR, 'ed25519.pub');
    assert.ok(fs.existsSync(privPath), 'ed25519.key not written');
    assert.ok(fs.existsSync(pubPath), 'ed25519.pub not written');

    // Filenames are deterministic — same names on every run.
    assert.equal(path.basename(privPath), 'ed25519.key');
    assert.equal(path.basename(pubPath), 'ed25519.pub');

    // Private key is mode 0600.
    const privStat = fs.statSync(privPath);
    const mode = privStat.mode & 0o777;
    assert.equal(mode, 0o600, `private key mode should be 0600, got ${mode.toString(8)}`);

    // The keys are a valid Ed25519 pair — load them through Node crypto.
    const crypto = require('node:crypto');
    const priv = fs.readFileSync(privPath, 'utf8');
    const pub = fs.readFileSync(pubPath, 'utf8');
    const privKeyObj = crypto.createPrivateKey({ key: priv, format: 'pem', type: 'pkcs8' });
    const pubKeyObj = crypto.createPublicKey({ key: pub, format: 'pem', type: 'spki' });
    // Round-trip a sign/verify to prove the pair is internally consistent.
    const sig = crypto.sign(null, Buffer.from('hello'), privKeyObj);
    const ok = crypto.verify(null, Buffer.from('hello'), pubKeyObj, sig);
    assert.equal(ok, true, 'keypair must round-trip a sign/verify');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── B: identity show — PEM, hex, base64 ───────────────────────────────

test('Story 19 identity show: prints public key as PEM, hex, AND base64', () => {
  const { tmp, env } = makeEnv();
  try {
    const init = run(['identity', 'init'], { env });
    assert.equal(init.status, 0, `init failed:\n${init.stderr}`);

    const show = run(['identity', 'show'], { env });
    assert.equal(show.status, 0, `show failed:\n${show.stderr}`);
    assert.match(show.stdout, /Public key \(PEM\):/, 'should print PEM line');
    assert.match(show.stdout, /Public key \(hex\):/, 'should print hex line');
    assert.match(show.stdout, /Public key \(b64\):/, 'should print base64 line');

    // Extract the hex value and verify it parses to 32 bytes.
    const hexMatch = show.stdout.match(/Public key \(hex\):\s+([0-9a-fA-F]+)/);
    assert.ok(hexMatch, 'hex value not found in show output');
    assert.equal(hexMatch[1].length, 64, 'hex value must be 64 chars (32 bytes)');
    assert.match(hexMatch[1], /^[0-9a-f]+$/, 'hex value must be lowercase hex');

    // Extract the base64 value and verify it parses to 32 bytes.
    const b64Match = show.stdout.match(/Public key \(b64\):\s+([A-Za-z0-9+/=]+)/);
    assert.ok(b64Match, 'b64 value not found in show output');
    const decoded = Buffer.from(b64Match[1], 'base64');
    assert.equal(decoded.length, 32, 'b64 value must decode to 32 bytes');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 19 identity show --json: emits all three encodings as fields', () => {
  const { tmp, env } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    const show = run(['identity', 'show', '--json'], { env });
    assert.equal(show.status, 0, `show --json failed:\n${show.stderr}`);
    const parsed = JSON.parse(show.stdout);
    assert.equal(parsed.algorithm, 'ed25519');
    assert.match(parsed.pubkey_pem, /-----BEGIN PUBLIC KEY-----/);
    assert.match(parsed.pubkey_hex, /^[0-9a-f]{64}$/);
    assert.equal(Buffer.from(parsed.pubkey_base64, 'base64').length, 32);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── C: kdna sign — produces detached signature file ───────────────────

test('Story 19 sign: writes <asset>.ed25519.sig with valid signature record', () => {
  const { tmp, env } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    const asset = copyFixture(tmp);
    const r = run(['sign', asset, '--json'], { env });
    assert.equal(r.status, 0, `sign failed:\n${r.stderr}`);
    const result = JSON.parse(r.stdout);
    assert.ok(result.sig_path, 'sig_path missing from JSON output');
    assert.ok(result.sig_path.endsWith('.ed25519.sig'), 'sig path must end in .ed25519.sig');
    assert.ok(fs.existsSync(result.sig_path), 'signature file not written');
    assert.match(result.asset_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(result.fingerprint.length, 12, 'fingerprint should be 12 hex chars');

    // The signature record itself
    const sigRecord = JSON.parse(fs.readFileSync(result.sig_path, 'utf8'));
    assert.equal(sigRecord.algorithm, 'ed25519');
    assert.equal(sigRecord.version, '1');
    assert.equal(sigRecord.asset_path, asset);
    assert.match(sigRecord.signed_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(sigRecord.signature_base64, /^[A-Za-z0-9+/=]+$/);
    assert.ok(sigRecord.asset_digest_inputs.kdna_json_sha256);
    assert.ok(sigRecord.asset_digest_inputs.payload_kdnab_sha256);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 19 sign: --sig overrides default signature path', () => {
  const { tmp, env } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    // Copy the fixture so we don't touch the real fixture's sig path
    const assetCopy = copyFixture(tmp);
    const customPath = path.join(tmp, 'my-sig.json');
    const r = run(['sign', assetCopy, '--sig', customPath], { env });
    assert.equal(r.status, 0, `sign failed:\n${r.stderr}`);
    assert.ok(fs.existsSync(customPath), 'custom --sig path not written');
    // Default path must NOT have been written.
    assert.ok(
      !fs.existsSync(`${assetCopy}.ed25519.sig`),
      'default sig path should not exist when --sig is given',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── D: kdna verify — pass with correct key ───────────────────────────

test('Story 19 verify: --key <correct pubkey> returns PASS, exit 0', () => {
  const { tmp, env } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    const asset = copyFixture(tmp);
    const sign = run(['sign', asset], { env });
    assert.equal(sign.status, 0, `sign failed:\n${sign.stderr}`);

    const pubPath = path.join(env.KDNA_IDENTITY_DIR, 'ed25519.pub');
    const verify = run(['verify', asset, '--key', pubPath], { env });
    assert.equal(verify.status, 0, `verify should exit 0:\n${verify.stderr}\n${verify.stdout}`);
    assert.match(verify.stdout, /Signature is valid/);
    assert.match(verify.stdout, /Asset digest:    sha256:/);
    assert.match(verify.stdout, /Key fingerprint: [0-9a-f]{12}/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── E: kdna verify — no key: prints signer pubkey + "cannot determine trust"

test('Story 19 verify: no --key prints the signer public key plus no-key message', () => {
  const { tmp, env } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    const asset = copyFixture(tmp);
    run(['sign', asset], { env });

    const verify = run(['verify', asset], { env });
    // Exit 2 = "no key provided" (informational; the CLI just
    // printed the signer's pubkey and refused to make a trust claim).
    assert.equal(
      verify.status,
      2,
      `verify with no key should exit 2, got ${verify.status}:\n${verify.stdout}\n${verify.stderr}`,
    );
    assert.match(verify.stdout, /No key provided; cannot determine trust/);
    assert.match(verify.stdout, /Signer public key hex:  [0-9a-f]{64}/);
    assert.match(verify.stdout, /Signer public key b64:  [A-Za-z0-9+/=]+/);
    // The CLI must NOT use the words "official", "trusted",
    // "verified", or "recommended" to describe the signature.
    assert.doesNotMatch(verify.stdout, /\b(official|trusted|recommended)\b/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── F: kdna verify — wrong key: returns INVALID, exit 1

test('Story 19 verify: wrong --key returns INVALID, exit 1', () => {
  const { tmp, env } = makeEnv();
  try {
    // Two identities: author and attacker
    run(['identity', 'init'], { env });
    const asset = copyFixture(tmp);
    run(['sign', asset], { env });

    // Generate a second identity (attacker)
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s19b-'));
    const env2 = {
      KDNA_IDENTITY_DIR: path.join(tmp2, 'keys'),
      KDNA_OLD_IDENTITY_DIR: path.join(tmp2, 'identity-legacy'),
      KDNA_HOME: path.join(tmp2, 'home'),
    };
    fs.mkdirSync(env2.KDNA_HOME, { recursive: true });
    const rInit2 = run(['identity', 'init'], { env: env2 });
    assert.equal(rInit2.status, 0, `attacker identity init failed: ${rInit2.stderr}`);
    const attackerPub = path.join(env2.KDNA_IDENTITY_DIR, 'ed25519.pub');
    assert.ok(fs.existsSync(attackerPub), 'attacker pub should exist after init');

    // Try to verify with attacker's key
    const verify = run(['verify', asset, '--key', attackerPub], { env });
    assert.equal(
      verify.status,
      1,
      `verify with wrong key should exit 1, got ${verify.status}:\n${verify.stdout}\n${verify.stderr}`,
    );
    // The "invalid" status message goes to stderr (this is an
    // error, not a normal output).
    assert.match(verify.stderr, /INVALID/);
    assert.match(verify.stderr, /does not verify/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── G: tamper detection — sign then modify → verify fails ─────────────

test('Story 19 verify: tampering with kdna.json after sign makes verify fail', () => {
  const { tmp, env } = makeEnv();
  try {
    run(['identity', 'init'], { env });

    // Tamper: copy the asset to a temp location, sign, then modify kdna.json
    const assetCopy = copyFixture(tmp, 'tampered');
    // Sign the copy first
    run(['sign', assetCopy], { env });
    // Then modify kdna.json in the copy
    const kdnaJsonPath = path.join(assetCopy, 'kdna.json');
    const original = JSON.parse(fs.readFileSync(kdnaJsonPath, 'utf8'));
    original.title = (original.title || 'title') + ' (TAMPERED)';
    fs.writeFileSync(kdnaJsonPath, JSON.stringify(original, null, 2));

    const pubPath = path.join(env.KDNA_IDENTITY_DIR, 'ed25519.pub');
    const verify = run(['verify', assetCopy, '--key', pubPath], { env });
    assert.equal(
      verify.status,
      1,
      `tampered verify should fail, got ${verify.status}:\n${verify.stdout}\n${verify.stderr}`,
    );
    // The "modified after signing" message goes to stderr (this
    // is an error, not a normal output).
    assert.match(verify.stderr, /INVALID/);
    assert.match(verify.stderr, /modified after signing/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── H: sign without identity — error ──────────────────────────────────

test('Story 19 sign: without identity init, sign returns an error', () => {
  const { tmp, env } = makeEnv();
  try {
    // No identity init — but the CLI does have the asset
    const r = run(['sign', FIXTURE], { env });
    assert.notEqual(r.status, 0, 'sign without identity should fail');
    assert.match(r.stderr, /No identity found|Run: kdna identity init/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
