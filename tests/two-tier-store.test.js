/**
 * two-tier-store.test.js — Project-local + user-global package
 * store (roadmap-2026.md §5.1 Story 2, RFC #148 v1.x Phase 1).
 *
 * The package store now supports two roots:
 *   - global:   ~/.kdna/packages/ (default for `kdna install`)
 *   - project:  ./.kdna/packages/ (opt-in via `kdna install --local`)
 *
 * On read, project wins on conflict. On remove, the entry is
 * removed from whichever root it lives in.
 *
 * The CLI commands `kdna list` and `kdna remove` (which display
 * the tier and drive the per-tier remove) ship in Story 1 (PR
 * aikdna/kdna-cli#70, v0.28.14) on a separate branch. Story 2
 * tests verify the underlying package-store behavior by reading
 * the index.json files and asset paths directly, so the test
 * suite stays branch-independent.
 *
 * Run: node --test tests/two-tier-store.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const cbor = require('cbor-x');
const { buildChecksums, pack } = require('@aikdna/kdna-core');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const V1_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'v1-minimal');

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
      stderr: '',
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

function buildAsset(tmpRoot, name, version = '0.1.0') {
  const source = path.join(tmpRoot, 'src-' + name.replace(/[@/]/g, '_') + '-' + version);
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
    core_insight: 'A test asset.',
    keywords: ['test'],
    quality_badge: 'untested',
    author: { name: 'Test', id: 'test', pubkey: 'ed25519:test' },
    license: { type: 'CC-BY-4.0' },
    file_count: 1,
    files: ['KDNA_Core.json'],
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
          statement: 'Reviewed for two-tier store test.',
          checked: { applies_when: true, does_not_apply_when: true, failure_risk: true },
        },
      },
    ],
    ontology: [],
    stances: [],
  });

  const asset = path.join(tmpRoot, name.replace(/[@/]/g, '_') + '-' + version + '.kdna');
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

function buildStringRoutedAsset(tmpRoot) {
  const source = path.join(tmpRoot, 'src-string-routed');
  fs.cpSync(V1_FIXTURE, source, { recursive: true });
  const manifestPath = path.join(source, 'kdna.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.name = '@aikdna/string_routed';
  manifest.asset_id = 'kdna:aikdna:string_routed';
  manifest.title = 'String Routed Judgment';
  manifest.version = '0.1.0';
  manifest.judgment_version = '0.1.0';
  manifest.description = 'String routed judgment test asset.';
  manifest.summary = manifest.description;
  manifest.keywords = ['routing', 'lifecycle'];
  writeJson(manifestPath, manifest);

  const payloadPath = path.join(source, 'payload.kdnab');
  const payload = cbor.decode(fs.readFileSync(payloadPath));
  payload.core.axioms = [
    {
      id: 'axiom_string_routed',
      one_sentence: 'String route fields should still be discoverable.',
      applies_when: 'review structural routing lifecycle behavior',
      does_not_apply_when: 'only fix grammar',
      failure_risk: 'Installed assets may be invisible to agents.',
    },
  ];
  fs.writeFileSync(payloadPath, cbor.encode(payload));
  writeJson(path.join(source, 'checksums.json'), buildChecksums(source));

  const asset = path.join(tmpRoot, 'string-routed.kdna');
  pack(source, asset);
  return asset;
}

/**
 * Isolated environment with:
 *   - HOME = root/home  (so the global root is root/home/.kdna)
 *   - KDNA_HOME = root/home/.kdna
 *   - CWD = root/proj   (so the project root is root/proj/.kdna)
 */
function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-two-tier-'));
  const home = path.join(root, 'home');
  const kdnaHome = path.join(home, '.kdna');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  return {
    root,
    home,
    kdnaHome,
    proj,
    env: { HOME: home, KDNA_HOME: kdnaHome, KDNA_PROJECT_ROOT: proj },
  };
}

function readProjectIndex(proj) {
  return JSON.parse(fs.readFileSync(path.join(proj, '.kdna', 'index.json'), 'utf8'));
}

