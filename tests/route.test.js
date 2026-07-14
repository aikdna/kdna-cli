const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadSchema, validateTrace } = require('../schema/trace-validator');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'v1-minimal');
// Prefer the sibling monorepo checkout when present (local dev / workspace CI),
// otherwise fall back to the npm-installed copy under node_modules.
let EVAL_PATH;
try {
  EVAL_PATH = path.dirname(require.resolve('@aikdna/kdna-eval/package.json'));
} catch (_) {
  EVAL_PATH = path.resolve(__dirname, '..', '..', 'kdna', 'packages', 'kdna-eval');
}

function runCli(args, opts = {}) {
  const env = {
    ...process.env,
    NODE_PATH: [EVAL_PATH, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    ...(opts.env || {}),
  };
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd || process.cwd(),
    env,
    timeout: 30_000,
  });
}

function makePoliciesFile(dir) {
  const p = path.join(dir, 'policy.json');
  fs.writeFileSync(
    p,
    JSON.stringify({
      review: {
        operation: 'review',
        loadProfile: 'compact',
        domains: [
          { id: 'deployment-review', weight: 1 },
          { id: 'content-review', weight: 0.5 },
        ],
      },
    }) + '\n',
  );
  return p;
}

function traceWithCost(cost) {
  return {
    kdna_trace: '1.0.0',
    trace_id: '0123456789abcdef0123456789abcdef',
    timestamp: '2026-07-14T00:00:00.000Z',
    operation: 'review',
    decision: {
      primary: { domain_id: 'golden', weight: 1, reason: 'fixture' },
      rejected: [],
      budget_profile: 'code-review',
    },
    cost,
  };
}

