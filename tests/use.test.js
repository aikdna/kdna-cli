const { after, it } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('@aikdna/kdna-core');
const { createProcessAgentHost } = require('../src/agent-host-process');
const { createCliRunner } = require('../src/runner');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE_SOURCE = path.resolve(__dirname, '..', 'fixtures', 'minimal');
const FIXTURE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-use-test-'));
const FIXTURE = path.join(FIXTURE_TMP, 'minimal.kdna');
core.pack(FIXTURE_SOURCE, FIXTURE);
const FIXTURE_ASSET_ID = core.inspect(FIXTURE).asset_id;
const SECOND_FIXTURE = path.join(FIXTURE_TMP, 'minimal-advisor.kdna');
fs.copyFileSync(FIXTURE, SECOND_FIXTURE);
const FIXTURE_DIGEST =
  'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex');

function writeAgentHost(name, body) {
  const file = path.join(FIXTURE_TMP, `${name}.js`);
  fs.writeFileSync(file, body);
  return file;
}

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
      max_tokens: overrides.maxTokens ?? 4000,
      max_chars: overrides.maxChars ?? 16000,
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

it('cli runner loads a real Runtime Capsule but does not claim task completion', () => {
  const result = require('node:child_process').spawnSync(
    'node',
    [CLI, 'use', FIXTURE, '--task=Review code', '--runner=cli:default', '--as=json'],
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  assert.notStrictEqual(result.status, 0, 'partial execution should not report full success');
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.status, 'partial');
  assert.strictEqual(out.trace.overall_status, 'partial');
  assert.strictEqual(out.trace.delivery_status, 'not_delivered');
  assert.strictEqual(out.trace.consumption_status, 'not_started');
  assert.strictEqual(out.trace.execution.status, 'not_started');
  assert.strictEqual(out.trace.conformance_status, 'not_evaluated');
  assert.strictEqual(out.trace.asset_identity.digest_verified, true);
  assert.match(out.trace.asset_identity.digest, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(out.trace.cost.assets_loaded, 1);
  assert.strictEqual(out.trace.cost.chars_consumed, 0);
  assert.strictEqual(out.trace.cost.chars_consumed_basis, 'not_observed');
  assert.ok(out.trace.cost.projection_chars > 0);
  assert.strictEqual(out.trace.cost.projection_chars_delivered, 0);
  assert.strictEqual(out.trace.cost.projection_char_delivery_basis, 'not_delivered');
  assert.ok(out.trace.cost.projection_tokens > 0);
  assert.ok(out.trace.cost.estimated_projection_tokens > 0);
  assert.strictEqual(out.trace.cost.token_count_basis, 'deterministic_estimate');
  assert.strictEqual(out.trace.cost.token_count_verified, false);
  assert.strictEqual(out.trace.cost.over_budget, false);
  assert.strictEqual(out.trace.budget.status, 'within_budget');
  assert.strictEqual(out.trace.cost.model_calls, 0);
  assert.strictEqual(out.result.shape, 'kdna-capsule-bundle');
  assert.strictEqual(out.result.task_result, null);
  assert.strictEqual(out.result.capsules.length, 1);
  assert.strictEqual(out.result.capsules[0].capsule.type, 'kdna.context.capsule');
  assert.strictEqual(out.result.capsules[0].capsule.profile, 'compact');
});

it('process Agent host can return an answer without proving Capsule consumption or conformance', () => {
  const requestCapture = path.join(FIXTURE_TMP, 'single-agent-host-request.json');
  const host = writeAgentHost(
    'single-agent-host',
    `const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  fs.writeFileSync(${JSON.stringify(requestCapture)}, input);
  if (request.protocol !== 'kdna.agent-host/1') process.exit(11);
  if (request.phase !== 'single_judgment') process.exit(12);
  if (request.authority?.final_decision !== true) process.exit(13);
  if (request.capsule?.type !== 'kdna.context.capsule') process.exit(14);
  const outcome = {
    judgment: {
      answer: 'The process Agent host returned an execution result.',
      reasoning: ['Received the Runtime Capsule contract with the requested task.'],
      confidence: 'high'
    },
    model: 'fixture-agent-model',
    usage: { tokens_used: 17, model_calls: 1 }
  };
  process.stdout.write(JSON.stringify({
    protocol: request.protocol,
    request_id: request.request_id,
    outcome
  }));
});
`,
  );
  const result = require('node:child_process').spawnSync(
    'node',
    [
      CLI,
      'use',
      FIXTURE,
      '--task=Review code',
      '--runner=cli:default',
      `--agent-host=${process.execPath}`,
      `--agent-host-arg=${host}`,
      '--as=json',
    ],
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.status, 'execution_completed');
  assert.strictEqual(out.result.shape, 'kdna-single-judgment');
  assert.strictEqual(out.result.answer, 'The process Agent host returned an execution result.');
  assert.strictEqual(out.trace.overall_status, 'execution_completed');
  assert.strictEqual(out.trace.delivery_status, 'correlated_response');
  assert.strictEqual(out.trace.consumption_status, 'not_independently_verified');
  assert.strictEqual(out.trace.execution_status, 'completed');
  assert.strictEqual(out.trace.conformance_status, 'not_evaluated');
  assert.strictEqual(out.trace.evidence_status, 'trace_recorded');
  assert.strictEqual(out.trace.execution.status, 'completed');
  assert.strictEqual(out.trace.execution.model, null);
  assert.strictEqual(out.trace.execution.reported_model, 'fixture-agent-model');
  assert.strictEqual(out.trace.execution.model_identity_basis, 'agent_host_report');
  assert.strictEqual(out.trace.cost.agent_host_calls, 1);
  assert.strictEqual(out.trace.cost.agent_host_calls_observed, true);
  assert.strictEqual(out.trace.cost.model_calls, 1);
  assert.strictEqual(out.trace.cost.model_call_count_basis, 'agent_host_report');
  assert.strictEqual(out.trace.cost.tokens_used, 17);
  assert.strictEqual(out.trace.cost.token_usage_basis, 'agent_host_report');
  assert.strictEqual(out.trace.cost.chars_consumed, 0);
  assert.strictEqual(out.trace.cost.chars_consumed_basis, 'not_observed');
  assert.ok(out.trace.cost.projection_chars_delivered > 0);
  assert.strictEqual(out.trace.cost.projection_chars_delivered, out.trace.cost.projection_chars);
  assert.strictEqual(
    out.trace.cost.projection_char_delivery_basis,
    'runtime_serialized_projection',
  );
  assert.strictEqual(out.trace.assets_loaded[0].handoff_status, 'host_response_received');
  assert.strictEqual(out.trace.assets_loaded[0].contribution_fulfilled, null);
  assert.strictEqual(out.trace.applicability_actual.decision, 'not_observed');
  assert.strictEqual(out.trace.applicability_actual.boundary_respected, null);
  assert.strictEqual(out.trace.projection_actual.observation_basis, 'runtime_capsule_digest');
  assert.strictEqual(out.trace.attempts[0].status, 'completed');
  assert.match(out.trace.attempts[0].host_receipt.request_digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(out.trace.attempts[0].host_receipt.response_digest, /^sha256:[a-f0-9]{64}$/);
  const hostRequest = JSON.parse(fs.readFileSync(requestCapture, 'utf8'));
  assert.strictEqual(hostRequest.authority.asset_id, FIXTURE_ASSET_ID);
  assert.strictEqual(hostRequest.asset.asset_id, FIXTURE_ASSET_ID);
  assert.strictEqual(out.trace.assets_loaded[0].asset_id, FIXTURE_ASSET_ID);
  assert.strictEqual(JSON.stringify(hostRequest).includes(FIXTURE), false);
  assert.strictEqual(JSON.stringify(out.trace).includes(FIXTURE), false);
});

it('process Agent host fails closed without claiming unconfirmed delivery', () => {
  const host = writeAgentHost(
    'invalid-agent-host',
    `process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('sensitive host diagnostic that must not enter the trace');
  process.stdout.write(JSON.stringify({ outcome: { judgment: { answer: 'invalid' } } }));
});
`,
  );
  const result = require('node:child_process').spawnSync(
    'node',
    [
      CLI,
      'use',
      FIXTURE,
      '--task=Review code',
      '--runner=cli:default',
      `--agent-host=${process.execPath}`,
      `--agent-host-arg=${host}`,
      '--as=trace',
    ],
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  assert.notStrictEqual(result.status, 0);
  const trace = JSON.parse(result.stdout);
  assert.strictEqual(trace.overall_status, 'execution_failed');
  assert.strictEqual(trace.execution.status, 'failed');
  assert.strictEqual(trace.delivery_status, 'unconfirmed');
  assert.strictEqual(trace.conformance_status, 'not_evaluated');
  assert.match(trace.errors[0], /protocol validation/);
  assert.doesNotMatch(JSON.stringify(trace), /sensitive host diagnostic/);
  assert.strictEqual(trace.cost.agent_host_calls, 0);
  assert.strictEqual(trace.cost.agent_host_calls_observed, false);
  assert.strictEqual(trace.cost.chars_consumed, 0);
  assert.strictEqual(trace.cost.projection_chars_delivered, 0);
  assert.strictEqual(trace.assets_loaded[0].handoff_status, 'delivery_unconfirmed');
});

it('a correlated but empty Agent judgment records delivery and still fails closed', () => {
  const host = writeAgentHost(
    'empty-judgment-agent-host',
    `let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    protocol: request.protocol,
    request_id: request.request_id,
    outcome: { judgment: { answer: '' } }
  }));
});
`,
  );
  const result = require('node:child_process').spawnSync(
    'node',
    [
      CLI,
      'use',
      FIXTURE,
      '--task=Review code',
      '--runner=cli:default',
      `--agent-host=${process.execPath}`,
      `--agent-host-arg=${host}`,
      '--as=trace',
    ],
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  assert.notStrictEqual(result.status, 0);
  const trace = JSON.parse(result.stdout);
  assert.strictEqual(trace.overall_status, 'execution_failed');
  assert.strictEqual(trace.execution.status, 'failed');
  assert.strictEqual(trace.delivery_status, 'correlated_response');
  assert.strictEqual(trace.consumption_status, 'not_verified');
  assert.match(trace.errors[0], /non-empty answer/);
  assert.strictEqual(trace.cost.agent_host_calls, 1);
  assert.strictEqual(trace.cost.agent_host_calls_observed, true);
  assert.strictEqual(trace.cost.chars_consumed, 0);
  assert.strictEqual(trace.cost.chars_consumed_basis, 'not_observed');
  assert.ok(trace.cost.projection_chars_delivered > 0);
  assert.strictEqual(trace.cost.projection_char_delivery_basis, 'runtime_serialized_projection');
  assert.strictEqual(trace.assets_loaded[0].handoff_status, 'delivered_to_agent_host');
  assert.match(trace.attempts[0].host_receipt.request_digest, /^sha256:[a-f0-9]{64}$/);
});

it('process Agent host enforces timeout and output limits', async () => {
  const timeoutHost = writeAgentHost(
    'timeout-agent-host',
    `process.stdin.resume();
process.stdin.on('end', () => setTimeout(() => {}, 1000));
`,
  );
  await assert.rejects(
    createProcessAgentHost({
      command: process.execPath,
      args: [timeoutHost],
      timeoutMs: 20,
    }).runStage({ phase: 'single_judgment' }),
    /timed out/,
  );

  const outputHost = writeAgentHost(
    'oversized-agent-host',
    `process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('x'.repeat(100)));
`,
  );
  await assert.rejects(
    createProcessAgentHost({
      command: process.execPath,
      args: [outputHost],
      timeoutMs: 1000,
      maxOutputBytes: 10,
    }).runStage({ phase: 'single_judgment' }),
    /output exceeded/,
  );
});

it('process Agent host does not enable staged Cluster execution', () => {
  const manifest = writeCluster('host-cluster-disabled');
  const result = require('node:child_process').spawnSync(
    'node',
    [
      CLI,
      'use',
      manifest,
      '--task=Deploy?',
      '--runner=cli:default',
      `--agent-host=${process.execPath}`,
      '--as=trace',
    ],
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /staged Cluster execution remains disabled/);
});

it('cli runner withholds a Capsule bundle that exceeds the exact character budget', () => {
  const manifest = writeCluster('character-budget', { maxChars: 1 });
  const result = require('node:child_process').spawnSync(
    'node',
    [CLI, 'use', manifest, '--task=Deploy?', '--runner=cli:default', '--as=trace'],
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  assert.notStrictEqual(result.status, 0);
  const trace = JSON.parse(result.stdout);
  assert.strictEqual(trace.execution.status, 'runner_error');
  assert.strictEqual(trace.cost.over_budget, true);
  assert.strictEqual(trace.cost.chars_consumed, 0);
  assert.ok(trace.cost.projection_chars > 1);
  assert.strictEqual(trace.budget.status, 'blocked');
  assert.deepStrictEqual(trace.budget.exceeded, ['max_chars']);
  assert.strictEqual(trace.assets_loaded.length, 1);
  assert.strictEqual(trace.assets_loaded[0].handoff_status, 'withheld_budget');
  assert.ok(trace.errors.some((message) => message.includes('withheld from Agent handoff')));
  assert.ok(!trace.errors.some((message) => message.includes('inspection-only')));
});

it('Agent hosts can enforce an exact model-token budget through countTokens', async () => {
  const plan = JSON.parse(
    execSync(`node ${CLI} plan-use ${FIXTURE} --task="Review code" --as=json`, {
      encoding: 'utf8',
      env: { ...process.env, KDNA_QUIET: '1' },
    }),
  );
  plan.budget.max_chars = 100000;
  plan.budget.max_tokens = 1;
  const runner = createCliRunner({ id: 'host-tokenizer-test' });
  const result = await runner.execute(plan, {
    assetTarget: FIXTURE,
    model: 'test-model',
    countTokens: () => 2,
  });
  assert.strictEqual(result.status, 'runner_error');
  assert.strictEqual(result.budget.status, 'blocked');
  assert.deepStrictEqual(result.budget.exceeded, ['max_tokens']);
  assert.strictEqual(result.cost.projection_tokens, 2);
  assert.strictEqual(result.cost.estimated_projection_tokens, 0);
  assert.strictEqual(result.cost.token_count_basis, 'host_tokenizer');
  assert.strictEqual(result.cost.token_count_verified, true);
  assert.strictEqual(result.assets_loaded[0].handoff_status, 'withheld_budget');
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
  const result = require('node:child_process').spawnSync(
    'node',
    [CLI, 'use', manifest, '--task=Deploy?', '--runner=cli:default', '--as=trace'],
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  assert.notStrictEqual(result.status, 0, 'Capsule-only handoff remains partial');
  const trace = JSON.parse(result.stdout);
  assert.strictEqual(trace.execution.status, 'partial');
  assert.strictEqual(trace.assets_loaded.length, 1);
  assert.strictEqual(trace.cost.chars_consumed, 0);
  assert.ok(trace.cost.projection_chars > 0);
  assert.ok(trace.cost.projection_tokens > 0);
  assert.strictEqual(trace.cost.model_calls, 0);
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
