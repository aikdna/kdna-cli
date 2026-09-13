#!/usr/bin/env node
'use strict';
/*
 * Preserved-baseline gate.
 *
 * Why it exists: this repository does not carry the published 0.36.1 tree at
 * its root any more. It keeps those bytes under `retired/` and keeps the
 * current component-semantics surface at the root. The retained CI jobs
 * (`golden-host-request`, `runtime-contract`, `evidence` and the exact-Core
 * steps in `test`) execute the published baseline, so they are only a gate on
 * THIS branch if something proves the branch still preserves that baseline.
 * This script is that proof, and it runs in every one of those jobs.
 *
 * What it checks, against a checkout of the published baseline commit:
 *   1. every tracked file under `retired/` is byte-identical to the baseline
 *      file at the same relative path, except for the three declared
 *      deviations, which are asserted exactly (no extra, no missing);
 *   2. `retired/entry-baseline/src/cli.js` is byte-identical to the baseline's
 *      `src/cli.js`;
 *   3. every path of the baseline root is still accounted for in this branch -
 *      either preserved under `retired/` or carried at the branch root - so a
 *      deleted baseline file cannot pass unnoticed;
 *   4. no declared deviation is dead (each one still describes a real path).
 *
 * Usage: node scripts/check-preserved-baseline.cjs <baseline-root>
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RETIRED = 'retired';
const RETIRED_PREFIX = `${RETIRED}/`;
const ENTRY_BASELINE_CLI = 'retired/entry-baseline/src/cli.js';

// The only paths where this branch deliberately departs from the preserved
// baseline. Each entry states why; the script fails if this list and reality
// disagree in either direction.
const DECLARED_DEVIATIONS = Object.freeze({
  'retired/src/cli.js':
    'replaced by the current package bin, which delegates to the current public CLI; ' +
    'the baseline bytes are preserved at retired/entry-baseline/src/cli.js',
  'retired/src/public-cli.js':
    'added by the current component-semantics surface; the baseline has no such path',
  'retired/entry-baseline/src/cli.js':
    'holds the baseline src/cli.js bytes that retired/src/cli.js would otherwise preserve',
});

let failures = 0;

function fail(message) {
  console.error(`preserved-baseline: FAIL ${message}`);
  failures += 1;
  // Set here as well as in the summary: an unexpected throw must not be able to
  // leave the process exiting 0.
  process.exitCode = 1;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function tracked(prefix) {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', prefix], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function main() {
  const baselineArg = process.argv[2];
  if (!baselineArg) throw new Error('usage: check-preserved-baseline.cjs <baseline-root>');
  const baseline = path.resolve(baselineArg);
  if (!fs.existsSync(path.join(baseline, 'package.json'))) {
    throw new Error(`baseline root does not look like a checkout: ${baseline}`);
  }
  const baselineFiles = execFileSync('git', ['-C', baseline, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const baselineSet = new Set(baselineFiles);

  const retired = tracked(RETIRED);
  if (retired.length === 0) throw new Error('no tracked files under retired/; refusing to pass');
  // `retired/<rel>` preserves the baseline path `<rel>`; the prefix is not part
  // of the baseline layout.
  const preserved = new Set(retired.map((rel) => rel.slice(RETIRED_PREFIX.length)));

  const seenDeviations = new Set();
  let identical = 0;
  let accountedAtRoot = 0;

  // (1) every preserved path must match the baseline byte for byte
  for (const rel of retired) {
    const reason = DECLARED_DEVIATIONS[rel];
    if (reason) {
      seenDeviations.add(rel);
      continue;
    }
    const baselineRel = rel.slice(RETIRED_PREFIX.length);
    if (!baselineSet.has(baselineRel)) {
      fail(`${rel} is preserved here but absent from the baseline`);
      continue;
    }
    const counterPart = path.join(baseline, baselineRel);
    if (sha256(path.join(ROOT, rel)) !== sha256(counterPart)) {
      fail(`${rel} differs from the baseline bytes`);
      continue;
    }
    identical += 1;
  }

  // (4) a declared deviation that no longer exists is a dead claim
  for (const rel of Object.keys(DECLARED_DEVIATIONS)) {
    if (!seenDeviations.has(rel)) fail(`declared deviation ${rel} is dead (path not present)`);
    if (!fs.existsSync(path.join(ROOT, rel))) fail(`declared deviation ${rel} does not exist`);
  }

  // (2) the baseline CLI entry is preserved under a different name
  const baselineCli = path.join(baseline, 'src/cli.js');
  if (!fs.existsSync(baselineCli)) {
    fail('baseline src/cli.js is missing; cannot verify the preserved entry bytes');
  } else if (sha256(path.join(ROOT, ENTRY_BASELINE_CLI)) !== sha256(baselineCli)) {
    fail(`${ENTRY_BASELINE_CLI} does not carry the baseline src/cli.js bytes`);
  }

  // (3) nothing from the baseline root may simply disappear
  for (const rel of baselineFiles) {
    if (fs.existsSync(path.join(ROOT, rel))) {
      accountedAtRoot += 1;
      continue;
    }
    if (preserved.has(rel)) continue;
    fail(`baseline path ${rel} is neither preserved under retired/ nor carried at the branch root`);
  }

  console.log(
    `preserved-baseline: ${failures === 0 ? 'MATCH' : 'MISMATCH'} retired=${retired.length} identical=${identical} ` +
      `declared_deviations=${seenDeviations.size} carried_at_root=${accountedAtRoot} ` +
      `baseline_paths=${baselineFiles.length}`,
  );
  if (failures > 0) {
    console.error(`preserved-baseline: ${failures} finding(s); refusing to pass`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  fail(error.message);
}
