/**
 * cli-smoke.test.js — Smoke test that all 19 case-routed commands are reachable
 * from the CLI dispatcher in src/cli.js.
 *
 * This test catches a class of bugs where a case is added/removed from the
 * switch statement (or its routing logic is wrong) and the command silently
 * becomes unreachable. It's a thin layer: we just spawn the CLI with the
 * top-level command and check that the response is NOT "Unknown command".
 *
 * We don't test command logic here (that's what e2e-encrypt.test.js etc.
 * are for); we test reachability.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const cliBin = path.join(__dirname, '..', 'src', 'cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The case-routed commands. Keep in sync with src/cli.js.
 * If you add a new case 'foo': { ... } block, add 'foo' to this array.
 */
const CASE_ROUTED_COMMANDS = [
  'validate',
  'plan-load',
  'load',
  'pack',
  'unpack',
  'inspect',
  'demo',
  'lint',
  'workpack',
  'license',
  'identity',
  'doctor',
  'trace',
  'history',
  'cluster',
  'protect',
  'attach',
  'attachments',
  'resolve',
  'disable',
  'enable',
  'switch',
  'rollback',
  'remove',
  'publish',
  'changelog',
  'explain',
  'protocol',
  'test',
  'badge',
  'domain',
  'governance',
  'legacy',
  'quality',
  'studio',
  'version',
];

test('cli-smoke: every case-routed command is reachable (not "Unknown command")', () => {
  const unreachable = [];
  for (const cmd of CASE_ROUTED_COMMANDS) {
    const r = runCli([cmd]);
    const out = (r.stdout || '') + (r.stderr || '');
    if (/Unknown command/.test(out)) {
      unreachable.push(cmd);
    }
  }
  assert.deepStrictEqual(
    unreachable,
    [],
    `Commands marked reachable in cli.js but dispatcher says "Unknown command": ${unreachable.join(', ')}`,
  );
});

test('cli-smoke: every case-routed command exits cleanly or with usage error (never crashes)', () => {
  const crashed = [];
  for (const cmd of CASE_ROUTED_COMMANDS) {
    const r = runCli([cmd]);
    // A usage error (exit 1/2/3) is fine — we just don't want a hard crash
    // (signal exit like SIGSEGV, exit code > 128, or stack trace in output).
    const out = (r.stdout || '') + (r.stderr || '');
    if (
      r.signal !== null ||
      (r.status !== null && r.status > 128) ||
      /at Object\..*\(/.test(out) || // Node stack trace
      /TypeError:/.test(out) ||
      /ReferenceError:/.test(out)
    ) {
      crashed.push({ cmd, status: r.status, signal: r.signal, snippet: out.slice(0, 200) });
    }
  }
  assert.deepStrictEqual(
    crashed,
    [],
    `Commands crashed (not just usage error):\n${crashed.map((c) => `  ${c.cmd}: exit=${c.status} signal=${c.signal} ${c.snippet}`).join('\n')}`,
  );
});

test('cli-smoke: --help exits 0 and shows the help text', () => {
  const r = runCli(['--help']);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}`);
  assert.match(r.stdout, /KDNA runtime CLI/, 'help output should include KDNA branding');
});
