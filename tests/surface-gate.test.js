'use strict';
/*
 * Permanent reverse cases for scripts/check-surface.cjs.
 *
 * The gate was correct but absent from the local chain: `npm test` ran only
 * `node --test tests/*.test.js`, so a clean clone was green while the surface
 * gate had never been executed. These cases keep both halves honest — the gate
 * still bites on a mutated tree, and the success line is never printed when it
 * is red.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const gate = path.join(repoRoot, 'scripts', 'check-surface.cjs');
const SUCCESS_LINE = 'Current CLI source/package allowlist MATCH';

function runGate(root, extraArgs = []) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'check-surface.cjs'), ...extraArgs], {
    encoding: 'utf8',
  });
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

// A faithful copy of the surface inputs only; no .git, no node_modules.
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-surface-gate-'));
  for (const rel of ['package.json', 'release-surface', 'src', 'scripts']) {
    fs.cpSync(path.join(repoRoot, rel), path.join(dir, rel), { recursive: true });
  }
  return dir;
}

test('surface gate: the live repository is green and prints the success line', () => {
  const run = runGate(repoRoot);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(SUCCESS_LINE));
});

test('surface gate: an extra source module turns it red with no success line', () => {
  const dir = makeFixture();
  write(path.join(dir, 'src', 'extra-module.js'), 'module.exports = 1;\n');
  const run = runGate(dir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /extra-module\.js/);
  assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('surface gate: a non-empty retired source directory turns it red', () => {
  const dir = makeFixture();
  write(path.join(dir, 'src', 'cmds', 'rogue.js'), 'module.exports = 1;\n');
  const run = runGate(dir);
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('surface gate: a package allowlist that disagrees with package.json turns it red', () => {
  const dir = makeFixture();
  const allowlistPath = path.join(dir, 'release-surface', 'npm-file-allowlist.json');
  const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
  allowlist.files = [...allowlist.files, 'src/not-in-the-manifest.js'];
  write(allowlistPath, JSON.stringify(allowlist, null, 2) + '\n');
  const run = runGate(dir);
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('surface gate: a mutated package.json export surface turns it red', () => {
  const dir = makeFixture();
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.private = false;
  write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const run = runGate(dir);
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('surface gate: a packed-file report that cannot be read turns it red (stub control)', () => {
  const dir = makeFixture();
  const missing = path.join(dir, 'not-a-pack-report.json');
  const run = runGate(dir, [missing]);
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('surface gate: entry guard runs the gate through a symlink instead of exiting silently', () => {
  const linked = path.join(os.tmpdir(), `kdna-surface-linked-${process.pid}.cjs`);
  fs.rmSync(linked, { force: true });
  fs.symlinkSync(gate, linked);
  const run = spawnSync(process.execPath, [linked], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(SUCCESS_LINE));
  fs.rmSync(linked, { force: true });
});
