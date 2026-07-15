/**
 * Smoke tests for v0.7+ commands: verify, search, diff, project, info.
 * compare is not smoke-tested because it requires an LLM API key and
 * costs money per run; it's exercised manually via demo/build-demo.js.
 *
 * These tests run the CLI as a subprocess and assert exit code +
 * key strings in output. They are not full unit tests — they verify
 * the wiring stays intact across refactors.
 *
 * Run: node --test tests/v07-commands.test.js
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
  const indexPath = path.join(os.homedir(), '.kdna', 'index.json');
  if (!fs.existsSync(indexPath)) return false;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const asset = index.packages?.['@aikdna/writing']?.asset_path;
    return !!asset && fs.existsSync(asset);
  } catch {
    return false;
  }
}

function writeRegistryHome(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-registry-home-'));
  const registryDir = path.join(home, '.kdna', 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'domains.json'),
    JSON.stringify(
      {
        schema_version: '3.0',
        registry_version: '3.0.0-test',
        updated: '2026-05-27T00:00:00Z',
        trust: {
          model: 'kdna.registry.snapshot',
          snapshot: {
            registry_version: '3.0.0-test',
            generated_at: '2026-05-27T00:00:00Z',
            expires_at: '2099-01-01T00:00:00Z',
          },
          timestamp: {
            generated_at: '2026-05-27T00:00:00Z',
            expires_at: '2099-01-01T00:00:00Z',
          },
          revocations: [],
        },
        scopes: {
          '@aikdna': {
            type: 'official',
            trust_pubkey: 'ed25519:test',
            registry_url: null,
            verified: true,
          },
        },
        domains: [
          {
            name: '@aikdna/writing',
            type: 'domain',
            version: '0.1.0',
            status: 'experimental',
            access: 'open',
            description: 'Writing judgment test asset.',
            core_insight: 'Most writing problems are structural.',
            keywords: ['writing', 'editing'],
            domain_field: ['content-creation'],
            judgment_patterns: ['quality-assessment'],
            asset_url: 'https://example.com/writing.kdna',
            asset_digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
            signature: 'ed25519:test',
            release_status: 'published_signed',
            author: { name: 'Test', id: 'test', pubkey: 'ed25519:test' },
            yanked: options.yanked === true,
            yanked_reason: options.yanked === true ? 'Protocol-invalid test asset.' : null,
            yanked_at: options.yanked === true ? '2026-05-28T16:37:29Z' : null,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  return { HOME: home };
}

function writeOldRegistryHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-old-registry-home-'));
  const registryDir = path.join(home, '.kdna', 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'domains.json'),
    JSON.stringify({ schema_version: '2.0', scopes: {}, domains: [] }, null, 2) + '\n',
  );
  return { HOME: home, KDNA_REGISTRY_URL: 'file:///dev/null' };
}

// ─── kdna help ─────────────────────────────────────────────────────────

test('kdna help keeps legacy commands out of the first-run surface', () => {
  const r = run(['help']);
  assert.ok(r.ok, `help failed: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /^\s+verify /m);
  assert.doesNotMatch(r.stdout, /^\s+compare /m);
  assert.doesNotMatch(r.stdout, /^\s+diff /m);
  assert.doesNotMatch(r.stdout, /^\s+search /m);
});

test('kdna help legacy still documents compatibility commands', () => {
  const r = run(['help', 'legacy']);
  assert.ok(r.ok, `help legacy failed: ${r.stderr}`);
  assert.match(r.stdout, /\bverify\b/);
  assert.match(r.stdout, /\bcompare\b/);
  assert.match(r.stdout, /\bdiff\b/);
  assert.match(r.stdout, /\bsearch\b/);
});

test('kdna project reports it was removed (v0.9)', () => {
  const r = run(['project', 'info']);
  assert.ok(!r.ok, 'kdna project should fail with explanation');
  assert.match(r.stderr, /removed in v0\.9/);
});

// ─── kdna search ───────────────────────────────────────────────────────

test('kdna search returns matches for a known keyword', () => {
  const r = run(['search', 'writing'], { env: writeRegistryHome() });
  assert.ok(r.ok, `search failed: ${r.stderr}`);
  assert.match(r.stdout, /@aikdna\/writing/);
  assert.match(r.stdout, /score:/);
});

test('kdna search reports no-match cleanly', () => {
  const r = run(['search', 'zzzznosuchkeyword'], { env: writeRegistryHome() });
  assert.ok(r.ok, `search no-match should still exit 0: ${r.stderr}`);
  assert.match(r.stdout, /No domains match/);
});

test('kdna search hides yanked registry entries by default', () => {
  const r = run(['search', 'writing'], { env: writeRegistryHome({ yanked: true }) });
  assert.ok(r.ok, `search failed: ${r.stderr}`);
  assert.match(r.stdout, /No installable registry entries/);
  assert.doesNotMatch(r.stdout, /@aikdna\/writing/);
});

test('kdna search rejects predecessor registry metadata', () => {
  const r = run(['search', 'writing'], { env: writeOldRegistryHome() });
  assert.ok(!r.ok, 'old registry schema must fail closed');
  assert.match(r.stderr, /Registry trust check failed/);
});

test('kdna list --available hides yanked registry entries by default', () => {
  const r = run(['list', '--available'], { env: writeRegistryHome({ yanked: true }) });
  assert.ok(r.ok, `list --available failed: ${r.stderr}`);
  assert.match(r.stdout, /No non-yanked registry entries/);
  assert.doesNotMatch(r.stdout, /@aikdna\/writing/);
});

// ─── kdna verify (structural only, offline) ──────────────────────────

test('kdna verify on uninstalled domain exits 2', () => {
  const r = run(['verify', '@aikdna/nonexistent_test_xxx']);
  assert.ok(!r.ok, `expected failure but got: ${r.stdout}`);
  assert.equal(r.code, 2);
});

// ─── kdna info ─────────────────────────────────────────────────────────

test('kdna info shows v2.1 governance section', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['info', '@aikdna/writing']);
  assert.ok(r.ok, `info failed: ${r.stderr}`);
  assert.match(r.stdout, /Identity & trust/);
  assert.match(r.stdout, /Judgment surface/);
  assert.match(r.stdout, /governance/);
});

test('kdna info refuses uninstalled domain', () => {
  const r = run(['info', '@aikdna/nonexistent_test_xxx']);
  assert.ok(!r.ok);
});

// ─── kdna project (removed in v0.9) ────────────────────────────────────
// The project command was removed because .kdna/config.json forced
// KDNA loading on tasks the user did not explicitly ask for, violating
// the "install ≠ load" safety model. Tests above already verify the
// command exits with a clear explanation.

// ─── kdna available / match / load (v0.9 agent-facing) ────────────────

test('kdna available returns installed domains', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['available']);
  assert.ok(r.ok, `available failed: ${r.stderr}`);
  assert.match(r.stdout, /@aikdna\/writing/);
});

test(
  'kdna available --json returns parseable JSON array',
  { skip: !ensureWritingInstalled() },
  () => {
    const r = run(['available', '--json']);
    assert.ok(r.ok, `available --json failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed), 'output should be an array');
    assert.ok(parsed.length > 0, 'should have at least one domain');
    const writing = parsed.find((d) => d.name === '@aikdna/writing');
    assert.ok(writing, 'writing should be in the list');
    assert.ok(Array.isArray(writing.applies_when), 'should expose applies_when');
  },
);

test('kdna match returns hint signals', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['match', 'review this blog post for structural problems']);
  assert.ok(r.ok, `match failed: ${r.stderr}`);
  // hints OR dropped should mention something
  assert.match(r.stdout, /HINT|hint|Dropped|writing/i);
});

test('kdna match --json returns structured result', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['match', 'review this draft', '--json']);
  assert.ok(r.ok, `match --json failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.ok('hints' in parsed, 'result should have hints field');
  assert.ok('dropped' in parsed, 'result should have dropped field');
  assert.ok('task' in parsed, 'result should echo the task');
});

test(
  'kdna load emits prompt-formatted text by default',
  { skip: !ensureWritingInstalled() },
  () => {
    const r = run(['load', '@aikdna/writing']);
    assert.ok(r.ok, `load failed: ${r.stderr}`);
    assert.match(r.stdout, /KDNA loaded/);
    assert.match(r.stdout, /Axioms/);
    // should NOT contain raw JSON braces at start
    assert.ok(!r.stdout.startsWith('{'), 'default output should not be JSON');
  },
);

test('kdna load --as=json emits parseable JSON', { skip: !ensureWritingInstalled() }, () => {
  const r = run(['load', '@aikdna/writing', '--as=json']);
  assert.ok(r.ok, `load --as=json failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.ok('manifest' in parsed);
  assert.ok('core' in parsed);
  assert.ok('patterns' in parsed);
});

test('kdna load on uninstalled domain exits 2', () => {
  const r = run(['load', '@aikdna/nonexistent_xxx']);
  assert.ok(!r.ok);
  assert.equal(r.code, 2);
});

// ─── deprecated commands give clear v0.9 explanation ──────────────────

test('removed commands explain themselves', () => {
  for (const cmd of ['preview', 'eval', 'export', 'demo']) {
    const r = run([cmd, './nothing']);
    assert.ok(!r.ok, `'${cmd}' should fail`);
    assert.match(r.stderr, /removed in v0\.9/, `'${cmd}' should say it was removed`);
  }
});

// ─── kdna diff ─────────────────────────────────────────────────────────

test('kdna diff with no args explains usage', () => {
  const r = run(['diff']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /Usage/);
});

// ─── kdna compare ──────────────────────────────────────────────────────

test('kdna compare without --input explains usage', () => {
  const r = run(['compare', '@aikdna/writing']);
  assert.ok(!r.ok);
  assert.match(r.stderr, /--input/);
});

test('kdna compare without API key explains how to configure', () => {
  const r = run(['compare', '@aikdna/writing', '--input', 'test'], {
    env: { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', SILICONFLOW_API_KEY: '' },
  });
  // exits non-zero; output explains config
  assert.ok(!r.ok || /API key not found/.test(r.stdout + r.stderr));
});
