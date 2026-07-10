/**
 * dev-pack-v2.test.js — v2 container packing (cbor-x dependency)
 *
 * cbor-x is an optional dependency. These tests are skipped when it is
 * not installed; they run in full when cbor-x is available.
 */
'use strict';

const { test, skip } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

let hasCbor = false;
try {
  require('cbor-x');
  hasCbor = true;
} catch (_) {
  /* ignore */
}

const devPack = require('../src/dev-pack-v2');

// ─── Module shape (always runs) ───────────────────────────────────────────────

test('dev-pack-v2: module exports expected functions', () => {
  assert.equal(typeof devPack.packV2, 'function', 'packV2 not exported');
  assert.equal(
    typeof devPack.verifySourceIntegrity,
    'function',
    'verifySourceIntegrity not exported',
  );
  assert.equal(typeof devPack.computeDirHash, 'function', 'computeDirHash not exported');
});

test('dev-pack-v2: packV2 throws cbor-x error when not installed', () => {
  if (hasCbor) return; // skip when cbor-x IS available
  assert.throws(() => devPack.packV2(os.tmpdir(), {}), /cbor-x is required/);
});

test('dev-pack-v2: packV2 returns entries object (does not write a file)', () => {
  if (hasCbor) {
    const os2 = require('os');
    const src = require('fs').mkdtempSync(require('path').join(os2.tmpdir(), 'kdna-v2-'));
    try {
      const result = devPack.packV2(src, { name: 'test/x', version: '0.0.1' });
      assert.ok(result && typeof result === 'object', 'should return an object');
      assert.ok(result.entries, 'should have entries');
      assert.ok(result.entries['kdna.json'], 'should have kdna.json');
      assert.ok(result.entries['payload.kdnab'], 'should have payload.kdnab');
    } finally {
      require('fs').rmSync(src, { recursive: true, force: true });
    }
  } else {
    // cbor-x not installed — test the error path
    assert.throws(() => devPack.packV2(require('os').tmpdir(), {}), /cbor-x is required/);
  }
});
