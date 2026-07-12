const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'v1-minimal');

it('use --help shows usage', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('node', [CLI, 'use', '--help'], { encoding: 'utf8' });
  const output = (result.stderr || '') + (result.stdout || '');
  assert.ok(output.includes('Usage') || output.includes('Runner'), 'help should show usage');
});

it('use with no args shows usage error', () => {
  try {
    execSync(`node ${CLI} use`, { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.status !== 0);
  }
});

it('use --list-runners shows registered runners', () => {
  const r = execSync(`node ${CLI} use --list-runners`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  assert.ok(r.includes('mock:default'));
  assert.ok(r.includes('cli:default'));
});

it('use with mock runner produces JSON result', () => {
  const r = execSync(
    `node ${CLI} use ${FIXTURE} --task="Deploy risk assessment" --runner mock:default --as json`,
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  const out = JSON.parse(r);
  assert.ok(out.plan_id.startsWith('plan_'));
  assert.strictEqual(out.mode, 'single');
  assert.strictEqual(out.status, 'completed');
  assert.ok(out.result);
  assert.ok(out.result.answer);
  assert.ok(out.trace);
  assert.strictEqual(out.trace.trace_version, '0.9.0');
  assert.ok(out.trace.trace_id.startsWith('trace_'));
  assert.strictEqual(out.trace.mode, 'single');
});

it('use --as=trace produces trace output', () => {
  const r = execSync(
    `node ${CLI} use ${FIXTURE} --task="Review code" --runner mock:default --as trace`,
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  const trace = JSON.parse(r);
  assert.strictEqual(trace.trace_version, '0.9.0');
  assert.ok(trace.trace_id);
  assert.ok(trace.plan_id);
  assert.ok(trace.execution);
  assert.ok(trace.provenance);
});

it('use --plan-only produces plan without execution', () => {
  const r = execSync(`node ${CLI} use ${FIXTURE} --task="Test" --plan-only --as json`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  const plan = JSON.parse(r);
  assert.strictEqual(plan.plan_version, '0.9.0');
  assert.strictEqual(plan.mode, 'single');
  // plan-only should not have a runner set — runner is optional in 0.9 schema
  assert.strictEqual(plan.runner, undefined);
});

it('use --dry-run validates runner without execution', () => {
  const r = execSync(
    `node ${CLI} use ${FIXTURE} --task="Dry run test" --runner mock:default --dry-run --as json`,
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  const out = JSON.parse(r);
  assert.strictEqual(out.dry_run, true);
  assert.ok(out.plan);
  assert.ok(out.runner_available);
});

it('use with non-existent asset fails', () => {
  try {
    execSync(
      `node ${CLI} use /nonexistent/path.kdna --task="test" --runner mock:default --as json`,
      { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
    );
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.status !== 0);
  }
});

// Round 4: trust facts regression
it('use --as=trace reports digest_verified: false (no Core verification)', () => {
  const r = execSync(
    `node ${CLI} use ${FIXTURE} --task="Review code" --runner mock:default --as trace`,
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  const trace = JSON.parse(r);
  if (trace.mode === 'single' && trace.asset_identity) {
    assert.strictEqual(
      trace.asset_identity.digest_verified,
      false,
      'digest_verified should be false without Core verification evidence',
    );
    assert.strictEqual(
      trace.asset_identity.revocation_status,
      null,
      'revocation_status should be null when unknown',
    );
  }
});

it('use with cli runner resolves a local asset and records Core digest verification', () => {
  const r = execSync(
    `node ${CLI} use ${FIXTURE} --task="Review code" --runner cli:default --as trace`,
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  const trace = JSON.parse(r);
  assert.strictEqual(trace.execution.status, 'completed');
  assert.strictEqual(trace.asset_identity.digest_verified, true);
  assert.match(trace.asset_identity.digest, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(trace.cost.assets_loaded, 1);
});

console.log('use.test.js: all tests complete');
