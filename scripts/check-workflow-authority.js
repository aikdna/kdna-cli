#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHECKOUT_SHA = ['9c091bb21b7c1c1d1991b', 'b908d89e4e9dddfe3e0'].join('');
const SETUP_NODE_SHA = ['249970729cb0ef3589644e', '2896645e5dc5ba9c38'].join('');
const CODEQL_SHA = ['99df26d4f13ea111d4ec1', 'a7dddef6063f76b97e9'].join('');
const STALE_SHA = ['1e223db275d687790206a7', 'acac4d1a11bd6fe629'].join('');
const CORE_COMMIT = ['1e77e3e0d486c330fe9f9262', 'b514ef24c859d469'].join('');

const WORKFLOW_AUTHORITIES = Object.freeze([
  Object.freeze({
    path: '.github/workflows/ci.yml',
    sha256: 'e271adb94b4c23176abf8cbefa8ceaa4e99629fb6b931948a9fda44ecce3bea3',
  }),
  Object.freeze({
    path: '.github/workflows/public-surface.yml',
    sha256: 'ef0c2c6a37ff94130f98bb9535b01779cdc838081370a8c039da7c2a19a1fd9f',
  }),
  Object.freeze({
    path: '.github/workflows/codeql-js.yml',
    sha256: 'c17ff9a889a246ee0566a928b3c430ad1ddaebfaad8a95b9c28d01be30d5a030',
  }),
  Object.freeze({
    path: '.github/workflows/stale.yml',
    sha256: '6c651ced1379089e0310af69eaae074984923fe6319ef2af31bbfb0bbabe70c4',
  }),
  Object.freeze({
    path: '.github/workflows/publish.yml',
    sha256: '1bb3ba51c5496972e84c575c57beab7b057640f640b206c993451ec0c1abf3ad',
  }),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function literalCount(source, literal) {
  return source.split(literal).length - 1;
}

function assertLiteralCount(source, literal, expected, label) {
  assert(
    literalCount(source, literal) === expected,
    `${label} must contain ${JSON.stringify(literal)} exactly ${expected} time(s)`,
  );
}

function workflowJobNames(source) {
  const lines = source.split(/\r?\n/);
  const jobs = [];
  let inJobs = false;
  for (const line of lines) {
    if (line === 'jobs:') {
      assert(!inJobs, 'workflow must contain exactly one jobs mapping');
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^[^\s#]/.test(line)) break;
    const match = line.match(/^  ([a-z0-9][a-z0-9-]*):\s*$/);
    if (match) jobs.push(match[1]);
  }
  assert(inJobs, 'workflow jobs mapping is missing');
  return jobs;
}

function actionUses(source) {
  return [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/gm)].map((match) => match[1]);
}

function assertExactJobs(source, expected, label) {
  assert(
    JSON.stringify(workflowJobNames(source)) === JSON.stringify(expected),
    `${label} job set or order drifted`,
  );
}

function assertExactActions(source, expected, label) {
  const actual = actionUses(source);
  for (const action of actual) {
    assert(
      /^[a-z0-9_.-]+\/[a-z0-9_.\/-]+@[a-f0-9]{40}$/i.test(action),
      `${label} uses mutable action ${action}`,
    );
  }
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} action set or order drifted`,
  );
}

function assertNoGenericBypasses(source, label) {
  for (const forbidden of [
    'paths-ignore:',
    'continue-on-error:',
    'pull_request_target:',
    'workflow_dispatch:',
  ]) {
    assert(!source.includes(forbidden), `${label} contains forbidden workflow bypass ${forbidden}`);
  }
}

function validateCi(source) {
  const label = 'CI workflow';
  assertNoGenericBypasses(source, label);
  assert(source.startsWith('name: CI\non: [pull_request, push]\n'), `${label} trigger drifted`);
  assertLiteralCount(source, 'permissions:\n  contents: read', 1, label);
  assertExactJobs(source, ['test', 'golden-host-request', 'runtime-contract', 'evidence'], label);
  assertLiteralCount(source, 'timeout-minutes: 20', 1, label);
  assertLiteralCount(source, 'timeout-minutes: 10', 3, label);
  assertLiteralCount(source, `ref: ${CORE_COMMIT}`, 3, label);
  assertLiteralCount(source, "node: ['18.20.8', '22.23.1']", 1, label);
  assertLiteralCount(source, "node-version: '22.23.1'", 3, label);
  assertLiteralCount(source, "node-version: '${{ matrix.node }}'", 1, label);
  assertLiteralCount(source, 'check-latest: false', 4, label);
  assertLiteralCount(source, "if: matrix.node != '18.20.8'", 1, label);
  assertLiteralCount(source, "if: matrix.node == '18.20.8'", 1, label);
  assertLiteralCount(source, 'if:', 2, label);
  assertLiteralCount(source, 'run: node scripts/check-workflow-authority.js', 1, label);
  assertLiteralCount(source, 'run: node scripts/check-public-surface.mjs', 1, label);
  assertExactActions(
    source,
    [
      `${CHECKOUT_SHA}`,
      `${CHECKOUT_SHA}`,
      `${SETUP_NODE_SHA}`,
      `${CHECKOUT_SHA}`,
      `${CHECKOUT_SHA}`,
      `${SETUP_NODE_SHA}`,
      `${CHECKOUT_SHA}`,
      `${CHECKOUT_SHA}`,
      `${SETUP_NODE_SHA}`,
      `${CHECKOUT_SHA}`,
      `${SETUP_NODE_SHA}`,
    ].map((ref, index) =>
      [2, 5, 8, 10].includes(index) ? `actions/setup-node@${ref}` : `actions/checkout@${ref}`,
    ),
    label,
  );
}

function validatePublicSurface(source) {
  const label = 'public-surface workflow';
  assertNoGenericBypasses(source, label);
  assertLiteralCount(source, 'permissions:\n  contents: read', 1, label);
  assertExactJobs(source, ['check'], label);
  assertLiteralCount(source, 'timeout-minutes: 5', 1, label);
  assertLiteralCount(source, "node-version: '22.23.1'", 1, label);
  assertLiteralCount(source, 'check-latest: false', 1, label);
  assertLiteralCount(source, 'run: node scripts/check-workflow-authority.js', 1, label);
  assertLiteralCount(source, 'run: node scripts/check-public-surface.mjs', 1, label);
  assertLiteralCount(source, 'if:', 0, label);
  assertExactActions(
    source,
    [`actions/checkout@${CHECKOUT_SHA}`, `actions/setup-node@${SETUP_NODE_SHA}`],
    label,
  );
}

function validateCodeql(source) {
  const label = 'CodeQL workflow';
  assertNoGenericBypasses(source, label);
  assertExactJobs(source, ['analyze'], label);
  assertLiteralCount(source, 'timeout-minutes: 360', 1, label);
  assertLiteralCount(source, 'security-events: write', 1, label);
  assertLiteralCount(source, 'actions: read', 1, label);
  assertLiteralCount(source, 'contents: read', 1, label);
  assertLiteralCount(source, "language: ['javascript-typescript']", 1, label);
  assertLiteralCount(source, 'if:', 0, label);
  assertExactActions(
    source,
    [
      `actions/checkout@${CHECKOUT_SHA}`,
      `github/codeql-action/init@${CODEQL_SHA}`,
      `github/codeql-action/autobuild@${CODEQL_SHA}`,
      `github/codeql-action/analyze@${CODEQL_SHA}`,
    ],
    label,
  );
}

function validateStale(source) {
  const label = 'stale workflow';
  assertNoGenericBypasses(source, label);
  assert(
    source.startsWith("name: 'Close stale issues and PRs'\n\non:\n  schedule:\n"),
    `${label} trigger drifted`,
  );
  assertLiteralCount(source, 'issues: write', 1, label);
  assertLiteralCount(source, 'pull-requests: write', 1, label);
  assertLiteralCount(source, 'contents:', 0, label);
  assertExactJobs(source, ['stale'], label);
  assertLiteralCount(source, 'timeout-minutes: 10', 1, label);
  assertLiteralCount(source, 'if:', 0, label);
  assertExactActions(source, [`actions/stale@${STALE_SHA}`], label);
}

function validatePublish(source) {
  const label = 'publish workflow';
  assertNoGenericBypasses(source, label);
  assertLiteralCount(source, 'release:\n    types: [published]', 1, label);
  assertExactJobs(source, ['publish'], label);
  assertLiteralCount(source, 'timeout-minutes: 30', 1, label);
  assertLiteralCount(source, 'contents: read', 1, label);
  assertLiteralCount(source, 'id-token: write', 1, label);
  assertLiteralCount(source, "node-version: '22.23.1'", 1, label);
  assertLiteralCount(source, 'check-latest: false', 1, label);
  assertLiteralCount(source, 'if: always()', 1, label);
  assertLiteralCount(source, "if: steps.registry.outputs.should_publish == 'true'", 1, label);
  assertExactActions(
    source,
    [`actions/checkout@${CHECKOUT_SHA}`, `actions/setup-node@${SETUP_NODE_SHA}`],
    label,
  );
}

const VALIDATORS = Object.freeze({
  '.github/workflows/ci.yml': validateCi,
  '.github/workflows/public-surface.yml': validatePublicSurface,
  '.github/workflows/codeql-js.yml': validateCodeql,
  '.github/workflows/stale.yml': validateStale,
  '.github/workflows/publish.yml': validatePublish,
});

function workflowInventory(root) {
  const directory = path.join(root, '.github', 'workflows');
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
}

function workflowSource(root, relative, sources) {
  if (sources && Object.hasOwn(sources, relative)) return sources[relative];
  return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
}

function validateWorkflowSet(root, options = {}) {
  const enforceHashes = options.enforceHashes !== false;
  const expectedInventory = WORKFLOW_AUTHORITIES.map(({ path: relative }) => relative).sort();
  const actualInventory = options.workflowPaths || workflowInventory(root);
  assert(
    JSON.stringify(actualInventory) === JSON.stringify(expectedInventory),
    'workflow inventory drifted or contains an unaudited workflow',
  );
  const summaries = [];
  for (const authority of WORKFLOW_AUTHORITIES) {
    const source = workflowSource(root, authority.path, options.sources);
    assert(
      typeof source === 'string' && source.endsWith('\n'),
      `${authority.path} must be canonical text`,
    );
    VALIDATORS[authority.path](source);
    const digest = sha256(source);
    if (enforceHashes) {
      assert(digest === authority.sha256, `${authority.path} exact bytes drifted`);
    }
    summaries.push(Object.freeze({ path: authority.path, sha256: digest }));
  }
  return Object.freeze(summaries);
}

function main() {
  const workflows = validateWorkflowSet(ROOT);
  console.log(`Workflow authority verified: ${workflows.length} exact workflows`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Workflow authority blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  CHECKOUT_SHA,
  CODEQL_SHA,
  CORE_COMMIT,
  SETUP_NODE_SHA,
  STALE_SHA,
  WORKFLOW_AUTHORITIES,
  validateWorkflowSet,
};
