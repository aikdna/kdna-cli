#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const evidence = require('../tests/fixtures/core-0.18-release-evidence.json');
const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');
const installedRoot = path.dirname(require.resolve('@aikdna/kdna-core/package.json'));
const installedPackage = require('@aikdna/kdna-core/package.json');
const lockEntry = packageLock.packages['node_modules/@aikdna/kdna-core'];

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

assert.equal(packageJson.dependencies[evidence.package], evidence.version);
assert.equal(installedPackage.version, evidence.version);
assert.equal(lockEntry.version, evidence.version);
assert.equal(lockEntry.integrity, evidence.registry_integrity);
assert.equal(
  lockEntry.resolved,
  `https://registry.npmjs.org/@aikdna/kdna-core/-/kdna-core-${evidence.version}.tgz`,
);

for (const [relative, expected] of Object.entries(evidence.files)) {
  assert.equal(digest(path.join(installedRoot, relative)), expected, `installed ${relative}`);
}

const sourceRoot = process.env.KDNA_RUNTIME_CONTRACT_CORE_ROOT;
if (sourceRoot) {
  const absoluteSource = path.resolve(sourceRoot);
  const sourceCommit = execFileSync('git', ['-C', absoluteSource, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(sourceCommit, evidence.git_head, 'pinned Core source commit');
  for (const [relative, expected] of Object.entries(evidence.files)) {
    assert.equal(digest(path.join(absoluteSource, relative)), expected, `source ${relative}`);
  }
}

console.log(
  `Core release evidence passed: ${evidence.package}@${evidence.version} ${evidence.git_head.slice(0, 12)}`,
);
