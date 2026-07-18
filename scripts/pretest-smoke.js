#!/usr/bin/env node
/**
 * kdna-cli pretest smoke — PR-8 replacement for the old
 * `npm install --ignore-scripts` pretest, which silently mutated
 * node_modules and hid lockfile drift. This script:
 *   1. Verifies @aikdna/kdna-core is loadable
 *   2. Verifies the installed version matches the declared range
 *   3. Fails fast with a clear error if anything is off
 *
 * CI should run `npm ci` explicitly before invoking the test scripts;
 * this script intentionally does NOT install or modify node_modules.
 */

const path = require('path');
const {
  verifyCandidateBinding,
  verifyInstalledAikdnaGraph,
} = require('./runtime-candidate-binding');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

console.log('kdna-cli pretest smoke');

// 1. @aikdna/kdna-core must be requireable.
check('require @aikdna/kdna-core', () => {
  const core = require('@aikdna/kdna-core');
  if (!core || typeof core !== 'object') {
    throw new Error('kdna-core module exports falsy');
  }
});

// 2. kdna-core must expose STANDARD_ENTRIES (PR-1 invariant).
check('STANDARD_ENTRIES exported', () => {
  const core = require('@aikdna/kdna-core');
  if (!Array.isArray(core.STANDARD_ENTRIES) || core.STANDARD_ENTRIES.length === 0) {
    throw new Error('STANDARD_ENTRIES missing or empty (PR-1 regression?)');
  }
});

// 3. kdna-core version matches what kdna-cli declares.
check('installed kdna-core version exactly matches declared version', () => {
  const corePath = require.resolve('@aikdna/kdna-core/package.json');
  const installed = require(corePath).version;
  const declared = require('../package.json').dependencies['@aikdna/kdna-core'];
  if (!declared) throw new Error('kdna-cli does not declare @aikdna/kdna-core');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(declared)) {
    throw new Error(`declared Core dependency must be an exact version: ${declared}`);
  } else if (installed !== declared) {
    throw new Error(`exact mismatch: installed ${installed} vs declared ${declared}`);
  }
  console.log(`       installed=${installed} declared=${declared}`);
});

check('installed kdna-eval version exactly matches declared version', () => {
  const evalPath = require.resolve('@aikdna/kdna-eval/package.json');
  const installed = require(evalPath).version;
  const declared = require('../package.json').dependencies['@aikdna/kdna-eval'];
  if (declared !== '0.3.1') {
    throw new Error(`declared Eval dependency must be exactly 0.3.1: ${String(declared)}`);
  }
  if (installed !== declared) {
    throw new Error(`exact mismatch: installed ${installed} vs declared ${declared}`);
  }
  console.log(`       installed=${installed} declared=${declared}`);
});

check('all command Eval root API contracts are available', () => {
  const { loadKdnaEval } = require('../src/cmds/_kdna-eval');
  for (const command of [
    'compose',
    'compose-review',
    'route',
    'eval-consumption',
    'eval-asset',
    'eval-cluster',
  ]) {
    loadKdnaEval(command);
  }
});

check('candidate dependency binding is complete and byte-authenticated', () => {
  verifyCandidateBinding(ROOT);
});

check('installed AIKDNA package graph is canonical and unique', () => {
  verifyInstalledAikdnaGraph(ROOT);
});

if (failures > 0) {
  console.error(`\nkdna-cli pretest smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nkdna-cli pretest smoke: all checks passed');