function readGlobalIndex(kdnaHome) {
  return JSON.parse(fs.readFileSync(path.join(kdnaHome, 'index.json'), 'utf8'));
}

function loadPackageStore(proj, kdnaHome) {
  // Reload the package-store with our env. KDNA_PROJECT_ROOT must
  // be set in process.env so the path getters pick it up; the
  // package-store also re-reads KDNA_HOME for the global root.
  // Use a fresh require so the module is initialised with the
  // current env.
  if (proj) process.env.KDNA_PROJECT_ROOT = proj;
  if (kdnaHome) process.env.KDNA_HOME = kdnaHome;
  delete require.cache[require.resolve('../src/package-store')];
  delete require.cache[require.resolve('../src/paths')];
  return require('../src/package-store');
}

// ─── kdna install --local writes to the project root ──────────────────

test('kdna install --local installs to ./.kdna/packages/ and adds an entry to ./.kdna/index.json', () => {
  const { proj, kdnaHome, env, root } = makeEnv();
  const asset = buildAsset(root, '@aikdna/writing');

  const r = run(['install', asset, '--yes', '--local'], { env, cwd: proj });
  assert.ok(r.ok, `kdna install --local failed: ${r.stderr}`);

  // Project index has the entry
  const projectIndex = readProjectIndex(proj);
  assert.ok(projectIndex.packages['@aikdna/writing'], 'project index should have the entry');
  assert.equal(projectIndex.packages['@aikdna/writing'].tier, 'project');

  // Project packages dir has the asset
  const projectAsset = path.join(
    proj,
    '.kdna',
    'packages',
    '@aikdna',
    'writing',
    '0.1.0',
    'writing-0.1.0.kdna',
  );
  assert.ok(fs.existsSync(projectAsset), 'project asset file should exist');

  // Global root is untouched
  assert.ok(!fs.existsSync(path.join(kdnaHome, 'index.json')), 'global index should NOT exist');
});

test('kdna install (no flag) defaults to the user-global root', () => {
  const { proj, kdnaHome, env, root } = makeEnv();
  const asset = buildAsset(root, '@aikdna/writing');

  const r = run(['install', asset, '--yes'], { env, cwd: proj });
  assert.ok(r.ok, `kdna install failed: ${r.stderr}`);

  // Global index has the entry
  const globalIndex = readGlobalIndex(kdnaHome);
  assert.ok(globalIndex.packages['@aikdna/writing'], 'global index should have the entry');
  assert.equal(globalIndex.packages['@aikdna/writing'].tier, 'global');

  // Project root is untouched
  assert.ok(!fs.existsSync(path.join(proj, '.kdna')), 'project root should NOT exist');
});

test('kdna install accepts v1 assets that declare asset_id instead of legacy name', () => {
  const { proj, env, root } = makeEnv();
  const asset = path.join(root, 'deployment-review.kdna');
  const pack = run(['pack', V1_FIXTURE, asset], { env, cwd: proj });
  assert.ok(pack.ok, `kdna pack failed: ${pack.stderr}`);

  const installed = run(['install', asset, '--yes', '--local'], { env, cwd: proj });
  assert.ok(installed.ok, `kdna install failed: ${installed.stderr}\n${installed.stdout}`);
  assert.match(installed.stdout, /Verification: local_format_valid/);
  assert.doesNotMatch(installed.stderr, /local_unverified/);

  const projectIndex = readProjectIndex(proj);
  const entry = projectIndex.packages['@example/deployment-review'];
  assert.ok(entry, 'project index should derive @example/deployment-review from asset_id');
  assert.equal(entry.tier, 'project');

  const projectAsset = path.join(
    proj,
    '.kdna',
    'packages',
    '@example',
    'deployment-review',
    '1.0.0',
    'deployment-review-1.0.0.kdna',
  );
  assert.ok(fs.existsSync(projectAsset), 'hyphenated v1 asset file should exist');
});

