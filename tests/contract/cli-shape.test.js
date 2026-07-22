/**
 * cli-shape.test.js — Contract test for the current minimal CLI surface.
 *
 * Fails CI if any deleted command name appears in the CLI source
 * or if the help output exceeds the contracted line count.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const cliBin = path.join(__dirname, '..', '..', 'src', 'cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const DELETED_COMMANDS = ['install', 'list', 'setup', 'update', 'registry', 'available', 'match'];

test('kdna --help is ≤12 lines', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout
    .trim()
    .split('\n')
    .filter((l) => l.length > 0);
  assert.ok(lines.length <= 12, `help has ${lines.length} lines, expected ≤12`);
});

test('kdna help legacy remains outside the default surface', () => {
  const r = runCli(['help', 'legacy']);
  assert.notEqual(r.status, 0, 'help legacy must exit non-zero');
  assert.match(r.stderr + r.stdout, /Usage: kdna legacy|Unknown command/);
  assert.doesNotMatch(runCli(['--help']).stdout, /help legacy/);
});

test('kdna help advanced does not exist', () => {
  const r = runCli(['help', 'advanced']);
  assert.notEqual(r.status, 0, 'help advanced must exit non-zero');
});

test('no deleted command names appear in src/cli.js routing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cli.js'), 'utf8');
  // Only check the switch statement — help text may mention archive/history terms
  const switchBlock = src.slice(src.indexOf('switch (cmd)'));
  const hits = [];
  for (const name of DELETED_COMMANDS) {
    const pattern = new RegExp(`case\\s+'${name}'\\s*:`);
    if (pattern.test(switchBlock)) {
      hits.push(name);
    }
  }
  assert.deepEqual(hits, [], `deleted commands still routed: ${hits.join(', ')}`);
});

test('kdna --help contains only the current Core commands', () => {
  const r = runCli(['--help']);
  const help = r.stdout;
  // Must have core commands
  assert.ok(help.includes('inspect'), 'missing inspect');
  assert.ok(help.includes('validate'), 'missing validate');
  assert.ok(help.includes('plan-load'), 'missing plan-load');
  assert.ok(help.includes('load'), 'missing load');
  assert.ok(help.includes('pack'), 'missing pack');
  assert.ok(help.includes('unpack'), 'missing unpack');
  assert.ok(help.includes('demo'), 'missing demo');
  assert.ok(help.includes('attach'), 'missing attach');
  assert.ok(help.includes('attachments'), 'missing attachments');
  assert.ok(help.includes('resolve'), 'missing resolve');
  assert.ok(help.includes('disable'), 'missing disable');
  assert.ok(help.includes('enable'), 'missing enable');
  assert.ok(help.includes('switch'), 'missing switch');
  assert.ok(help.includes('rollback'), 'missing rollback');
  assert.ok(help.includes('remove'), 'missing attachment remove');
  // Must NOT have legacy references
  assert.ok(!help.includes('help legacy'), 'must not mention help legacy');
  assert.ok(!help.includes('Compatibility'), 'must not have compatibility section');
});

test('consumer first-run path passes end-to-end', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-contract-'));
  try {
    const r1 = runCli(['demo', 'minimal', tmp + '/minimal']);
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runCli(['pack', tmp + '/minimal', tmp + '/minimal.kdna']);
    assert.equal(r2.status, 0, r2.stderr);
    const r3 = runCli(['validate', tmp + '/minimal.kdna']);
    assert.equal(r3.status, 0, r3.stderr);
    const v = JSON.parse(r3.stdout);
    assert.equal(v.overall_valid, true);
    const r4 = runCli(['plan-load', tmp + '/minimal.kdna', '--json']);
    assert.equal(r4.status, 0, r4.stderr);
    const plan = JSON.parse(r4.stdout);
    assert.equal(plan.state, 'ready');
    assert.equal(plan.can_load_now, true);
    const r5 = runCli(['load', tmp + '/minimal.kdna', '--profile=compact', '--as=prompt']);
    assert.equal(r5.status, 0, r5.stderr);
    assert.ok(r5.stdout.includes('KDNA Judgment Asset'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
