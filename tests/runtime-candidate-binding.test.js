'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test } = require('node:test');
const {
  BINDING_PATH,
  STRICT_PACKAGE_INSTALL_EQUIVALENCE,
  assertPackageTarInstallEquivalent,
  assertRegistryReleaseReady,
  canonicalRegistryUrl,
  readTarFileEntries,
  resolveTrustedNpmInvocation,
  strictRegistryLookup,
  verifyCandidateBinding,
  verifyInstalledAikdnaGraph,
} = require('../scripts/runtime-candidate-binding');
const {
  CORE_CANDIDATE_EVIDENCE_PATH,
  CORE_CANDIDATE_WORKFLOW_PATH,
} = require('../scripts/core-candidate');
const {
  assertCheckedArtifactIntegrity,
  sha512Integrity,
} = require('../scripts/verify-core-candidate-tar');
const {
  coreSourcePackArguments,
  inspectCoreSourceAuthority,
  materializeCoreCommitPackage,
  readCoreCommitFile,
} = require('../scripts/core-source-authority');
const {
  assertEvidenceDocument,
  assertSourceFactsUnchanged,
  sourceFileHashes,
} = require('../scripts/generate-core-candidate-evidence');
const {
  gitNullDevice,
  materializeTrustedCommit,
  readTrustedCommitTree,
  trustedGitEnvironment,
} = require('../scripts/trusted-git');

const ROOT = path.resolve(__dirname, '..');
const CORE = '@aikdna/kdna-core';
const EVAL = '@aikdna/kdna-eval';

function copyFixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, path.dirname(BINDING_PATH)), { recursive: true });
  for (const file of [
    'package.json',
    'package-lock.json',
    BINDING_PATH,
    CORE_CANDIDATE_EVIDENCE_PATH,
    CORE_CANDIDATE_WORKFLOW_PATH,
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  const binding = JSON.parse(fs.readFileSync(path.join(root, BINDING_PATH), 'utf8'));
  for (const entry of binding.packages) {
    fs.copyFileSync(path.join(ROOT, entry.artifact), path.join(root, entry.artifact));
  }
  return root;
}

function mutateJson(root, relativePath, mutation) {
  const target = path.join(root, relativePath);
  const value = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutation(value);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeInstalledPackage(root, installPath, name, version) {
  const directory = path.join(root, 'node_modules', ...installPath.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name, version }, null, 2)}\n`,
  );
  return directory;
}

function createCanonicalInstalledGraph(root) {
  writeInstalledPackage(root, CORE, CORE, '0.19.0');
  writeInstalledPackage(root, EVAL, EVAL, '0.3.1');
}

function git(repository, args) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: trustedGitEnvironment(),
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function gitBuffer(repository, args, input) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: 'buffer',
    env: trustedGitEnvironment(),
    input,
    shell: false,
  });
  assert.equal(result.status, 0, (result.stderr || result.stdout).toString('utf8'));
  return result.stdout;
}

function createCoreSourceFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-core-source-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  const packageRoot = path.join(repository, 'packages', 'kdna-core');
  fs.mkdirSync(packageRoot, { recursive: true });
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.email', 'test@example.invalid']);
  git(repository, ['config', 'user.name', 'KDNA Test']);
  fs.writeFileSync(path.join(repository, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: CORE, version: '0.19.0' }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(packageRoot, 'index.js'), "'use strict';\n");
  git(repository, ['add', '--all']);
  git(repository, ['commit', '--quiet', '-m', 'test: source authority fixture']);
  return { root, repository, packageRoot, head: git(repository, ['rev-parse', 'HEAD']) };
}

function rewriteTarChecksum(header) {
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
}

function writeTarOctal(header, offset, length, value) {
  header.fill(0, offset, offset + length);
  Buffer.from(`${value.toString(8).padStart(length - 1, '0')}\0`).copy(header, offset);
}

function tarEntryOffsets(archive) {
  const offsets = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeField = header.subarray(124, 136);
    const end = sizeField.indexOf(0);
    const size = Number.parseInt(
      sizeField
        .subarray(0, end < 0 ? sizeField.length : end)
        .toString('ascii')
        .trim(),
      8,
    );
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    offsets.push({ body: offset + 512, header: offset, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return offsets;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

test('trusted Git uses a Git-compatible null config device and still scrubs every Git input', () => {
  assert.equal(gitNullDevice('win32'), 'NUL');
  assert.equal(gitNullDevice('linux'), '/dev/null');
  assert.equal(gitNullDevice('darwin'), '/dev/null');

  const source = {
    PATH: '/trusted/bin',
    GIT_DIR: '/hostile/repository',
    GIT_CONFIG_GLOBAL: '/hostile/global-config',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.useReplaceRefs',
    GIT_CONFIG_VALUE_0: 'true',
  };
  for (const [platform, expected] of [
    ['win32', 'NUL'],
    ['linux', '/dev/null'],
  ]) {
    const environment = trustedGitEnvironment(source, { platform });
    assert.equal(environment.PATH, source.PATH);
    assert.equal(environment.GIT_CONFIG_GLOBAL, expected);
    assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(environment.GIT_NO_REPLACE_OBJECTS, '1');
    assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
    assert.equal(environment.GIT_DIR, undefined);
    assert.equal(environment.GIT_CONFIG_COUNT, undefined);
    assert.equal(environment.GIT_CONFIG_KEY_0, undefined);
    assert.equal(environment.GIT_CONFIG_VALUE_0, undefined);
  }
});

test('default install binds one exact Core candidate while published Eval stays canonical', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  const binding = verifyCandidateBinding(ROOT);
  assert.equal(pkg.dependencies[CORE], '0.19.0');
  assert.equal(lock.packages[''].dependencies[CORE], '0.19.0');
  assert.equal(lock.packages[`node_modules/${CORE}`].version, '0.19.0');
  assert.equal(
    lock.packages[`node_modules/${CORE}`].resolved,
    `file:${binding.packages[0].artifact}`,
  );
  assert.equal(
    lock.packages[`node_modules/${EVAL}`].resolved,
    canonicalRegistryUrl(EVAL, pkg.dependencies[EVAL]),
  );
  assert.equal(require('@aikdna/kdna-core/package.json').version, '0.19.0');
  assert.deepEqual(verifyInstalledAikdnaGraph(ROOT), {
    [CORE]: '0.19.0',
    [EVAL]: '0.3.1',
  });
});

test('candidate-bound release gate blocks before registry lookup', () => {
  let lookups = 0;
  assert.throws(
    () =>
      assertRegistryReleaseReady(ROOT, () => {
        lookups += 1;
        throw new Error('registry lookup must not run');
      }),
    /still candidate-bound/,
  );
  assert.equal(lookups, 0);
});

test('registry release gate checks exact package identity, version, and integrity', (t) => {
  const root = copyFixtureRoot(t);
  const binding = verifyCandidateBinding(root);
  const entry = binding.packages[0];
  mutateJson(root, 'package-lock.json', (lock) => {
    lock.packages[`node_modules/${CORE}`].resolved = canonicalRegistryUrl(CORE, entry.version);
  });

  let calls = 0;
  assert.doesNotThrow(() =>
    assertRegistryReleaseReady(root, (name, version) => {
      calls += 1;
      return { name, version, 'dist.integrity': entry.integrity };
    }),
  );
  assert.equal(calls, 1);
  for (const [field, value, pattern] of [
    ['name', '@aikdna/not-core', /registry package name mismatch/],
    ['version', '0.19.1', /registry package version mismatch/],
    [
      'dist.integrity',
      `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      /registry integrity mismatch/,
    ],
  ]) {
    assert.throws(
      () =>
        assertRegistryReleaseReady(root, () => ({
          name: entry.name,
          version: entry.version,
          'dist.integrity': entry.integrity,
          [field]: value,
        })),
      pattern,
    );
  }
});

