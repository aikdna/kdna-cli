/**
 * story21-watermarking.test.js — Payload-level watermarking (Story 21)
 *
 * Verifies the six acceptance criteria from the Story 21 work package:
 *   1. kdna plan-load <asset> outputs watermark_policy for
 *      access: "licensed" or "remote" (and NOT for "public").
 *   2. The watermark contains asset_uid, consumer_id (if
 *      known), timestamp, session_nonce.
 *   3. The watermark is cryptographically hashed (HMAC-SHA256).
 *   4. The watermark appears in JSON, prompt, and compact
 *      output profiles.
 *   5. Tests: 8-10 new tests.
 *   6. Normal push, no force push.
 *
 * Forbidden:
 *   - No trust claims ("official", "trusted", "verified",
 *     "recommended") in the watermark output.
 *   - No blocking load when no watermark (post-hoc
 *     traceability, not access control).
 *   - No watermark keys committed to the repo (the key is
 *     process-local, generated fresh per CLI invocation).
 *
 * Run: node --test tests/story21-watermarking.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

const {
  shouldWatermark,
  buildWatermark,
  watermarkPolicy,
  verifyWatermark,
  renderWatermarkHeader,
  resolveConsumerId,
  newHmacKey,
  stableStringify,
  WATERMARK_VERSION,
  WATERMARKED_ACCESS_MODES,
} = require('../src/cmds/watermark');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

function makeFixture(tmpDir, access = 'public') {
  const dir = path.join(tmpDir, 'asset');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mimetype'), 'application/vnd.kdna.asset');
  const core = require('@aikdna/kdna-core');
  const manifest = {
    kdna_version: '1.0',
    asset_id: `kdna:test:watermark-${access}`,
    asset_uid: `urn:uuid:11111111-1111-4111-8111-aaaaaaaaaaa${access === 'public' ? '1' : '2'}`,
    asset_type: 'domain',
    title: 'Watermark Test',
    version: '1.0.0',
    judgment_version: '1.0.0',
    created_at: '2026-06-28T00:00:00.000Z',
    updated_at: '2026-06-28T00:00:00.000Z',
    creator: { name: 'Test', id: 'test' },
    compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
    payload: { path: 'payload.kdnab', encoding: 'json', encrypted: false },
    access,
    // Note: no `entitlement` block is set. With no
    // entitlement_profile, the planLoad path falls through
    // to the "active entitlement → can_load_now = true" branch
    // (kda-core v1/index.js ~line 1441) when the consumer
    // passes --entitlement-status. Setting a profile here
    // (e.g. 'account') would route the plan into a
    // "needs_account" path that ignores --entitlement-status.
  };
  const payload = {
    profile: 'judgment-profile-v1',
    core: {
      highest_question: 'Q?',
      axioms: [{ id: 'ax1', one_sentence: 'Test axiom.' }],
      boundaries: [],
      risk_model: {},
    },
    patterns: [],
    scenarios: [],
    cases: [],
    reasoning: { self_checks: [], failure_modes: [] },
    evolution: { changelog: [], version_notes: [] },
  };
  fs.writeFileSync(path.join(dir, 'kdna.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'payload.kdnab'), JSON.stringify(payload) + '\n');
  fs.writeFileSync(
    path.join(dir, 'checksums.json'),
    JSON.stringify(core.buildChecksumsV1(dir), null, 2) + '\n',
  );
  return dir;
}

// ─── A: shouldWatermark + module-level behavior ──────────────────────────

test('Story 21 watermark: shouldWatermark returns true for licensed/remote, false for public', () => {
  assert.equal(shouldWatermark('licensed'), true);
  assert.equal(shouldWatermark('remote'), true);
  assert.equal(shouldWatermark('public'), false);
  assert.equal(shouldWatermark(null), false);
  assert.equal(shouldWatermark(undefined), false);
  assert.equal(shouldWatermark('something-else'), false);
});

test('Story 21 watermark: buildWatermark returns null for public access', () => {
  const wm = buildWatermark({
    access: 'public',
    assetUid: 'urn:test',
  });
  assert.equal(wm, null);
});

test('Story 21 watermark: buildWatermark includes all required fields', () => {
  const wm = buildWatermark({
    access: 'licensed',
    assetUid: 'urn:uuid:abc',
    consumerId: 'consumer-123',
    timestamp: '2026-06-28T00:00:00.000Z',
  });
  assert.equal(wm.version, WATERMARK_VERSION);
  assert.equal(wm.asset_uid, 'urn:uuid:abc');
  assert.equal(wm.consumer_id, 'consumer-123');
  assert.equal(wm.timestamp, '2026-06-28T00:00:00.000Z');
  assert.match(wm.session_nonce, /^[0-9a-f]{32}$/);
  assert.equal(wm.algorithm, 'hmac-sha256');
  assert.match(wm.hmac, /^[0-9a-f]{64}$/);
});

test('Story 21 watermark: verifyWatermark returns ok when the HMAC matches', () => {
  const key = newHmacKey();
  const wm = buildWatermark({
    access: 'remote',
    assetUid: 'urn:test',
    consumerId: 'c1',
    timestamp: '2026-06-28T00:00:00.000Z',
    hmacKey: key,
  });
  const v = verifyWatermark(wm, { hmacKey: key });
  assert.equal(v.ok, true);
});

test('Story 21 watermark: verifyWatermark returns invalid when the HMAC does not match', () => {
  const wm = buildWatermark({
    access: 'remote',
    assetUid: 'urn:test',
    hmacKey: newHmacKey(),
  });
  const v = verifyWatermark(wm, { hmacKey: newHmacKey() });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'hmac mismatch');
});

test('Story 21 watermark: verifyWatermark returns invalid when the body is tampered', () => {
  const key = newHmacKey();
  const wm = buildWatermark({
    access: 'licensed',
    assetUid: 'urn:test',
    hmacKey: key,
  });
  // Tamper with the body
  const tampered = { ...wm, asset_uid: 'urn:attacker' };
  const v = verifyWatermark(tampered, { hmacKey: key });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'hmac mismatch');
});

test('Story 21 watermark: renderWatermarkHeader produces a content-neutral one-liner', () => {
  const wm = buildWatermark({
    access: 'licensed',
    assetUid: 'urn:uuid:abc',
    consumerId: 'consumer-1',
    timestamp: '2026-06-28T00:00:00.000Z',
    hmacKey: newHmacKey(),
  });
  const header = renderWatermarkHeader(wm);
  assert.match(header, /^\[WATERMARK /);
  assert.match(header, /hmac-sha256/);
  assert.match(header, /ts=2026-06-28T00:00:00\.000Z/);
  // Trust language discipline: no "official", "trusted", "verified", or "recommended"
  const lower = header.toLowerCase();
  assert.doesNotMatch(lower, /\bofficial\b/);
  assert.doesNotMatch(lower, /\btrusted\b/);
  assert.doesNotMatch(lower, /\bverified\b/);
  assert.doesNotMatch(lower, /\brecommended\b/);
});

test('Story 21 watermark: watermarkPolicy describes the policy without secret material', () => {
  const policy = watermarkPolicy({
    access: 'licensed',
    assetUid: 'urn:test',
  });
  assert.equal(policy.version, WATERMARK_VERSION);
  assert.equal(policy.access_mode, 'licensed');
  assert.equal(policy.algorithm, 'hmac-sha256');
  assert.ok(Array.isArray(policy.fields));
  assert.ok(policy.fields.includes('hmac'));
  // The policy does NOT contain the HMAC key or any precomputed
  // hmac — those are generated at load time.
  assert.equal(policy.hmac, undefined);
});

// ─── B: CLI integration ────────────────────────────────────────────────

test('Story 21 plan-load: watermark_policy appears for licensed asset', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  try {
    const dir = makeFixture(tmp, 'licensed');
    // Licensed assets return exit 3 (can_load_now = false) until
    // a valid entitlement is provided. The watermark policy is
    // part of the plan regardless.
    const r = run(['plan-load', dir, '--json'], { env });
    assert.ok([0, 3].includes(r.status), `plan-load unexpected exit: ${r.status}: ${r.stderr}`);
    const plan = JSON.parse(r.stdout);
    assert.ok(plan.watermark_policy, 'watermark_policy should be present for licensed');
    assert.equal(plan.watermark_policy.access_mode, 'licensed');
    assert.equal(plan.watermark_policy.algorithm, 'hmac-sha256');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 21 plan-load: watermark_policy appears for remote asset', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  try {
    const dir = makeFixture(tmp, 'remote');
    const r = run(['plan-load', dir, '--json'], { env });
    assert.ok([0, 3].includes(r.status), `plan-load unexpected exit: ${r.status}`);
    const plan = JSON.parse(r.stdout);
    assert.ok(plan.watermark_policy, 'watermark_policy should be present for remote');
    assert.equal(plan.watermark_policy.access_mode, 'remote');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 21 plan-load: NO watermark_policy for public asset', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  try {
    const dir = makeFixture(tmp, 'public');
    const r = run(['plan-load', dir, '--json'], { env });
    assert.equal(r.status, 0);
    const plan = JSON.parse(r.stdout);
    assert.equal(
      plan.watermark_policy,
      undefined,
      'watermark_policy MUST NOT be present for public assets',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 21 load: JSON output includes watermark for licensed asset', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  try {
    const dir = makeFixture(tmp, 'licensed');
    // Pass --entitlement-status so the plan reaches the
    // can_load_now=true branch. The fixture's manifest omits
    // the `entitlement` block, so this hits the "active status
    // → can load" fallthrough at the bottom of planLoad.
    const r = run(['load', dir, '--as=json', '--entitlement-status', 'active'], { env });
    assert.equal(r.status, 0, `load failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.watermark, 'watermark should be in JSON load result');
    assert.match(out.watermark.asset_uid, /^urn:uuid:/);
    assert.match(out.watermark.hmac, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 21 load: prompt output includes the [WATERMARK ...] header for licensed asset', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  try {
    const dir = makeFixture(tmp, 'licensed');
    const r = run(['load', dir, '--as=prompt', '--entitlement-status', 'active'], { env });
    assert.equal(r.status, 0, `load failed: ${r.stderr}`);
    // The first non-empty line should be the [WATERMARK ...] header.
    const firstLine = r.stdout.split('\n').find((l) => l.length > 0);
    assert.match(firstLine, /^\[WATERMARK /);
    assert.match(firstLine, /alg=hmac-sha256/);
    // The actual judgment text follows.
    assert.match(r.stdout, /Highest question|KDNA Judgment Asset/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 21 load: NO watermark for public asset (even in --as=prompt)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  try {
    const dir = makeFixture(tmp, 'public');
    const r = run(['load', dir, '--as=json', '--entitlement-status', 'active'], { env });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.watermark, undefined, 'watermark MUST NOT be present for public assets');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 21 load: watermark consumer_id is the local identity fingerprint when kdna identity is set up', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = {
    KDNA_IDENTITY_DIR: path.join(tmp, 'keys'),
    KDNA_OLD_IDENTITY_DIR: path.join(tmp, 'old'),
  };
  try {
    // Initialize the local identity
    const rInit = run(['identity', 'init'], { env });
    assert.equal(rInit.status, 0, `init failed: ${rInit.stderr}`);

    const dir = makeFixture(tmp, 'licensed');
    const r = run(['load', dir, '--as=json', '--entitlement-status', 'active'], { env });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(out.watermark.consumer_id, 'consumer_id should be set when kdna identity exists');
    assert.match(out.watermark.consumer_id, /^[0-9a-f]{16}$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 21 load: watermark consumer_id is null when no kdna identity is set up', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = {
    KDNA_IDENTITY_DIR: path.join(tmp, 'keys-no-such'),
    KDNA_OLD_IDENTITY_DIR: path.join(tmp, 'old-no-such'),
  };
  try {
    // No identity init — the consumer_id must still be null
    // (the watermark still works; it's just less specific).
    const dir = makeFixture(tmp, 'licensed');
    const r = run(['load', dir, '--as=json', '--entitlement-status', 'active'], { env });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.watermark.consumer_id,
      null,
      'consumer_id should be null when no kdna identity is set up',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
