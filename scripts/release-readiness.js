#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EXPECTED_PACKAGE_NAME, STABLE_VERSION_RE } = require('./release-policy');
const { CORE_CANDIDATE_VERSION } = require('./core-candidate');
const {
  canonicalRegistryUrl,
  verifyCandidateBinding,
  verifyInstalledAikdnaGraph,
} = require('./runtime-candidate-binding');

const CORE_PACKAGE_NAME = '@aikdna/kdna-core';
const REQUIRED_CORE_VERSION = CORE_CANDIDATE_VERSION;
const CBOR_PACKAGE_NAME = 'cbor-x';
const REQUIRED_CBOR_VERSION = '1.6.4';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateReleaseReadiness({ pkg, lock, installedCore, installedCbor }) {
  assert(pkg?.name === EXPECTED_PACKAGE_NAME, `package name must be ${EXPECTED_PACKAGE_NAME}`);
  assert(STABLE_VERSION_RE.test(pkg.version || ''), 'CLI version must be stable canonical SemVer');
  assert(lock?.lockfileVersion === 3, 'package-lock.json must use lockfileVersion 3');

  const declaredCore = pkg.dependencies?.[CORE_PACKAGE_NAME];
  assert(
    declaredCore === REQUIRED_CORE_VERSION,
    `Core dependency must be ${REQUIRED_CORE_VERSION}; found ${String(declaredCore)}`,
  );
  const declaredCbor = pkg.dependencies?.[CBOR_PACKAGE_NAME];
  assert(
    declaredCbor === REQUIRED_CBOR_VERSION,
    `CBOR dependency must be ${REQUIRED_CBOR_VERSION}; found ${String(declaredCbor)}`,
  );
  const root = lock.packages?.[''];
  assert(
    root?.name === pkg.name && root?.version === pkg.version,
    'lockfile root identity mismatch',
  );
  assert(
    root.dependencies?.[CORE_PACKAGE_NAME] === REQUIRED_CORE_VERSION,
    'lockfile root Core dependency is stale',
  );
  assert(
    root.dependencies?.[CBOR_PACKAGE_NAME] === REQUIRED_CBOR_VERSION,
    'lockfile root CBOR dependency is stale',
  );
  const lockedCore = lock.packages?.[`node_modules/${CORE_PACKAGE_NAME}`];
  assert(lockedCore?.version === REQUIRED_CORE_VERSION, 'locked Core artifact is stale');
  assert(
    lockedCore?.resolved === canonicalRegistryUrl(CORE_PACKAGE_NAME, REQUIRED_CORE_VERSION),
    `locked Core must use the canonical registry artifact before release; found ${String(lockedCore?.resolved)}`,
  );
  assert(
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(lockedCore?.integrity || ''),
    'locked Core registry integrity is missing or invalid',
  );
  assert(
    installedCore?.name === CORE_PACKAGE_NAME && installedCore?.version === REQUIRED_CORE_VERSION,
    'installed Core artifact does not match the formal release dependency',
  );
  const lockedCbor = lock.packages?.[`node_modules/${CBOR_PACKAGE_NAME}`];
  assert(lockedCbor?.version === REQUIRED_CBOR_VERSION, 'locked CBOR artifact is stale');
  assert(
    lockedCbor?.resolved === canonicalRegistryUrl(CBOR_PACKAGE_NAME, REQUIRED_CBOR_VERSION),
    `locked CBOR must use the canonical registry artifact before release; found ${String(lockedCbor?.resolved)}`,
  );
  assert(
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(lockedCbor?.integrity || ''),
    'locked CBOR registry integrity is missing or invalid',
  );
  assert(
    installedCbor?.name === CBOR_PACKAGE_NAME && installedCbor?.version === REQUIRED_CBOR_VERSION,
    'installed CBOR artifact does not match the formal release dependency',
  );

  return Object.freeze({
    cli: `${pkg.name}@${pkg.version}`,
    core: `${CORE_PACKAGE_NAME}@${REQUIRED_CORE_VERSION}`,
    cbor: `${CBOR_PACKAGE_NAME}@${REQUIRED_CBOR_VERSION}`,
  });
}

function main() {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const installedCorePath = require.resolve(`${CORE_PACKAGE_NAME}/package.json`, { paths: [root] });
  const installedCore = JSON.parse(fs.readFileSync(installedCorePath, 'utf8'));
  const installedCborPath = require.resolve(`${CBOR_PACKAGE_NAME}/package.json`, { paths: [root] });
  const installedCbor = JSON.parse(fs.readFileSync(installedCborPath, 'utf8'));
  verifyCandidateBinding(root);
  verifyInstalledAikdnaGraph(root);
  const ready = validateReleaseReadiness({ pkg, lock, installedCore, installedCbor });
  console.log(`Release dependency closure verified: ${ready.cli} -> ${ready.core}, ${ready.cbor}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Release readiness blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  CORE_PACKAGE_NAME,
  CBOR_PACKAGE_NAME,
  REQUIRED_CORE_VERSION,
  REQUIRED_CBOR_VERSION,
  validateReleaseReadiness,
};