test('kdna route --help shows usage', () => {
  const r = runCli(['route', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /--policy/);
  assert.match(r.stderr, /--as=/);
});

test('kdna route with no args shows usage error', () => {
  const r = runCli(['route']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test('kdna route with fixture --as=json outputs trace', () => {
  const r = runCli(['route', FIXTURE, '--as=json']);
  assert.equal(r.status, 0, `route failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kdna_trace, '1.0.0');
  assert.ok(out.trace_id);
  assert.ok(out.timestamp);
  assert.equal(out.operation, 'review');
  assert.ok(out.decision);
  assert.ok(out.decision.primary);
  assert.ok(out.decision.budget_profile);
});

test('kdna route --as=trace includes validation', () => {
  const r = runCli(['route', FIXTURE, '--as=trace']);
  assert.equal(r.status, 0, `route failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(out._validation);
  assert.equal(typeof out._validation.valid, 'boolean');
  assert.ok(Array.isArray(out._validation.errors));
});

test('kdna route --as=prompt produces human-readable output', () => {
  const r = runCli(['route', FIXTURE, '--as=prompt']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /# kdna route/);
  assert.match(r.stdout, /## Primary/);
  assert.match(r.stdout, /## Cost/);
});

test('kdna route with --policy uses specified policy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-route-'));
  const policyFile = makePoliciesFile(tmp);
  try {
    const r = runCli(['route', FIXTURE, '--as=json', '--policy', policyFile]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision.primary.domain_id, 'deployment-review');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna route --budget uses correct profile', () => {
  const r = runCli(['route', FIXTURE, '--as=json', '--budget=code-review']);
  assert.equal(r.status, 0, `route failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision.budget_profile, 'code-review');
});

test('kdna route --trace writes trace file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-route-'));
  const traceFile = path.join(tmp, 'trace.json');
  try {
    const r = runCli(['route', FIXTURE, '--as=json', '--trace', traceFile]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    assert.ok(fs.existsSync(traceFile));
    const content = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    assert.equal(content.kdna_trace, '1.0.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna route with non-existent path gives clear error', () => {
  const r = runCli(['route', '/nonexistent/path', '--as=json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision.primary.domain_id, null);
});

test('kdna route trace_id is 32-char hex', () => {
  const r = runCli(['route', FIXTURE, '--as=json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.trace_id, /^[0-9a-f]{32}$/);
});

test('kdna route cost fields are present', () => {
  const r = runCli(['route', FIXTURE, '--as=json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok('cost' in out);
  assert.ok('tokens_consumed' in out.cost);
  assert.ok('chars_consumed' in out.cost);
  assert.ok('assets_loaded' in out.cost);
  assert.ok('over_budget' in out.cost);
});

test('Trace delivery schema constrains counts and evidence bases', () => {
  const cost = loadSchema().properties.cost.properties;
  for (const field of [
    'tokens_consumed',
    'chars_consumed',
    'projection_chars',
    'projection_chars_delivered',
    'assets_loaded',
  ]) {
    assert.equal(cost[field].type, 'integer');
    assert.equal(cost[field].minimum, 0);
  }
  assert.deepEqual(cost.chars_consumed_basis.enum, [
    'not_observed',
    'agent_host_report',
    'independent_measurement',
  ]);
  assert.ok(cost.projection_char_delivery_basis.enum.includes('runtime_serialized_projection'));
});

test('Trace validator rejects invalid delivery and consumption bases', () => {
  for (const invalidCost of [
    { chars_consumed: 0, chars_consumed_basis: 42 },
    { chars_consumed: 0, chars_consumed_basis: 'runtime_guess' },
    {
      projection_chars_delivered: 0,
      projection_char_delivery_basis: false,
    },
    {
      projection_chars_delivered: 0,
      projection_char_delivery_basis: 'host_says_so',
    },
  ]) {
    const result = validateTrace(traceWithCost(invalidCost));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('basis must be one of')));
  }
});

test('Trace validator rejects negative and fractional delivery counts', () => {
  for (const projectionCharsDelivered of [-1, 0.5]) {
    const result = validateTrace(
      traceWithCost({
        projection_chars_delivered: projectionCharsDelivered,
        projection_char_delivery_basis: 'runtime_serialized_projection',
      }),
    );
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.includes('cost.projection_chars_delivered must be a non-negative integer'),
    );
  }
});

test('kdna route provenance fields are present', () => {
  const r = runCli(['route', FIXTURE, '--as=json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.provenance);
  assert.ok('policy_input_hash' in out.provenance);
  assert.ok('consumer_index_version' in out.provenance);
});

test('kdna route with --route-card applies card preferences', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-route-'));
  const policyFile = makePoliciesFile(tmp);
  const cardFile = path.join(tmp, 'card.json');
  fs.writeFileSync(
    cardFile,
    JSON.stringify({
      route_card: '0.1.0',
      domain_id: 'card-domain',
      role: 'primary',
    }) + '\n',
  );
  try {
    const r = runCli([
      'route',
      FIXTURE,
      '--as=json',
      '--policy',
      policyFile,
      '--route-card',
      cardFile,
    ]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision.primary.domain_id, 'deployment-review');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna route with invalid --route-card fails cleanly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-route-'));
  const cardFile = path.join(tmp, 'card.json');
  fs.writeFileSync(cardFile, JSON.stringify({ route_card: '0.1.0', role: 'primary' }) + '\n');
  try {
    const r = runCli(['route', FIXTURE, '--as=json', '--route-card', cardFile]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Invalid route card|domain_id/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna route with --consumer-index includes consumer_index_version in provenance', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-route-'));
  const policyFile = makePoliciesFile(tmp);
  const ciFile = path.join(tmp, 'ci.json');
  fs.writeFileSync(
    ciFile,
    JSON.stringify({
      consumer_index: '0.1.0',
      entries: [{ domain_id: 'deployment-review', status: 'trusted_runtime', enabled: true }],
    }) + '\n',
  );
  try {
    const r = runCli([
      'route',
      FIXTURE,
      '--as=json',
      '--policy',
      policyFile,
      '--consumer-index',
      ciFile,
    ]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.provenance.consumer_index_version, '0.1.0');
    assert.ok(out.provenance.consumer_index_path);
    assert.equal(out.decision.confidence, 'high');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna route with consumer index marks untrusted domain as low confidence', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-route-'));
  const policyFile = makePoliciesFile(tmp);
  const ciFile = path.join(tmp, 'ci.json');
  fs.writeFileSync(
    ciFile,
    JSON.stringify({
      consumer_index: '0.1.0',
      entries: [{ domain_id: 'deployment-review', status: 'draft_generated', enabled: false }],
    }) + '\n',
  );
  try {
    const r = runCli([
      'route',
      FIXTURE,
      '--as=json',
      '--policy',
      policyFile,
      '--consumer-index',
      ciFile,
    ]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision.confidence, 'low');
    assert.match(out.decision.abstain_reason, /not trusted/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
