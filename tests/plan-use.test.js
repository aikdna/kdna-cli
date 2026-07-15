'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('@aikdna/kdna-core');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const SOURCE = path.resolve(__dirname, '..', 'fixtures', 'minimal');
let root;
let asset;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-plan-use-'));
  asset = path.join(root, 'minimal.kdna');
  core.pack(SOURCE, asset);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function run(args) {
  return spawnSync(process.execPath, [CLI, 'plan-use', ...args], {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
}

test('plan-use help describes the current Runtime plan', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stderr + result.stdout, /ConsumptionPlan/);
  assert.doesNotMatch(result.stderr + result.stdout, /opt.?in|Plan \d/iu);
});

test('plan-use requires a packaged asset and a task', () => {
  assert.notEqual(run([]).status, 0);
  assert.notEqual(run([SOURCE, '--task=Review', '--as=json']).status, 0);
  assert.notEqual(run([asset, '--as=json']).status, 0);
});

test('plan-use emits one current, deterministic ConsumptionPlan', () => {
  const first = run([asset, '--task=Review deployment risk', '--as=json']);
  const second = run([asset, '--task=Review deployment risk', '--as=json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const a = JSON.parse(first.stdout);
  const b = JSON.parse(second.stdout);
  assert.equal(a.type, 'kdna.consumption-plan');
  assert.equal(a.contract_version, '0.1.0');
  assert.equal(a.mode, 'single');
  assert.equal(a.plan_id, b.plan_id);
  assert.equal(a.asset_ref.asset_id, 'kdna:example:deployment-review');
  assert.deepEqual(a.projection_request.accepted_capsule_versions, ['0.1.0']);
});

test('plan-use supports an explicit plan id and file output', () => {
  const output = path.join(root, 'plan.json');
  const result = run([
    asset,
    '--task=Review',
    '--plan-id=plan_0123456789abcdef',
    `--out=${output}`,
    '--as=json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).plan_id, 'plan_0123456789abcdef');
});

test('plan-use rejects alternate output contracts and generation selectors', () => {
  assert.notEqual(run([asset, '--task=Review', '--as=md']).status, 0);
  assert.notEqual(run([asset, '--task=Review', '--runtime-contract=1']).status, 0);
  assert.notEqual(
    run([asset, '--task=Review', '--runtime-contract', '--runtime-contract']).status,
    0,
  );
});
