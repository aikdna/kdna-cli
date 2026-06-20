/**
 * v1-global-cli.test.js — KDNA Core v1 route tests for aikdna/kdna-cli.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('@aikdna/kdna-core');

const cliBin = path.join(__dirname, '..', 'src', 'cli.js');
const fixture = path.join(__dirname, '..', 'fixtures', 'v1-minimal');
const FORBIDDEN_TERMS = ['trusted', 'recommended', 'high_quality', 'officially_approved', 'quality_badge'];

function runCli(args) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('kdna inspect v1 source dir returns content-neutral JSON', () => {
  const r = runCli(['inspect', fixture]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kdna_version, '1.0');
  assert.equal(out.asset_id, 'kdna:example:atomspeak-core');
  assert.equal(out.payload, 'payload.kdnab');
  assert.equal(out.payload_encrypted, false);
  assert.equal(out.profile, 'judgment-profile-v1');
  for (const term of FORBIDDEN_TERMS) {
    assert.ok(!Object.prototype.hasOwnProperty.call(out, term), `forbidden term "${term}" present`);
  }
});

test('kdna validate v1 source dir reports overall_valid=true', () => {
  const r = runCli(['validate', fixture]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.overall_valid, true);
  assert.equal(out.format_valid, true);
  assert.equal(out.schema_valid, true);
  assert.equal(out.payload_valid, true);
  assert.equal(out.checksums_valid, true);
  assert.equal(out.load_contract_valid, true);
  assert.deepEqual(out.problems, []);
});

test('kdna validate --runtime exits 3 when LoadPlan cannot load now', () => {
  if (typeof core.planLoad !== 'function') return;
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-cli-validate-runtime-'));
  const secret = 'CLI_VALIDATE_RUNTIME_SECRET_SHOULD_NOT_LEAK';
  try {
    for (const name of fs.readdirSync(fixture)) {
      fs.copyFileSync(path.join(fixture, name), path.join(tmp, name));
    }
    const manifestPath = path.join(tmp, 'kdna.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.access = 'remote';
    manifest.runtime = { endpoint: 'https://runtime.example.test/v1/project' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const payloadPath = path.join(tmp, 'payload.kdnab');
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    payload.core.axioms = [{ id: 'secret', one_sentence: secret }];
    fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
    fs.writeFileSync(path.join(tmp, 'checksums.json'), JSON.stringify(core.buildChecksumsV1(tmp), null, 2));

    const r = runCli(['validate', tmp, '--runtime']);
    assert.equal(r.status, 3, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overall_valid, true);
    assert.equal(out.runtime_load_plan.state, 'needs_runtime');
    assert.equal(out.runtime_load_plan.can_load_now, false);
    assert.ok(!r.stdout.includes(secret));
    assert.ok(!r.stderr.includes(secret));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna plan-load uses the Core LoadPlan API when available', () => {
  const r = runCli(['plan-load', fixture, '--json']);
  if (typeof core.planLoad !== 'function') {
    assert.equal(r.status, 6, r.stderr);
    assert.match(r.stderr, /requires @aikdna\/kdna-core with the LoadPlan v1 API/);
    return;
  }

  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.access, 'public');
  assert.equal(out.state, 'ready');
  assert.equal(out.required_action, 'load');
  assert.equal(out.can_load_now, true);
});

test('kdna load refuses v1 assets when LoadPlan cannot load now', () => {
  if (typeof core.planLoad !== 'function') return;
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-cli-load-denied-'));
  const secret = 'CLI_SECRET_PAYLOAD_SHOULD_NOT_LEAK';
  try {
    for (const name of fs.readdirSync(fixture)) {
      fs.copyFileSync(path.join(fixture, name), path.join(tmp, name));
    }
    const manifestPath = path.join(tmp, 'kdna.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.access = 'remote';
    manifest.runtime = { endpoint: 'https://runtime.example.test/v1/project' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const payloadPath = path.join(tmp, 'payload.kdnab');
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    payload.core.axioms = [{ id: 'secret', one_sentence: secret }];
    fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
    fs.writeFileSync(path.join(tmp, 'checksums.json'), JSON.stringify(core.buildChecksumsV1(tmp), null, 2));

    const plan = runCli(['plan-load', tmp, '--json']);
    assert.equal(plan.status, 3, plan.stderr);
    assert.equal(JSON.parse(plan.stdout).can_load_now, false);

    const loaded = runCli(['load', tmp, '--profile=compact', '--as=prompt']);
    assert.notEqual(loaded.status, 0, 'load must be denied by LoadPlan');
    assert.match(loaded.stderr, /LoadPlan denied loading/);
    assert.ok(!loaded.stdout.includes(secret));
    assert.ok(!loaded.stderr.includes(secret));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna pack produces deterministic container', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-cli-det-'));
  try {
    const a = path.join(tmp, 'a.kdna');
    const b = path.join(tmp, 'b.kdna');
    const rA = runCli(['pack', fixture, a]);
    const rB = runCli(['pack', fixture, b]);
    assert.equal(rA.status, 0, rA.stderr);
    assert.equal(rB.status, 0, rB.stderr);
    const ha = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');
    const hb = crypto.createHash('sha256').update(fs.readFileSync(b)).digest('hex');
    assert.equal(ha, hb, 'pack must be deterministic');
    assert.equal(ha, 'dad166e23c5c13be1f9d11829d102498a20ed11e7664ce427cc56bee4d38f59e', 'hash must match PR-94 baseline');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna unpack + validate round-trip', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-cli-rt-'));
  try {
    const packed = path.join(tmp, 'packed.kdna');
    const dir = path.join(tmp, 'unpacked');
    const rP = runCli(['pack', fixture, packed]);
    assert.equal(rP.status, 0, rP.stderr);
    const rU = runCli(['unpack', packed, dir]);
    assert.equal(rU.status, 0, rU.stderr);
    const rV = runCli(['validate', dir]);
    assert.equal(rV.status, 0, rV.stderr);
    const out = JSON.parse(rV.stdout);
    assert.equal(out.overall_valid, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna validate on non-v1 dir does NOT wrongly pass', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-cli-bad-'));
  try {
    // dir with kdna.json but no mimetype — must fail
    fs.writeFileSync(path.join(dir, 'kdna.json'), JSON.stringify({ kdna_version: '1.0' }));
    const r = runCli(['validate', dir]);
    assert.notEqual(r.status, 0, 'must not pass a non-v1 dir');
    assert.ok(!/overall_valid.*true/.test(r.stdout + r.stderr));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kdna validate on lineage-as-array exits non-zero', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-cli-la-'));
  try {
    fs.writeFileSync(path.join(dir, 'mimetype'), 'application/vnd.kdna.asset');
    fs.writeFileSync(path.join(dir, 'kdna.json'), JSON.stringify({
      kdna_version: '1.0', asset_id: 'kdna:test:lineage-arr',
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000099',
      asset_type: 'sample', title: 'test', version: '1.0.0', judgment_version: '1.0.0',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      creator: { name: 'Test' },
      compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
      payload: { path: 'payload.kdnab', encoding: 'json', encrypted: false },
      lineage: [{ type: 'original' }],
    }));
    fs.writeFileSync(path.join(dir, 'payload.kdnab'), JSON.stringify({
      profile: 'judgment-profile-v1', core: { highest_question: 'q', axioms: [] },
    }));
    const r = runCli(['validate', dir]);
    assert.notEqual(r.status, 0, 'lineage as array must be rejected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kdna inspect on v1 container round-trips through pack', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-cli-ct-'));
  try {
    const packed = path.join(tmp, 'inspect-test.kdna');
    runCli(['pack', fixture, packed]);
    const r = runCli(['inspect', packed]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.kdna_version, '1.0');
    assert.equal(out.asset_id, 'kdna:example:atomspeak-core');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
