const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const ASSET = path.resolve(__dirname, '..', 'fixtures', 'minimal');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KDNA_QUIET: '1' },
  });
}

function buildAssayInput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-eval-asset-'));
  const fixtureDir = path.join(dir, 'fixtures');
  fs.mkdirSync(fixtureDir);
  const categories = [
    ...Array(8).fill('positive_target'),
    ...Array(4).fill('non_applicable'),
    ...Array(4).fill('adjacent_ambiguous'),
    ...Array(2).fill('high_risk_failure'),
    ...Array(2).fill('regression'),
    'holdout',
  ];
  const observations = [];
  categories.forEach((category, index) => {
    const fixtureId = `fixture_${String(index).padStart(2, '0')}`;
    const fixture = { fixture_id: fixtureId, category, task: `Task ${index}`, expected: {} };
    fs.writeFileSync(path.join(fixtureDir, `${fixtureId}.json`), JSON.stringify(fixture));
    for (const arm of [
      'no_kdna',
      'best_ordinary_prompt',
      'correct_single_kdna',
      'wrong_or_adjacent_kdna',
    ]) {
      const correct = arm === 'correct_single_kdna';
      observations.push({
        fixture_id: fixtureId,
        arm,
        result: {
          answer:
            category === 'non_applicable' && correct
              ? 'Not applicable — outside scope.'
              : 'Bounded recommendation.',
          reasoning: ['Observed mechanism', 'Required evidence'],
          risks: ['Dominant risk'],
          confidence: 'medium',
          score_5pt:
            arm === 'no_kdna' ? 3 : arm === 'best_ordinary_prompt' ? 3.2 : correct ? 4 : 2.5,
          critical_errors: 0,
        },
      });
    }
  });
  const observationsFile = path.join(dir, 'observations.json');
  fs.writeFileSync(observationsFile, JSON.stringify({ observations }));
  return { dir, fixtureDir, observationsFile };
}

test('eval asset without fixtures reports structural-only honestly', () => {
  const result = runCli(['eval', 'asset', ASSET, '--as=json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'structural_only');
  assert.equal(report.fixture_validation.valid, false);
});

test('eval asset executes a complete behavioral observation matrix', () => {
  const input = buildAssayInput();
  try {
    const result = runCli([
      'eval',
      'asset',
      ASSET,
      `--fixtures=${input.fixtureDir}`,
      `--observations=${input.observationsFile}`,
      '--as=json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, 'behavioral_observations');
    assert.equal(report.fixture_validation.valid, true);
    assert.equal(report.observations_loaded, 84);
    assert.equal(report.overall_verdict, 'pass');
    assert.ok(report.classification.levels.includes('behavior_evaluated_asset'));
    assert.equal(report.evidence_claim.classification.not_behavior_evaluated, false);
  } finally {
    fs.rmSync(input.dir, { recursive: true, force: true });
  }
});
