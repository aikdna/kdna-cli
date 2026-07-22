#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const UNIT_TEST_FILES = Object.freeze([
  'tests/external-entitlement.test.js',
  'tests/external-activation-flow.test.js',
  'tests/asset-store.test.js',
  'tests/doctor.test.js',
  'tests/kdf-spec.test.js',
  'tests/common-utils.test.js',
  'tests/single-format-regression.test.js',
  'tests/dev-pack.test.js',
  'tests/two-tier-store.test.js',
  'tests/remove-list-cli.test.js',
  'tests/versioned-asset-lifecycle.test.js',
  'tests/layer-isolation.test.js',
  'tests/current-global-cli.test.js',
  'tests/workspace-attachments.test.js',
  'tests/demo.test.js',
  'tests/e2e-encrypt.test.js',
  'tests/e2e-password.test.js',
  'tests/capsule-verify.test.js',
  'tests/archive-io-hardening.test.js',
  'tests/discovery-install-hardening.test.js',
  'tests/cli-smoke.test.js',
  'tests/setup.test.js',
  'tests/secret-store.test.js',
  'tests/license-redaction.test.js',
  'tests/remote-transport-policy.test.js',
  'tests/validate-bundle.test.js',
  'tests/story5-bundle.test.js',
  'tests/story6-dependencies.test.js',
  'tests/story8-context-budget.test.js',
  'tests/story9-conflict-analysis.test.js',
  'tests/story10-audit-log.test.js',
  'tests/story11-rag-namespace.test.js',
  'tests/story12-asset-inheritance.test.js',
  'tests/story13-trust-deprecation.test.js',
  'tests/story19-sign-verify-identity.test.js',
  'tests/story21-watermarking.test.js',
  'tests/critical-2-remote-mode-client.test.js',
  'tests/eval-consumption.test.js',
  'tests/eval-asset.test.js',
  'tests/eval-cluster.test.js',
  'tests/eval-runtime-boundary.test.js',
  'tests/project.test.js',
  'tests/route.test.js',
  'tests/compose.test.js',
  'tests/compose-review.test.js',
  'tests/asset-evidence.test.js',
  'tests/plan-use.test.js',
  'tests/use.test.js',
  'tests/runtime-contract.test.js',
  'tests/current-producers.test.js',
  'tests/validator.test.js',
  'tests/public-surface-policy.test.js',
  'tests/protocol-naming-gate.test.js',
  'tests/workflow-authority.test.js',
  'tests/runtime-candidate-binding.test.js',
  'tests/publish-hardening.test.js',
  'tests/cluster.test.js',
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
