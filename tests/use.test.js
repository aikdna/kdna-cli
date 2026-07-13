const { after, it } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('@aikdna/kdna-core');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE_SOURCE = path.resolve(__dirname, '..', 'fixtures', 'v1-minimal');
const FIXTURE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-use-test-'));
const FIXTURE = path.join(FIXTURE_TMP, 'v1-minimal.kdna');
core.pack(FIXTURE_SOURCE, FIXTURE);
const SECOND_FIXTURE = path.join(FIXTURE_TMP, 'v1-minimal-advisor.kdna');
fs.copyFileSync(FIXTURE, SECOND_FIXTURE);
const FIXTURE_DIGEST =
  'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex');

function writeCluster(name, overrides = {}) {
  const manifest = {
    format: 'kdna-cluster',
    format_version: '0.9.0',
    cluster_id: `@test/${name}`,
    name,
    version: '0.1.0',
    description: 'CLI Cluster regression fixture.',
    type: 'vertical',
    status: 'schema_valid',
    access: 'public',
    domains: [
      {
        id: FIXTURE,
        version: '1.0.0',
        digest: FIXTURE_DIGEST,
        role: 'primary-candidate',
        required: true,
        load_condition: 'deploy',
        routing_signals: ['deploy'],
      },
      {
        id: overrides.advisorPath || '/nonexistent/optional-advisor.kdna',
        version: '1.0.0',
        digest: FIXTURE_DIGEST,
        role: 'advisor',
        required: false,
        load_condition: 'deploy',
        routing_signals: ['deploy'],
        contribution_hypothesis_template: 'Add an independent advisor check for {task}.',
      },
    ],
    composition: {
      strategy: 'signal_based',
      max_active_domains: 2,
      conflict_policy: overrides.conflictPolicy || 'surface',
      priority_order: [FIXTURE, overrides.advisorPath || '/nonexistent/optional-advisor.kdna'],
      primary_selection: 'exactly_one',
      advisor_selection: 'contribution_hypothesis_required',
    },
    budget: {
      profile: 'interactive',
      max_tokens: 100,
      max_chars: 400,
      max_assets: overrides.maxAssets || 2,
      enforcement: 'hard',
    },
    degradation_policy: {
      primary_unavailable: 'block',
      required_advisor_unavailable: 'block',
      optional_advisor_unavailable: 'continue_with_warning',
      budget_exceeded: 'block',
    },
    relationships: overrides.relationships || [],
  };
  const file = path.join(FIXTURE_TMP, `${name}.kdna.cluster.json`);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

after(() => fs.rmSync(FIXTURE_TMP, { recursive: true, force: true }));

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

it('cluster plan-use preflights and degrades an unavailable optional advisor', () => {
  const manifest = writeCluster('optional-degradation');
  const result = execSync(`node ${CLI} cluster plan-use ${manifest} --task="Deploy?" --as=json`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  const plan = JSON.parse(result);
  assert.strictEqual(plan.load_plan_ref.status, 'ready');
  assert.strictEqual(plan.load_plan_ref.preflight.status, 'degraded');
  assert.strictEqual(plan.selection.advisors.length, 0);
  assert.strictEqual(plan.budget.assets_consumed, 1);
  assert.ok(plan.warnings.some((warning) => warning.includes('Optional advisor')));
});

it('cluster use continues with the primary and records optional degradation', () => {
  const manifest = writeCluster('optional-use-degradation');
  const result = execSync(
    `node ${CLI} use ${manifest} --task="Deploy?" --runner=cli:default --as=trace`,
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  const trace = JSON.parse(result);
  assert.strictEqual(trace.execution.status, 'completed');
  assert.strictEqual(trace.assets_loaded.length, 1);
  assert.strictEqual(trace.selection_actual.deviated_from_plan, true);
  assert.strictEqual(trace.degradations.length, 1);
  assert.ok(trace.warnings.some((warning) => warning.includes('Optional advisor')));
});

it('cluster block conflict emits a non-executed zero-load trace', () => {
  const manifest = writeCluster('blocking-conflict', {
    advisorPath: SECOND_FIXTURE,
    conflictPolicy: 'block',
    relationships: [
      {
        from: FIXTURE,
        to: SECOND_FIXTURE,
        type: 'conflicts_with',
        description: 'Regression conflict',
      },
    ],
  });
  const result = require('node:child_process').spawnSync(
    'node',
    [CLI, 'use', manifest, '--task=Deploy?', '--runner=cli:default', '--as=trace'],
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  assert.notStrictEqual(result.status, 0);
  const trace = JSON.parse(result.stdout);
  assert.strictEqual(trace.execution.status, 'blocked');
  assert.strictEqual(trace.execution.attempts, 0);
  assert.strictEqual(trace.assets_loaded.length, 0);
  assert.strictEqual(trace.cost.assets_loaded, 0);
});

console.log('use.test.js: all tests complete');
