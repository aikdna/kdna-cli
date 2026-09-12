/**
 * tests/e2e-password.test.js
 *
 * End-to-end test for the --password-stdin / --has-password CLI surface.
 * This is the regression test for the T16 security fix: --has-password
 * must be REJECTED on `kdna load` (it is a plan-load diagnostic only),
 * while stdin-delivered passwords must decrypt correctly without entering argv.
 *
 * Five scenarios:
 *   1. load --has-password → exits 1 with clear error
 *   2. load --password-stdin with correct input → returns plaintext
 *   3. load --password-stdin with wrong input   → exits 1 with clear error
 *   4. load --password-stdin with empty input   → exits 1
 *   5. plan-load --has-password  → works for planning, never leaks plaintext
 *   6. password input in argv is rejected
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const cliBin = path.join(__dirname, '..', 'src', 'cli.js');
const FIXTURE_PASSWORD = 'correct-horse-battery-staple';

function run(args, opts = {}) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function runWithPassword(args, password) {
  return run([...args, '--password-stdin'], {
    input: `${password}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function mkTmp(prefix = 'kdna-e2e-pw-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeProtectedAsset(tmpDir) {
  // 1. Run kdna demo minimal into a fresh dir
  const demoDir = path.join(tmpDir, 'demo');
  const demoR = run(['demo', 'minimal', demoDir, '--force']);
  assert.equal(demoR.status, 0, `kdna demo failed: ${demoR.stderr}`);

  // 2. Pack to a .kdna file
  const kdnaFile = path.join(tmpDir, 'asset.kdna');
  const packR = run(['pack', demoDir, kdnaFile]);
  assert.equal(packR.status, 0, `kdna pack failed: ${packR.stderr}`);

  // 3. Protect the packaged asset without placing the password in argv.
  const protectedFile = path.join(tmpDir, 'protected.kdna');
  const protR = runWithPassword(['protect', kdnaFile, '--out', protectedFile], FIXTURE_PASSWORD);
  assert.equal(protR.status, 0, `kdna protect failed: ${protR.stderr}`);
  return { kdnaFile: protectedFile, demoDir, kdnaFileUnprotected: kdnaFile };
}

let tmp;
let kdnaFile;

test.before(() => {
  tmp = mkTmp();
  ({ kdnaFile } = makeProtectedAsset(tmp));
});

test.after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('e2e-password: setup generates protected asset', () => {
  assert.ok(fs.existsSync(kdnaFile), 'protected .kdna file should exist');
});

// ── Scenario 1: load --has-password is REJECTED ──────────────────────────
test('e2e-password scenario 1: load --has-password exits 1 with clear error', () => {
  const r = run(['load', kdnaFile, '--has-password', '--profile=compact', '--as=prompt']);
  assert.notEqual(r.status, 0, 'load --has-password must fail');
  assert.match(
    r.stderr,
    /--has-password.*plan-load|not.*decrypt|forbidden|invalid/i,
    `error message must explain --has-password is plan-load only. Got: ${r.stderr}`,
  );
  // CRITICAL: must NOT contain any plaintext from the asset
  assert.doesNotMatch(
    r.stdout,
    /axiom|judgment|boundary/i,
    'plaintext must not leak even on failure',
  );
});

// ── Scenario 2: stdin with the correct password succeeds ────────────────
test('e2e-password scenario 2: load --password-stdin returns plaintext', () => {
  const r = runWithPassword(
    ['load', kdnaFile, '--profile=compact', '--as=prompt'],
    FIXTURE_PASSWORD,
  );
  assert.equal(r.status, 0, `load --password-stdin failed: ${r.stderr}`);
  assert.ok(r.stdout.length > 0, 'plaintext should be returned');
  // The minimal fixture should render some judgment text
  assert.match(r.stdout, /\S/, 'stdout should contain non-whitespace content');
});

// ── Scenario 3: stdin with the wrong password fails clearly ─────────────
test('e2e-password scenario 3: wrong stdin password exits 1 with clear error', () => {
  const r = runWithPassword(
    ['load', kdnaFile, '--profile=compact', '--as=prompt'],
    'definitely-not-the-right-password',
  );
  assert.notEqual(r.status, 0, 'load with the wrong stdin password must fail');
  assert.match(
    r.stderr,
    /decrypt|invalid|wrong|password|auth/i,
    `error must mention password failure. Got: ${r.stderr}`,
  );
  // CRITICAL: wrong password must not silently return empty or partial output
  assert.doesNotMatch(r.stdout, /axiom|judgment/i, 'plaintext must not leak on wrong password');
});

// ── Scenario 4: empty stdin is treated as a missing password ─────────────
test('e2e-password scenario 4: empty password stdin exits 1', () => {
  const r = runWithPassword(['load', kdnaFile, '--profile=compact', '--as=prompt'], '');
  assert.notEqual(r.status, 0, 'load with empty password stdin must fail');
  assert.match(
    r.stderr,
    /password.*required|requires.*password|missing.*password|needs_password|password or recoveryCode/i,
    `error must say password is required (not that it was wrong). Got: ${r.stderr}`,
  );
});

// ── Scenario 5: plan-load --has-password is allowed but does not leak ─────
test('e2e-password scenario 5: plan-load --has-password works without leaking plaintext', () => {
  const r = run(['plan-load', kdnaFile, '--has-password', '--json']);
  assert.equal(r.status, 3, `plan-load should remain blocked until verification: ${r.stderr}`);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.state, 'needs_password');
  assert.equal(plan.can_load_now, false);
  assert.ok(plan.issues.some((issue) => issue.code === 'KDNA_AUTH_PASSWORD_UNVERIFIED'));
  // CRITICAL: must NOT contain actual judgment content
  assert.doesNotMatch(
    r.stdout,
    /The minimal payload is the smallest shape that passes the schema/i,
    'plan-load must never leak plaintext even with --has-password',
  );
});

test('e2e-password scenario 6: password input in argv is rejected', () => {
  const legacyFlag = ['--pass', 'word'].join('');
  const r = run([
    'load',
    kdnaFile,
    legacyFlag,
    FIXTURE_PASSWORD,
    '--profile=compact',
    '--as=prompt',
  ]);
  assert.notEqual(r.status, 0, 'password input in argv must be rejected');
  assert.match(r.stderr, /not supported|process arguments|password-stdin/i);
});
