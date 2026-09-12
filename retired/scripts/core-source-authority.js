'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  discoverTrustedGitRoot,
  readTrustedCommitTree,
  readTrustedGitBlob,
  readTrustedIndexEntries,
  runTrustedGit,
} = require('./trusted-git');

const CORE_PACKAGE_RELATIVE = 'packages/kdna-core';
const COMMIT_RE = /^[0-9a-f]{40}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runGit(repository, args, options = {}) {
  return runTrustedGit(repository, args, options);
}

function assertCanonicalDirectory(directory, expectedRealPath, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw new Error(`${label} is missing`);
  }
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    `${label} must be a regular non-symlink directory`,
  );
  assert(fs.realpathSync(directory) === expectedRealPath, `${label} path must be canonical`);
}

function parseCommitTree(commitTree) {
  const prefix = `${CORE_PACKAGE_RELATIVE}/`;
  const entries = commitTree
    .filter(({ file }) => file.startsWith(prefix))
    .map(({ file: treePath, mode, object }) =>
      Object.freeze({ mode, object, relativePath: treePath.slice(prefix.length), treePath }),
    );
  assert(entries.length > 0, 'Core commit tree contains no package files');
  return Object.freeze(entries);
}

function gitBlobId(bytes) {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function assertIndexMatchesCommit(repository, commitTree) {
  const indexed = readTrustedIndexEntries(repository);
  assert(
    indexed.length === commitTree.length,
    'Core source index does not match the pinned commit tree',
  );
  for (let index = 0; index < commitTree.length; index += 1) {
    const expected = commitTree[index];
    const actual = indexed[index];
    assert(
      actual.file === expected.file &&
        actual.mode === expected.mode &&
        actual.object === expected.object,
      `Core source index differs from the pinned commit tree: ${expected.file}`,
    );
  }
}

function assertNormalizedWorktreeClean(repository) {
  const trackedChanges = runGit(
    repository,
    ['-c', 'core.autocrlf=true', 'diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv'],
    { encoding: 'buffer' },
  );
  const untrackedFiles = runGit(repository, ['ls-files', '--others', '--exclude-standard', '-z'], {
    encoding: 'buffer',
  });
  assert(
    trackedChanges.length === 0 && untrackedFiles.length === 0,
    'Core source worktree must be clean',
  );
}

function readCoreCommitFile(authority, relativePath) {
  assert(
    authority && typeof authority === 'object' && Array.isArray(authority.treeEntries),
    'Core commit authority is invalid',
  );
  const entry = authority.treeEntries.find((candidate) => candidate.relativePath === relativePath);
  assert(entry, `Core commit tree is missing: ${relativePath}`);
  return readTrustedGitBlob(authority.repository, entry.object);
}

function inspectCoreSourceAuthority(sourceRoot, expectedCommit) {
  assert(
    typeof sourceRoot === 'string' && path.isAbsolute(sourceRoot),
    'KDNA_CORE_SOURCE_ROOT must be an absolute path',
  );
  assert(COMMIT_RE.test(expectedCommit || ''), 'Core source expected commit must be exact');

  const lexicalSourceRoot = path.resolve(sourceRoot);
  let sourceStat;
  try {
    sourceStat = fs.lstatSync(lexicalSourceRoot);
  } catch {
    throw new Error('Core source package is missing');
  }
  assert(
    sourceStat.isDirectory() && !sourceStat.isSymbolicLink(),
    'Core source package must be a regular non-symlink directory',
  );
  const repository = discoverTrustedGitRoot(lexicalSourceRoot);
  assertCanonicalDirectory(repository, repository, 'Core source repository');
  const packagesDirectory = path.join(repository, 'packages');
  assertCanonicalDirectory(packagesDirectory, packagesDirectory, 'Core packages directory');
  const packageRoot = path.join(repository, ...CORE_PACKAGE_RELATIVE.split('/'));
  assert(
    lexicalSourceRoot === packageRoot,
    `Core source package root must be exactly ${CORE_PACKAGE_RELATIVE}`,
  );
  assertCanonicalDirectory(packageRoot, packageRoot, 'Core source package');

  const head = runGit(repository, ['rev-parse', 'HEAD']).trim();
  assert(head === expectedCommit, 'Core source does not match the exact commit authority');
  const commitTree = readTrustedCommitTree(repository, expectedCommit);
  const treeEntries = parseCommitTree(commitTree);
  assertIndexMatchesCommit(repository, commitTree);
  assertNormalizedWorktreeClean(repository);
  for (const entry of treeEntries) {
    const file = path.join(packageRoot, ...entry.relativePath.split('/'));
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new Error(`Core source tracked file is missing: ${entry.relativePath}`);
    }
    assert(
      stat.isFile() && !stat.isSymbolicLink(),
      `Core source tracked path must be a regular non-symlink file: ${entry.relativePath}`,
    );
    assert(
      stat.nlink === 1,
      `Core source tracked file must have one hard link: ${entry.relativePath}`,
    );
    assert(
      fs.realpathSync(file) === file,
      `Core source tracked file path must be canonical: ${entry.relativePath}`,
    );
  }

  const commitAuthority = Object.freeze({ repository, treeEntries });
  const packageJson = JSON.parse(
    readCoreCommitFile(commitAuthority, 'package.json').toString('utf8'),
  );
  return Object.freeze({
    expectedCommit,
    head,
    packageJson,
    packageRoot,
    repository,
    treeEntries,
  });
}

function authoritySnapshot(authority) {
  return JSON.stringify({
    expectedCommit: authority.expectedCommit,
    head: authority.head,
    packageJson: authority.packageJson,
    packageRoot: authority.packageRoot,
    repository: authority.repository,
    treeEntries: authority.treeEntries,
  });
}

function assertCoreSourceAuthorityUnchanged(before, after) {
  assert(
    authoritySnapshot(before) === authoritySnapshot(after),
    'Core source authority changed during candidate pack',
  );
}

function materializeCoreCommitPackage(authority, destination) {
  const destinationReal = fs.realpathSync(destination);
  assertCanonicalDirectory(destination, destinationReal, 'Core isolated package directory');
  assert(fs.readdirSync(destination).length === 0, 'Core isolated package directory must be empty');
  for (const entry of authority.treeEntries) {
    const target = path.join(destination, ...entry.relativePath.split('/'));
    assert(
      target.startsWith(`${destinationReal}${path.sep}`),
      `Core isolated package path escapes destination: ${entry.relativePath}`,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = readCoreCommitFile(authority, entry.relativePath);
    assert(gitBlobId(bytes) === entry.object, `Core Git blob is corrupt: ${entry.relativePath}`);
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 });
    const stat = fs.lstatSync(target);
    assert(
      stat.isFile() && stat.nlink === 1,
      `Core isolated file is invalid: ${entry.relativePath}`,
    );
  }
  return destinationReal;
}

function coreSourcePackArguments(destination) {
  return Object.freeze([
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    destination,
    '--registry=https://registry.npmjs.org/',
    '--@aikdna:registry=https://registry.npmjs.org/',
  ]);
}

module.exports = {
  CORE_PACKAGE_RELATIVE,
  assertCoreSourceAuthorityUnchanged,
  coreSourcePackArguments,
  inspectCoreSourceAuthority,
  materializeCoreCommitPackage,
  readCoreCommitFile,
};
