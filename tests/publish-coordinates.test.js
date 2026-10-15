'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findingsFor } = require('../scripts/check-publish-coordinates');

// C01: a non-private package may not carry `file:` coordinates into a publish.
// `file:` coordinates are the offline-installable form inside this workspace
// (the gate's own header), and this repository is deliberately between
// releases right now: the working graph carries exactly one `file:` candidate
// coordinate — @aikdna/kdna-core, whose source-migration tree is merged
// (aikdna/kdna PR #394) but not yet published as its successor release. The
// expectation below is pinned to that exact finding set so a silent re-pin
// cannot pass unnoticed, and the real protection is unchanged: publish.yml
// still runs the gate and refuses this tree. The negatives after it keep this
// test from passing for the wrong reason.

const root = path.resolve(__dirname, '..');
const checker = path.join(root, 'scripts', 'check-publish-coordinates.js');

test('the committed manifest carries exactly the deliberate unreleased-candidate finding', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.private, undefined);
  assert.deepEqual(findingsFor(manifest), [{
    rule: 'non_private_package_declares_file_coordinate',
    package: '@aikdna/kdna-cli',
    field: 'dependencies',
    name: '@aikdna/kdna-core',
    spec: 'file:vendor/aikdna-kdna-core-0.37.6.tgz',
  }]);
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /non_private_package_declares_file_coordinate/);
});

test('a non-private package on a file: coordinate is a finding', () => {
  const findings = findingsFor({
    name: '@aikdna/probe',
    dependencies: { '@aikdna/kdna-core': 'file:vendor/aikdna-kdna-core-0.36.0-rc.r2.7.tgz' },
  });
  assert.deepEqual(
    findings.map((finding) => finding.rule),
    ['non_private_package_declares_file_coordinate'],
  );
  assert.ok(findings[0].spec.startsWith('file:'));
});

test('a private package with the same graph is not a finding', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(findingsFor({ ...manifest, private: true }), []);
});

test('a non-private package on exact registry coordinates is not a finding', () => {
  assert.deepEqual(
    findingsFor({ name: '@aikdna/probe', dependencies: { '@aikdna/kdna-core': '0.37.6' } }),
    [],
  );
  assert.equal(
    findingsFor({ name: '@aikdna/probe', dependencies: { '@aikdna/kdna-core': 'file:vendor/a.tgz' } }).length,
    1,
  );
  assert.equal(
    findingsFor({ name: '@aikdna/probe', devDependencies: { '@aikdna/kdna-core': 'file:vendor/a.tgz' } }).length,
    1,
  );
});

test('the gate points at the tree it is given', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-coordinates-'));
  try {
    fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({
      name: '@aikdna/probe',
      dependencies: { '@aikdna/kdna-core': 'file:vendor/aikdna-kdna-core-0.37.6.tgz' },
    }));
    const failing = spawnSync(process.execPath, [checker, '--root', scratch], { encoding: 'utf8' });
    assert.equal(failing.status, 1);
    const reportOnly = spawnSync(process.execPath, [checker, '--root', scratch, '--report-only'], { encoding: 'utf8' });
    assert.equal(reportOnly.status, 0);
    fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({
      name: '@aikdna/probe',
      private: true,
      dependencies: { '@aikdna/kdna-core': 'file:vendor/aikdna-kdna-core-0.37.6.tgz' },
    }));
    const privateOk = spawnSync(process.execPath, [checker, '--root', scratch], { encoding: 'utf8' });
    assert.equal(privateOk.status, 0);
    assert.match(privateOk.stdout, /findings=0/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
