'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE_V1 = path.resolve(__dirname, '..', 'fixtures', 'v1-minimal');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

test('Story 5: validate v1 exits 0 with no spurious deprecation warning', () => {
  // The v1 format is stable — there is no KDNA v2 product to migrate to.
  // The earlier deprecation warning was a false claim introduced in ac82ab6
  // and has been removed. v1 assets must validate cleanly with no stderr noise.
  const r = run(['validate', FIXTURE_V1]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /KDNA v1 format is deprecated/i);
});

test('Story 5: load v1 exits 0 with no spurious deprecation warning', () => {
  const r = run(['load', FIXTURE_V1]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /KDNA v1 format is deprecated/i);
});

test('Story 5: inspect v1 exits 0 with no spurious deprecation warning', () => {
  const r = run(['inspect', FIXTURE_V1]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /KDNA v1 format is deprecated/i);
});

test('Story 5: validate v2 bundle manifest and payload successfully', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-v2-bundle-'));
  try {
    // Write mimetype for v2
    fs.writeFileSync(path.join(tmp, 'mimetype'), 'application/vnd.aikdna.kdna+zip');

    // Write a valid v2 bundle kdna.json manifest
    const manifest = {
      kdna_version: '2.0',
      asset_id: 'kdna:bundle:test-bundle',
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000009',
      asset_type: 'bundle',
      title: 'Test Bundle v2',
      version: '1.0.0',
      judgment_version: '1.0.0',
      created_at: '2026-06-28T00:00:00Z',
      updated_at: '2026-06-28T00:00:00Z',
      creator: {
        name: 'Test Creator',
        id: 'test-creator'
      },
      compatibility: {
        min_loader_version: '1.0.0',
        profile: 'bundle-profile-v1'
      },
      payload: {
        path: 'payload.kdnab',
        encoding: 'json',
        encrypted: false
      },
      summary: 'Testing bundle payload validation',
      description: 'A test v2 bundle.',
      languages: ['en'],
      default_language: 'en',
      license: 'Apache-2.0',
      status: 'stable',
      quality_badge: 'tested'
    };
    fs.writeFileSync(path.join(tmp, 'kdna.json'), JSON.stringify(manifest, null, 2));

    // Write payload matching bundle-profile-v1.schema.json
    const payload = {
      profile: 'bundle-profile-v1',
      components: [
        { id: 'comp-a', path: './comp-a.kdna', priority: 1 }
      ]
    };
    fs.writeFileSync(path.join(tmp, 'payload.kdnab'), JSON.stringify(payload, null, 2));

    const r = run(['validate', tmp]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.stderr}`);
    // v2 Bundle containers have never triggered the (now-removed) v1 deprecation warning.
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