test('kdna plan-load accepts an installed v1 asset name', () => {
  const { proj, env, root } = makeEnv();
  const asset = path.join(root, 'deployment-review.kdna');
  const pack = run(['pack', V1_FIXTURE, asset], { env, cwd: proj });
  assert.ok(pack.ok, `kdna pack failed: ${pack.stderr}`);

  const installed = run(['install', asset, '--yes', '--local'], { env, cwd: proj });
  assert.ok(installed.ok, `kdna install failed: ${installed.stderr}\n${installed.stdout}`);

  const otherCwd = path.join(root, 'other-project');
  fs.mkdirSync(otherCwd, { recursive: true });
  const planned = run(['plan-load', '@example/deployment-review', '--json'], {
    env,
    cwd: otherCwd,
  });
  assert.ok(
    planned.ok,
    `kdna plan-load by installed name failed: ${planned.stderr}\n${planned.stdout}`,
  );
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.state, 'ready');
  assert.equal(plan.can_load_now, true);
});

test('agent discovery normalizes string routing fields from installed assets', () => {
  const { proj, env, root } = makeEnv();
  const asset = buildStringRoutedAsset(root);

  const installed = run(['install', asset, '--yes', '--local'], { env, cwd: proj });
  assert.ok(installed.ok, `kdna install failed: ${installed.stderr}\n${installed.stdout}`);

  const available = run(['available', '--json'], { env, cwd: proj });
  assert.ok(available.ok, `available failed: ${available.stderr}`);
  const domains = JSON.parse(available.stdout);
  assert.deepEqual(domains[0].applies_when, ['review structural routing lifecycle behavior']);
  assert.deepEqual(domains[0].does_not_apply_when, ['only fix grammar']);

  const match = run(['match', 'review structural routing lifecycle behavior', '--json'], {
    env,
    cwd: proj,
  });
  assert.ok(match.ok, `match failed: ${match.stderr}`);
  const matched = JSON.parse(match.stdout);
  assert.equal(matched.no_strong_matches, false);
  assert.equal(matched.hints[0].name, '@aikdna/string_routed');
  assert.ok(
    matched.hints[0].top_signals.length > 0,
    'string applies_when should produce hint signals',
  );
});

// ─── getInstalled / listInstalled: project wins on conflict ───────────

test('package-store.getInstalled returns the project entry when both tiers have the same name', () => {
  const { proj, kdnaHome, env, root } = makeEnv();
  const assetGlobal = buildAsset(root, '@aikdna/conflict', '1.0.0');
  const assetProject = buildAsset(root, '@aikdna/conflict', '2.0.0');

  const g = run(['install', assetGlobal, '--yes'], { env, cwd: proj });
  assert.ok(g.ok, `global install failed: ${g.stderr}`);
  const p = run(['install', assetProject, '--yes', '--local'], { env, cwd: proj });
  assert.ok(p.ok, `project install failed: ${p.stderr}`);

  const store = loadPackageStore(proj, kdnaHome);
  const got = store.getInstalled('@aikdna/conflict');
  assert.ok(got, 'getInstalled should return an entry');
  assert.equal(got.tier, 'project', 'project should win on conflict');
  assert.equal(got.version, '2.0.0');
});

test('package-store.getInstalled returns null when the name is not in either tier', () => {
  const { proj, kdnaHome } = makeEnv();
  const store = loadPackageStore(proj, kdnaHome);
  const got = store.getInstalled('@aikdna/never_installed');
  assert.equal(got, null);
});

