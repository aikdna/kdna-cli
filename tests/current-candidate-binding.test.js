'use strict';
// The current candidate binding: the vendored Core archive is the merged
// source-migration tree (aikdna/kdna PR #394), recorded in
// vendor/current-sources.json, and it is deliberately NOT the published 0.37.6
// tar. These assertions hold the three carriers together — provenance record,
// committed lock, and the accepted_core entry of the public contract binding —
// so none of them can silently drift while the release-wave flip-back is
// pending.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sha512base64 = (bytes) => crypto.createHash('sha512').update(bytes).digest('base64');

test('the vendored Core archive is the recorded candidate, never the registry tar', () => {
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'current-sources.json'), 'utf8'));
  assert.equal(sources.schema, 'kdna.current-candidate-sources');
  assert.equal(sources.packages.length, 1);
  const entry = sources.packages[0];
  assert.equal(entry.name, '@aikdna/kdna-core');
  assert.equal(entry.version, '0.37.6');
  assert.equal(entry.artifact, 'vendor/aikdna-kdna-core-0.37.6.tgz');
  assert.equal(entry.sha256, '287932b98272d243d43f3f6603b13c82f9eb62ce14a9a52160c910cc38f41c5a');
  assert.equal(entry.repository, 'aikdna/kdna');
  assert.match(entry.commit, /^[0-9a-f]{40}$/u);
  assert.match(entry.tree, /^[0-9a-f]{40}$/u);
  assert.equal(entry.packageDirectory, 'packages/kdna-core');
  assert.equal(entry.sourceEnvironment, 'KDNA_CORE_CANDIDATE_SOURCE');
  assert.equal(entry.registry_coordinate.version, '0.37.6');
  assert.equal(entry.registry_coordinate.tar_sha256, '17137ebdd316f5e44b64c6164d6fca07b0e8486b42b5eb6e85347d92ad25087f');

  const bytes = fs.readFileSync(path.join(root, entry.artifact));
  assert.equal(sha256(bytes), entry.sha256);
  assert.notEqual(entry.sha256, entry.registry_coordinate.tar_sha256, 'candidate bytes must differ from the published tar');

  const binding = JSON.parse(fs.readFileSync(path.join(root, 'public-contract-binding.json'), 'utf8'));
  assert.equal(binding.accepted_core.version, entry.version);
  assert.equal(binding.accepted_core.tar_sha256, entry.sha256);
  assert.equal(binding.accepted_core.source, entry.artifact);
});

test('the committed lock installs the vendored candidate archive exactly', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const entry = lock.packages['node_modules/@aikdna/kdna-core'];
  const bytes = fs.readFileSync(path.join(root, 'vendor', 'aikdna-kdna-core-0.37.6.tgz'));
  assert.equal(entry.version, '0.37.6');
  assert.equal(entry.resolved, 'file:vendor/aikdna-kdna-core-0.37.6.tgz');
  assert.equal(entry.integrity, 'sha512-' + sha512base64(bytes));
  assert.equal(lock.packages[''].dependencies['@aikdna/kdna-core'], 'file:vendor/aikdna-kdna-core-0.37.6.tgz');
});

test('the Read companion archive stays the published bytes', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].dependencies['@aikdna/kdna-read'], '0.13.0');
  const bytes = fs.readFileSync(path.join(root, 'vendor', 'aikdna-kdna-read-0.13.0.tgz'));
  assert.equal(sha256(bytes), '26f62bb703c7ad92acdfa02e44b3b981f73ec2e9c20bec29e1412937968170a7');
});
