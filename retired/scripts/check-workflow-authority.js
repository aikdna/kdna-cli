#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHECKOUT_SHA = ['3d3c42e5aac5ba805825da7', '6410c181273ba90b1'].join('');
const SETUP_NODE_SHA = ['249970729cb0ef3589644e', '2896645e5dc5ba9c38'].join('');
const CODEQL_SHA = ['ff2f1c621b7f889edc0d3c7', '61ac2e6a3f8cdb0dd'].join('');
const STALE_SHA = ['4391f3da665fdf50b6810c1a6', '6712fb9ba21aa93'].join('');
const CORE_COMMIT = ['32aa3ff8e633291d4bb9e0', '1de5a70181c8415d93'].join('');

const WORKFLOW_AUTHORITIES = Object.freeze([
  Object.freeze({
    path: '.github/workflows/ci.yml',
    sha256: '96bfa479beffdedeab9ac752754c5d73b61c636aad11e3fab36d1423cdb2510c',
  }),
  Object.freeze({
    path: '.github/workflows/public-surface.yml',
    sha256: '082db09457d8b97f7ea8c758ed708093c4e91b8d8c11b80b219cd586cd766863',
  }),
  Object.freeze({
    path: '.github/workflows/codeql-js.yml',
    sha256: '90cfbebd93d00381ac48f8d9d8d8956f1fd9f0c03c022e037dbb61abc936a34d',
  }),
  Object.freeze({
    path: '.github/workflows/stale.yml',
    sha256: 'a1ad24f80a94d47d91bbc363021c7b714b97f66db6c37d8c07ac2b0d1493841e',
  }),
  Object.freeze({
    path: '.github/workflows/publish.yml',
    sha256: '8f7837c9f1a25168371f764319946f4705f83cbac3f34f0d8c268cd3b369ed49',
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
      /^[a-z0-9_.-]+\/[a-z0-9_./-]+@[a-f0-9]{40}$/i.test(action),
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
  assertLiteralCount(source, "node: ['22.23.1', '24.18.0']", 1, label);
  assertLiteralCount(source, "node-version: '22.23.1'", 3, label);
  assertLiteralCount(source, "node-version: '${{ matrix.node }}'", 1, label);
  assertLiteralCount(source, 'check-latest: false', 4, label);
  assertLiteralCount(source, 'if:', 0, label);
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
