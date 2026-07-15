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
  const checksums = JSON.parse(fs.readFileSync(path.join(source, 'checksums.json'), 'utf8'));
  return { assetPath, entrySetDigest: checksums.asset_digest };
}

function writeCapsule(tmp, entrySetDigest) {
  const capsulePath = path.join(tmp, 'capsule.json');
  fs.writeFileSync(
    capsulePath,
    JSON.stringify({
      type: 'kdna.context.capsule',
      version: '1.0',
      domain: 'kdna:test:capsule-verification',
      judgment_version: '1.0.0',
      asset_digest: entrySetDigest,
      signature: { state: 'absent' },
      access: 'public',
      profile: 'compact',
      context: { highest_question: 'What boundary was verified?' },
      trace: {
        payload_encoding: 'cbor',
        loaded_by: 'test',
        loaded_at: '2026-07-14T00:00:00.000Z',
        schema_valid: true,
        signature_state: 'absent',
        profile: 'compact',
      },
    }),
  );
  return capsulePath;
}

test('capsule verification recomputes the legacy entry-set digest in memory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-capsule-verify-'));
  try {
    const { assetPath, entrySetDigest } = makeAsset(tmp, 'asset-"quoted"-$(printf ignored).kdna');
    const capsulePath = writeCapsule(tmp, entrySetDigest);

    assert.equal(computeEntrySetDigestFromFile(assetPath), entrySetDigest);
    const result = verifyCapsule(capsulePath, { assetPath });
    assert.equal(result.valid, true, result.errors.join('; '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('capsule verification fails closed for a mismatched entry-set digest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-capsule-mismatch-'));
  try {
    const { assetPath } = makeAsset(tmp);
    const capsulePath = writeCapsule(tmp, `sha256:${'0'.repeat(64)}`);
    const result = verifyCapsule(capsulePath, { assetPath });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes('Entry-set digest mismatch')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('capsule verification fails cleanly for a corrupt container without temp extraction', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-capsule-corrupt-'));
  try {
    const assetPath = path.join(tmp, 'broken-$(touch should-not-exist).kdna');
    fs.writeFileSync(assetPath, 'not a zip');
    const capsulePath = writeCapsule(tmp, `sha256:${'0'.repeat(64)}`);
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
        message.includes('Unable to verify protected runtime entries'),
      ),
    );
    assert.deepEqual(after, before);
    assert.equal(fs.existsSync(path.join(tmp, 'should-not-exist')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
