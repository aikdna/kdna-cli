const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const cbor = require('cbor-x');

function readPayload(p) {
  const buf = fs.readFileSync(p);
  try {
    return cbor.decode(buf);
  } catch {
    return JSON.parse(buf.toString('utf8'));
  }
}

const cliBin = path.join(__dirname, '..', 'src', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('demo minimal creates fixture in empty dir', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  const r = run(['demo', 'minimal', target]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(target, 'mimetype')));
  assert.ok(fs.existsSync(path.join(target, 'kdna.json')));
  assert.ok(fs.existsSync(path.join(target, 'payload.kdnab')));
  assert.ok(fs.existsSync(path.join(target, 'checksums.json')));
  const checksums = JSON.parse(fs.readFileSync(path.join(target, 'checksums.json'), 'utf8'));
  assert.equal(checksums.digest_profile, 'kdna-runtime-entry-set-v1');
  assert.deepEqual(checksums.covered_entries, ['kdna.json', 'payload.kdnab']);
  assert.notEqual(checksums.asset_digest, 'sha256:placeholder');
  assert.match(checksums.asset_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(checksums.entry_set_digest, checksums.asset_digest);
  assert.match(r.stdout, /Next:/);
  assert.match(r.stdout, /kdna pack/);
  assert.match(r.stdout, /kdna validate/);
  assert.match(r.stdout, /kdna plan-load/);
  assert.match(r.stdout, /kdna load/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal with existing non-empty dir fails without --force', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'test.txt'), 'x');
  const r = run(['demo', 'minimal', target]);
  assert.notEqual(r.status, 0, 'should fail on existing non-empty dir');
  assert.match(r.stderr, /already exists/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal with --force overwrites existing non-empty dir', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'test.txt'), 'x');
  const r = run(['demo', 'minimal', target, '--force']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(target, 'mimetype')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal fixture validates with v1 route', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  run(['demo', 'minimal', target]);
  const r = run(['validate', target]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.overall_valid, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal fixture packs deterministically', () => {
  const crypto = require('node:crypto');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  run(['demo', 'minimal', target]);
  const a = path.join(tmp, 'a.kdna');
  const b = path.join(tmp, 'b.kdna');
  run(['pack', target, a]);
  run(['pack', target, b]);
  const ha = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');
  const hb = crypto.createHash('sha256').update(fs.readFileSync(b)).digest('hex');
  assert.equal(ha, hb);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal works from /tmp', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const r = run(['demo', 'minimal', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'mimetype')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── judgment demo tests ──────────────────────────────────────────

test('demo judgment creates fixture with real judgment content', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-judge-'));
  const target = path.join(tmp, 'jd');
  const r = run(['demo', 'judgment', target]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(target, 'mimetype')));
  assert.ok(fs.existsSync(path.join(target, 'kdna.json')));
  assert.ok(fs.existsSync(path.join(target, 'payload.kdnab')));
  assert.ok(fs.existsSync(path.join(target, 'checksums.json')));

  const checksums = JSON.parse(fs.readFileSync(path.join(target, 'checksums.json'), 'utf8'));
  assert.equal(checksums.digest_profile, 'kdna-runtime-entry-set-v1');
  assert.deepEqual(checksums.covered_entries, ['kdna.json', 'payload.kdnab']);
  assert.notEqual(checksums.asset_digest, 'sha256:placeholder');
  assert.match(checksums.asset_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(checksums.entry_set_digest, checksums.asset_digest);

  const payload = readPayload(path.join(target, 'payload.kdnab'));
  assert.ok(payload.core.axioms.length >= 4, 'must have at least 4 axioms');
  assert.ok(payload.core.boundaries.length >= 2, 'must have boundaries');
  assert.ok(payload.patterns.length >= 2, 'must have patterns');
  assert.ok(payload.scenarios.length >= 2, 'must have scenarios');
  assert.ok(payload.cases.length >= 2, 'must have cases');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo judgment validates with overall_valid=true', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-judge-'));
  const target = path.join(tmp, 'jd');
  run(['demo', 'judgment', target]);
  const r = run(['validate', target]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.overall_valid, true);
  assert.equal(out.checksums_valid, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo judgment plan-load returns ready', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-judge-'));
  const target = path.join(tmp, 'jd');
  const packed = path.join(tmp, 'judgment.kdna');
  run(['demo', 'judgment', target]);
  assert.equal(run(['pack', target, packed]).status, 0);
  const r = run(['plan-load', packed, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.state, 'ready');
  assert.equal(plan.can_load_now, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo judgment compact prompt contains real judgment markers', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-judge-'));
  const target = path.join(tmp, 'jd');
  const packed = path.join(tmp, 'judgment.kdna');
  run(['demo', 'judgment', target]);
  assert.equal(run(['pack', target, packed]).status, 0);
  const r = run(['load', packed, '--profile=compact', '--as=prompt']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('Content Review Judgment'), 'must have title');
  assert.ok(r.stdout.includes('Axioms:'), 'must have axioms');
  assert.ok(r.stdout.includes('Boundaries:'), 'must have boundaries');
  assert.ok(r.stdout.includes('Failure modes:'), 'must have failure modes');
  assert.ok(r.stdout.includes('Self-checks:'), 'must have self-checks');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo judgment scenario profile is available', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-judge-'));
  const target = path.join(tmp, 'jd');
  const packed = path.join(tmp, 'judgment.kdna');
  run(['demo', 'judgment', target]);
  assert.equal(run(['pack', target, packed]).status, 0);
  const r = run(['load', packed, '--profile=scenario', '--as=json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.profile, 'scenario', 'must load scenario profile');
  assert.ok(out.context && out.context.scenarios, 'must have scenario content');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo minimal still works', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-demo-'));
  const target = path.join(tmp, 'minimal');
  const r = run(['demo', 'minimal', target]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(target, 'mimetype')));
  const v = run(['validate', target]);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(JSON.parse(v.stdout).overall_valid, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('demo unknown subcommand fails', () => {
  const r = run(['demo', 'nonexistent', '/tmp/x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:|judgment|minimal/);
});
