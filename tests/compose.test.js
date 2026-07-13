const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
          { id: 'style-advisor', weight: 0.3 },
        ],
      },
    }) + '\n',
  );
  return p;
}

test('kdna compose --help shows usage', () => {
  const r = runCli(['compose', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /--primary/);
  assert.match(r.stderr, /--advisors/);
  assert.match(r.stderr, /--source-hardmax/);
});

test('kdna compose with no args shows usage error', () => {
  const r = runCli(['compose']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test('kdna compose with --primary uses specified primary', () => {
  const r = runCli(['compose', FIXTURE, '--as=json', '--primary=my-domain']);
  assert.equal(r.status, 0, `compose failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision.primary.domain_id, 'my-domain');
});

test('kdna compose without --primary and no policy fails', () => {
  const r = runCli(['compose', FIXTURE, '--as=json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Cannot determine primary/);
});

test('kdna compose with policy auto-selects primary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-comp-'));
  const policyFile = makePoliciesFile(tmp);
  try {
    const r = runCli(['compose', FIXTURE, '--as=json', '--policy', policyFile]);
    assert.equal(r.status, 0, `compose failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision.primary.domain_id, 'deployment-review');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna compose with --advisors assigns advisors', () => {
  const r = runCli([
    'compose',
    FIXTURE,
    '--as=json',
    '--primary=my-domain',
    '--advisors=adv-a,adv-b',
  ]);
  assert.equal(r.status, 0, `compose failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision.advisors.length, 2);
  assert.equal(out.decision.advisors[0].domain_id, 'adv-a');
  assert.equal(out.decision.advisors[1].domain_id, 'adv-b');
});

test('kdna compose with --source-hardmax limits advisors', () => {
  const r = runCli([
    'compose',
    FIXTURE,
    '--as=json',
    '--primary=my-domain',
    '--advisors=adv-a,adv-b,adv-c',
    '--source-hardmax=2',
  ]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  const accepted = out.decision.advisors;
  const rejected = out.decision.rejected;
  assert.ok(accepted.length <= 1, `expected <=1 advisor with hardmax=2, got ${accepted.length}`);
  assert.ok(rejected.length > 0);
});

test('kdna compose --as=trace includes validation', () => {
  const r = runCli(['compose', FIXTURE, '--as=trace', '--primary=test-domain']);
  assert.equal(r.status, 0, `compose failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(out._validation);
  assert.equal(typeof out._validation.valid, 'boolean');
});

test('kdna compose JSON output includes attribution fields', () => {
  const r = runCli(['compose', FIXTURE, '--as=json', '--primary=test-domain', '--advisors=adv-a']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.decision.confidence);
  assert.ok(Array.isArray(out.decision.rejected));
});

test('kdna compose JSON output includes cost fields', () => {
  const r = runCli([
    'compose',
    FIXTURE,
    '--as=json',
    '--primary=test-domain',
    '--budget=code-review',
  ]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.cost);
  assert.ok('over_budget' in out.cost);
  assert.equal(out.decision.budget_profile, 'code-review');
});

test('kdna compose --as=prompt produces human-readable output', () => {
  const r = runCli([
    'compose',
    FIXTURE,
    '--as=prompt',
    '--primary=test-domain',
    '--advisors=adv-a',
  ]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /# kdna compose/);
  assert.match(r.stdout, /## Primary/);
  assert.match(r.stdout, /## Advisors/);
  assert.match(r.stdout, /## Attribution/);
});

test('kdna compose --trace writes trace file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-comp-'));
  const traceFile = path.join(tmp, 'compose-trace.json');
  try {
    const r = runCli([
      'compose',
      FIXTURE,
      '--as=json',
      '--primary=test-domain',
      '--trace',
      traceFile,
    ]);
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(traceFile));
    const content = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    assert.equal(content.kdna_trace, '1.0.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('kdna compose trace_id is 32-char hex', () => {
  const r = runCli(['compose', FIXTURE, '--as=json', '--primary=test-domain']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.trace_id, /^[0-9a-f]{32}$/);
});

test('kdna compose with --consumer-index filters untrusted advisors', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-comp-'));
  const ciFile = path.join(tmp, 'ci.json');
  fs.writeFileSync(
    ciFile,
    JSON.stringify({
      consumer_index: '0.1.0',
      entries: [
        { domain_id: 'trusted-advisor', status: 'trusted_runtime', enabled: true },
        { domain_id: 'untrusted-advisor', status: 'draft_generated', enabled: false },
      ],
    }) + '\n',
  );
  try {
    const r = runCli([
      'compose',
      FIXTURE,
      '--as=json',
      '--primary=my-domain',
      '--advisors=trusted-advisor,untrusted-advisor',
      '--consumer-index',
      ciFile,
    ]);
    assert.equal(r.status, 0, `compose failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const advisorIds = out.decision.advisors.map((a) => a.domain_id);
    assert.ok(advisorIds.includes('trusted-advisor'));
    assert.ok(!advisorIds.includes('untrusted-advisor'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
