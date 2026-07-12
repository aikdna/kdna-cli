const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const CLUSTER = path.resolve(__dirname, '..', 'fixtures', 'cluster-launch-decision.json');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KDNA_QUIET: '1' },
  });
}

function writeObservedEvidence() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-eval-cluster-'));
  const armsFile = path.join(dir, 'comparison-arms.json');
  const traceFile = path.join(dir, 'trace.json');
  fs.writeFileSync(
    armsFile,
    JSON.stringify({
      comparison_arms: [
        { arm: 'primary_only', mean_score: 3.5, critical_errors: 0 },
        { arm: 'bounded_compose', mean_score: 4.0, critical_errors: 0 },
      ],
    }),
  );
  fs.writeFileSync(
    traceFile,
    JSON.stringify({
      trace_version: '0.9.0',
      mode: 'cluster',
      assets_loaded: [
        { asset_id: '@aikdna/dev-change-risk', role: 'primary', digest_verified: true },
        { asset_id: '@aikdna/dev-api-design-judgment', role: 'advisor', digest_verified: true },
        {
          asset_id: '@aikdna/dev-silent-failure-detection',
          role: 'advisor',
          digest_verified: true,
        },
      ],
      cost: { tokens_used: 600, model_calls: 1 },
    }),
  );
  return { dir, armsFile, traceFile };
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
  assert.deepEqual(report.verdict.incomplete_gates.sort(), ['behavioral', 'trust']);
});

test('eval cluster passes only with observed comparison, trust, and cost evidence', () => {
  const evidence = writeObservedEvidence();
  try {
    const result = runCli([
      'eval',
      'cluster',
      CLUSTER,
      '--task=Deploy a new public API without monitoring',
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