test('registry dependency lookup uses one trusted client and fixed exact arguments', () => {
  const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
  const npmExecPath = path.join(os.tmpdir(), 'verified-npm', 'bin', 'npm-cli.js');
  const invocation = { command: process.execPath, prefixArgs: [npmExecPath] };
  let observed;
  const validResult = {
    status: 0,
    signal: null,
    stdout: JSON.stringify({ name: CORE, version: '0.19.0', 'dist.integrity': integrity }),
    stderr: '',
  };
  const lookup = (result = validResult) =>
    strictRegistryLookup(CORE, '0.19.0', {
      root: ROOT,
      invocation,
      runner: (command, args, options) => {
        observed = { command, args, options };
        return result;
      },
    });
  const metadata = lookup();
  assert.equal(metadata.name, CORE);
  assert.equal(observed.command, process.execPath);
  assert.equal(observed.args[0], npmExecPath);
  assert.ok(observed.args.includes('--registry=https://registry.npmjs.org/'));
  assert.ok(observed.args.includes('--@aikdna:registry=https://registry.npmjs.org/'));
  assert.ok(observed.args.includes('--loglevel=silent'));
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.timeout, 30_000);

  for (const [mutation, pattern] of [
    [(result) => ({ ...result, status: 1 }), /not successful/],
    [(result) => ({ ...result, signal: 'SIGTERM' }), /not successful/],
    [(result) => ({ ...result, error: new Error('provider details') }), /lookup failed/],
    [(result) => ({ ...result, stderr: 'warning\n' }), /unexpected stderr/],
    [(result) => ({ ...result, stdout: `${result.stdout}\ntrailing` }), /complete JSON document/],
    [(result) => ({ ...result, stdout: '[]' }), /must be an object/],
    [
      (result) => ({
        ...result,
        stdout: JSON.stringify({
          name: CORE,
          version: '0.19.0',
          'dist.integrity': integrity,
          extra: true,
        }),
      }),
      /fields are not exact/,
    ],
  ]) {
    assert.throws(() => lookup(mutation(validResult)), pattern);
  }
});

test('trusted npm invocation rejects self-reported clients and copied candidate tar bytes', () => {
  const fakeNpm = Buffer.from(
    `${JSON.stringify({ name: 'npm', version: '11.17.0' })}\ncopy candidate tar`,
  );
  const binding = verifyCandidateBinding(ROOT);
  const copiedCandidateTar = fs.readFileSync(path.join(ROOT, binding.packages[0].artifact));
  for (const archiveBytes of [fakeNpm, copiedCandidateTar]) {
    assert.throws(
      () =>
        resolveTrustedNpmInvocation(ROOT, {
          archiveBytes,
          npmExecPath: '/tmp/fake/npm-cli.js',
        }),
      /archive integrity mismatch/,
    );
  }
  assert.equal(
    fs
      .readFileSync(path.join(ROOT, 'scripts/runtime-candidate-binding.js'), 'utf8')
      .includes('npm_execpath'),
    false,
  );
});

test('source pack arguments disable lifecycle scripts and pin both registries', () => {
  assert.deepEqual(coreSourcePackArguments('/tmp/output'), [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    '/tmp/output',
    '--registry=https://registry.npmjs.org/',
    '--@aikdna:registry=https://registry.npmjs.org/',
  ]);
});

