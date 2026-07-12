/**
 * remove-list-cli.test.js — kdna remove + kdna list CLI commands
 * (roadmap-2026.md §5.1 Story 1, RFC #148 v1.x Phase 1).
 *
 * Closes the largest gap between the RFC's claim ("no kdna
 * remove / kdna list commands") and reality. The package-store API
 * already has `removeInstalled()` and `listInstalled()`; this story
 * wires them into the top-level CLI dispatcher and adds the test
 * coverage that proves they work end-to-end.
 *
 * `kdna list` is the human-facing list of what is installed on the
 * local machine. `kdna available` (a separate command) is the
 * agent-facing list with applies_when / does_not_apply_when for
 * matching. They are different commands serving different needs.
 *
 * Run: node --test tests/remove-list-cli.test.js
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

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Build a minimal .kdna source dir in `tmpRoot/source` and pack
 * it into `tmpRoot/asset.kdna` using the same Python zipfile recipe
 * the asset-store fixture uses. Returns the absolute .kdna path.
 */
function buildAsset(tmpRoot, name = '@aikdna/writing', version = '0.1.0') {
  const source = path.join(tmpRoot, 'source');
  fs.mkdirSync(source, { recursive: true });
  writeJson(path.join(source, 'kdna.json'), {
    format: 'kdna',
    kdna_version: '1.0',
    name,
    version,
    judgment_version: '2026.05',
    status: 'experimental',
    access: 'public',
    languages: ['en'],
    default_language: 'en',
    description: `${name} test asset.`,
    core_insight: 'A test asset for the remove/list CLI tests.',
    keywords: ['test'],
    quality_badge: 'untested',
    author: { name: 'Test', id: 'test', pubkey: 'ed25519:test' },
    license: { type: 'CC-BY-4.0' },
    file_count: 2,
    files: ['KDNA_Core.json', 'KDNA_Patterns.json'],
  });
  writeJson(path.join(source, 'KDNA_Core.json'), {
    meta: { domain: name, version, purpose: 'Test' },
    axioms: [
      {
        id: 'ax_1',
        one_sentence: 'Test axiom.',
        applies_when: ['test'],
        does_not_apply_when: ['production'],
        failure_risk: 'low',
        status: 'locked',
        human_lock: {
          by: 'test',
          statement: 'Reviewed for remove/list test fixture.',
          checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
        },
      },
    ],
    ontology: [],
    stances: [],
  });
  writeJson(path.join(source, 'KDNA_Patterns.json'), {
    misunderstandings: [],
    self_check: ['Is this a test?'],
  });
  fs.writeFileSync(path.join(source, 'README.md'), '# test\n');

  const asset = path.join(tmpRoot, 'asset.kdna');
  const script = `import zipfile, os
src = ${JSON.stringify(source)}
out = ${JSON.stringify(asset)}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr(zipfile.ZipInfo('mimetype'), 'application/vnd.kdna.asset', compress_type=zipfile.ZIP_STORED)
    for name in sorted(os.listdir(src)):
        zf.write(os.path.join(src, name), name)
`;
  execFileSync('python3', ['-c', script], { stdio: 'pipe' });
  return asset;
}

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remove-list-home-'));
  const kdnaHome = path.join(home, '.kdna');
  return { home, kdnaHome, env: { HOME: home, KDNA_HOME: kdnaHome } };
}

// ─── kdna list ──────────────────────────────────────────────────────────

test('kdna list with no installs prints a friendly empty message', () => {
  const { env } = makeEnv();
  const r = run(['list'], { env });
  assert.ok(r.ok, `kdna list failed: ${r.stderr}`);
  assert.match(r.stdout, /No KDNA packages installed\./);
  assert.match(r.stdout, /Install with: kdna install/);
});

