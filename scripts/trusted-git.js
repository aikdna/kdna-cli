'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const MAX_PATH_BYTES = 4096;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const MAX_MATERIALIZED_BYTES = 256 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalDirectory(directory) {
  assert(
    typeof directory === 'string' && path.isAbsolute(directory),
    'trusted Git root must be absolute',
  );
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink(),
    'trusted Git root must be a regular directory',
  );
  const real = fs.realpathSync(resolved);
  assert(real === resolved, 'trusted Git root path must be canonical');
  return real;
}

function trustedGitEnvironment(source = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (!name.startsWith('GIT_')) environment[name] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function rawGit(repository, args, options = {}) {
  return execFileSync(
    'git',
    [
      '--no-replace-objects',
      '--literal-pathspecs',
      '-c',
      'core.useReplaceRefs=false',
      '-C',
      repository,
      ...args,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
      env: trustedGitEnvironment(),
    },
  );
}

function assertTrustedRepository(root) {
  const discovered = fs.realpathSync(
    path.resolve(rawGit(root, ['rev-parse', '--show-toplevel']).trim()),
  );
  assert(discovered === root, 'trusted Git root must be the exact repository top level');
  const replaceRefs = rawGit(root, ['for-each-ref', '--format=%(refname)', 'refs/replace']).trim();
  assert(replaceRefs === '', 'trusted Git repository must not contain Git replace refs');
}

function discoverTrustedGitRoot(directory) {
  const start = canonicalDirectory(directory);
  const root = fs.realpathSync(
    path.resolve(rawGit(start, ['rev-parse', '--show-toplevel']).trim()),
  );
  canonicalDirectory(root);
  assertTrustedRepository(root);
  return root;
}

function runTrustedGit(repository, args, options = {}) {
  const root = canonicalDirectory(repository);
  assertTrustedRepository(root);
  return rawGit(root, args, options);
}

function assertTrustedIndexIsOrdinary(repository) {
  const output = runTrustedGit(repository, ['ls-files', '-v', '-z'], {
    encoding: 'buffer',
  }).toString('utf8');
  const paths = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = record.match(/^(.?) (.+)$/s);
    assert(
      match && match[1] === 'H',
      `trusted Git index has a hidden or non-ordinary state: ${match?.[2] || record}`,
    );
    paths.push(match[2]);
  }
  return Object.freeze(paths);
}

function decodePathRecord(record, label) {
  assert(
    record.length > 0 && record.length <= MAX_PATH_BYTES + 128,
    `${label} record size is invalid`,
  );
  let value;
  try {
    value = UTF8.decode(record);
  } catch {
    throw new Error(`${label} contains invalid UTF-8`);
  }
  return value;
}

function assertCanonicalGitPath(file, seen, label) {
  assert(
    file &&
      !/[\u0000-\u001f\u007f]/u.test(file) &&
      !file.includes('\\') &&
      !path.posix.isAbsolute(file) &&
      path.posix.normalize(file) === file &&
      !file.split('/').some((segment) => ['', '.', '..'].includes(segment)),
    `${label} path is invalid: ${JSON.stringify(file)}`,
  );
  assert(Buffer.byteLength(file, 'utf8') <= MAX_PATH_BYTES, `${label} path is too long`);
  assert(!seen.has(file), `${label} contains a duplicate normalized path: ${file}`);
  seen.add(file);
}

function nulRecords(output, label) {
  assert(
    Buffer.isBuffer(output) && output.length <= MAX_TREE_BYTES,
    `${label} output is too large`,
  );
  if (output.length === 0) return [];
  assert(output[output.length - 1] === 0, `${label} output is truncated`);
  const records = [];
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    assert(end >= offset, `${label} output is malformed`);
    assert(end > offset, `${label} contains an empty record`);
    records.push(output.subarray(offset, end));
    offset = end + 1;
    assert(records.length <= MAX_TREE_ENTRIES, `${label} has too many entries`);
  }
  return records;
}

