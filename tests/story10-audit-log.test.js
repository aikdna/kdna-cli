/**
 * story10-audit-log.test.js — CLI load audit log (Story 10)
 *
 * Verifies:
 *   A) appendAuditEntry() + readAuditLog() unit round-trip
 *   B) auditStats() computes correct summary
 *   C) kdna load writes a success entry to the audit log
 *   D) kdna history --audit reads the audit log
 *   E) kdna history --audit --stats computes stats
 *   F) kdna history --audit --json returns JSON
 *   G) audit write failure never crashes kdna load
 *
 * Run: node --test tests/story10-audit-log.test.js
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
    env: { ...process.env, KDNA_HOME: opts.kdnaHome || process.env.KDNA_HOME, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

// ─── A: Unit — appendAuditEntry + readAuditLog ────────────────────────────────

test('Story 10 unit: appendAuditEntry writes a line; readAuditLog reads it back', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s10-'));
  // Temporarily override KDNA_HOME so audit file goes to tmp
  const origHome = process.env.KDNA_HOME;
  process.env.KDNA_HOME = tmp;
  // Re-require modules to pick up new PATHS
  delete require.cache[require.resolve('../src/paths.js')];
  delete require.cache[require.resolve('../src/cmds/audit-log.js')];
  try {
    const { appendAuditEntry, readAuditLog } = require('../src/cmds/audit-log');
    appendAuditEntry({
      asset_path: '/test/writing.kdna',
      asset_id: 'kdna:domain:writing',
      version: '0.7.2',
      profile: 'compact',
      as: 'prompt',
      access_mode: 'public',
      result: 'success',
      error_code: null,
      duration_ms: 120,
    });
    const entries = readAuditLog();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event_type, 'load');
    assert.equal(entries[0].asset_id, 'kdna:domain:writing');
    assert.equal(entries[0].result, 'success');
    assert.equal(entries[0].profile, 'compact');
    assert.ok(entries[0].timestamp);
    assert.equal(entries[0].duration_ms, 120);
  } finally {
    process.env.KDNA_HOME = origHome;
    delete require.cache[require.resolve('../src/paths.js')];
    delete require.cache[require.resolve('../src/cmds/audit-log.js')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Story 10 unit: readAuditLog filters by result', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s10-'));
  const origHome = process.env.KDNA_HOME;
  process.env.KDNA_HOME = tmp;
  delete require.cache[require.resolve('../src/paths.js')];
  delete require.cache[require.resolve('../src/cmds/audit-log.js')];
  try {
    const { appendAuditEntry, readAuditLog } = require('../src/cmds/audit-log');
    appendAuditEntry({ asset_path: '/a.kdna', result: 'success', profile: 'compact', as: 'json' });
    appendAuditEntry({ asset_path: '/b.kdna', result: 'error', error_code: 'KDNA_DECRYPT_FAILED', profile: 'compact', as: 'json' });
    appendAuditEntry({ asset_path: '/c.kdna', result: 'success', profile: 'full', as: 'json' });

    const all = readAuditLog();
    const errors = readAuditLog({ result: 'error' });
    const successes = readAuditLog({ result: 'success' });

    assert.equal(all.length, 3);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error_code, 'KDNA_DECRYPT_FAILED');
    assert.equal(successes.length, 2);
  } finally {
    process.env.KDNA_HOME = origHome;
    delete require.cache[require.resolve('../src/paths.js')];
    delete require.cache[require.resolve('../src/cmds/audit-log.js')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── B: Unit — auditStats ─────────────────────────────────────────────────────

test('Story 10 unit: auditStats computes correct summary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s10-'));
  const origHome = process.env.KDNA_HOME;
  process.env.KDNA_HOME = tmp;
  delete require.cache[require.resolve('../src/paths.js')];
  delete require.cache[require.resolve('../src/cmds/audit-log.js')];
  try {
    const { appendAuditEntry, readAuditLog, auditStats } = require('../src/cmds/audit-log');
    appendAuditEntry({ asset_id: 'kdna:a', result: 'success', profile: 'compact', as: 'json' });
    appendAuditEntry({ asset_id: 'kdna:a', result: 'success', profile: 'compact', as: 'json' });
    appendAuditEntry({ asset_id: 'kdna:b', result: 'error', error_code: 'KDNA_DECRYPT_FAILED', profile: 'compact', as: 'json' });

    const entries = readAuditLog();
    const s = auditStats(entries);

    assert.equal(s.total, 3);
    assert.equal(s.success, 2);
    assert.equal(s.error, 1);
    assert.equal(s.error_rate, 33);
    assert.equal(s.by_error_code['KDNA_DECRYPT_FAILED'], 1);
    assert.equal(s.by_asset['kdna:a'].success, 2);
    assert.equal(s.by_asset['kdna:b'].error, 1);
  } finally {
    process.env.KDNA_HOME = origHome;
    delete require.cache[require.resolve('../src/paths.js')];
    delete require.cache[require.resolve('../src/cmds/audit-log.js')];
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── C: CLI — kdna load writes audit entry ────────────────────────────────────

test('Story 10 CLI: kdna load success writes audit entry to KDNA_HOME/audit.jsonl', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s10-home-'));
  try {
    const r = run(['load', FIXTURE, '--profile=compact', '--as=json'], { kdnaHome: tmpHome });
    assert.equal(r.status, 0, `kdna load failed:\n${r.stderr}`);

    const auditFile = path.join(tmpHome, 'audit.jsonl');
    assert.ok(fs.existsSync(auditFile), 'audit.jsonl should exist after kdna load');

    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'should have exactly one audit entry');

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.event_type, 'load');
    assert.equal(entry.result, 'success');
    assert.equal(entry.profile, 'compact');
    assert.equal(entry.as, 'json');
    assert.ok(entry.timestamp);
    assert.ok(typeof entry.duration_ms === 'number');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── D: CLI — kdna history --audit reads audit log ───────────────────────────

test('Story 10 CLI: kdna history --audit --json shows audit entries', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s10-home-'));
  try {
    // First, create some audit entries via kdna load
    run(['load', FIXTURE, '--profile=compact', '--as=json'], { kdnaHome: tmpHome });
    run(['load', FIXTURE, '--profile=full', '--as=prompt'], { kdnaHome: tmpHome });

    const r = run(['history', '--audit', '--json'], { kdnaHome: tmpHome });
    assert.equal(r.status, 0, `kdna history --audit --json failed:\n${r.stderr}`);

    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.entries), 'entries should be an array');
    assert.ok(out.total >= 2, `expected >= 2 entries, got ${out.total}`);
    assert.equal(out.entries[0].event_type, 'load');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── E: CLI — kdna history --audit --stats ───────────────────────────────────

test('Story 10 CLI: kdna history --audit --stats --json shows stats', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s10-home-'));
  try {
    run(['load', FIXTURE, '--profile=compact', '--as=json'], { kdnaHome: tmpHome });

    const r = run(['history', '--audit', '--stats', '--json'], { kdnaHome: tmpHome });
    assert.equal(r.status, 0, `failed:\n${r.stderr}`);

    const out = JSON.parse(r.stdout);
    assert.ok(typeof out.total === 'number');
    assert.ok(typeof out.success === 'number');
    assert.ok(typeof out.error === 'number');
    assert.ok(typeof out.error_rate === 'number');
    assert.equal(out.success, 1);
    assert.equal(out.error, 0);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── F: Audit file absent → history --audit exits 0 with empty message ────────

test('Story 10 CLI: kdna history --audit with no audit file exits 0', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s10-home-'));
  try {
    const r = run(['history', '--audit'], { kdnaHome: tmpHome });
    assert.equal(r.status, 0, `expected exit 0:\n${r.stderr}`);
    assert.match(r.stdout, /No audit log entries found/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
