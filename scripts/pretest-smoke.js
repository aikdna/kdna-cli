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

let failures = 0;

function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); }
  catch (e) { failures += 1; console.error(`  FAIL ${name}: ${e.message}`); }
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
check('installed kdna-core version satisfies declared range', () => {
  const corePath = require.resolve('@aikdna/kdna-core/package.json');
  const installed = require(corePath).version;
  const declared = require('../package.json').dependencies['@aikdna/kdna-core'];
  if (!declared) throw new Error('kdna-cli does not declare @aikdna/kdna-core');
  // Naive semver check: declared ^X.Y.Z allows >=X.Y.Z <(X+1).0.0
  const m = declared.match(/\^?(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`unparseable declared range: ${declared}`);
  const [, dmaj, dmin, dpat] = m;
  const inst = installed.split('.').map(Number);
  if (inst[0] !== +dmaj) {
    throw new Error(`major mismatch: installed ${installed} vs declared ${declared}`);
  }
  if (inst[0] === 0) {
    // 0.x.y is special: ^0.y.z means >=0.y.z <0.(y+1).0
    if (inst[1] !== +dmin) {
      throw new Error(`minor mismatch on 0.x: installed ${installed} vs declared ${declared}`);
    }
    if (inst[2] < +dpat) {
      throw new Error(`patch behind: installed ${installed} vs declared ${declared}`);
    }
  } else {
    if (inst[1] < +dmin) {
      throw new Error(`minor behind: installed ${installed} vs declared ${declared}`);
    }
  }
  console.log(`       installed=${installed} declared=${declared}`);
});

if (failures > 0) {
  console.error(`\nkdna-cli pretest smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nkdna-cli pretest smoke: all checks passed');
