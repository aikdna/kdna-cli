#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  'manifest.schema.json',
  'checksums.schema.json',
  'load-contract.schema.json',
  'payload-profile.schema.json',
  'bundle-profile.schema.json',
];

function coreSchemaRoot() {
  const sourceRoot = process.env.KDNA_CORE_SOURCE_ROOT;
  if (sourceRoot) return path.join(path.resolve(sourceRoot), 'schema');
  return path.join(path.dirname(require.resolve('@aikdna/kdna-core/package.json')), 'schema');
}

function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--write'].includes(mode)) {
    throw new Error('usage: sync-core-schemas.js [--check|--write]');
  }
  const sourceRoot = coreSchemaRoot();
  const mismatches = [];
  for (const file of FILES) {
    const source = path.join(sourceRoot, file);
    const destination = path.join(ROOT, 'schema', file);
    const expected = fs.readFileSync(source);
    if (mode === '--write') {
      fs.writeFileSync(destination, expected);
    } else if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(expected)) {
      mismatches.push(path.relative(ROOT, destination));
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Core schema copies are stale:\n${mismatches.map((file) => `- ${file}`).join('\n')}`,
    );
  }
  console.log(`Core schema synchronization ${mode === '--write' ? 'completed' : 'verified'}.`);
}

main();
