'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('@aikdna/kdna-core');
const { verifyCapsule, computeEntrySetDigestFromFile } = require('../src/capsule-verify');

function makeAsset(tmp, fileName = 'asset.kdna') {
  const source = path.join(tmp, 'source');
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'judgment'), source, {
    recursive: true,
  });
  const assetPath = path.join(tmp, fileName);
  core.pack(source, assetPath);
  return { assetPath, capsule: core.loadRuntimeCapsule(assetPath, { profile: 'compact' }) };
}

function writeCapsule(tmp, capsule) {
  const capsulePath = path.join(tmp, 'capsule.json');
  fs.writeFileSync(capsulePath, JSON.stringify(capsule));
  return capsulePath;
}

test('capsule verification recomputes current A/C/E digest evidence in memory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-capsule-verify-'));
  try {
    const { assetPath, capsule } = makeAsset(tmp, 'asset-"quoted"-$(printf ignored).kdna');
    const capsulePath = writeCapsule(tmp, capsule);

    assert.equal(
      computeEntrySetDigestFromFile(assetPath),
      capsule.digests.runtime_entry_set.value,
    );
    const result = verifyCapsule(capsulePath, { assetPath });
    assert.equal(result.valid, true, result.errors.join('; '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('capsule verification fails closed for a mismatched entry-set digest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-capsule-mismatch-'));
  try {
    const { assetPath, capsule } = makeAsset(tmp);
    capsule.digests.runtime_entry_set.value = `sha256:${'0'.repeat(64)}`;
    const capsulePath = writeCapsule(tmp, capsule);
    const result = verifyCapsule(capsulePath, { assetPath });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('Runtime entry-set digest mismatch')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('capsule verification fails cleanly for a corrupt container without temp extraction', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-capsule-corrupt-'));
  try {
    const assetPath = path.join(tmp, 'broken-$(touch should-not-exist).kdna');
    fs.writeFileSync(assetPath, 'not a zip');
    const { capsule } = makeAsset(tmp, 'valid.kdna');
    const capsulePath = writeCapsule(tmp, capsule);
    const before = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('kdna-cv-'))
      .sort();

    const result = verifyCapsule(capsulePath, { assetPath });
    const after = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('kdna-cv-'))
      .sort();
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((message) =>
        message.includes('Unable to verify packaged asset digest evidence'),
      ),
    );
    assert.deepEqual(after, before);
    assert.equal(fs.existsSync(path.join(tmp, 'should-not-exist')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