test('kdna list --json with no installs prints an empty array', () => {
  const { env } = makeEnv();
  const r = run(['list', '--json'], { env });
  assert.ok(r.ok, `kdna list --json failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed, []);
});

test('kdna list after install shows the installed package in human format', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remove-list-'));
  const { env } = makeEnv();
  const asset = buildAsset(tmpRoot);

  const install = run(['install', asset, '--yes'], { env });
  assert.ok(install.ok, `kdna install failed: ${install.stderr}`);

  const r = run(['list'], { env });
  assert.ok(r.ok, `kdna list failed: ${r.stderr}`);
  assert.match(r.stdout, /1 installed KDNA package/);
  assert.match(r.stdout, /@aikdna\/writing/);
  assert.match(r.stdout, /v0\.1\.0/);
  assert.match(r.stdout, /\[public\]/);
  // The asset path should be under the isolated KDNA_HOME
  assert.match(r.stdout, /asset:/);
});

test('kdna list --json after install returns one entry with the expected fields', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remove-list-'));
  const { env } = makeEnv();
  const asset = buildAsset(tmpRoot);

  const install = run(['install', asset, '--yes'], { env });
  assert.ok(install.ok, `kdna install failed: ${install.stderr}`);

  const r = run(['list', '--json'], { env });
  assert.ok(r.ok, `kdna list --json failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.length, 1);
  const entry = parsed[0];
  assert.equal(entry.name, '@aikdna/writing');
  assert.equal(entry.version, '0.1.0');
  assert.equal(entry.access, 'public');
  assert.equal(typeof entry.asset_path, 'string');
  assert.match(entry.asset_digest, /^sha256:/);
  assert.match(entry.content_digest, /^sha256:/);
  assert.equal(typeof entry.installed_at, 'string');
  assert.ok(entry.judgment_version, 'judgment_version should be present');
});

// ─── kdna remove ───────────────────────────────────────────────────────

test('kdna remove with no name prints a usage error', () => {
  const { env } = makeEnv();
  const r = run(['remove'], { env });
  assert.equal(r.code, 2, 'expected usage error exit 2');
  assert.match(r.stderr, /Usage: kdna remove <@scope\/name>/);
});

test('kdna remove on an uninstalled package prints "is not installed"', () => {
  const { env } = makeEnv();
  const r = run(['remove', '@aikdna/never_installed'], { env });
  assert.ok(r.ok, `kdna remove failed: ${r.stderr}`);
  assert.match(r.stdout, /@aikdna\/never_installed is not installed/);
});

test('kdna remove on an installed package deletes it and the index entry', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remove-list-'));
  const { kdnaHome, env } = makeEnv();
  const asset = buildAsset(tmpRoot);

  const install = run(['install', asset, '--yes'], { env });
  assert.ok(install.ok, `kdna install failed: ${install.stderr}`);

  // Pre-conditions: index.json has the entry, asset file exists
  const indexPath = path.join(kdnaHome, 'index.json');
  const indexBefore = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const entryBefore = indexBefore.packages['@aikdna/writing'];
  assert.ok(entryBefore, 'pre-condition: entry should exist in index.json');
  assert.ok(fs.existsSync(entryBefore.asset_path), 'pre-condition: asset file should exist');

  const r = run(['remove', '@aikdna/writing'], { env });
  assert.ok(r.ok, `kdna remove failed: ${r.stderr}`);
  assert.match(r.stdout, /✓ Removed @aikdna\/writing/);

  // Post-conditions: index.json no longer has the entry, asset file
  // is gone, and `kdna list` is empty.
  const indexAfter = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(
    indexAfter.packages['@aikdna/writing'],
    undefined,
    'post-condition: entry should be removed from index.json',
  );
  assert.ok(
    !fs.existsSync(entryBefore.asset_path),
    'post-condition: asset file should be removed from disk',
  );

  const list = run(['list'], { env });
  assert.ok(list.ok);
  assert.match(list.stdout, /No KDNA packages installed\./);
});

test('kdna remove followed by re-install leaves the index in a clean state', () => {
  // Regression: index.json must be writable after a remove, and a
  // subsequent install must not collide with the previous entry.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-remove-list-'));
  const { kdnaHome, env } = makeEnv();
  const asset = buildAsset(tmpRoot);

  run(['install', asset, '--yes'], { env });
  run(['remove', '@aikdna/writing'], { env });
  const reinstall = run(['install', asset, '--yes'], { env });
  assert.ok(reinstall.ok, `re-install failed: ${reinstall.stderr}`);

  const index = JSON.parse(fs.readFileSync(path.join(kdnaHome, 'index.json'), 'utf8'));
  assert.ok(index.packages['@aikdna/writing'], 're-installed entry should be present');
  const list = run(['list', '--json'], { env });
  const parsed = JSON.parse(list.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, '@aikdna/writing');
});
