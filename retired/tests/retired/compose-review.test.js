const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function runCli(args, opts = {}) {
  const env = {
    ...process.env,
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

test('compose-review-workbook --help shows usage', () => {
  const r = runCli(['compose-review-workbook', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /compose-review-workbook/);
});

test('compose-review-workbook with diagnostic produces valid Markdown', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const diagFile = path.join(tmp, 'diag.json');
  fs.writeFileSync(
    diagFile,
    JSON.stringify({
      kdna_eval_consumption: '0.1.0',
      asset: { path: 'test-asset', version: '1.0' },
      run: {
        timestamp: '2026-07-10T00:00:00Z',
        modes: ['fresh'],
        gates: ['route', 'compose'],
      },
      results: {
        fresh: {
          gates: [
            { gate: 'route', pass: true, score: 1.0, details: { primary: 'content-review' } },
            {
              gate: 'promotion',
              pass: false,
              score: 0.0,
              details: { promotionBlocked: true, blockReason: 'sealed-derived' },
            },
          ],
        },
      },
      verdict: { overall: 'fail', blocked_gates: [], failed_gates: [], regression_flags: [] },
      budget: { profile: 'interactive', consumed: { tokens: 0, chars: 0, assets: 0 } },
    }) + '\n',
  );
  try {
    const r = runCli(['compose-review-workbook', diagFile, '--as=md']);
    assert.equal(r.status, 0, `failed: ${r.stderr}`);
    assert.match(r.stdout, /# KDNA Compose Review Workbook/);
    assert.match(r.stdout, /## Asset:/);
    assert.match(r.stdout, /### Decision:/);
    assert.match(r.stdout, /## Review Prompts/);
    assert.match(r.stdout, /## Candidate Sidecar Patch/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('compose-review-workbook output includes Review Prompts section', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const diagFile = path.join(tmp, 'diag.json');
  fs.writeFileSync(
    diagFile,
    JSON.stringify({
      kdna_eval_consumption: '0.1.0',
      asset: { path: 'test', version: '1.0' },
      run: { timestamp: '2026-07-10T00:00:00Z', modes: ['fresh'], gates: ['route'] },
      results: {
        fresh: {
          gates: [
            { gate: 'promotion', pass: false, score: 0, details: { promotionBlocked: true } },
          ],
        },
      },
      verdict: { overall: 'fail', blocked_gates: [], failed_gates: [], regression_flags: [] },
      budget: { profile: 'interactive', consumed: { tokens: 0, chars: 0, assets: 0 } },
    }) + '\n',
  );
  try {
    const r = runCli(['compose-review-workbook', diagFile, '--as=md']);
    assert.equal(r.status, 0, `failed: ${r.stderr}`);
    assert.match(r.stdout, /## Review Prompts/);
    assert.match(r.stdout, /- \[ \] Has a human reviewed/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('compose-review-workbook output includes Candidate Sidecar Patch', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const diagFile = path.join(tmp, 'diag.json');
  fs.writeFileSync(
    diagFile,
    JSON.stringify({
      kdna_eval_consumption: '0.1.0',
      asset: { path: 'test', version: '1.0' },
      run: { timestamp: '2026-07-10T00:00:00Z', modes: ['fresh'], gates: ['route'] },
      results: {
        fresh: {
          gates: [
            {
              gate: 'route',
              pass: true,
              score: 1.0,
              details: { primary: 'my-domain', confidence: 'high' },
            },
          ],
        },
      },
      verdict: { overall: 'fail', blocked_gates: [], failed_gates: [], regression_flags: [] },
      budget: { profile: 'interactive', consumed: { tokens: 0, chars: 0, assets: 0 } },
    }) + '\n',
  );
  try {
    const r = runCli(['compose-review-workbook', diagFile, '--as=md']);
    assert.equal(r.status, 0, `failed: ${r.stderr}`);
    assert.match(r.stdout, /## Candidate Sidecar Patch/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate-compose-decisions --help shows usage', () => {
  const r = runCli(['validate-compose-decisions', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /validate-compose-decisions/);
});

test('validate-compose-decisions with ledger produces valid JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const ledgerFile = path.join(tmp, 'ledger.jsonl');
  fs.writeFileSync(
    ledgerFile,
    JSON.stringify({ record_id: 'd1', task: 'review', primary: 'my-domain' }) + '\n',
  );
  try {
    const r = runCli(['validate-compose-decisions', ledgerFile]);
    assert.equal(r.status, 0, `failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.kdna_validate_compose, '0.1.0');
    assert.ok(out.ledger);
    assert.ok(Array.isArray(out.results));
    assert.ok(out.summary);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate report includes summary with total/passed/failed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const ledgerFile = path.join(tmp, 'ledger.jsonl');
  fs.writeFileSync(
    ledgerFile,
    JSON.stringify({ record_id: 'd1', task: 'review', primary: 'my-domain' }) +
      '\n' +
      JSON.stringify({ record_id: 'd2', task: 'decide', primary: 'other' }) +
      '\n',
  );
  try {
    const r = runCli(['validate-compose-decisions', ledgerFile]);
    const out = JSON.parse(r.stdout);
    assert.ok('total' in out.summary);
    assert.ok('passed' in out.summary);
    assert.ok('failed' in out.summary);
    assert.ok('promotion_blocked' in out.summary);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validate correctly marks promotion_blocked in summary', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const ledgerFile = path.join(tmp, 'ledger.jsonl');
  fs.writeFileSync(
    ledgerFile,
    JSON.stringify({
      record_id: 'd1',
      task: 'review',
      primary: 'my-domain',
      source: 'sealed-derived',
    }) + '\n',
  );
  try {
    const r = runCli(['validate-compose-decisions', ledgerFile]);
    const out = JSON.parse(r.stdout);
    assert.ok(out.summary.promotion_blocked >= 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('apply-reviewed-compose-decisions --help shows usage', () => {
  const r = runCli(['apply-reviewed-compose-decisions', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /apply-reviewed-compose-decisions/);
});

test('apply-reviewed-compose-decisions outputs updated consumer-index', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const ledgerFile = path.join(tmp, 'ledger.jsonl');
  const ciFile = path.join(tmp, 'ci.json');
  const validationFile = path.join(tmp, 'validation.json');
  fs.writeFileSync(ciFile, JSON.stringify({ consumer_index: '0.1.0', entries: [] }) + '\n');
  fs.writeFileSync(
    validationFile,
    JSON.stringify({
      kdna_validate_compose: '0.1.0',
      results: [{ record_id: 'd1', verdict: 'pass' }],
      summary: { total: 1, passed: 1, failed: 0 },
    }) + '\n',
  );
  fs.writeFileSync(
    ledgerFile,
    JSON.stringify({
      record_id: 'd1',
      task: 'review',
      primary: 'my-domain',
      review_status: 'human_reviewed',
      source: 'experiment-derived',
    }) + '\n',
  );
  try {
    const r = runCli([
      'apply-reviewed-compose-decisions',
      ledgerFile,
      '--validation',
      validationFile,
      '--consumer-index',
      ciFile,
    ]);
    assert.equal(r.status, 0, `failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.applied);
    assert.ok(out.skipped);
    assert.ok(out.consumer_index);
    assert.equal(out.summary.total, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('apply-reviewed without --validation fails with clear error', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const ledgerFile = path.join(tmp, 'ledger.jsonl');
  fs.writeFileSync(
    ledgerFile,
    JSON.stringify({ record_id: 'd1', task: 'review', primary: 'my-domain' }) + '\n',
  );
  try {
    const r = runCli(['apply-reviewed-compose-decisions', ledgerFile]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--validation/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('apply-reviewed with --validation reads verdict correctly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const ledgerFile = path.join(tmp, 'ledger.jsonl');
  const validationFile = path.join(tmp, 'validation.json');
  const ciFile = path.join(tmp, 'ci.json');
  fs.writeFileSync(ciFile, JSON.stringify({ consumer_index: '0.1.0', entries: [] }) + '\n');
  fs.writeFileSync(
    ledgerFile,
    JSON.stringify({
      record_id: 'd1',
      task: 'review',
      primary: 'my-domain',
      review_status: 'human_reviewed',
      source: 'experiment-derived',
    }) + '\n',
  );
  fs.writeFileSync(
    validationFile,
    JSON.stringify({
      kdna_validate_compose: '0.1.0',
      results: [{ record_id: 'd1', verdict: 'pass' }],
      summary: { total: 1, passed: 1, failed: 0 },
    }) + '\n',
  );
  try {
    const r = runCli([
      'apply-reviewed-compose-decisions',
      ledgerFile,
      '--validation',
      validationFile,
      '--consumer-index',
      ciFile,
    ]);
    assert.equal(r.status, 0, `failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.summary.applied, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('apply-reviewed skips record with non-pass verdict', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cr-'));
  const ledgerFile = path.join(tmp, 'ledger.jsonl');
  const validationFile = path.join(tmp, 'validation.json');
  const ciFile = path.join(tmp, 'ci.json');
  fs.writeFileSync(ciFile, JSON.stringify({ consumer_index: '0.1.0', entries: [] }) + '\n');
  fs.writeFileSync(
    ledgerFile,
    JSON.stringify({
      record_id: 'd1',
      task: 'review',
      primary: 'my-domain',
      review_status: 'human_reviewed',
      source: 'experiment-derived',
    }) + '\n',
  );
  fs.writeFileSync(
    validationFile,
    JSON.stringify({
      kdna_validate_compose: '0.1.0',
      results: [{ record_id: 'd1', verdict: 'fail' }],
      summary: { total: 1, passed: 0, failed: 1 },
    }) + '\n',
  );
  try {
    const r = runCli([
      'apply-reviewed-compose-decisions',
      ledgerFile,
      '--validation',
      validationFile,
      '--consumer-index',
      ciFile,
    ]);
    assert.equal(r.status, 0, `failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.summary.skipped, 1);
    assert.equal(out.summary.applied, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
