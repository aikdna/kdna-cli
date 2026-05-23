/**
 * Smoke tests for v0.12+ commands: doctor, trace, history, license, compare report.
 *
 * Run: node --test tests/v012-commands.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');

function run(args, opts = {}) {
  try {
    return {
      ok: true,
      code: 0,
      stdout: execFileSync('node', [CLI, ...args], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, ...(opts.env || {}) },
        cwd: opts.cwd || process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (e) {
    return {
      ok: false,
      code: e.status,
      stdout: (e.stdout || '').toString(),
      stderr: (e.stderr || '').toString(),
    };
  }
}

function ensureWritingInstalled() {
  const dir = path.join(os.homedir(), '.kdna', 'domains', '@aikdna', 'writing');
  return fs.existsSync(dir);
}

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-test-'));

// ─── kdna help — v0.12+ commands ──────────────────────────────────────

test('help mentions doctor', () => {
  const r = run(['help']);
  assert.ok(r.ok, `help failed: ${r.stderr}`);
  assert.match(r.stdout, /doctor/);
});

test('help mentions trace', () => {
  const r = run(['help']);
  assert.match(r.stdout, /trace/);
});

test('help mentions history', () => {
  const r = run(['help']);
  assert.match(r.stdout, /history/);
});

test('help mentions license', () => {
  const r = run(['help']);
  assert.match(r.stdout, /\blicense\b/);
});

// ─── kdna doctor ───────────────────────────────────────────────────────

test('kdna doctor exits 0', () => {
  const r = run(['doctor']);
  assert.ok(r.ok, `doctor failed: ${r.stderr || r.stdout}`);
});

test('kdna doctor --agents outputs agent names', () => {
  const r = run(['doctor', '--agents']);
  assert.ok(r.ok, `doctor --agents failed: ${r.stderr || r.stdout}`);
  assert.match(r.stdout, /OpenCode|Codex|Claude|Cursor|Gemini/);
});

test('kdna doctor --agents --json returns parseable JSON', () => {
  const r = run(['doctor', '--agents', '--json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.checks), 'checks should be array');
  assert.ok(parsed.checks.some(c => c.agent), 'at least one agent check');
  assert.ok(parsed.checks.some(c => c.skillInstalled !== undefined), 'skillInstalled field present');
});

test('kdna doctor --json reports healthy', () => {
  const r = run(['doctor', '--json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok('healthy' in parsed);
  assert.ok('ok' in parsed);
  assert.ok('failures' in parsed);
});

// ─── kdna trace ────────────────────────────────────────────────────────

test('kdna trace exits 0 with no entries', () => {
  const r = run(['trace', '--clear']);
  assert.ok(r.ok, `trace --clear failed: ${r.stderr}`);
  const r2 = run(['trace']);
  assert.ok(r2.ok, `trace read failed: ${r2.stderr}`);
  assert.match(r2.stdout, /No trace entries|entries total/);
});

test('kdna trace --json returns valid JSON array', () => {
  const r = run(['trace', '--json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok('entries' in parsed);
  assert.ok(Array.isArray(parsed.entries));
  assert.ok('count' in parsed);
});

test('kdna trace generates entry on kdna load', { skip: !ensureWritingInstalled() }, () => {
  run(['trace', '--clear']);
  const load = run(['load', '@aikdna/writing', '--as=json']);
  assert.ok(load.ok, `load failed: ${load.stderr}`);
  const trace = run(['trace', '--json']);
  assert.ok(trace.ok);
  const parsed = JSON.parse(trace.stdout);
  assert.ok(parsed.entries.length >= 1, 'should have at least one trace entry');
  const entry = parsed.entries[0];
  assert.equal(entry.domain, '@aikdna/writing');
  assert.ok(entry.timestamp);
});

test('kdna trace --export writes file', () => {
  const outPath = path.join(TMPDIR, 'trace-export.json');
  const r = run(['trace', '--export', outPath]);
  assert.ok(r.ok, `trace --export failed: ${r.stderr}`);
  const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok('entries' in data);
  fs.unlinkSync(outPath);
});

// ─── kdna history ──────────────────────────────────────────────────────

test('kdna history exits 0', () => {
  const r = run(['history']);
  assert.ok(r.ok, `history failed: ${r.stderr}`);
});

test('kdna history --stats outputs domain counts', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['history', '--stats']);
  assert.ok(r.ok, `history --stats failed: ${r.stderr}`);
  assert.match(r.stdout, /Total KDNA loads/);
  assert.match(r.stdout, /By domain/);
});

test('kdna history --json returns parseable', () => {
  const r = run(['history', '--json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok('entries' in parsed);
  assert.ok('total' in parsed);
});

// ─── kdna license ──────────────────────────────────────────────────────

test('kdna license generate requires domain', () => {
  const r = run(['license', 'generate']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /Usage/);
});

test('kdna license generate creates valid JSON', () => {
  const outPath = path.join(TMPDIR, 'test-license.json');
  const r = run(['license', 'generate', '@aikdna/test', '--to', 'test@test.com', '--save', outPath]);
  assert.ok(r.ok, `license generate failed: ${r.stderr}`);
  const lic = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(lic.domain, '@aikdna/test');
  assert.equal(lic.issued_to, 'test@test.com');
  assert.ok(lic.license_id);
  assert.ok(lic.signature);
  assert.ok(lic.signature.startsWith('ed25519:'));
  fs.unlinkSync(outPath);
});

test('kdna license bind adds machine fingerprint', () => {
  const outPath = path.join(TMPDIR, 'test-lic-bind.json');
  run(['license', 'generate', '@aikdna/test', '--to', 't@t.com', '--save', outPath]);
  const r = run(['license', 'bind', outPath]);
  assert.ok(r.ok, `license bind failed: ${r.stderr}`);
  const lic = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.ok(lic.machine_fingerprint);
  assert.ok(lic.bound_at);
  assert.ok(lic.signature); // re-signed after binding
  fs.unlinkSync(outPath);
});

test('kdna license verify reports valid', () => {
  const outPath = path.join(TMPDIR, 'test-lic-verify.json');
  run(['license', 'generate', '@aikdna/test', '--to', 't@t.com', '--save', outPath]);
  run(['license', 'bind', outPath]);
  const r = run(['license', 'verify', outPath]);
  assert.ok(r.ok, `license verify should pass: ${r.stderr}`);
  assert.match(r.stdout, /License valid/);
  fs.unlinkSync(outPath);
});

test('kdna license verify --json returns parseable', () => {
  const outPath = path.join(TMPDIR, 'test-lic-vj.json');
  run(['license', 'generate', '@aikdna/test', '--to', 't@t.com', '--save', outPath]);
  run(['license', 'bind', outPath]);
  const r = run(['license', 'verify', '--json', outPath]);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok('license_id' in parsed);
  assert.ok('valid' in parsed);
  assert.equal(parsed.valid, true);
  fs.unlinkSync(outPath);
});

test('kdna license install registers to ~/.kdna/licenses/', () => {
  const outPath = path.join(TMPDIR, 'test-lic-install.json');
  run(['license', 'generate', '@aikdna/test', '--to', 't@t.com', '--save', outPath]);
  run(['license', 'bind', outPath]);
  const r = run(['license', 'install', outPath]);
  assert.ok(r.ok, `license install failed: ${r.stderr}`);
  assert.match(r.stdout, /License installed/);
  // Verify file exists
  const licDir = path.join(os.homedir(), '.kdna', 'licenses');
  const installed = path.join(licDir, 'aikdna-test.json');
  assert.ok(fs.existsSync(installed), 'license file should exist');
  fs.unlinkSync(installed);
  fs.unlinkSync(outPath);
});

test('kdna license without subcommand shows usage', () => {
  const r = run(['license']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /Usage/);
});

// ─── kdna compare report ───────────────────────────────────────────────

test('kdna compare --report-md requires --input', () => {
  const r = run(['compare', '@aikdna/writing', '--report-md']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /--input/);
});

test('kdna compare --report-json requires --input', () => {
  const r = run(['compare', '@aikdna/writing', '--report-json']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /--input/);
});

// ─── Cleanup ───────────────────────────────────────────────────────────

test('cleanup trace data', () => {
  run(['trace', '--clear']);
  const r = run(['trace', '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.entries.length, 0);
});

// Clean temp files
process.on('exit', () => {
  try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {}
});
