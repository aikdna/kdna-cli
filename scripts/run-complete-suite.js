#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UNIT_TEST_FILES = Object.freeze([
  'tests/release-surface.test.js',
  'tests/cli-smoke.test.js',
  'tests/workspace-attachments.test.js',
  'tests/demo.test.js',
  'tests/e2e-encrypt.test.js',
  'tests/story10-audit-log.test.js',
  'tests/external-entitlement.test.js',
  'tests/secret-store.test.js',
  'tests/runtime-remote-transport.test.js',
  'tests/public-surface-policy.test.js',
  'tests/protocol-naming-gate.test.js',
  'tests/workflow-authority.test.js',
  'tests/runtime-candidate-binding.test.js',
  'tests/publish-hardening.test.js',
]);

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal != null) {
    throw new Error(`direct Node test step failed: ${args.join(' ')}`);
  }
}

function runUnitSuite() {
  runNode(['--test', ...UNIT_TEST_FILES]);
}

function runSmokeSuite() {
  runNode(['scripts/pretest-smoke.js']);
}

function main() {
  const mode = process.argv[2] || '--complete';
  if (
    !['--complete', '--unit', '--smoke'].includes(mode) ||
    process.argv.length < 2 ||
    process.argv.length > 3
  ) {
    throw new Error('usage: run-complete-suite.js [--complete|--unit|--smoke]');
  }
  if (mode === '--complete') {
    runNode(['scripts/check-public-surface.mjs']);
    runNode(['scripts/check-current-protocol-names.js']);
  }
  if (mode !== '--smoke') runUnitSuite();
  if (mode !== '--unit') runSmokeSuite();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Complete test suite failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { UNIT_TEST_FILES, runSmokeSuite, runUnitSuite };
