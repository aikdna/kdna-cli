'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptSrc = path.join(__dirname, '..', 'scripts', 'check-release-prerelease-readiness.mjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-prerelease-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(scriptSrc, path.join(dir, 'scripts', 'check-release-prerelease-readiness.mjs'));
  const version = options.version ?? '0.1.0-rc.fixture';
  const pkg = {
    name: '@fixture/cli', version, license: 'Apache-2.0',
    scripts: {
      build: 'node -e "process.exit(0)"',
      check: 'node -e "process.exit(0)"',
      test: options.gateFail ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"',
    },
  };
  if (options.repoPrivate !== undefined) pkg.private = options.repoPrivate;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  const passing = 'const test = require(\'node:test\');\ntest(\'fixture passes\', () => {});\n';
  for (const name of ['cli-slice.test.js', 'surface-gate.test.js', 'prerelease-readiness.test.js']) fs.writeFileSync(path.join(dir, 'tests', name), passing);
  if (options.gateFail) {
    fs.writeFileSync(path.join(dir, 'tests', 'cli-slice.test.js'), 'const test = require(\'node:test\');\nconst assert = require(\'node:assert/strict\');\ntest(\'fixture fails\', () => { assert.equal(1, 2); });\n');
  }
  const packRoot = path.join(dir, 'packroot', 'package');
  fs.mkdirSync(path.join(packRoot, 'src'), { recursive: true });
  const inside = { name: pkg.name, version, license: 'Apache-2.0' };
  if (options.packedPrivate !== undefined) inside.private = options.packedPrivate;
  if (options.depSpec !== undefined) inside.dependencies = { '@fixture/core': options.depSpec };
  fs.writeFileSync(path.join(packRoot, 'package.json'), JSON.stringify(inside, null, 2) + '\n');
  const memberFile = options.namingHit ? 'v2-thing.js' : 'cli.js';
  fs.writeFileSync(path.join(packRoot, 'src', memberFile), '// fixture\n');
  fs.writeFileSync(path.join(packRoot, 'LICENSE'), 'Apache-2.0\n');
  const tgz = path.join(dir, 'fixture.tgz');
  const tar = spawnSync('/usr/bin/tar', ['-czf', tgz, '-C', path.join(dir, 'packroot'), 'package/package.json', `package/src/${memberFile}`, 'package/LICENSE']);
  assert.equal(tar.status, 0);
  const member = { name: pkg.name, version, tgz, member_count: 3 };
  member.sha256 = options.shaMismatch ? '0'.repeat(64) : sha256(fs.readFileSync(tgz));
  const candidate = { format: 'kdna.prerelease-candidate/1', label: 'fixture', dist_tag: options.distTag ?? 'r2.7', members: [member] };
  const candidatePath = path.join(dir, 'candidate.json');
  fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2) + '\n');
  const run = extra => {
    const args = [path.join(dir, 'scripts', 'check-release-prerelease-readiness.mjs'), '--label=fixture', `--candidate=${candidatePath}`, ...extra];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: dir, timeout: 120000 });
    assert.equal(result.error, undefined);
    return { status: result.status, report: result.stdout ? JSON.parse(result.stdout) : null };
  };
  return { dir, run };
}

test('prerelease preflight: absent required arguments exit 64', () => {
  const { run } = fixture();
  const r = run([]);
  assert.equal(r.status, 64);
  assert.equal(r.report, null);
});

test('prerelease preflight: an empty naming bind fails closed', () => {
  const { run } = fixture();
  const r = run(['--naming-bind= ']);
  assert.equal(r.status, 1);
  assert.ok(r.report.failures.some(f => f.id === 'NAMING_BIND_MISSING'));
});

test('prerelease preflight: a clean candidate passes and states the candidate-domain naming scope', () => {
  const { run } = fixture();
  const r = run(['--naming-bind=fixture@0.1.0-rc.fixture']);
  assert.equal(r.status, 0);
  assert.equal(r.report.exit_code, 0);
  assert.match(r.report.naming_scope, /候选域子集/);
});

test('prerelease preflight: a latest dist-tag is forbidden', () => {
  const { run } = fixture({ distTag: 'latest' });
  const r = run(['--naming-bind=x-y']);
  assert.equal(r.status, 1);
  assert.ok(r.report.failures.some(f => f.id === 'DIST_TAG_LATEST_FORBIDDEN'));
});

test('prerelease preflight: a packed private manifest is refused head-on', () => {
  const { run } = fixture({ packedPrivate: true });
  const r = run(['--naming-bind=x-y']);
  assert.equal(r.status, 1);
  assert.ok(r.report.failures.some(f => f.id === 'PACKED_PRIVATE_PRESENT'));
});

test('prerelease preflight: file: and non-exact dependency specifiers are refused', () => {
  const file = fixture({ depSpec: 'file:../core' });
  const rf = file.run(['--naming-bind=x-y']);
  assert.equal(rf.status, 1);
  assert.ok(rf.report.failures.some(f => f.id === 'DEP_FILE_SPECIFIER_FORBIDDEN'));
  const range = fixture({ depSpec: '^1.0.0' });
  const rr = range.run(['--naming-bind=x-y']);
  assert.equal(rr.status, 1);
  assert.ok(rr.report.failures.some(f => f.id === 'DEP_SPEC_NOT_EXACT'));
});

test('prerelease preflight: the candidate-domain naming subset flags vN tokens', () => {
  const { run } = fixture({ namingHit: true });
  const r = run(['--naming-bind=x-y']);
  assert.equal(r.status, 1);
  assert.ok(r.report.failures.some(f => f.id === 'NAMING_SUBSET_HIT'));
});

test('prerelease preflight: a member sha mismatch stops the run', () => {
  const { run } = fixture({ shaMismatch: true });
  const r = run(['--naming-bind=x-y']);
  assert.equal(r.status, 1);
  assert.ok(r.report.failures.some(f => f.id === 'MEMBER_SHA_MISMATCH'));
});

test('prerelease preflight: a repository gate failure is recorded raw', () => {
  const { run } = fixture({ gateFail: true });
  const r = run(['--naming-bind=x-y']);
  assert.equal(r.status, 1);
  const failure = r.report.failures.find(f => f.id === 'REPO_GATES_FAILED');
  assert.ok(failure);
  assert.match(failure.detail.command, /--test tests\/cli-slice\.test\.js/);
});

test('prerelease preflight: unknown flags are refused', () => {
  const { run } = fixture();
  const r = run(['--naming-bind=x-y', '--bogus=1']);
  assert.equal(r.status, 1);
  assert.ok(r.report.failures.some(f => f.id === 'ARGUMENT_INVALID'));
});
