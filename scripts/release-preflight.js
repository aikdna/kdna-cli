#!/usr/bin/env node

const { execFileSync } = require('child_process');
const path = require('node:path');
const { assertTrustedIndexIsOrdinary, runTrustedGit } = require('./trusted-git');

const root = path.resolve(__dirname, '..');
const node = process.execPath;

const checks = [
  [node, ['scripts/run-trusted-npm.js', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']],
  [node, ['scripts/release-readiness.js']],
  [node, ['scripts/check-public-surface.mjs']],
  [node, ['scripts/check-workflow-authority.js']],
  [node, ['scripts/check-current-protocol-names.js']],
  [node, ['node_modules/prettier/bin/prettier.cjs', '--check', '.']],
  [node, ['node_modules/eslint/bin/eslint.js', 'src/', 'validators/', 'tests/']],
  [node, ['scripts/run-complete-suite.js', '--complete']],
  [node, ['scripts/verify-eval-runtime-package.js']],
  [node, ['scripts/verify-pack-policy.js']],
];

for (const [command, args] of checks) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit' });
}

console.log('\n$ trusted git diff --check');
assertTrustedIndexIsOrdinary(root);
runTrustedGit(root, ['diff', '--check'], { stdio: 'inherit' });

console.log('\nKDNA CLI release preflight passed');
