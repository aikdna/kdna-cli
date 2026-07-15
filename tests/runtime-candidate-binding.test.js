'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  BINDING_PATH,
  assertRegistryReleaseReady,
  canonicalRegistryUrl,
  verifyCandidateBinding,
} = require('../scripts/runtime-candidate-binding');

const ROOT = path.resolve(__dirname, '..');
const CORE = '@aikdna/kdna-core';
const EVAL = '@aikdna/kdna-eval';

function copyFixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, path.dirname(BINDING_PATH)), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', BINDING_PATH]) {
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
    /non-direct packages/,
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
    /AIKDNA lock package path invalid/,
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
  const result = spawnSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', output],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, 1);
  const candidateEntries = reports[0].files.filter(
    (file) =>
      file.path.startsWith('tests/fixtures/runtime-candidates/') || file.path.endsWith('.tgz'),
  );
  assert.deepEqual(candidateEntries, []);
});
