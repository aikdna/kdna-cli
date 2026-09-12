#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('@aikdna/kdna-core');

const target = process.argv[2];
if (!target || target === '--help' || target === '-h') {
  console.log(`kdna-validate — Validate a current KDNA source or packaged asset.

Usage: kdna-validate <source-folder|asset.kdna>

Options:
  -h, --help    Show this help message`);
  process.exit(target ? 0 : 2);
}

const absolute = path.resolve(target);
if (!fs.existsSync(absolute)) {
  console.error(`Not found: ${absolute}`);
  process.exit(2);
}
if (typeof core.validate !== 'function') {
  console.error('Current @aikdna/kdna-core validate API is required.');
  process.exit(2);
}

let result;
try {
  result = core.validate(absolute);
} catch (cause) {
  console.error(`Validation failed closed: ${cause.message}`);
  process.exit(1);
}
if (!result || typeof result.overall_valid !== 'boolean' || !Array.isArray(result.problems)) {
  console.error('Validation failed closed: Core returned an incomplete validation result.');
  process.exit(1);
}
if (!result.overall_valid) {
  console.error('Errors:');
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`✓ KDNA asset valid: ${absolute}`);
