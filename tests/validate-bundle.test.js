/**
 * validate-bundle.test.js — kdna validate --bundle stub tests
 * (roadmap-2026.md §5.1 Story 3, RFC #148 v1.x Phase 1).
 *
 * Verifies that `kdna validate <bundle.json> --bundle` correctly:
 *
 *   - Validates a well-formed bundle manifest with valid components
 *   - Rejects a bundle with a missing bundle_format field
 *   - Rejects a bundle whose component paths do not exist
 *   - Rejects a bundle manifest with invalid JSON
 *   - Rejects a missing manifest file
 *   - Accepts two components pointing at the same fixture (valid duplicate)
 *   - Emits the conflict-analysis stub INFO note in all valid runs
 *
 * The conflict analysis itself is NOT tested here (that is Story 9).
 * The test at the bottom of this file verifies that the stub INFO
 * note is present so callers can detect that Story 9 is pending.
 *
 * Run: node --test tests/validate-bundle.test.js
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

/** Write a bundle manifest and return its absolute path. */
function writeBundle(dir, data, filename = 'bundle.json') {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('validate --bundle: valid manifest with one component exits 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bundle-'));
  try {
    const bundlePath = writeBundle(tmp, {
      bundle_format: 'kdna-bundle-v1',
      name: '@test/single',
      version: '1.0.0',
      components: [
        { id: '@test/comp-a@1.0.0', path: FIXTURE, priority: 1 },
      ],
    });
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.bundle_valid, true);
    assert.equal(out.bundle_format, 'kdna-bundle-v1');
    assert.equal(out.components.length, 1);
    assert.equal(out.components[0].id, '@test/comp-a@1.0.0');
    assert.equal(out.components[0].valid, true);
    assert.equal(out.conflicts.error_count, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate --bundle: two valid components exits 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bundle-'));
  try {
    const bundlePath = writeBundle(tmp, {
      bundle_format: 'kdna-bundle-v1',
      name: '@test/dual',
      version: '1.0.0',
      components: [
        { id: '@test/comp-a@1.0.0', path: FIXTURE, priority: 1 },
        { id: '@test/comp-b@1.0.0', path: FIXTURE, priority: 2 },
      ],
    });
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 0, `expected exit 0:\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.bundle_valid, true);
    assert.equal(out.components.length, 2);
    assert.ok(out.components.every((c) => c.valid === true));
    assert.equal(out.conflicts.error_count, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate --bundle: missing bundle_format exits 1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bundle-'));
  try {
    const bundlePath = writeBundle(tmp, {
      // bundle_format intentionally omitted
      name: '@test/no-format',
      version: '1.0.0',
      components: [
        { id: '@test/comp-a@1.0.0', path: FIXTURE },
      ],
    });
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.bundle_valid, false);
    assert.ok(out.conflicts.error_count > 0);
    const errNote = out.errors.find((e) => e.field === 'bundle_format');
    assert.ok(errNote, 'should have a bundle_format error entry');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate --bundle: component path does not exist exits 1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bundle-'));
  try {
    const bundlePath = writeBundle(tmp, {
      bundle_format: 'kdna-bundle-v1',
      name: '@test/missing-comp',
      version: '1.0.0',
      components: [
        { id: '@test/comp-a@1.0.0', path: FIXTURE, priority: 1 },
        { id: '@test/ghost@1.0.0', path: './nonexistent.kdna', priority: 2 },
      ],
    });
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.bundle_valid, false);
    const ghostComp = out.components.find((c) => c.id === '@test/ghost@1.0.0');
    assert.ok(ghostComp, 'ghost component should appear in output');
    assert.equal(ghostComp.valid, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate --bundle: empty components array exits 1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bundle-'));
  try {
    const bundlePath = writeBundle(tmp, {
      bundle_format: 'kdna-bundle-v1',
      name: '@test/empty',
      version: '1.0.0',
      components: [],
    });
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.bundle_valid, false);
    const errNote = out.errors.find((e) => e.field === 'components');
    assert.ok(errNote, 'should have a components error entry');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate --bundle: invalid JSON manifest exits 1 with no JSON stdout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bundle-'));
  try {
    const bundlePath = path.join(tmp, 'bad.json');
    fs.writeFileSync(bundlePath, '{ not valid json }');
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    // The output is still JSON (the error result)
    const out = JSON.parse(r.stdout);
    assert.equal(out.bundle_valid, false);
    assert.ok(out.conflicts.error_count > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate --bundle: manifest file does not exist exits 1', () => {
  const r = run(['validate', '/tmp/__nonexistent_bundle_manifest__.json', '--bundle']);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.bundle_valid, false);
});

test('validate --bundle: missing manifest argument exits non-zero with usage message', () => {
  const r = run(['validate', '--bundle']);
  assert.notEqual(r.status, 0, `expected non-zero exit, got 0`);
  assert.match(r.stderr, /Usage/i);
});

test('validate --bundle: valid run includes Story 9 conflict-analysis stub INFO note', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bundle-'));
  try {
    const bundlePath = writeBundle(tmp, {
      bundle_format: 'kdna-bundle-v1',
      name: '@test/stub-check',
      version: '1.0.0',
      components: [
        { id: '@test/comp-a@1.0.0', path: FIXTURE, priority: 1 },
      ],
    });
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    // The stub must emit exactly one INFO entry pointing to Story 9
    assert.equal(out.info.length, 1, 'expected exactly one INFO stub entry');
    assert.ok(
      out.info[0].note.includes('Story 9') || out.info[0].note.includes('CONFLICT_RESOLUTION'),
      'INFO entry should reference Story 9 or CONFLICT_RESOLUTION.md',
    );
    assert.equal(out.conflicts.info_count, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate --bundle: component missing id field records error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bundle-'));
  try {
    const bundlePath = writeBundle(tmp, {
      bundle_format: 'kdna-bundle-v1',
      name: '@test/no-id',
      version: '1.0.0',
      components: [
        { path: FIXTURE, priority: 1 }, // id intentionally absent
      ],
    });
    const r = run(['validate', bundlePath, '--bundle']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.bundle_valid, false);
    const idErr = out.errors.find((e) => e.field === 'id');
    assert.ok(idErr, 'should have an id-field error entry');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