test('Core source authority rejects wrong roots, links, and hidden index state', async (t) => {
  await t.test('canonical clean source', (t) => {
    const fixture = createCoreSourceFixture(t);
    const authority = inspectCoreSourceAuthority(fixture.packageRoot, fixture.head);
    assert.equal(authority.repository, fixture.repository);
    assert.equal(authority.packageRoot, fixture.packageRoot);
    assert.equal(authority.head, fixture.head);
  });

  await t.test('autocrlf-normalized CRLF checkout is clean but substantive drift blocks', (t) => {
    const fixture = createCoreSourceFixture(t);
    for (const file of ['package.json', 'index.js']) {
      const target = path.join(fixture.packageRoot, file);
      fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll('\n', '\r\n'));
    }
    assert.notEqual(
      git(fixture.repository, ['status', '--porcelain', '--untracked-files=all']),
      '',
    );
    assert.doesNotThrow(() => inspectCoreSourceAuthority(fixture.packageRoot, fixture.head));

    fs.writeFileSync(
      path.join(fixture.packageRoot, 'index.js'),
      "'use strict';\r\nmodule.exports = 'substantive-drift';\r\n",
    );
    assert.throws(
      () => inspectCoreSourceAuthority(fixture.packageRoot, fixture.head),
      /worktree must be clean/,
    );
  });

  await t.test('clean CRLF checkout uses exact commit blobs for content authority', (t) => {
    const fixture = createCoreSourceFixture(t);
    fs.writeFileSync(
      path.join(fixture.repository, '.gitattributes'),
      [
        'packages/kdna-core/package.json text eol=crlf',
        'packages/kdna-core/index.js text eol=crlf',
        '',
      ].join('\n'),
    );
    git(fixture.repository, ['add', '.gitattributes']);
    git(fixture.repository, ['commit', '--quiet', '-m', 'test: CRLF checkout policy']);
    const head = git(fixture.repository, ['rev-parse', 'HEAD']);
    fs.rmSync(fixture.packageRoot, { recursive: true, force: true });
    git(fixture.repository, ['checkout', 'HEAD', '--', 'packages/kdna-core']);
    assert.equal(git(fixture.repository, ['status', '--porcelain', '--untracked-files=all']), '');

    const checkoutPackage = fs.readFileSync(path.join(fixture.packageRoot, 'package.json'));
    const checkoutIndex = fs.readFileSync(path.join(fixture.packageRoot, 'index.js'));
    assert.ok(checkoutPackage.includes(Buffer.from('\r\n')));
    assert.ok(checkoutIndex.includes(Buffer.from('\r\n')));

    const authority = inspectCoreSourceAuthority(fixture.packageRoot, head);
    const commitPackage = readCoreCommitFile(authority, 'package.json');
    const commitIndex = readCoreCommitFile(authority, 'index.js');
    assert.equal(commitPackage.includes(Buffer.from('\r\n')), false);
    assert.equal(commitIndex.includes(Buffer.from('\r\n')), false);
    assert.equal(authority.packageJson.name, CORE);
    assert.deepEqual(sourceFileHashes(authority, ['index.js']), {
      'index.js': crypto.createHash('sha256').update(commitIndex).digest('hex'),
    });
    assert.notEqual(
      sourceFileHashes(authority, ['index.js'])['index.js'],
      crypto.createHash('sha256').update(checkoutIndex).digest('hex'),
    );
  });

  await t.test('dirty tracked file', (t) => {
    const fixture = createCoreSourceFixture(t);
    fs.appendFileSync(path.join(fixture.packageRoot, 'index.js'), 'dirty\n');
    assert.throws(
      () => inspectCoreSourceAuthority(fixture.packageRoot, fixture.head),
      /worktree must be clean/,
    );
  });

  await t.test('ignored wrong root', (t) => {
    const fixture = createCoreSourceFixture(t);
    const wrongRoot = path.join(fixture.repository, 'ignored', 'packages', 'kdna-core');
    fs.mkdirSync(wrongRoot, { recursive: true });
    fs.writeFileSync(
      path.join(wrongRoot, 'package.json'),
      `${JSON.stringify({ name: CORE, version: '0.19.0' })}\n`,
    );
    assert.throws(
      () => inspectCoreSourceAuthority(wrongRoot, fixture.head),
      /package root must be exactly packages\/kdna-core/,
    );
  });

  await t.test('canonical package symlink', (t) => {
    const fixture = createCoreSourceFixture(t);
    const backing = path.join(fixture.root, 'package-backing');
    fs.renameSync(fixture.packageRoot, backing);
    fs.symlinkSync(backing, fixture.packageRoot, 'dir');
    assert.throws(
      () => inspectCoreSourceAuthority(fixture.packageRoot, fixture.head),
      /regular non-symlink directory/,
    );
  });

  await t.test('tracked file hard link', (t) => {
    const fixture = createCoreSourceFixture(t);
    fs.linkSync(
      path.join(fixture.packageRoot, 'package.json'),
      path.join(fixture.root, 'hardlink'),
    );
    assert.throws(
      () => inspectCoreSourceAuthority(fixture.packageRoot, fixture.head),
      /must have one hard link/,
    );
  });

  for (const [name, flag, undo] of [
    ['assume unchanged', '--assume-unchanged', '--no-assume-unchanged'],
    ['skip worktree', '--skip-worktree', '--no-skip-worktree'],
  ]) {
    await t.test(name, (t) => {
      const fixture = createCoreSourceFixture(t);
      const tracked = 'packages/kdna-core/package.json';
      git(fixture.repository, ['update-index', flag, tracked]);
      assert.throws(
        () => inspectCoreSourceAuthority(fixture.packageRoot, fixture.head),
        /hidden or non-ordinary state/,
      );
      git(fixture.repository, ['update-index', undo, tracked]);
    });
  }

  await t.test('Git replace ref', (t) => {
    const fixture = createCoreSourceFixture(t);
    const original = fs.readFileSync(path.join(fixture.packageRoot, 'index.js'));
    fs.writeFileSync(
      path.join(fixture.packageRoot, 'index.js'),
      "'use strict';\nmodule.exports = 'replaced';\n",
    );
    git(fixture.repository, ['add', 'packages/kdna-core/index.js']);
    git(fixture.repository, ['commit', '--quiet', '-m', 'test: replacement commit']);
    const replacement = git(fixture.repository, ['rev-parse', 'HEAD']);
    git(fixture.repository, ['checkout', '--quiet', '--detach', fixture.head]);
    const authority = inspectCoreSourceAuthority(fixture.packageRoot, fixture.head);

    const isolated = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-replace-proof-')),
    );
    t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
    materializeCoreCommitPackage(authority, isolated);
    assert.ok(original.equals(fs.readFileSync(path.join(isolated, 'index.js'))));
    git(fixture.repository, ['replace', fixture.head, replacement]);
    const rejected = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-replace-rejected-')),
    );
    t.after(() => fs.rmSync(rejected, { recursive: true, force: true }));
    assert.throws(
      () => materializeCoreCommitPackage(authority, rejected),
      /must not contain Git replace refs/,
    );
    assert.throws(
      () => inspectCoreSourceAuthority(fixture.packageRoot, fixture.head),
      /must not contain Git replace refs/,
    );
  });

  await t.test('hostile Git environment', (t) => {
    const fixture = createCoreSourceFixture(t);
    const poison = path.join(fixture.root, 'hostile-git-environment');
    const variables = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(poison, 'alternate-objects'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_GLOBAL: path.join(poison, 'global-config'),
      GIT_CONFIG_KEY_0: 'core.useReplaceRefs',
      GIT_CONFIG_SYSTEM: path.join(poison, 'system-config'),
      GIT_CONFIG_VALUE_0: 'true',
      GIT_DIR: path.join(poison, '.git'),
      GIT_INDEX_FILE: path.join(poison, 'index'),
      GIT_OBJECT_DIRECTORY: path.join(poison, 'objects'),
      GIT_WORK_TREE: poison,
    };
    const previous = new Map(Object.keys(variables).map((name) => [name, process.env[name]]));
    Object.assign(process.env, variables);
    try {
      const authority = inspectCoreSourceAuthority(fixture.packageRoot, fixture.head);
      const isolated = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-git-env-proof-')),
      );
      t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
      materializeCoreCommitPackage(authority, isolated);
      assert.equal(
        fs.readFileSync(path.join(isolated, 'package.json'), 'utf8'),
        fs.readFileSync(path.join(fixture.packageRoot, 'package.json'), 'utf8'),
      );
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

test('trusted Git commit reader rejects links and invalid tree paths', async (t) => {
  await t.test('symbolic link', (t) => {
    const fixture = createCoreSourceFixture(t);
    fs.symlinkSync('package.json', path.join(fixture.packageRoot, 'linked.json'));
    git(fixture.repository, ['add', '--all']);
    git(fixture.repository, ['commit', '--quiet', '-m', 'test: symlink tree']);
    const commit = git(fixture.repository, ['rev-parse', 'HEAD']);
    const destination = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-trusted-tree-link-')),
    );
    t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
    assert.throws(
      () => materializeTrustedCommit(fixture.repository, commit, destination),
      /non-regular entry/,
    );
  });

  await t.test('gitlink', (t) => {
    const fixture = createCoreSourceFixture(t);
    git(fixture.repository, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${fixture.head},nested-repository`,
    ]);
    git(fixture.repository, ['commit', '--quiet', '-m', 'test: gitlink tree']);
    const commit = git(fixture.repository, ['rev-parse', 'HEAD']);
    assert.throws(() => readTrustedCommitTree(fixture.repository, commit), /non-blob entry/);
  });

  await t.test('backslash path', (t) => {
    const fixture = createCoreSourceFixture(t);
    fs.writeFileSync(path.join(fixture.repository, 'invalid\\path'), 'invalid\n');
    git(fixture.repository, ['add', '--all']);
    git(fixture.repository, ['commit', '--quiet', '-m', 'test: invalid tree path']);
    const commit = git(fixture.repository, ['rev-parse', 'HEAD']);
    assert.throws(() => readTrustedCommitTree(fixture.repository, commit), /path is invalid/);
  });

  await t.test('invalid UTF-8 path', (t) => {
    const fixture = createCoreSourceFixture(t);
    const blob = git(fixture.repository, [
      'rev-parse',
      `${fixture.head}:packages/kdna-core/package.json`,
    ]);
    const treeInput = Buffer.concat([
      Buffer.from(`100644 blob ${blob}\tinvalid-`),
      Buffer.from([0xff, 0]),
    ]);
    const tree = gitBuffer(fixture.repository, ['mktree', '-z'], treeInput)
      .toString('ascii')
      .trim();
    const commit = gitBuffer(
      fixture.repository,
      ['commit-tree', tree, '-m', 'test: invalid UTF-8 tree'],
      Buffer.alloc(0),
    )
      .toString('ascii')
      .trim();
    assert.throws(() => readTrustedCommitTree(fixture.repository, commit), /invalid UTF-8/);
  });
});

test('portable candidate tar reader rejects corrupted headers and hostile paths', (t) => {
  const binding = verifyCandidateBinding(ROOT);
  const artifact = path.join(ROOT, binding.packages[0].artifact);
  assert.equal(readTarFileEntries(artifact).length, 39);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-hostile-tar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = zlib.gunzipSync(fs.readFileSync(artifact));

  const corrupt = Buffer.from(archive);
  corrupt[0] ^= 1;
  const corruptPath = path.join(root, 'corrupt.tgz');
  fs.writeFileSync(corruptPath, zlib.gzipSync(corrupt));
  assert.throws(() => readTarFileEntries(corruptPath), /header checksum mismatch/);

  const traversal = Buffer.from(archive);
  traversal.fill(0, 0, 100);
  Buffer.from('../package.json').copy(traversal, 0);
  rewriteTarChecksum(traversal.subarray(0, 512));
  const traversalPath = path.join(root, 'traversal.tgz');
  fs.writeFileSync(traversalPath, zlib.gzipSync(traversal));
  assert.throws(() => readTarFileEntries(traversalPath), /entry path invalid/);
});

test('strict package install equivalence excludes only declared archive metadata', async (t) => {
  const binding = verifyCandidateBinding(ROOT);
  const entry = binding.packages[0];
  const artifact = fs.readFileSync(path.join(ROOT, entry.artifact));
  const archive = zlib.gunzipSync(artifact);
  const offsets = tarEntryOffsets(archive);
  assert.equal(offsets.length, 39);

  await t.test('gzip wrapper variance keeps lock authority on checked artifact bytes', () => {
    const wrapperVariant = zlib.gzipSync(archive, { level: 1 });
    assert.equal(wrapperVariant.equals(artifact), false);
    assert.notEqual(sha512Integrity(wrapperVariant), entry.integrity);
    assert.deepEqual(assertPackageTarInstallEquivalent(artifact, wrapperVariant), {
      ...STRICT_PACKAGE_INSTALL_EQUIVALENCE,
      entry_count: 39,
    });
    const locked = require('../package-lock.json').packages[`node_modules/${CORE}`];
    assert.equal(assertCheckedArtifactIntegrity(entry, locked, artifact), entry.integrity);
  });

  const metadataOnly = Buffer.from(archive);
  for (const { header } of offsets) {
    const block = metadataOnly.subarray(header, header + 512);
    writeTarOctal(block, 108, 8, 1);
    writeTarOctal(block, 116, 8, 2);
    writeTarOctal(block, 136, 12, 3);
    rewriteTarChecksum(block);
  }
  const metadataOnlyArtifact = zlib.gzipSync(metadataOnly, { level: 1 });
  assert.equal(metadataOnlyArtifact.equals(artifact), false);
  assert.deepEqual(assertPackageTarInstallEquivalent(artifact, metadataOnlyArtifact), {
    ...STRICT_PACKAGE_INSTALL_EQUIVALENCE,
    entry_count: 39,
  });

  const mutations = [
    {
      name: 'complete entry set',
      pattern: /complete entry set differs/,
      mutate(candidate) {
        const header = candidate.subarray(0, 512);
        header.fill(0, 0, 100);
        Buffer.from('package/renamed-entry').copy(header, 0);
        rewriteTarChecksum(header);
      },
    },
    {
      name: 'file mode',
      pattern: /file mode differs/,
      mutate(candidate) {
        const header = candidate.subarray(0, 512);
        writeTarOctal(header, 100, 8, 0o755);
        rewriteTarChecksum(header);
      },
    },
    {
      name: 'file bytes',
      pattern: /file bytes differ/,
      mutate(candidate) {
        candidate[offsets[0].body] ^= 1;
      },
    },
    {
      name: 'regular file type',
      pattern: /entry type is unsupported/,
      mutate(candidate) {
        const header = candidate.subarray(0, 512);
        header[156] = 50;
        rewriteTarChecksum(header);
      },
    },
  ];
  for (const mutation of mutations) {
    await t.test(mutation.name, () => {
      const candidate = Buffer.from(archive);
      mutation.mutate(candidate);
      assert.throws(
        () => assertPackageTarInstallEquivalent(artifact, zlib.gzipSync(candidate)),
        mutation.pattern,
      );
    });
  }
});

test('candidate pack evidence rejects source mutations between its two packs', () => {
  const before = {
    packageRoot: '/candidate/core',
    packageJson: { name: CORE, version: '0.19.0' },
    head: 'a'.repeat(40),
    files: { 'src/runtime-contract.js': 'b'.repeat(64) },
  };
  assert.doesNotThrow(() => assertSourceFactsUnchanged(before, cloneJson(before)));
  for (const mutation of [
    (after) => {
      after.head = 'c'.repeat(40);
    },
    (after) => {
      after.packageJson.version = '0.19.1';
    },
    (after) => {
      after.files['src/runtime-contract.js'] = 'd'.repeat(64);
    },
  ]) {
    const after = cloneJson(before);
    mutation(after);
    assert.throws(() => assertSourceFactsUnchanged(before, after), /changed during npm pack/);
  }
});

test('candidate evidence authority ignores formatting and blocks every semantic drift', () => {
  const expected = {
    evidence_kind: 'candidate_source_pack',
    package: CORE,
    version: '0.19.0',
    git_head: 'a'.repeat(40),
    pack: { status: 'strict', reproducible_runs: 2 },
    files: { 'src/runtime-contract.js': 'b'.repeat(64) },
  };
  const reordered = Object.fromEntries(Object.entries(expected).reverse());
  assert.deepEqual(assertEvidenceDocument(JSON.stringify(reordered), expected), reordered);

  for (const mutation of [
    (candidate) => {
      delete candidate.pack.reproducible_runs;
    },
    (candidate) => {
      candidate.extra = true;
    },
    (candidate) => {
      candidate.files['src/runtime-contract.js'] = 'c'.repeat(64);
    },
  ]) {
    const candidate = cloneJson(expected);
    mutation(candidate);
    assert.throws(
      () => assertEvidenceDocument(JSON.stringify(candidate, null, 4), expected),
      /Core candidate evidence is stale/,
    );
  }
  assert.throws(() => assertEvidenceDocument('{', expected), /must be one valid JSON document/);
});

test('binding completeness rejects omissions, extras, duplicate copies, and hostile lock paths', (t) => {
  const root = copyFixtureRoot(t);
  const tracked = [BINDING_PATH, 'package.json', 'package-lock.json'];
  const originals = new Map(tracked.map((file) => [file, fs.readFileSync(path.join(root, file))]));
  const reset = () => {
    for (const [file, bytes] of originals) fs.writeFileSync(path.join(root, file), bytes);
  };
  const rejects = (relativePath, mutation, pattern) => {
    reset();
    mutateJson(root, relativePath, mutation);
    assert.throws(() => verifyCandidateBinding(root), pattern);
  };

  assert.doesNotThrow(() => verifyCandidateBinding(root));
  rejects(
    BINDING_PATH,
    (binding) => {
      binding.packages = [];
    },
    /candidate binding is empty/,
  );
  rejects(
    BINDING_PATH,
    (binding) => {
      binding.packages.push({ ...binding.packages[0] });
    },
    /duplicate packages/,
  );
  rejects(
    BINDING_PATH,
    (binding) => {
      binding.packages[0].name = '@aikdna/unexpected-runtime';
    },
    /candidate binding package set mismatch|non-direct packages/,
  );
  rejects(
    BINDING_PATH,
    (binding) => {
      binding.packages[0].commit = 'b'.repeat(40);
    },
    /commit does not match the CI pin/,
  );
  rejects(
    BINDING_PATH,
    (binding) => {
      binding.packages[0].commit = binding.packages[0].commit.toUpperCase();
    },
    /commit audit reference invalid/,
  );
  rejects(
    BINDING_PATH,
    (binding) => {
      binding.packages.push({ ...binding.packages[0], name: EVAL });
    },
    /candidate binding package set mismatch|duplicate packages/,
  );
  for (const artifact of [
    'tests\\fixtures\\runtime-candidates\\kdna-core-0.19.0.tgz',
    'tests/fixtures/runtime-candidates//kdna-core-0.19.0.tgz',
    'tests/fixtures/runtime-candidates/./kdna-core-0.19.0.tgz',
    'tests/fixtures/runtime-candidates/%2e%2e.tgz',
    'tests/fixtures/runtime-candidates/KDNA-core-0.19.0.tgz',
  ]) {
    rejects(
      BINDING_PATH,
      (binding) => {
        binding.packages[0].artifact = artifact;
      },
      /candidate artifact path invalid/,
    );
  }
  rejects(
    'package-lock.json',
    (lock) => {
      delete lock.packages[''].dependencies[CORE];
    },
    /lock root AIKDNA dependencies package set mismatch.*kdna-core/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.dependencies = {
        'shadow-core': { version: 'npm:@aikdna/kdna-core@0.18.0' },
      };
    },
    /legacy top-level package lock dependencies are not permitted/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages[''].name = '@other/cli';
    },
    /package lock root identity mismatch/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/@aikdna/unbound-runtime'] = {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/@aikdna/unbound-runtime/-/unbound-runtime-1.0.0.tgz',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      };
    },
    /unbound AIKDNA lock package/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages[`node_modules/${EVAL}`].resolved = 'file:tests/fixtures/eval.tgz';
    },
    /unbound file lock package/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages[`node_modules/foreign/node_modules/${CORE}`] = {
        ...lock.packages[`node_modules/${CORE}`],
      };
    },
    /AIKDNA lock package must appear exactly once.*kdna-core.*count=2/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/foreign/node_modules/@aikdna%2fkdna-core'] = {
        version: '0.19.0',
      };
    },
    /AIKDNA lock package (?:path|name) invalid/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/foreign/node_modules/%2540aikdna%252fkdna-core'] = {
        version: '0.19.0',
      };
    },
    /AIKDNA lock package name invalid/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/foreign/node_modules/@AIKDNA/kdna-core'] = { version: '0.19.0' };
    },
    /AIKDNA lock package name invalid/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules\\foreign\\node_modules\\@aikdna\\kdna-core'] = {
        version: '0.19.0',
      };
    },
    /AIKDNA lock package path invalid/,
  );
});

test('full dependency graph rejects npm aliases and disguised AIKDNA package identities', (t) => {
  const root = copyFixtureRoot(t);
  const tracked = ['package.json', 'package-lock.json'];
  const originals = new Map(tracked.map((file) => [file, fs.readFileSync(path.join(root, file))]));
  const reset = () => {
    for (const [file, bytes] of originals) fs.writeFileSync(path.join(root, file), bytes);
  };
  const rejects = (relativePath, mutation, pattern = /AIKDNA/) => {
    reset();
    mutateJson(root, relativePath, mutation);
    assert.throws(() => verifyCandidateBinding(root), pattern);
  };
  const aliasSpecs = [
    'npm:@aikdna/kdna-core@0.18.0',
    'npm:@AIKDNA/kdna-core@0.18.0',
    'npm:@aikdna\\kdna-core@0.18.0',
    'npm:%40aikdna%2fkdna-core@0.18.0',
    'npm:%2540aikdna%252fkdna-core@0.18.0',
  ];

  for (const mapName of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ]) {
    for (const spec of aliasSpecs) {
      rejects(
        'package.json',
        (pkg) => {
          pkg[mapName] = { ...(pkg[mapName] || {}), 'shadow-core': spec };
        },
        /alias or encoded dependency spec/,
      );
      rejects(
        'package-lock.json',
        (lock) => {
          lock.packages[''][mapName] = {
            ...(lock.packages[''][mapName] || {}),
            'shadow-core': spec,
          };
        },
        /alias or encoded dependency spec/,
      );
    }
  }

  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/foreign'] = {
        version: '1.0.0',
        dependencies: { 'shadow-core': 'npm:@aikdna/kdna-core@0.18.0' },
      };
    },
    /lock package.*alias or encoded dependency spec/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/foreign'] = {
        version: '1.0.0',
        dependencies: { [CORE]: '0.18.0' },
      };
    },
    /AIKDNA dependency spec mismatch/,
  );
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/shadow-core'] = {
        name: CORE,
        version: '0.18.0',
        resolved: canonicalRegistryUrl(CORE, '0.18.0'),
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      };
    },
    /lock entry name\/path mismatch/,
  );
  for (const resolved of [
    canonicalRegistryUrl(CORE, '0.18.0'),
    'https://registry.npmjs.org/%40aikdna%2fkdna-core/-/kdna-core-0.18.0.tgz',
    'https://registry.npmjs.org/@AIKDNA/kdna-core/-/kdna-core-0.18.0.tgz',
  ]) {
    rejects(
      'package-lock.json',
      (lock) => {
        lock.packages['node_modules/shadow-core'] = {
          version: '0.18.0',
          resolved,
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        };
      },
      /lock resolution\/path mismatch|unbound AIKDNA lock resolution/,
    );
  }
  rejects(
    'package-lock.json',
    (lock) => {
      lock.packages['node_modules/%ZZ/node_modules/%40aikdna%2fkdna-core'] = {
        version: '0.18.0',
        resolved: 'https://example.invalid/shadow.tgz',
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      };
    },
    /AIKDNA lock package (?:path|name) invalid/,
  );
});

test('candidate authority rejects missing and non-regular binding or artifact paths', async (t) => {
  const artifactFor = (root) => {
    const binding = JSON.parse(fs.readFileSync(path.join(root, BINDING_PATH), 'utf8'));
    return path.join(root, binding.packages[0].artifact);
  };

  await t.test('missing artifact', (t) => {
    const root = copyFixtureRoot(t);
    fs.unlinkSync(artifactFor(root));
    assert.throws(() => verifyCandidateBinding(root), /candidate artifact.*is missing/);
  });
  await t.test('artifact directory', (t) => {
    const root = copyFixtureRoot(t);
    const artifact = artifactFor(root);
    fs.unlinkSync(artifact);
    fs.mkdirSync(artifact);
    assert.throws(() => verifyCandidateBinding(root), /regular non-symlink file/);
  });
  await t.test('artifact symlink outside candidate directory', (t) => {
    const root = copyFixtureRoot(t);
    const artifact = artifactFor(root);
    const outside = path.join(root, 'outside.tgz');
    fs.renameSync(artifact, outside);
    fs.symlinkSync(outside, artifact);
    assert.throws(() => verifyCandidateBinding(root), /regular non-symlink file/);
  });
  await t.test('artifact symlink inside candidate directory', (t) => {
    const root = copyFixtureRoot(t);
    const artifact = artifactFor(root);
    const sibling = path.join(path.dirname(artifact), 'sibling.tgz');
    fs.renameSync(artifact, sibling);
    fs.symlinkSync(sibling, artifact);
    assert.throws(() => verifyCandidateBinding(root), /regular non-symlink file/);
  });
  await t.test('artifact hard link', (t) => {
    const root = copyFixtureRoot(t);
    const artifact = artifactFor(root);
    fs.linkSync(artifact, path.join(root, 'outside-hardlink.tgz'));
    assert.throws(() => verifyCandidateBinding(root), /exactly one hard link/);
  });
  await t.test('artifact FIFO', (t) => {
    if (process.platform === 'win32') {
      t.skip('FIFO is not available on Windows');
      return;
    }
    const root = copyFixtureRoot(t);
    const artifact = artifactFor(root);
    fs.unlinkSync(artifact);
    const result = spawnSync('mkfifo', [artifact], { encoding: 'utf8' });
    if (result.status !== 0) {
      t.skip('mkfifo is not available');
      return;
    }
    assert.throws(() => verifyCandidateBinding(root), /regular non-symlink file/);
  });
  await t.test('binding symlink', (t) => {
    const root = copyFixtureRoot(t);
    const binding = path.join(root, BINDING_PATH);
    const sibling = path.join(path.dirname(binding), 'binding-copy.json');
    fs.renameSync(binding, sibling);
    fs.symlinkSync(sibling, binding);
    assert.throws(() => verifyCandidateBinding(root), /candidate binding.*regular non-symlink/);
  });
  await t.test('binding hard link', (t) => {
    const root = copyFixtureRoot(t);
    const binding = path.join(root, BINDING_PATH);
    fs.linkSync(binding, path.join(root, 'binding-hardlink.json'));
    assert.throws(() => verifyCandidateBinding(root), /candidate binding.*exactly one hard link/);
  });
  for (const [file, label] of [
    ['package.json', 'package manifest'],
    ['package-lock.json', 'package lock'],
    [CORE_CANDIDATE_EVIDENCE_PATH, 'Core candidate evidence'],
    [CORE_CANDIDATE_WORKFLOW_PATH, 'Core candidate workflow'],
  ]) {
    await t.test(`${file} symlink`, (t) => {
      const root = copyFixtureRoot(t);
      const authority = path.join(root, file);
      const outside = path.join(root, `outside-${path.basename(file)}`);
      fs.renameSync(authority, outside);
      fs.symlinkSync(outside, authority);
      assert.throws(
        () => verifyCandidateBinding(root),
        new RegExp(`${label}.*regular non-symlink`),
      );
    });
    await t.test(`${file} hard link`, (t) => {
      const root = copyFixtureRoot(t);
      const authority = path.join(root, file);
      fs.linkSync(authority, path.join(root, `hardlink-${path.basename(file)}`));
      assert.throws(
        () => verifyCandidateBinding(root),
        new RegExp(`${label}.*exactly one hard link`),
      );
    });
  }
  await t.test('candidate directory symlink escape', (t) => {
    const root = copyFixtureRoot(t);
    const directory = path.join(root, 'tests/fixtures/runtime-candidates');
    const outside = path.join(root, 'outside-candidates');
    fs.renameSync(directory, outside);
    fs.symlinkSync(outside, directory);
    assert.throws(() => verifyCandidateBinding(root), /candidate binding.*escapes.*canonical path/);
  });
});

test('installed graph rejects alias copies, nested copies, symlinks, extras, and drift', async (t) => {
  await t.test('canonical graph', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    assert.deepEqual(verifyInstalledAikdnaGraph(root), {
      [CORE]: '0.19.0',
      [EVAL]: '0.3.1',
    });
  });
  await t.test('npm alias physical package identity', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'shadow-core', CORE, '0.18.0');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /not at its canonical top-level path/);
  });
  await t.test('nested duplicate package identity', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'foreign', 'foreign', '1.0.0');
    writeInstalledPackage(root, 'foreign/node_modules/shadow-core', CORE, '0.19.0');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /not at its canonical top-level path/);
  });
  await t.test('deep descendant node_modules alias', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'ajv', 'ajv', '1.0.0');
    writeInstalledPackage(root, 'ajv/dist/node_modules/shadow-core', CORE, '0.19.0');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /not at its canonical top-level path/);
  });
  await t.test('arbitrarily deep descendant node_modules alias', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'ajv', 'ajv', '1.0.0');
    writeInstalledPackage(root, 'ajv/dist/a/b/node_modules/shadow-core', CORE, '0.19.0');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /not at its canonical top-level path/);
  });
  await t.test('vendored package manifest identity', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'ajv', 'ajv', '1.0.0');
    writeInstalledPackage(root, 'ajv/vendor/shadow-core', CORE, '0.19.0');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /not at its canonical top-level path/);
  });
  await t.test('deep vendored encoded package manifest identity', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'ajv', 'ajv', '1.0.0');
    writeInstalledPackage(root, 'ajv/vendor/a/b/shadow-core', '%40aikdna%2fkdna-core', '0.19.0');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /installed AIKDNA package name invalid/);
  });
  await t.test('non-canonical node_modules case', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'ajv', 'ajv', '1.0.0');
    writeInstalledPackage(root, 'ajv/dist/NODE_MODULES/shadow-core', CORE, '0.19.0');
    assert.throws(
      () => verifyInstalledAikdnaGraph(root),
      /node_modules path has non-canonical case/,
    );
  });
  await t.test('broken descendant node_modules symlink', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'ajv', 'ajv', '1.0.0');
    const nested = path.join(root, 'node_modules/ajv/dist/node_modules');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.symlinkSync(path.join(root, 'missing-target'), nested);
    assert.throws(() => verifyInstalledAikdnaGraph(root), /package tree contains a symlink/);
  });
  await t.test('root .bin descendant node_modules', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, '.bin/node_modules/shadow-core', CORE, '0.19.0');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /\.bin must not contain directories/);
  });
  await t.test('nested .bin descendant node_modules', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'ajv', 'ajv', '1.0.0');
    writeInstalledPackage(
      root,
      'ajv/dist/node_modules/.bin/node_modules/shadow-core',
      CORE,
      '0.19.0',
    );
    assert.throws(() => verifyInstalledAikdnaGraph(root), /\.bin must not contain directories/);
  });
  await t.test('symlinked .bin directory', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    const target = path.join(root, 'alternate-bin');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, 'node_modules/.bin'));
    assert.throws(() => verifyInstalledAikdnaGraph(root), /\.bin must be a regular non-symlink/);
  });
  await t.test('normal contained .bin executable symlink', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    const executable = path.join(root, 'node_modules', CORE, 'cli.js');
    fs.writeFileSync(executable, '#!/usr/bin/env node\n');
    const bin = path.join(root, 'node_modules/.bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(path.relative(bin, executable), path.join(bin, 'kdna-core'));
    assert.doesNotThrow(() => verifyInstalledAikdnaGraph(root));
  });
  await t.test('symlinked alias package', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    fs.symlinkSync(
      path.join(root, 'node_modules', CORE),
      path.join(root, 'node_modules/shadow-core'),
    );
    assert.throws(() => verifyInstalledAikdnaGraph(root), /package graph contains a symlink/);
  });
  await t.test('undeclared scoped package', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, '@aikdna/unexpected', '@aikdna/unexpected', '1.0.0');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /installed undeclared AIKDNA package/);
  });
  await t.test('case-disguised package name', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    writeInstalledPackage(root, 'shadow-core', '@AIKDNA/kdna-core', '0.19.0');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /installed AIKDNA package name invalid/);
  });
  await t.test('canonical package version drift', (t) => {
    const root = copyFixtureRoot(t);
    writeInstalledPackage(root, CORE, CORE, '0.18.0');
    writeInstalledPackage(root, EVAL, EVAL, '0.3.1');
    assert.throws(() => verifyInstalledAikdnaGraph(root), /version mismatch/);
  });
  await t.test('installed package manifest symlink', (t) => {
    const root = copyFixtureRoot(t);
    createCanonicalInstalledGraph(root);
    const manifest = path.join(root, 'node_modules', CORE, 'package.json');
    const outside = path.join(root, 'installed-core.json');
    fs.renameSync(manifest, outside);
    fs.symlinkSync(outside, manifest);
    assert.throws(() => verifyInstalledAikdnaGraph(root), /manifest must be a regular non-symlink/);
  });
});

test('binding rejects changed candidate bytes and lock integrity', (t) => {
  const root = copyFixtureRoot(t);
  const binding = verifyCandidateBinding(root);
  fs.appendFileSync(path.join(root, binding.packages[0].artifact), Buffer.from([0]));
  assert.throws(() => verifyCandidateBinding(root), /candidate integrity mismatch/);

  const cleanRoot = copyFixtureRoot(t);
  mutateJson(cleanRoot, 'package-lock.json', (lock) => {
    lock.packages[`node_modules/${CORE}`].integrity =
      `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  });
  assert.throws(() => verifyCandidateBinding(cleanRoot), /lock package integrity mismatch/);
});

test('npm package contains zero candidate binding or nested tar entries', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-candidate-pack-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const npm = resolveTrustedNpmInvocation(ROOT);
  let result;
  try {
    result = spawnSync(
      npm.command,
      [
        ...npm.prefixArgs,
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        output,
        '--registry=https://registry.npmjs.org/',
        '--@aikdna:registry=https://registry.npmjs.org/',
      ],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false },
    );
  } finally {
    npm.dispose();
  }
  assert.equal(result.status, 0, result.stderr);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, 1);
  const candidateEntries = reports[0].files.filter(
    (file) =>
      file.path.startsWith('tests/fixtures/runtime-candidates/') || file.path.endsWith('.tgz'),
  );
  assert.deepEqual(candidateEntries, []);
});