function readTrustedCommitTree(repository, commit) {
  assert(/^[0-9a-f]{40}$/.test(commit || ''), 'trusted Git commit must be exact');
  const output = runTrustedGit(repository, ['ls-tree', '-r', '-z', '--full-tree', commit], {
    encoding: 'buffer',
  });
  const entries = [];
  const paths = new Set();
  for (const rawRecord of nulRecords(output, 'trusted Git commit tree')) {
    const record = decodePathRecord(rawRecord, 'trusted Git commit tree');
    const match = record.match(/^([0-7]{6}) ([a-z]+) ([0-9a-f]{40})\t(.+)$/);
    assert(match, 'trusted Git commit tree contains an invalid entry');
    const [, mode, type, object, file] = match;
    assert(type === 'blob', `trusted Git commit tree contains a non-blob entry: ${file}`);
    assert(
      mode === '100644' || mode === '100755',
      `trusted Git commit tree contains a non-regular entry: ${file}`,
    );
    assertCanonicalGitPath(file, paths, 'trusted Git commit tree');
    entries.push(Object.freeze({ file, mode, object }));
  }
  assert(entries.length > 0, 'trusted Git commit tree is empty');
  return Object.freeze(entries);
}

function gitBlobId(bytes) {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function materializeTrustedCommit(repository, commit, destination) {
  const root = canonicalDirectory(destination);
  assert(
    fs.readdirSync(root).length === 0,
    'trusted Git materialization destination must be empty',
  );
  const entries = readTrustedCommitTree(repository, commit);
  let totalBytes = 0;
  for (const entry of entries) {
    const target = path.join(root, ...entry.file.split('/'));
    assert(
      target.startsWith(`${root}${path.sep}`),
      `trusted Git materialization path escapes: ${entry.file}`,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = runTrustedGit(repository, ['cat-file', 'blob', entry.object], {
      encoding: 'buffer',
      maxBuffer: MAX_BLOB_BYTES,
    });
    totalBytes += bytes.length;
    assert(
      totalBytes <= MAX_MATERIALIZED_BYTES,
      'trusted Git commit tree is too large to materialize',
    );
    assert(gitBlobId(bytes) === entry.object, `trusted Git blob is corrupt: ${entry.file}`);
    fs.writeFileSync(target, bytes, {
      flag: 'wx',
      mode: entry.mode === '100755' ? 0o755 : 0o644,
    });
    const stat = fs.lstatSync(target);
    assert(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
      `trusted Git materialized file is invalid: ${entry.file}`,
    );
  }
  return Object.freeze({ commit, entries, root });
}

function readTrustedIndexEntries(repository) {
  assertTrustedIndexIsOrdinary(repository);
  const output = runTrustedGit(repository, ['ls-files', '-s', '-z'], { encoding: 'buffer' });
  const entries = [];
  const paths = new Set();
  for (const rawRecord of nulRecords(output, 'trusted Git index')) {
    const record = decodePathRecord(rawRecord, 'trusted Git index');
    const match = record.match(/^([0-7]{6}) ([0-9a-f]{40}) ([0-3])\t(.+)$/);
    assert(match, 'trusted Git index contains an invalid entry');
    const [, mode, object, stage, file] = match;
    assert(stage === '0', `trusted Git index contains an unresolved entry: ${file}`);
    assert(
      mode === '100644' || mode === '100755',
      `trusted Git index contains a non-regular entry: ${file}`,
    );
    assertCanonicalGitPath(file, paths, 'trusted Git index');
    entries.push(Object.freeze({ file, mode, object }));
  }
  return Object.freeze(entries);
}

function readTrustedGitBlob(repository, object) {
  assert(/^[0-9a-f]{40}$/.test(object || ''), 'trusted Git blob id must be exact');
  const bytes = runTrustedGit(repository, ['cat-file', 'blob', object], {
    encoding: 'buffer',
    maxBuffer: MAX_BLOB_BYTES,
  });
  assert(gitBlobId(bytes) === object, 'trusted Git blob bytes do not match the object id');
  return bytes;
}

function initializeTrustedGitFixture(directory) {
  const root = canonicalDirectory(directory);
  rawGit(root, ['init', '--quiet']);
  return root;
}

module.exports = {
  assertTrustedIndexIsOrdinary,
  discoverTrustedGitRoot,
  initializeTrustedGitFixture,
  materializeTrustedCommit,
  readTrustedGitBlob,
  readTrustedIndexEntries,
  readTrustedCommitTree,
  runTrustedGit,
  trustedGitEnvironment,
};
