/**
 * tests/e2e-password.test.js
 *
 * End-to-end test for the --password / --has-password CLI surface.
 * This is the regression test for the T16 security fix: --has-password
 * must be REJECTED on `kdna load` (it is a plan-load diagnostic only),
 * while --password=<value> must still decrypt correctly.
 *
 * Five scenarios:
 *   1. load --has-password → exits 1 with clear error
 *   2. load --password=<correct> → returns plaintext
 *   3. load --password=<wrong>   → exits 1 with clear error
 *   4. load --password=""        → exits 1 (NOT treated as "has password")
 *   5. plan-load --has-password  → works for planning, never leaks plaintext
 *
 * Status: skeleton — full implementation requires the `kdna demo <name> --password <pw>`
 * command and a fixture that supports encryption. See src/cmds/demo.js.
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

  // 3. Re-pack with --password to produce a protected .kdna
  // NOTE: requires `kdna demo <name> --password <pw>` support, or
  // a separate `kdna protect <file> --password <pw>` command. Check
  // current CLI for available subcommand.
  // For now this is a placeholder — the encryption path needs to be
  // verified against the actual CLI surface.
  const protectedFile = path.join(tmpDir, 'protected.kdna');
  const protR = run(['pack', demoDir, protectedFile, '--password', FIXTURE_PASSWORD]);
  if (protR.status !== 0) {
    // Fall back: try `kdna protect` if it exists
    const altR = run(['protect', demoDir, '--password', FIXTURE_PASSWORD]);
    if (altR.status !== 0) {
      throw new Error(
        `No working --password pack path. pack+--password failed: ${protR.stderr}\n` +
          `protect failed: ${altR.stderr}`,
      );
    }
  }
  return { kdnaFile: protectedFile, demoDir, kdnaFileUnprotected: kdnaFile };
}

test('e2e-password: setup generates protected asset', () => {
  const tmp = mkTmp();
  const { kdnaFile } = makeProtectedAsset(tmp);
  assert.ok(fs.existsSync(kdnaFile), 'protected .kdna file should exist');
});

// ── Scenario 1: load --has-password is REJECTED ──────────────────────────
test('e2e-password scenario 1: load --has-password exits 1 with clear error', () => {
  const tmp = mkTmp();
  const { kdnaFile } = makeProtectedAsset(tmp);
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

// ── Scenario 2: load --password=<correct> succeeds and returns plaintext ──
test('e2e-password scenario 2: load --password=<correct> returns plaintext', () => {
  const tmp = mkTmp();
  const { kdnaFile } = makeProtectedAsset(tmp);
  const r = run([
    'load',
    kdnaFile,
    `--password=${FIXTURE_PASSWORD}`,
    '--profile=compact',
    '--as=prompt',
  ]);
  assert.equal(r.status, 0, `load --password=<correct> failed: ${r.stderr}`);
  assert.ok(r.stdout.length > 0, 'plaintext should be returned');
  // The minimal fixture should render some judgment text
  assert.match(r.stdout, /\S/, 'stdout should contain non-whitespace content');
});

// ── Scenario 3: load --password=<wrong> fails clearly ─────────────────────
test('e2e-password scenario 3: load --password=<wrong> exits 1 with clear error', () => {
  const tmp = mkTmp();
  const { kdnaFile } = makeProtectedAsset(tmp);
  const r = run([
    'load',
    kdnaFile,
    '--password=definitely-not-the-right-password',
    '--profile=compact',
    '--as=prompt',
  ]);
  assert.notEqual(r.status, 0, 'load --password=<wrong> must fail');
  assert.match(
    r.stderr,
    /decrypt|invalid|wrong|password|auth/i,
    `error must mention password failure. Got: ${r.stderr}`,
  );
  // CRITICAL: wrong password must not silently return empty or partial output
  assert.doesNotMatch(r.stdout, /axiom|judgment/i, 'plaintext must not leak on wrong password');
});

// ── Scenario 4: load --password="" is treated as MISSING password ─────────
test('e2e-password scenario 4: load --password="" exits 1 (not "has empty password")', () => {
  const tmp = mkTmp();
  const { kdnaFile } = makeProtectedAsset(tmp);
  const r = run(['load', kdnaFile, '--password=', '--profile=compact', '--as=prompt']);
  assert.notEqual(r.status, 0, 'load --password="" must fail');
  // Must behave like "no password supplied", not like "supplied wrong password"
  assert.match(
    r.stderr,
    /password.*required|missing.*password|needs_password|password or recoveryCode/i,
    `error must say password is required (not that it was wrong). Got: ${r.stderr}`,
  );
});

// ── Scenario 5: plan-load --has-password is allowed but does not leak ─────
test('e2e-password scenario 5: plan-load --has-password works without leaking plaintext', () => {
  const tmp = mkTmp();
  const { kdnaFile } = makeProtectedAsset(tmp);
  const r = run(['plan-load', kdnaFile, '--has-password', '--json']);
  // plan-load --has-password should succeed (presence signal only)
  assert.equal(r.status, 0, `plan-load --has-password failed: ${r.stderr}`);
  // The output should report the access state as "licensed" or "needs_password"
  assert.match(
    r.stdout,
    /needs_password|licensed|access/i,
    `plan-load output should mention access state. Got: ${r.stdout}`,
  );
  // CRITICAL: must NOT contain actual judgment content
  assert.doesNotMatch(
    r.stdout,
    /axiom|judgment|boundary|applies_when/i,
    'plan-load must never leak plaintext even with --has-password',
  );
});
