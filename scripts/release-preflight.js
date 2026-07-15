#!/usr/bin/env node

const { execFileSync } = require('child_process');

const checks = [
  ['npm', ['ci', '--ignore-scripts']],
  ['node', ['scripts/release-readiness.js']],
  ['node', ['scripts/check-public-surface.mjs']],
  ['node', ['scripts/check-current-protocol-names.js']],
  ['npm', ['run', 'format:check']],
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'test:all']],
  ['npm', ['run', 'pack:verify']],
  ['git', ['diff', '--check']],
];

for (const [command, args] of checks) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit' });
}

console.log('\nKDNA CLI release preflight passed');
