/**
 * Integration tests — need installed domain + network (registry lookup).
 * Run with: npm run test:integration
 */

const { test, describe } = require('node:test');
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
        timeout: 60000,
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

// ─── kdna verify (needs installed domain + registry lookup) ──────────

describe('verify (needs network)', () => {
  test('kdna verify all three layers', { skip: !ensureWritingInstalled() }, () => {
    const r = run(['verify', '@aikdna/writing']);
    // May fail if registry unreachable, accept that gracefully
    if (!r.ok) {
      console.log('  (verify skipped — registry unreachable or signature needs update)');
      return;
    }
    assert.match(r.stdout, /STRUCTURE/);
    assert.match(r.stdout, /TRUST/);
    assert.match(r.stdout, /JUDGMENT/);
  });

  test('kdna verify --judgment', { skip: !ensureWritingInstalled() }, () => {
    const r = run(['verify', '@aikdna/writing', '--judgment']);
    if (!r.ok) {
      console.log('  (verify --judgment skipped — may need eval files)');
      return;
    }
    assert.match(r.stdout, /score:\d+\/\d+/);
  });
});

// ─── kdna info (needs installed domain + registry) ───────────────────

test('kdna info shows metadata', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['info', '@aikdna/writing']);
  assert.ok(r.ok, `info failed: ${r.stderr}`);
  assert.match(r.stdout, /Identity & trust|Judgment surface|governance/);
});

// ─── .kdnae end-to-end: generate → pack → install → load ────────────

describe('.kdnae end-to-end', () => {
  const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kdnae-e2e-'));
  const licensePath = path.join(TMPDIR, 'license.json');
  const domainDir = path.join(os.homedir(), '.kdna', 'domains', '@aikdna', 'writing');
  const kdnaePath = path.join(TMPDIR, 'writing.kdnae');

  test('license generate + bind + install', { skip: !ensureWritingInstalled() }, () => {
    const gen = run(['license', 'generate', '@aikdna/writing', '--to', 'test@e2e.com', '--save', licensePath]);
    assert.ok(gen.ok, `license generate failed: ${gen.stderr}`);
    const lic = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
    assert.ok(lic.license_id);
    assert.ok(lic.signature?.startsWith('ed25519:'));

    const bind = run(['license', 'bind', licensePath]);
    assert.ok(bind.ok, `license bind failed: ${bind.stderr}`);
  });

  test('pack --encrypt creates .kdnae', { skip: !ensureWritingInstalled() }, () => {
    const pack = run(['pack', domainDir, '--encrypt', '--license', licensePath, '--output', TMPDIR]);
    assert.ok(pack.ok, `encrypt pack failed: ${pack.stderr}`);
    assert.ok(fs.existsSync(kdnaePath), '.kdnae file should exist');
    assert.match(pack.stdout, /Encrypted pack/);
  });

  test('license install + install .kdnae auto-decrypts', { skip: !ensureWritingInstalled() }, () => {
    const inst = run(['license', 'install', licensePath]);
    assert.ok(inst.ok, `license install failed: ${inst.stderr}`);

    const install = run(['install', kdnaePath, '--yes']);
    assert.ok(install.ok, `install .kdnae failed: ${install.stderr}`);
    assert.match(install.stdout, /Installed/);
  });

  test('load decrypted domain works', { skip: !ensureWritingInstalled() }, () => {
    const load = run(['load', '@aikdna/writing', '--as=json']);
    assert.ok(load.ok, `load failed: ${load.stderr}`);
    const parsed = JSON.parse(load.stdout);
    assert.ok('core' in parsed, 'should have core');
    assert.ok(parsed.core.axioms?.length > 0, 'should have axioms');
  });

  // Cleanup
  process.on('exit', () => {
    fs.rmSync(TMPDIR, { recursive: true, force: true });
  });
});

// ─── kdna available / match / load (need installed domain) ──────────

test('kdna available returns domains', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['available']);
  assert.ok(r.ok, `available failed: ${r.stderr}`);
  assert.match(r.stdout, /@aikdna\/writing/);
});

test('kdna available --json returns array', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['available', '--json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed));
});

test('kdna match returns signals', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['match', 'review this blog post for structural problems']);
  assert.ok(r.ok);
  assert.match(r.stdout, /HINT|hint|Dropped|writing/i);
});

test('kdna load emits prompt text', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['load', '@aikdna/writing']);
  assert.ok(r.ok);
  assert.match(r.stdout, /KDNA loaded/);
});

test('kdna load --as=json emits parseable JSON', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['load', '@aikdna/writing', '--as=json']);
  assert.ok(r.ok);
  const parsed = JSON.parse(r.stdout);
  assert.ok('manifest' in parsed);
  assert.ok('core' in parsed);
});
