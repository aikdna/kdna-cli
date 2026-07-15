const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'minimal');

it('plan-use --help shows usage (via stderr)', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('node', [CLI, 'plan-use', '--help'], { encoding: 'utf8' });
  const output = (result.stderr || '') + (result.stdout || '');
  assert.ok(
    output.includes('Usage') || output.includes('ConsumptionPlan'),
    'help should show usage',
  );
});

it('plan-use with no args shows error', () => {
  try {
    execSync(`node ${CLI} plan-use`, {
      encoding: 'utf8',
      env: { ...process.env, KDNA_QUIET: '1' },
    });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.status !== 0);
  }
});

it('plan-use with valid fixture produces valid JSON', () => {
  const r = execSync(`node ${CLI} plan-use ${FIXTURE} --task="Deploy risk assessment" --as=json`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  const plan = JSON.parse(r);
  assert.strictEqual(plan.plan_version, '0.9.0');
  assert.strictEqual(plan.mode, 'single');
  assert.ok(plan.plan_id.startsWith('plan_'));
  assert.ok(plan.asset_ref);
  assert.ok(plan.asset_ref.asset_id);
  assert.ok(plan.applicability);
  assert.ok(['applies', 'does_not_apply', 'ask', 'blocked'].includes(plan.applicability.decision));
  assert.ok(plan.budget);
  assert.ok(plan.trace_policy);
});

it('plan-use with markdown output', () => {
  const r = execSync(`node ${CLI} plan-use ${FIXTURE} --task="Review code" --as=md`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  assert.ok(r.includes('Consumption Plan'));
  assert.ok(r.includes('## Task'));
  assert.ok(r.includes('## Applicability'));
});

it('plan-use is deterministic', () => {
  const r1 = execSync(`node ${CLI} plan-use ${FIXTURE} --task="Same task" --as=json`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  const r2 = execSync(`node ${CLI} plan-use ${FIXTURE} --task="Same task" --as=json`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  const p1 = JSON.parse(r1);
  const p2 = JSON.parse(r2);
  assert.strictEqual(p1.plan_id, p2.plan_id, 'Same asset+task should produce same plan_id');
});

it('plan-use different tasks produce different plan_ids', () => {
  const r1 = execSync(`node ${CLI} plan-use ${FIXTURE} --task="Task A" --as=json`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  const r2 = execSync(`node ${CLI} plan-use ${FIXTURE} --task="Task B" --as=json`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  const p1 = JSON.parse(r1);
  const p2 = JSON.parse(r2);
  assert.notStrictEqual(p1.plan_id, p2.plan_id);
});

it('plan-use --plan-id overrides', () => {
  const r = execSync(
    `node ${CLI} plan-use ${FIXTURE} --task="test" --plan-id=my-custom-plan --as=json`,
    { encoding: 'utf8', env: { ...process.env, KDNA_QUIET: '1' } },
  );
  const plan = JSON.parse(r);
  assert.strictEqual(plan.plan_id, 'my-custom-plan');
});

it('plan-use --out writes to file', () => {
  const tmp = path.resolve(__dirname, '..', 'tmp-plan-use-test.json');
  execSync(`node ${CLI} plan-use ${FIXTURE} --task="test" --out=${tmp} --as=json`, {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
  const fs = require('fs');
  assert.ok(fs.existsSync(tmp));
  const content = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  assert.strictEqual(content.plan_version, '0.9.0');
  fs.unlinkSync(tmp);
});

it('plan-use non-existent path gives error', () => {
  try {
    execSync(`node ${CLI} plan-use /nonexistent/path.kdna --as=json`, {
      encoding: 'utf8',
      env: { ...process.env, KDNA_QUIET: '1' },
    });
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e.status !== 0);
  }
});

console.log('plan-use.test.js: all tests complete');
