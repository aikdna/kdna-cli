#!/usr/bin/env node
'use strict';

/**
 * check-test-inventory.js — machine gate that keeps the "complete suite"
 * name honest.
 *
 * Every top-level tests/*.test.js must be covered by exactly one of:
 *   1. run-complete-suite.js UNIT_TEST_FILES (the complete suite), or
 *   2. a dedicated CI job (currently: golden-host-request.test.js), or
 *   3. tests/retired/ (explicitly retired command-surface tests).
 *
 * A new top-level test file that is not wired into the complete suite
 * fails this gate, so a "complete" suite can never silently drop tests.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const RETIRED_DIR = path.join(TESTS_DIR, 'retired');

const { UNIT_TEST_FILES } = require('./run-complete-suite');

const DEDICATED_CI_JOBS = Object.freeze([
  'tests/golden-host-request.test.js',
]);

function fail(message) {
  console.error(`test inventory gate failed: ${message}`);
  process.exitCode = 1;
}

// 1. every listed unit file must exist
for (const relative of UNIT_TEST_FILES) {
  if (!fs.existsSync(path.join(ROOT, relative))) {
    fail(`UNIT_TEST_FILES references a missing file: ${relative}`);
  }
}

// 2. every listed unit file must be a top-level tests/*.test.js
for (const relative of UNIT_TEST_FILES) {
  if (!relative.startsWith('tests/') || !relative.endsWith('.test.js') || relative.includes('/retired/')) {
    fail(`UNIT_TEST_FILES entry is not a top-level test path: ${relative}`);
  }
}

// 3. UNIT_TEST_FILES must not contain duplicates
const seen = new Set();
for (const relative of UNIT_TEST_FILES) {
  if (seen.has(relative)) fail(`duplicate UNIT_TEST_FILES entry: ${relative}`);
  seen.add(relative);
}

// 4. every top-level tests/*.test.js must be covered
const topLevel = fs
  .readdirSync(TESTS_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => `tests/${name}`)
  .sort();

const covered = new Set([...UNIT_TEST_FILES, ...DEDICATED_CI_JOBS]);
for (const relative of topLevel) {
  if (!covered.has(relative)) {
    fail(
      `${relative} is not wired into the complete suite or a dedicated CI job ` +
      '(add it to UNIT_TEST_FILES, add a dedicated CI job, or move it to tests/retired/)',
    );
  }
}

// 5. retired files are quarantined in tests/retired/ and never wired in
if (fs.existsSync(RETIRED_DIR)) {
  const retired = fs.readdirSync(RETIRED_DIR).filter((name) => name.endsWith('.test.js'));
  for (const name of retired) {
    const relative = `tests/retired/${name}`;
    if (covered.has(relative)) fail(`retired test must not be wired into the suite: ${relative}`);
  }
}

if (!process.exitCode) {
  console.log(
    `test inventory gate passed: ${topLevel.length} top-level test(s), ` +
    `${UNIT_TEST_FILES.length} in the complete suite, ${DEDICATED_CI_JOBS.length} dedicated CI job(s)`,
  );
}
