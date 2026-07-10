const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'v1-minimal');

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

test('asset-evidence --help shows usage', () => {
  const r = runCli(['asset-evidence', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /--out/);
});

test('asset-evidence with no args shows usage error', () => {
  const r = runCli(['asset-evidence']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test('asset-evidence with fixture --as=json outputs valid evidence', () => {
  const r = runCli(['asset-evidence', FIXTURE, '--as=json']);
  assert.equal(r.status, 0, `failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kdna_asset_evidence, '0.1.0');
  assert.ok(out.asset);
  assert.ok(out.asset.id);
  assert.ok(out.integrity);
  assert.ok(out.integrity.sidecar_files);
  assert.ok(out.compatibility);
  assert.ok(out.regression_fixtures);
  assert.equal(out.regression_fixtures.available, false);
  assert.ok(out.evidence);
  assert.ok(out.evidence.generated_at);
  assert.ok(out.evidence.tool_version);
});

test('asset-evidence --as=md outputs markdown', () => {
  const r = runCli(['asset-evidence', FIXTURE, '--as=md']);
  assert.equal(r.status, 0, `failed: ${r.stderr}`);
  assert.match(r.stdout, /# KDNA Asset Evidence/);
  assert.match(r.stdout, /## Integrity/);
  assert.match(r.stdout, /## Compatibility/);
  assert.match(r.stdout, /## Checksums/);
});

test('asset-evidence regression_fixtures.available is false', () => {
  const r = runCli(['asset-evidence', FIXTURE, '--as=json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.regression_fixtures.available, false);
  assert.ok(out.regression_fixtures.note);
});

test('asset-evidence includes checksums for sidecar files', () => {
  const r = runCli(['asset-evidence', FIXTURE, '--as=json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(Object.keys(out.integrity.checksums).length > 0);
  for (const [key, val] of Object.entries(out.integrity.checksums)) {
    assert.match(val, /^sha256:/);
  }
});

test('asset-evidence compatibility has kdna_core and kdna_cli versions', () => {
  const r = runCli(['asset-evidence', FIXTURE, '--as=json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.compatibility.kdna_core_version);
  assert.ok(out.compatibility.kdna_cli_version);
});

test('asset-evidence with --out writes to file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-ev-'));
  const outFile = path.join(tmp, 'evidence.json');
  try {
    const r = runCli(['asset-evidence', FIXTURE, '--as=json', '--out', outFile]);
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(outFile));
    const content = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(content.kdna_asset_evidence, '0.1.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
