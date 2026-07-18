const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const CLUSTER = path.resolve(__dirname, '..', 'fixtures', 'cluster-launch-decision.json');
const { CLUSTER_COMPARISON_ARMS, createClusterFixture } = require('@aikdna/kdna-eval');

const TASK = 'Deploy a new public API without monitoring';

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KDNA_QUIET: '1' },
  });
}

function writeAssayInputs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-eval-cluster-'));
  const fixturesDir = path.join(dir, 'fixtures');
  const armsFile = path.join(dir, 'comparison-arms.json');
  fs.mkdirSync(fixturesDir);
  const fixture = createClusterFixture({
    task: TASK,
    expectedPrimary: '@aikdna/dev-change-risk',
    expectedAdvisors: ['@aikdna/dev-api-design-judgment', '@aikdna/dev-silent-failure-detection'],
    expectedRejected: [],
    expectedConflicts: 0,
  });
  fs.writeFileSync(path.join(fixturesDir, 'deploy-api.json'), JSON.stringify(fixture));
  fs.writeFileSync(
    armsFile,
    JSON.stringify({
      comparison_arms: CLUSTER_COMPARISON_ARMS.map((arm) => ({
        arm,
        fixture_ids: [fixture.fixture_id],
        mean_score: arm === 'bounded_compose' ? 4.0 : arm === 'primary_only' ? 3.5 : 3.0,
        result_count: 1,
        critical_errors: 0,
      })),
    }),
  );
  return { dir, fixturesDir, armsFile };
}

function comparisonArgs(input) {
  return [
    'eval',
    'cluster',
    CLUSTER,
    `--task=${TASK}`,
    `--fixtures=${input.fixturesDir}`,
    `--comparison-arms=${input.armsFile}`,
    '--as=json',
  ];
}

test('eval cluster help discloses the CLI promotion boundary', () => {
  const result = runCli(['eval', 'cluster', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /CLI mode keeps trust and economics promotion blocked/);
  assert.match(result.stderr, /Eval API inside the trusted\s+evidence producer/);
});

test('eval cluster fails closed when behavioral and trust evidence are absent', () => {
  const result = runCli(['eval', 'cluster', CLUSTER, `--task=${TASK}`, '--as=json']);
  assert.equal(result.status, 4, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verdict.overall, 'fail');
  assert.deepEqual(report.verdict.failed_gates.sort(), ['behavioral', 'economics', 'structural']);
  assert.deepEqual(report.verdict.incomplete_gates, ['trust']);
  assert.deepEqual(report.verdict.failed_evidence.sort(), [
    'comparison_arms',
    'economics',
    'fixture_dataset',
    'fixture_expectations',
    'loaded_assets',
  ]);
});

test('eval cluster cannot promote caller-supplied comparisons without trusted producer evidence', () => {
  const input = writeAssayInputs();
  try {
    const result = runCli(comparisonArgs(input));
    assert.equal(result.status, 4, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.gates.behavioral.pass, true);
    assert.equal(report.gates.behavioral.details.delta, 0.5);
    assert.equal(report.gates.economics.pass, false);
    assert.equal(report.gates.trust.pass, null);
    assert.equal(report.verdict.overall, 'fail');
    assert.equal(report.verdict.all_passed, false);
  } finally {
    fs.rmSync(input.dir, { recursive: true, force: true });
  }
});

test('eval cluster gate display filter cannot launder a failed promotion verdict', () => {
  const input = writeAssayInputs();
  try {
    const args = comparisonArgs(input);
    args.splice(args.length - 1, 0, '--gates=structural');
    const result = runCli(args);
    assert.equal(result.status, 4, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report.gates), ['structural']);
    assert.equal(report.gates.structural.pass, true);
    assert.equal(report.verdict.overall, 'fail');
    assert.equal(report.verdict.all_passed, false);
    assert.ok(report.verdict.failed_gates.includes('economics'));
    assert.deepEqual(report.verdict.incomplete_gates, ['trust']);
  } finally {
    fs.rmSync(input.dir, { recursive: true, force: true });
  }
});

test('eval cluster rejects unknown gate display filters', () => {
  const result = runCli([
    'eval',
    'cluster',
    CLUSTER,
    `--task=${TASK}`,
    '--gates=structural,unknown',
    '--as=json',
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown Cluster assay gate: unknown/);
});

test('eval cluster rejects external trace JSON instead of trusting self-declared provenance', () => {
  const input = writeAssayInputs();
  try {
    const traceFile = path.join(input.dir, 'trace.json');
    fs.writeFileSync(
      traceFile,
      JSON.stringify({
        trace_id: 'trace_0000000000000000',
        authorization: 'authorized',
        digest_verified: true,
        token_count_basis: 'caller_declared',
      }),
    );
    const result = runCli([...comparisonArgs(input), `--trace=${traceFile}`]);
    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /External Cluster trace JSON cannot establish promotion provenance/,
    );
    assert.equal(result.stdout, '');
  } finally {
    fs.rmSync(input.dir, { recursive: true, force: true });
  }
});
