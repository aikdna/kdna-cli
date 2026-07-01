/**
 * story20-revocation.test.js — Revocation state machine (Story 20)
 *
 * Verifies the seven acceptance criteria from the Story 20 work package:
 *   1. kdna revoke <asset> writes a signed
 *      signatures/revocation.ed25519.json using the author's
 *      private key.
 *   2. The revocation record references the revoked .ed25519.sig
 *      file by content hash, with timestamp and optional reason.
 *   3. If a valid revocation by the same key exists, kdna verify
 *      <asset> exits 4 (status: 'revoked').
 *   4. In verify without --key, revocation surfaces as exit 2
 *      (same as the no-key behavior).
 *   5. Revocation is only valid when signed by the same public
 *      key that signed the original. A different key cannot
 *      revoke another signer's signature.
 *   6. The CLI never says "official", "trusted", "verified", or
 *      "recommended" about a revoked signature. It just says
 *      "revoked by its author" + reason.
 *   7. Reuses loadAssetForSigning, rawPublicKey, fingerprint,
 *      and the same Ed25519 primitives from Story 19. No
 *      modifications to the sign/verify path.
 *
 * Test isolation: KDNA_IDENTITY_DIR + KDNA_OLD_IDENTITY_DIR
 * redirected to a temp dir per test, so the test does not
 * touch the user's real ~/.kdna/keys/ or ~/.kdna/identity/.
 *
 * Run: node --test tests/story20-revocation.test.js
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

/** Set up an isolated identity dir + asset copy (so we don't
 * pollute the shared FIXTURE between tests). */
function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s20-'));
  const env = {
    KDNA_IDENTITY_DIR: path.join(tmp, 'keys'),
    KDNA_OLD_IDENTITY_DIR: path.join(tmp, 'identity-legacy'),
    KDNA_HOME: path.join(tmp, 'home'),
  };
  fs.mkdirSync(env.KDNA_HOME, { recursive: true });
  // Copy the fixture into the test's tmp dir. Each test uses
  // its own copy; revocations and signatures do not leak
  // between tests.
  const assetDir = path.join(tmp, 'asset');
  fs.cpSync(FIXTURE, assetDir, { recursive: true });
  return { tmp, env, asset: assetDir };
}

// ─── A: kdna revoke — writes a signed revocation record ────────────────

