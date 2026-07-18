const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const CLUSTER = path.resolve(__dirname, '..', 'fixtures', 'cluster-launch-decision.json');
const { CLUSTER_COMPARISON_ARMS, createClusterFixture } = require('@aikdna/kdna-eval');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KDNA_QUIET: '1' },
  });
}

function writeObservedEvidence() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-eval-cluster-'));
  const fixturesDir = path.join(dir, 'fixtures');
  const armsFile = path.join(dir, 'comparison-arms.json');
  const traceFile = path.join(dir, 'trace.json');
  fs.mkdirSync(fixturesDir);
  const fixture = createClusterFixture({
    task: 'Deploy a new public API without monitoring',
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
  fs.writeFileSync(
    traceFile,
    JSON.stringify({
      trace_version: '0.9.0',
      mode: 'cluster',
      assets_loaded: [
        {
          asset_id: '@aikdna/dev-change-risk',
          role: 'primary',
          digest_verified: true,
          authorization: 'authorized',
        },
        {
          asset_id: '@aikdna/dev-api-design-judgment',
          role: 'advisor',
          digest_verified: true,
          authorization: 'authorized',
        },
        {
          asset_id: '@aikdna/dev-silent-failure-detection',
          role: 'advisor',
          digest_verified: true,
          authorization: 'authorized',
        },
      ],
      cost: { tokens_used: 600, model_calls: 1 },
    }),
  );
  return { dir, fixturesDir, armsFile, traceFile };
}

test('eval cluster fails closed when behavioral and trust evidence are absent', () => {
  const result = runCli([
    'eval',
    'cluster',
    CLUSTER,
    '--task=Deploy a new public API without monitoring',
    '--as=json',
  ]);
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

test('eval cluster passes only with observed comparison, trust, and cost evidence', () => {
  const evidence = writeObservedEvidence();
  try {
    const result = runCli([
      'eval',
      'cluster',
      CLUSTER,
      '--task=Deploy a new public API without monitoring',
      `--fixtures=${evidence.fixturesDir}`,
      `--comparison-arms=${evidence.armsFile}`,
      `--trace=${evidence.traceFile}`,
      '--as=json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict.overall, 'pass');
    assert.equal(report.verdict.all_passed, true);
    assert.equal(report.gates.behavioral.details.delta, 0.5);
    assert.equal(report.gates.trust.details.verified, 3);
  } finally {
    fs.rmSync(evidence.dir, { recursive: true, force: true });
  }
});

test('eval cluster gate display filter cannot launder a failed promotion verdict', () => {
  const evidence = writeObservedEvidence();
  try {
    const result = runCli([
      'eval',
      'cluster',
      CLUSTER,
      '--task=Deploy a new public API without monitoring',
      `--fixtures=${evidence.fixturesDir}`,
      '--gates=structural',
      '--as=json',
    ]);
    assert.equal(result.status, 4, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report.gates), ['structural']);
    assert.equal(report.gates.structural.pass, true);
    assert.equal(report.verdict.overall, 'fail');
    assert.equal(report.verdict.all_passed, false);
    assert.ok(report.verdict.failed_gates.includes('behavioral'));
    assert.ok(report.verdict.failed_gates.includes('economics'));
    assert.deepEqual(report.verdict.incomplete_gates, ['trust']);
  } finally {
    fs.rmSync(evidence.dir, { recursive: true, force: true });
  }
});

test('eval cluster rejects unknown gate display filters', () => {
  const result = runCli([
    'eval',
    'cluster',
    CLUSTER,
    '--task=Deploy a new public API without monitoring',
    '--gates=structural,unknown',
    '--as=json',
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown Cluster assay gate: unknown/);
});
