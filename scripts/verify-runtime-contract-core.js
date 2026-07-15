#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  CORE_CANDIDATE_EVIDENCE_PATH,
  CORE_CANDIDATE_PACKAGE,
  CORE_CANDIDATE_VERSION,
  readPinnedCoreCommit,
} = require('./core-candidate');

const root = path.resolve(__dirname, '..');
const evidencePath = path.join(root, CORE_CANDIDATE_EVIDENCE_PATH);
const sourceRoot = process.env.KDNA_CORE_SOURCE_ROOT || process.env.KDNA_RUNTIME_CONTRACT_CORE_ROOT;

if (!sourceRoot) {
  throw new Error('KDNA_CORE_SOURCE_ROOT is required to verify the unpublished Core candidate.');
}

execFileSync(
  process.execPath,
  [path.join(__dirname, 'generate-core-candidate-evidence.js'), '--check'],
  {
    cwd: root,
    env: { ...process.env, KDNA_CORE_SOURCE_ROOT: path.resolve(sourceRoot) },
    stdio: 'inherit',
  },
);

const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');
const candidateRoot = path.resolve(sourceRoot);

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

assert.equal(evidence.evidence_kind, 'candidate_source_pack');
assert.equal(evidence.package, CORE_CANDIDATE_PACKAGE);
assert.equal(evidence.version, CORE_CANDIDATE_VERSION);
assert.equal(evidence.git_head, readPinnedCoreCommit(root));
assert.equal(evidence.registry_artifact, null);
assert.equal(evidence.pack.status, 'candidate_source_pack_not_registry_artifact');
assert.equal(evidence.pack.reproducible_runs, 2);
assert.equal(packageJson.dependencies[evidence.package], evidence.version);
assert.equal(packageLock.packages['node_modules/@aikdna/kdna-core'].version, evidence.version);

const candidatePackage = JSON.parse(
  fs.readFileSync(path.join(candidateRoot, 'package.json'), 'utf8'),
);
assert.equal(candidatePackage.name, evidence.package);
assert.equal(candidatePackage.version, evidence.version);
const repository = path.resolve(candidateRoot, '..', '..');
const sourceCommit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
assert.equal(sourceCommit, evidence.git_head, 'candidate Core source commit');
for (const [relative, expected] of Object.entries(evidence.files)) {
  assert.equal(
    digest(path.join(candidateRoot, relative)),
    expected,
    `candidate source ${relative}`,
  );
}

console.log(
  `Core candidate evidence passed: ${evidence.package}@${evidence.version} ${evidence.git_head.slice(0, 12)} (not registry evidence)`,
);