test('package-store.listInstalled merges both tiers and project wins on name conflict', () => {
  const { proj, kdnaHome, env, root } = makeEnv();
  const assetA = buildAsset(root, '@aikdna/pkg_a');
  const assetB = buildAsset(root, '@aikdna/pkg_b');
  const assetGlobal = buildAsset(root, '@aikdna/conflict', '1.0.0');
  const assetProject = buildAsset(root, '@aikdna/conflict', '2.0.0');

  const r1 = run(['install', assetA, '--yes'], { env, cwd: proj });
  assert.ok(r1.ok, `install A failed: ${r1.stderr}\n${r1.stdout}`);
  const r2 = run(['install', assetB, '--yes', '--local'], { env, cwd: proj });
  assert.ok(r2.ok, `install B failed: ${r2.stderr}\n${r2.stdout}`);
  const r3 = run(['install', assetGlobal, '--yes'], { env, cwd: proj });
  assert.ok(r3.ok, `install conflict global failed: ${r3.stderr}\n${r3.stdout}`);
  const r4 = run(['install', assetProject, '--yes', '--local'], { env, cwd: proj });
  assert.ok(r4.ok, `install conflict project failed: ${r4.stderr}\n${r4.stdout}`);

  const store = loadPackageStore(proj, kdnaHome);
  const installed = store.listInstalled();
  // 4 installs, but the conflict pair is 1 merged entry → 3 total
  assert.equal(installed.length, 3);

  const a = installed.find((e) => e.full === '@aikdna/pkg_a');
  const b = installed.find((e) => e.full === '@aikdna/pkg_b');
  const c = installed.find((e) => e.full === '@aikdna/conflict');
  assert.ok(a, '@aikdna/pkg_a should be in the list');
  assert.ok(b, '@aikdna/pkg_b should be in the list');
  assert.ok(c, '@aikdna/conflict should be in the list');
  assert.equal(a.tier, 'global');
  assert.equal(b.tier, 'project');
  assert.equal(c.tier, 'project', 'project should win on conflict');
  assert.equal(c.version, '2.0.0');
});

test('package-store.listInstalled returns [] when nothing is installed', () => {
  const { proj, kdnaHome } = makeEnv();
  const store = loadPackageStore(proj, kdnaHome);
  const installed = store.listInstalled();
  assert.deepEqual(installed, []);
});

// ─── removeInstalled: per-tier removal ────────────────────────────────

test('package-store.removeInstalled removes the project entry (and leaves global alone)', () => {
  const { proj, kdnaHome, env, root } = makeEnv();
  const assetA = buildAsset(root, '@aikdna/pkg_local');
  const assetB = buildAsset(root, '@aikdna/pkg_global');

  assert.ok(run(['install', assetA, '--yes', '--local'], { env, cwd: proj }).ok);
  assert.ok(run(['install', assetB, '--yes'], { env, cwd: proj }).ok);

  const store = loadPackageStore(proj, kdnaHome);
  const removed = store.removeInstalled('@aikdna/pkg_local');
  assert.equal(removed, true);

  // Project entry gone
  const projectIndex = readProjectIndex(proj);
  assert.equal(projectIndex.packages['@aikdna/pkg_local'], undefined);

  // Global entry still there
  const globalIndex = readGlobalIndex(kdnaHome);
  assert.ok(globalIndex.packages['@aikdna/pkg_global'], 'global entry should remain');
});

test('package-store.removeInstalled on a conflict removes the project copy first (not the global)', () => {
  const { proj, kdnaHome, env, root } = makeEnv();
  const assetGlobal = buildAsset(root, '@aikdna/conflict', '1.0.0');
  const assetProject = buildAsset(root, '@aikdna/conflict', '2.0.0');

  assert.ok(run(['install', assetGlobal, '--yes'], { env, cwd: proj }).ok);
  assert.ok(run(['install', assetProject, '--yes', '--local'], { env, cwd: proj }).ok);

  const store = loadPackageStore(proj, kdnaHome);
  const removed = store.removeInstalled('@aikdna/conflict');
  assert.equal(removed, true);

  // Project entry gone
  const projectIndex = readProjectIndex(proj);
  assert.equal(projectIndex.packages['@aikdna/conflict'], undefined);

  // Global entry still there
  const globalIndex = readGlobalIndex(kdnaHome);
  assert.ok(
    globalIndex.packages['@aikdna/conflict'],
    'global entry should remain after removing the project copy',
  );

  // listInstalled should now show the global entry only
  const installed = store.listInstalled();
  assert.equal(installed.length, 1);
  assert.equal(installed[0].full, '@aikdna/conflict');
  assert.equal(installed[0].tier, 'global');
  assert.equal(installed[0].version, '1.0.0');
});

test('package-store.removeInstalled on a name in neither tier returns false', () => {
  const { proj, kdnaHome } = makeEnv();
  const store = loadPackageStore(proj, kdnaHome);
  const removed = store.removeInstalled('@aikdna/never_installed');
  assert.equal(removed, false);
});
