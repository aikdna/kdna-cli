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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-use-'));
  asset = path.join(root, 'minimal.kdna');
  core.pack(SOURCE, asset);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function run(args) {
  return spawnSync(process.execPath, [CLI, 'use', ...args], {
    encoding: 'utf8',
    env: { ...process.env, KDNA_QUIET: '1' },
  });
}

test('use help exposes only the current process Host path', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  const output = result.stderr + result.stdout;
  assert.match(output, /Runtime Capsule/);
  assert.match(output, /cli:default/);
  assert.doesNotMatch(output, /mock:default|opt.?in|Host \d/iu);
});

test('use lists only the current runner', () => {
  const result = run(['--list-runners']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Registered runners (1):\n  - cli:default\n');
});

test('use plan-only emits the same current plan without a Host', () => {
  const result = run([asset, '--task=Review', '--plan-only', '--as=json']);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.type, 'kdna.consumption-plan');
  assert.equal(plan.contract_version, '0.1.0');
});

test('use requires an explicit process Host and rejects alternate single-asset runners', () => {
  const missing = run([asset, '--task=Review', '--as=json']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /explicit --agent-host/);
  const alternate = run([
    asset,
    '--task=Review',
    '--runner=mock:default',
    '--agent-host=node',
    '--as=json',
  ]);
  assert.notEqual(alternate.status, 0);
  assert.match(alternate.stderr, /cli:default/);
});

test('use rejects source directories, alternate output contracts, and dry-run', () => {
  assert.notEqual(run([SOURCE, '--task=Review', '--plan-only']).status, 0);
  assert.notEqual(run([asset, '--task=Review', '--plan-only', '--as=prompt']).status, 0);
  assert.notEqual(run([asset, '--task=Review', '--dry-run']).status, 0);
});

test('use keeps staged Cluster execution outside the single-asset Runtime', () => {
  const cluster = path.join(root, 'cluster.json');
  fs.writeFileSync(cluster, '{}\n');
  const result = run([cluster, '--task=Review', '--as=trace']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /separate staged Runtime/);
});
