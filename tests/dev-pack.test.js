/**
 * dev-pack.test.js — dev .kdna container packing (cbor-x dependency)
 *
 * cbor-x is an optional dependency. These tests are skipped when it is
 * not installed; they run in full when cbor-x is available.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

let hasCbor = false;
try {
  require('cbor-x');
  hasCbor = true;
} catch {
  /* ignore */
}

const devPack = require('../src/dev-pack');

// ─── Module shape (always runs) ───────────────────────────────────────────────

test('dev-pack: module exports expected functions', () => {
  assert.equal(typeof devPack.packKdna, 'function', 'packKdna not exported');
  assert.equal(
    typeof devPack.verifySourceIntegrity,
    'function',
    'verifySourceIntegrity not exported',
  );
  assert.equal(typeof devPack.computeDirHash, 'function', 'computeDirHash not exported');
});

test('dev-pack: packKdna throws cbor-x error when not installed', () => {
  if (hasCbor) return; // skip when cbor-x IS available
  assert.throws(() => devPack.packKdna(os.tmpdir(), {}), /cbor-x is required/);
});

test('dev-pack: packs current source without requiring a Human Lock', () => {
  if (hasCbor) {
    const os2 = require('os');
    const fs2 = require('fs');
    const path2 = require('path');
    const src = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kdna-dev-'));
    try {
      fs2.writeFileSync(
        path2.join(src, 'KDNA_Core.json'),
        JSON.stringify({
          meta: { domain: 'test', version: '0.0.1', purpose: 'test' },
          axioms: [],
          ontology: [],
          stances: [],
        }),
      );
      fs2.writeFileSync(
        path2.join(src, 'KDNA_Patterns.json'),
        JSON.stringify({
          meta: { domain: 'test', version: '0.0.1', purpose: 'test' },
          terminology: { standard_terms: [], banned_terms: [] },
          misunderstandings: [],
          self_check: [],
        }),
      );
      const result = devPack.packKdna(src, { name: 'test/x', version: '0.0.1' });
      assert.ok(result && typeof result === 'object', 'should return an object');
      assert.ok(result.entries, 'should have entries');
      assert.ok(result.entries['kdna.json'], 'should have kdna.json');
      assert.ok(result.entries['payload.kdnab'], 'should have payload.kdnab');
      assert.equal(
        result.entries.mimetype,
        'application/vnd.kdna.asset',
        'mimetype must be the single KDNA asset media type',
      );
      const manifest = JSON.parse(result.entries['kdna.json']);
      assert.equal(JSON.stringify(manifest).includes('human_lock'), false);
      assert.equal(manifest.format_version, '0.1.0');
      assert.equal(manifest.compatibility.profile, 'kdna.payload.judgment');
      assert.equal(manifest.compatibility.profile_version, '0.1.0');
      assert.equal(manifest.payload.path, 'payload.kdnab');
      assert.equal(manifest.payload.encoding, 'cbor');
      assert.equal(manifest.payload.encrypted, false);
      assert.equal(result.entries['payload.kdnab'].length > 0, true);
      assert.equal(result.payload.profile, 'kdna.payload.judgment');
      assert.equal(result.payload.profile_version, '0.1.0');
      const checksums = JSON.parse(result.entries['checksums.json']);
      assert.equal(checksums.digest_profile, 'kdna.digest-basis.runtime-entry-set');
      assert.equal(checksums.digest_profile_version, '0.1.0');
      assert.equal(checksums.asset_digest, undefined);
    } finally {
      fs2.rmSync(src, { recursive: true, force: true });
    }
  } else {
    // cbor-x not installed — test the error path
    assert.throws(() => devPack.packKdna(require('os').tmpdir(), {}), /cbor-x is required/);
  }
});

test('dev-pack: obsolete manifest fields fail closed instead of being stripped', () => {
  if (!hasCbor) return;
  const obsoleteField = ['kdna', 'version'].join('_');
  assert.throws(
    () => devPack.packKdna(os.tmpdir(), { [obsoleteField]: '1.0' }),
    new RegExp(`Unsupported manifest fields: ${obsoleteField}`),
  );
});
