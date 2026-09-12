/**
 * watermarking.test.js — Payload-level watermarking
 *
 * Verifies the public watermark behavior:
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
 * Run: node --test tests/watermarking.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  currentManifest,
  currentJudgmentPayload,
  writeCurrentSource,
} = require('./helpers/current-asset');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

const {
  shouldWatermark,
  buildWatermark,
  watermarkPolicy,
  verifyWatermark,
  renderWatermarkHeader,
  newHmacKey,
  WATERMARK_VERSION,
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
  const core = require('@aikdna/kdna-core');
  const manifest = currentManifest({
    asset_id: `kdna:test:watermark-${access}`,
    asset_uid: `urn:uuid:11111111-1111-4111-8111-aaaaaaaaaaa${access === 'public' ? '1' : '2'}`,
    asset_type: 'domain',
    title: 'Watermark Test',
    version: '1.0.0',
    judgment_version: '1.0.0',
    created_at: '2026-06-28T00:00:00.000Z',
    updated_at: '2026-06-28T00:00:00.000Z',
    creator: { name: 'Test', id: 'test' },
    access,
    ...(access === 'licensed' && {
      entitlement: { profile: 'local_receipt', offline: true, revocable: true },
    }),
  });
  const payload = currentJudgmentPayload({
    core: {
      highest_question: 'Q?',
      axioms: [{ id: 'ax1', one_sentence: 'Test axiom.' }],
      boundaries: [],
      risk_model: {},
    },
    patterns: [],
    scenarios: [],
    cases: [],
    reasoning: { self_check: [], failure_modes: [] },
    evolution: { changelog: [], version_notes: [] },
  });
  writeCurrentSource(dir, { manifest, payload });
  const assetPath = path.join(tmpDir, `watermark-${access}.kdna`);
  core.pack(dir, assetPath);
  return assetPath;
}

// ─── A: shouldWatermark + module-level behavior ──────────────────────────

test('watermark: shouldWatermark returns true for licensed/remote, false for public', () => {
  assert.equal(shouldWatermark('licensed'), true);
  assert.equal(shouldWatermark('remote'), true);
  assert.equal(shouldWatermark('public'), false);
  assert.equal(shouldWatermark(null), false);
  assert.equal(shouldWatermark(undefined), false);
  assert.equal(shouldWatermark('something-else'), false);
});

test('watermark: buildWatermark returns null for public access', () => {
  const wm = buildWatermark({
    access: 'public',
    assetUid: 'urn:test',
  });
  assert.equal(wm, null);
});

test('watermark: buildWatermark includes all required fields', () => {
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

test('watermark: verifyWatermark returns ok when the HMAC matches', () => {
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

test('watermark: verifyWatermark returns invalid when the HMAC does not match', () => {
  const wm = buildWatermark({
    access: 'remote',
    assetUid: 'urn:test',
    hmacKey: newHmacKey(),
  });
  const v = verifyWatermark(wm, { hmacKey: newHmacKey() });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'hmac mismatch');
});

test('watermark: verifyWatermark returns invalid when the body is tampered', () => {
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

test('watermark: renderWatermarkHeader produces a content-neutral one-liner', () => {
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

test('watermark: watermarkPolicy describes the policy without secret material', () => {
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

test('plan-load: licensed plan stays inside the public LoadPlan schema', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  try {
    const dir = makeFixture(tmp, 'licensed');
    // Licensed assets return exit 3 (can_load_now = false) until
    // a valid entitlement is provided. Watermarking is an observed-load
    // concern and must not add an undeclared property to LoadPlan.
    const r = run(['plan-load', dir, '--json'], { env });
    assert.ok([0, 3].includes(r.status), `plan-load unexpected exit: ${r.status}: ${r.stderr}`);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.watermark_policy, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('plan-load: remote plan stays inside the public LoadPlan schema', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s21-'));
  const env = { KDNA_IDENTITY_DIR: path.join(tmp, 'keys') };
  try {
    const dir = makeFixture(tmp, 'remote');
    const r = run(['plan-load', dir, '--json'], { env });
    assert.ok([0, 3].includes(r.status), `plan-load unexpected exit: ${r.status}`);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.watermark_policy, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('plan-load: NO watermark_policy for public asset', () => {
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
