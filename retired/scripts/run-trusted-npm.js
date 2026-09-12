#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');

const ROOT = path.resolve(__dirname, '..');

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new Error('trusted npm arguments are required');
  const npm = resolveTrustedNpmInvocation(ROOT);
  let result;
  try {
    result = spawnSync(
      npm.command,
      [
        ...npm.prefixArgs,
        '--registry=https://registry.npmjs.org/',
        '--@aikdna:registry=https://registry.npmjs.org/',
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: 'inherit',
      },
    );
  } finally {
    npm.dispose();
  }
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal != null) {
    throw new Error('trusted npm command failed');
  }
}

try {
  main();
} catch (error) {
  console.error('Trusted npm rejected: ' + error.message);
  process.exitCode = 1;
}
