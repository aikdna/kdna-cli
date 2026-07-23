'use strict';

const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const COMMAND_POLICY = require('../release-surface/cli-command-allowlist.json');
const FILE_POLICY = require('../release-surface/npm-file-allowlist.json');
const { resolveTrustedNpmInvocation } = require('../scripts/runtime-candidate-binding');
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kdna-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('command allowlist is unique and exactly matches the callable router', () => {
  const commands = COMMAND_POLICY.commands.map((entry) => entry.command);
  assert.equal(new Set(commands).size, commands.length);
  for (const command of commands) {
    const result =
      command === 'help' || command === 'version' ? runCli([command]) : runCli([command]);
    assert.doesNotMatch(
      result.stderr,
      /command is not in the approved allowlist/u,
      `${command} must be routed`,
    );
  }
});

test('every retired command is rejected through one stable fail-closed path', () => {
  const forbidden = [
    'available',
    'asset-evidence',
    'badge',
    'capsule-verify',
    'changelog',
    'cluster',
    'compose',
    'compose-review-workbook',
    'doctor',
    'domain',
    'eval',
    'eval-consumption',
    'explain',
    'governance',
    'history',
    'identity',
    'install',
    'legacy',
    'license',
    'lint',
    'list',
    'match',
    'plan-use',
    'project',
    'protect',
    'protocol',
    'publish',
    'quality',
    'registry',
    'route',
    'search',
    'setup',
    'studio',
    'test',
    'trace',
    'update',
    'use',
    'workpack',
  ];
  for (const command of forbidden) {
    const result = runCli([command]);
    assert.equal(result.status, COMMAND_POLICY.rejection.exit_code, command);
    assert.equal(result.stderr, `${COMMAND_POLICY.rejection.stderr_prefix} ${command}\n`, command);
    assert.equal(result.stdout, '', command);
  }
});

test('npm dry-run file set exactly equals the approved package file allowlist', () => {
  const npm = resolveTrustedNpmInvocation(ROOT);
  try {
    const result = spawnSync(
      npm.command,
      [...npm.prefixArgs, 'pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: ROOT,
        env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const actual = report[0].files.map((entry) => entry.path).sort();
    const expected = [...FILE_POLICY.files].sort();
    assert.deepEqual(actual, expected);
  } finally {
    npm.dispose();
  }
});

test('package manifest has one bin and no evaluation dependency', () => {
  const manifest = require('../package.json');
  assert.deepEqual(manifest.bin, { kdna: 'src/cli.js' });
  assert.deepEqual(manifest.dependencies, {
    '@aikdna/kdna-core': '0.21.0',
    'cbor-x': '1.6.4',
  });
  assert.equal(manifest.optionalDependencies, undefined);
});

test('every packaged local require stays inside the file allowlist', () => {
  const approved = new Set(FILE_POLICY.files);
  const javascript = FILE_POLICY.files.filter((file) => file.endsWith('.js'));
  for (const relative of javascript) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    const requires = source.matchAll(/require\((['"])(\.[^'"]+)\1\)/gu);
    for (const match of requires) {
      const base = path.resolve(ROOT, path.dirname(relative), match[2]);
      const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
      const resolved = candidates.find((candidate) => fs.existsSync(candidate));
      assert.ok(resolved, `${relative} has unresolved local require ${match[2]}`);
      const requiredRelative = path.relative(ROOT, resolved).split(path.sep).join('/');
      assert.ok(
        approved.has(requiredRelative),
        `${relative} escapes package allowlist through ${requiredRelative}`,
      );
    }
  }
});

test('package file set excludes retired experiments, global asset paths, and adapters', () => {
  const serialized = FILE_POLICY.files.join('\n');
  for (const forbidden of [
    'validators/',
    'templates/',
    'skills/',
    'schema/',
    'src/package-store.js',
    'src/registry.js',
    'src/install.js',
    'src/setup.js',
    'src/cmds/eval',
    'src/cmds/cluster',
    'src/cmds/compose',
    'src/cmds/legacy',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }
});

test('ordinary explicit-file command does not discover or mutate a user-global asset directory', () => {
  const root = temporaryRoot('no-global-asset-discovery');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  const unrelated = path.join(home, 'store', 'unrelated-name');
  fs.mkdirSync(unrelated, { recursive: true });
  fs.cpSync(path.join(ROOT, 'fixtures', 'minimal'), unrelated, { recursive: true });
  fs.mkdirSync(cwd);
  const before = fs.readdirSync(home, { recursive: true }).sort();

  const result = runCli(['inspect', 'unrelated-name'], {
    cwd,
    env: { KDNA_HOME: home },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /File not found/u);
  assert.deepEqual(fs.readdirSync(home, { recursive: true }).sort(), before);
});
