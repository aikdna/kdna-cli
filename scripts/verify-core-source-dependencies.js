#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CORE_CANDIDATE_PACKAGE,
  CORE_CANDIDATE_VERSION,
  readPinnedCoreCommit,
} = require('./core-candidate');
const { inspectCoreSourceAuthority } = require('./core-source-authority');

const ROOT = path.resolve(__dirname, '..');

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..';
}

function verifyCoreSourceDependencies(sourceRoot) {
  const authority = inspectCoreSourceAuthority(
    path.resolve(sourceRoot),
    readPinnedCoreCommit(ROOT),
  );
  const { packageJson, packageRoot, repository } = authority;
  const candidateNodeModules = fs.realpathSync(path.join(repository, 'node_modules'));

  assert.equal(packageJson.name, CORE_CANDIDATE_PACKAGE);
  assert.equal(packageJson.version, CORE_CANDIDATE_VERSION);

  const verified = [];
  for (const dependency of Object.keys(packageJson.dependencies || {}).sort()) {
    const dependencyRoot = fs.realpathSync(
      path.join(candidateNodeModules, ...dependency.split('/')),
    );
    const installed = JSON.parse(
      fs.readFileSync(path.join(dependencyRoot, 'package.json'), 'utf8'),
    );
    assert.equal(installed.name, dependency, `${dependency} package identity must match`);

    const resolvedEntry = fs.realpathSync(require.resolve(dependency, { paths: [packageRoot] }));
    assert.ok(
      isWithin(dependencyRoot, resolvedEntry),
      `${dependency} resolved outside the candidate checkout: ${resolvedEntry}`,
    );
    assert.ok(
      isWithin(candidateNodeModules, dependencyRoot),
      `${dependency} was not installed under the candidate checkout`,
    );
    verified.push(`${dependency}@${installed.version}`);
  }

  assert.ok(verified.length > 0, 'Core candidate must declare runtime dependencies');
  return verified;
}

function main() {
  const sourceRoot = process.env.KDNA_CORE_SOURCE_ROOT;
  if (!sourceRoot) throw new Error('KDNA_CORE_SOURCE_ROOT is required.');
  const verified = verifyCoreSourceDependencies(sourceRoot);
  console.log(`Exact Core source dependencies verified: ${verified.join(', ')}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Core source dependency verification blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyCoreSourceDependencies };
