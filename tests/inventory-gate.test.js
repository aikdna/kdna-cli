'use strict';
/*
 * Permanent reverse cases for scripts/check-inventory.cjs.
 *
 * The gate exists because a broad `.gitignore` pattern made a file that must
 * travel with the repository invisible to `git status`. These cases keep the
 * gate honest: each one mutates the real condition the gate claims to detect
 * and asserts the gate goes red, and the last group asserts that a success
 * line is never printed on a failing tree and that no caller-supplied
 * inventory can be substituted for real git state.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const gate = path.join(repoRoot, 'scripts', 'check-inventory.cjs');
const SUCCESS_LINE = 'Repository inventory MATCH';

function git(cwd, args, allowFailure = false) {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (run.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed: ${run.stderr || run.stdout}`);
  }
  return run;
}

function runGate(root, extraArgs = []) {
  return spawnSync(process.execPath, [gate, '--root', root, ...extraArgs], { encoding: 'utf8' });
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// A deliberately tiny repository that reproduces the original defect shape:
// a vendored archive that must travel, a retired byte-preservation archive that
// must travel, and an internal evidence path that must not be committed.
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-inventory-gate-'));
  git(dir, ['init', '-q']);
  write(path.join(dir, 'src', 'keep.js'), 'module.exports = 1;\n');
  write(path.join(dir, 'vendor', 'a.tgz'), 'vendor bytes\n');
  write(path.join(dir, 'retired', 'x', 'y', 'old.tgz'), 'retired bytes\n');
  write(path.join(dir, 'docs', 'audits', 'internal.md'), 'internal evidence\n');
  write(
    path.join(dir, '.gitignore'),
    ['*.tgz', '!vendor/*.tgz', '!retired/**/*.tgz', 'docs/audits/', ''].join('\n'),
  );
  return dir;
}

function manifestBody(overrides = {}) {
  return {
    document_type: 'kdna.repository-inventory',
    tracked_count: 0,
    must_track_globs: ['vendor/*.tgz', 'retired/**/*.tgz'],
    allowed_untracked_globs: [],
    allowed_ignored_globs: ['docs/audits/**'],
    ...overrides,
  };
}

function writeManifest(dir, overrides = {}) {
  const manifest = manifestBody(overrides);
  write(path.join(dir, 'release-surface', 'inventory.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// Stage the fixture the way the real repository does (the manifest is tracked
// content), then pin the declared count to the resulting index size.
function stageFixture(dir, { addRetiredArchive = true, overrides = {} } = {}) {
  writeManifest(dir, { ...overrides, tracked_count: 0 });
  git(dir, ['read-tree', '--empty']);
  const paths = ['.gitignore', 'src/keep.js', 'vendor/a.tgz', 'release-surface/inventory.json'];
  if (addRetiredArchive) paths.push('retired/x/y/old.tgz');
  git(dir, ['add', '-f', '--', ...paths]);
  const count = git(dir, ['ls-files']).stdout.split('\n').filter(Boolean).length;
  writeManifest(dir, { ...overrides, tracked_count: count });
  return count;
}

test('inventory gate: the live repository satisfies its own declaration', () => {
  const run = runGate(repoRoot);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(SUCCESS_LINE));
});

test('inventory gate: clean fixture is green and prints the success line', () => {
  const dir = makeFixture();
  stageFixture(dir);
  const run = runGate(dir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventory gate: an archive hidden by a broad ignore pattern turns it red', () => {
  const dir = makeFixture();
  // The original defect: the whitelist that keeps the retired archive
  // commit-able is missing, so the file is ignored and invisible to status.
  write(path.join(dir, '.gitignore'), ['*.tgz', '!vendor/*.tgz', 'docs/audits/', ''].join('\n'));
  const tracked = stageFixture(dir, { addRetiredArchive: false });
  // The status view cannot see the loss: the ignored archive is not listed.
  const statusLines = git(dir, ['status', '--short', '-uall']).stdout.split('\n').filter(Boolean);
  assert.equal(
    statusLines.some((line) => line.includes('old.tgz')),
    false,
    'the fixture must hide the archive from status for this case to be meaningful',
  );
  assert.equal(tracked, 4);
  const run = runGate(dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /INVENTORY FAIL/);
  assert.match(run.stderr, /retired\/x\/y\/old\.tgz/);
  assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventory gate: present-but-ignored outside the declaration turns it red', () => {
  const dir = makeFixture();
  write(path.join(dir, '.gitignore'), ['*.tgz', '!vendor/*.tgz', '!retired/**/*.tgz', 'docs/audits/', '*.bin', ''].join('\n'));
  write(path.join(dir, 'scratch.bin'), 'unexpected artifact\n');
  stageFixture(dir);
  const run = runGate(dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /scratch\.bin/);
  assert.match(run.stderr, /present and ignored but is not declared/);
  assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventory gate: present-but-untracked outside the declaration turns it red', () => {
  const dir = makeFixture();
  write(path.join(dir, 'loose.txt'), 'never added\n');
  stageFixture(dir);
  const run = runGate(dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /loose\.txt/);
  assert.match(run.stderr, /present and untracked but is not declared/);
  assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventory gate: the declared file count is verified in both directions', () => {
  const dir = makeFixture();
  const count = stageFixture(dir);
  for (const lie of [count - 1, count + 1]) {
    writeManifest(dir, { tracked_count: lie });
    const run = runGate(dir);
    assert.equal(run.status, 1, `declared ${lie} against ${count} tracked must fail`);
    assert.match(run.stderr, /declared tracked_count=/);
    assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  }
  writeManifest(dir, { tracked_count: count });
  assert.equal(runGate(dir).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventory gate: the manifest cannot switch off the hard in-repository rule', () => {
  const dir = makeFixture();
  stageFixture(dir, { overrides: { must_track_globs: [] } });
  const run = runGate(dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /no longer declares the required in-repository glob/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventory gate: no caller-supplied inventory input exists (stub control)', () => {
  const dir = makeFixture();
  stageFixture(dir);
  const clean = path.join(path.dirname(dir), `fabricated-${path.basename(dir)}.json`);
  write(clean, '{"tracked_count":0}\n');
  for (const flag of ['--inventory', '--state', '--files']) {
    const run = runGate(dir, [flag, clean]);
    assert.equal(run.status, 2, `${flag} must be refused`);
    assert.match(run.stderr, /unknown argument/);
    assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  }
  fs.rmSync(clean, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inventory gate: entry guard runs the gate through a symlink instead of exiting silently', () => {
  const dir = makeFixture();
  stageFixture(dir);
  const linked = path.join(os.tmpdir(), `kdna-inventory-linked-${process.pid}.cjs`);
  fs.rmSync(linked, { force: true });
  fs.symlinkSync(gate, linked);
  const run = spawnSync(process.execPath, [linked, '--root', dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(linked, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
