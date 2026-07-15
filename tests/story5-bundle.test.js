'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const core = require('@aikdna/kdna-core');
const {
  currentManifest,
  currentBundlePayload,
  writeCurrentSource,
} = require('./helpers/current-asset');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'minimal');
const FIXTURE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-s5-fixture-'));
const RUNTIME_FIXTURE = path.join(FIXTURE_TMP, 'minimal.kdna');
core.pack(FIXTURE, RUNTIME_FIXTURE);
after(() => fs.rmSync(FIXTURE_TMP, { recursive: true, force: true }));

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

test('Story 5: validate current format exits 0 with no spurious deprecation warning', () => {
  const r = run(['validate', FIXTURE]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /format is deprecated/i);
});

test('Story 5: load current format exits 0 with no spurious deprecation warning', () => {
  const r = run(['load', RUNTIME_FIXTURE]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /format is deprecated/i);
});

test('Story 5: inspect current format exits 0 with no spurious deprecation warning', () => {
  const r = run(['inspect', FIXTURE]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /format is deprecated/i);
});

test('Story 5: validate bundle manifest and payload successfully', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-bundle-'));
  try {
    const manifest = currentManifest({
      asset_id: 'kdna:bundle:test-bundle',
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000009',
      asset_type: 'bundle',
      title: 'Test Bundle',
      version: '1.0.0',
      judgment_version: '1.0.0',
      created_at: '2026-06-28T00:00:00Z',
      updated_at: '2026-06-28T00:00:00Z',
      creator: {
        name: 'Test Creator',
        id: 'test-creator',
      },
      summary: 'Testing bundle payload validation',
      description: 'A test bundle.',
      languages: ['en'],
      default_language: 'en',
      license: 'Apache-2.0',
      status: 'stable',
      quality_badge: 'tested',
    });
    writeCurrentSource(tmp, {
      manifest,
      payload: currentBundlePayload([{ id: 'comp-a', path: './comp-a.kdna', priority: 1 }]),
    });

    const r = run(['validate', tmp]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}`);
    // Current Bundle containers must not trigger a generation-based deprecation warning.
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