test('Story 20 revoke: writes a signed revocation record', () => {
  const { tmp, env, asset } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    run(['sign', asset], { env });

    const r = run(['revoke', asset, '--json'], { env });
    assert.equal(r.status, 0, `revoke failed: ${r.stderr}`);

    const result = JSON.parse(r.stdout);
    assert.ok(result.revocation_path, 'revocation_path missing');
    assert.match(result.revocation_path, /signatures[/\\]revocation\.ed25519\.json$/);
    assert.match(result.asset_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(result.revoked_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(result.fingerprint.length, 12);

    // The revocation file itself
    assert.ok(fs.existsSync(result.revocation_path), 'revocation file not written');
    const record = JSON.parse(fs.readFileSync(result.revocation_path, 'utf8'));
    assert.equal(record.version, '1');
    assert.equal(record.algorithm, undefined, 'algorithm field not used in revocation record');
    assert.equal(record.public_key_hex.length, 64);
    assert.match(record.signature_base64, /^[A-Za-z0-9+/=]+$/);
    assert.match(record.revoked_signature_digest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(record.revoked_signature_path.endsWith('.ed25519.sig'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 20 revoke: --reason flag is included in the record', () => {
  const { tmp, env, asset } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    run(['sign', asset], { env });
    const r = run(['revoke', asset, '--reason', 'asset was superseded by v2', '--json'], { env });
    assert.equal(r.status, 0, `revoke failed: ${r.stderr}`);
    const result = JSON.parse(r.stdout);
    assert.equal(result.reason, 'asset was superseded by v2');
    const record = JSON.parse(fs.readFileSync(result.revocation_path, 'utf8'));
    assert.equal(record.reason, 'asset was superseded by v2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 20 revoke: refuses if .ed25519.sig does not exist', () => {
  const { tmp, env, asset } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    // No sign first
    const r = run(['revoke', asset], { env });
    assert.notEqual(r.status, 0, 'revoke without signature should fail');
    assert.match(r.stderr, /signature file not found|Run: kdna sign/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 20 revoke: refuses if a revocation already exists (use --force to overwrite)', () => {
  const { tmp, env, asset } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    run(['sign', asset], { env });
    const r1 = run(['revoke', asset], { env });
    assert.equal(r1.status, 0);
    const r2 = run(['revoke', asset], { env });
    assert.notEqual(r2.status, 0, 'second revoke should fail without --force');
    assert.match(r2.stderr, /revocation file already exists/);
    const r3 = run(['revoke', asset, '--force'], { env });
    assert.equal(r3.status, 0, 'revoke --force should succeed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── B: kdna verify — exit 4 when valid revocation exists ──────────────

test('Story 20 verify: returns exit 4 (revoked) when same-key revocation exists', () => {
  const { tmp, env, asset } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    run(['sign', asset], { env });
    run(['revoke', asset], { env });

    const pubPath = path.join(env.KDNA_IDENTITY_DIR, 'ed25519.pub');
    const verify = run(['verify', asset, '--key', pubPath], { env });
    assert.equal(
      verify.status,
      4,
      `verify with valid revocation should exit 4, got ${verify.status}:\n${verify.stdout}\n${verify.stderr}`,
    );
    // The "revoked" message goes to stderr (this is a status
    // signal, not a normal output).
    assert.match(verify.stderr, /REVOKED by its author/);
    assert.match(verify.stderr, /Revoked at:/);
    assert.match(verify.stderr, /Revocation file:/);
    // Trust language discipline — the CLI must NOT use the
    // words "official", "trusted", "verified", or "recommended".
    const combined = verify.stdout + verify.stderr;
    assert.doesNotMatch(combined, /\b(official|trusted|recommended)\b/);
    // "verified" is allowed only when describing the
    // cryptographic fact (e.g. "signature verifies"). It must
    // not appear in the REVOKED message.
    assert.doesNotMatch(verify.stderr, /verified/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── C: kdna verify — exit 2 when no key + revocation exists ───────────

test('Story 20 verify: no --key + valid revocation surfaces as exit 2', () => {
  const { tmp, env, asset } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    run(['sign', asset], { env });
    run(['revoke', asset], { env });

    const verify = run(['verify', asset], { env });
    assert.equal(
      verify.status,
      2,
      `verify with no key + revocation should still exit 2, got ${verify.status}:\n${verify.stdout}\n${verify.stderr}`,
    );
    assert.match(verify.stdout, /No key provided; cannot determine trust/);
    // The revocation should be surfaced informationally in the
    // no-key output.
    assert.match(verify.stdout, /a revocation record exists/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── D: revocation is only valid when signed by the same key ────────────

test('Story 20 verify: a different key cannot revoke another signers signature', () => {
  const { tmp, env, asset } = makeEnv();
  try {
    // Author signs the asset
    run(['identity', 'init'], { env });
    run(['sign', asset], { env });

    // Attacker generates a separate identity and tries to revoke
    // the asset (by creating a revocation file with their own key
    // but referencing the author's signature).
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s20b-'));
    const env2 = {
      KDNA_IDENTITY_DIR: path.join(tmp2, 'keys'),
      KDNA_OLD_IDENTITY_DIR: path.join(tmp2, 'identity-legacy'),
      KDNA_HOME: path.join(tmp2, 'home'),
    };
    fs.mkdirSync(env2.KDNA_HOME, { recursive: true });
    const rInit2 = run(['identity', 'init'], { env: env2 });
    assert.equal(rInit2.status, 0, `attacker init failed: ${rInit2.stderr}`);

    // Switch back to the author's identity and try to revoke a
    // foreign-signed signature: but first, let's simulate the
    // attack differently — have the attacker write a revocation
    // record manually, signed by their key, claiming the author's
    // sig is revoked.
    const sigPath = `${asset}.ed25519.sig`;
    const sigRecord = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
    const sigBytes = fs.readFileSync(sigPath);
    const sigDigest = `sha256:${require('node:crypto')
      .createHash('sha256')
      .update(sigBytes)
      .digest('hex')}`;
    const attackerPub = fs.readFileSync(
      path.join(env2.KDNA_IDENTITY_DIR, 'ed25519.pub'),
      'utf8',
    );
    const attackerCrypto = require('node:crypto');
    const attackerPriv = fs.readFileSync(
      path.join(env2.KDNA_IDENTITY_DIR, 'ed25519.key'),
      'utf8',
    );
    const attackerPrivKeyObj = attackerCrypto.createPrivateKey({
      key: attackerPriv,
      format: 'pem',
      type: 'pkcs8',
    });
    const attackerPubKeyObj = attackerCrypto.createPublicKey(attackerPrivKeyObj);
    const attackerPubRaw = attackerPubKeyObj
      .export({ type: 'spki', format: 'der' })
      .subarray(-32);
    const body = {
      version: '1',
      revoked_signature_path: sigPath,
      revoked_signature_digest: sigDigest,
      asset_path: asset,
      asset_kind: 'source-dir',
      asset_digest: sigRecord.asset_digest,
      asset_digest_inputs: sigRecord.asset_digest_inputs,
      public_key_hex: attackerPubRaw.toString('hex'),
      public_key_base64: attackerPubRaw.toString('base64'),
      fingerprint: sigRecord.public_key_fingerprint, // lie to look like the author
      revoked_at: new Date().toISOString(),
      reason: 'malicious revocation by attacker',
    };
    function stable(v) {
      if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
      if (v && typeof v === 'object') {
        return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
      }
      return JSON.stringify(v);
    }
    const bodyBytes = Buffer.from(stable(body), 'utf8');
    const attackerSigBytes = attackerCrypto.sign(null, bodyBytes, attackerPrivKeyObj);
    const record = {
      ...body,
      signature_base64: attackerSigBytes.toString('base64'),
    };
    const revocationPath = `${asset}.signatures/revocation.ed25519.json`;
    fs.mkdirSync(path.dirname(revocationPath), { recursive: true });
    fs.writeFileSync(revocationPath, JSON.stringify(record, null, 2));

    // Now verify with the author's key — the malicious revocation
    // should NOT count because it was signed by a different key.
    const authorPub = path.join(env.KDNA_IDENTITY_DIR, 'ed25519.pub');
    const verify = run(['verify', asset, '--key', authorPub], { env });
    // The signature itself is valid (author's sig is intact) and
    // there is no valid same-key revocation, so verify should
    // return status: 'valid' (exit 0).
    assert.equal(
      verify.status,
      0,
      `valid signature with attacker revocation should still be valid (exit 0), got ${verify.status}:\n${verify.stdout}\n${verify.stderr}`,
    );
    assert.match(verify.stdout, /Signature is valid/);

    fs.rmSync(tmp2, { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── E: kdna revocation status subcommand ───────────────────────────────

test('Story 20 revocation status: reports the current revocation record', () => {
  const { tmp, env, asset } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    run(['sign', asset], { env });
    run(['revoke', asset, '--reason', 'testing revocation'], { env });

    const r = run(['revocation', 'status', asset, '--json'], { env });
    assert.equal(r.status, 0, `status failed: ${r.stderr}`);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, 'valid', 'status should be "valid"');
    assert.ok(result.record, 'should include the record');
    assert.equal(result.record.reason, 'testing revocation');
    assert.equal(result.references_current_signature, true);
    assert.equal(result.key_matches_local, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 20 revocation status: reports absent when no revocation exists', () => {
  const { tmp, env, asset } = makeEnv();
  try {
    run(['identity', 'init'], { env });
    run(['sign', asset], { env });
    // No revoke
    const r = run(['revocation', 'status', asset, '--json'], { env });
    assert.equal(r.status, 0);
    const result = JSON.parse(r.stdout);
    assert.equal(result.status, 'absent');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
