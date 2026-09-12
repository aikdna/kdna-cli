'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateAuthoringProvenance } = require('../src/publish');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'minimal');

function authoringManifest(overrides = {}) {
  const { authoring: authoringOverrides = {}, ...manifestOverrides } = overrides;
  return {
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    authoring: {
      created_by: 'independent-compiler',
      compiler: '@example/kdna-compiler',
      compiler_version: '1.0.0',
      compiled_at: '2026-07-16T00:00:00.000Z',
      conformance: { passed: true, format_version: '0.1.0' },
      project_uid: 'project-001',
      build_id: 'build-001',
      domain_id: 'kdna:example:domain',
      content_digest: `sha256:${'a'.repeat(64)}`,
      ...authoringOverrides,
    },
    ...manifestOverrides,
  };
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('authoring evidence accepts any compiler identity with current conformance metadata', () => {
  assert.deepEqual(validateAuthoringProvenance(authoringManifest()), []);
});

test('authoring evidence rejects a claimed authoring record without conformance metadata', () => {
  const issues = validateAuthoringProvenance(
    authoringManifest({ authoring: { conformance: undefined } }),
  );
  assert.ok(issues.some((issue) => issue.includes('authoring.conformance.passed')));
  assert.ok(issues.some((issue) => issue.includes('authoring.conformance.format_version')));
});
