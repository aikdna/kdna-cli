'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { trustedGitEnvironment } = require('../scripts/trusted-git');

const ROOT = path.resolve(__dirname, '..');

const EVIDENCE_PATH = 'tests/fixtures/core-0.19-candidate-evidence.json';
const BINDING_PATH = 'tests/fixtures/runtime-candidates/binding.json';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

async function policy() {
  return import('../scripts/public-surface-policy.mjs');
}

function evidenceText(overrides = {}) {
  return JSON.stringify(
    {
      package: '@aikdna/kdna-core',
      git_head: SHA,
      pack: { sha1: OTHER_SHA },
      ...overrides,
    },
    null,
    2,
  );
}

test('formal release evidence allows only its structured source and artifact hashes', async () => {
  const { allowFormalReleaseHash } = await policy();
  const text = evidenceText();
  assert.equal(
    allowFormalReleaseHash([SHA], {
      file: EVIDENCE_PATH,
      line: '  "git_head": "' + SHA + '",',
      text,
    }),
    true,
  );
  assert.equal(
    allowFormalReleaseHash([OTHER_SHA], {
      file: EVIDENCE_PATH,
      line: '    "sha1": "' + OTHER_SHA + '",',
      text,
    }),
    true,
  );
});

test('formal release evidence rejects duplicate keys and additional commit hashes', async () => {
  const { allowFormalReleaseHash } = await policy();
  const duplicate =
    '{\n  "git_head": "' +
    OTHER_SHA +
    '",\n  "git_head": "' +
    SHA +
    '",\n  "pack": { "sha1": "' +
    OTHER_SHA +
    '" }\n}\n';
  for (const candidate of [OTHER_SHA, SHA]) {
    assert.equal(
      allowFormalReleaseHash([candidate], {
        file: EVIDENCE_PATH,
        line: '  "git_head": "' + candidate + '",',
        text: duplicate,
      }),
      false,
    );
  }

  const additional = evidenceText({ other_commit: 'c'.repeat(40) });
  assert.equal(
    allowFormalReleaseHash([SHA], {
      file: EVIDENCE_PATH,
      line: '  "git_head": "' + SHA + '",',
      text: additional,
    }),
    false,
  );
});

test('formal release evidence rejects other fields, paths, and malformed JSON', async () => {
  const { allowFormalReleaseHash } = await policy();
  const text = evidenceText();
  assert.equal(
    allowFormalReleaseHash([SHA], {
      file: EVIDENCE_PATH,
      line: '  "other_commit": "' + SHA + '"',
      text,
    }),
    false,
  );
  assert.equal(
    allowFormalReleaseHash([SHA], {
      file: EVIDENCE_PATH + '.private',
      line: '  "git_head": "' + SHA + '"',
      text,
    }),
    false,
  );
  assert.equal(
    allowFormalReleaseHash([SHA], {
      file: EVIDENCE_PATH,
      line: '  "git_head": "' + SHA + '"',
      text: '{"git_head":"' + SHA + '"',
    }),
    false,
  );
});

test('candidate binding permits only structured commit audit references', async () => {
  const { allowFormalReleaseHash } = await policy();
  const binding = JSON.stringify(
    {
      schema: 'kdna.runtime-candidate-binding',
      schema_version: '0.1.0',
      packages: [{ name: '@aikdna/kdna-core', commit: SHA }],
    },
    null,
    2,
  );
  const context = {
    file: BINDING_PATH,
    line: `      "commit": "${SHA}"`,
    text: binding,
  };
  assert.equal(allowFormalReleaseHash([SHA], context), true);
  assert.equal(
    allowFormalReleaseHash([SHA], { ...context, line: `      "other": "${SHA}"` }),
    false,
  );
  assert.equal(
    allowFormalReleaseHash([SHA], {
      ...context,
      text: binding.replace(/\n}\s*$/, `,\n  "other": "${OTHER_SHA}"\n}\n`),
    }),
    false,
  );
  assert.equal(
    allowFormalReleaseHash([SHA], {
      ...context,
      text: binding.replace('kdna.runtime-candidate-binding', 'other.binding'),
    }),
    false,
  );
});

test('public-surface path exclusions distinguish exact files from prefixes', async () => {
  const { isRulePathExcluded } = await policy();
  const rule = {
    excludeExactPaths: ['ecosystem-manifest.json'],
    excludePathPrefixes: ['.github/workflows/'],
  };
  assert.equal(isRulePathExcluded('ecosystem-manifest.json', rule), true);
  assert.equal(isRulePathExcluded('ecosystem-manifest.json.private', rule), false);
  assert.equal(isRulePathExcluded('.github/workflows/ci.yml', rule), true);
  assert.equal(isRulePathExcluded('docs/.github/workflows/ci.yml', rule), false);
});

test('public-surface scan ignores hostile Git repository and index redirection', (t) => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/check-public-surface.mjs'), 'utf8');
  assert.match(source, /readTrustedIndexEntries\(ROOT\)/);
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-public-git-')));
  const poison = path.join(fixture, 'poison');
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  for (const file of [
    'check-public-surface.mjs',
    'public-surface-policy.mjs',
    'public-surface.config.json',
    'trusted-git.js',
  ]) {
    fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(fixture, 'scripts', file));
  }
  fs.writeFileSync(path.join(fixture, 'safe.txt'), 'safe\n');
  const git = (args) => {
    const result = spawnSync('git', ['-C', fixture, ...args], {
      encoding: 'utf8',
      env: trustedGitEnvironment(),
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'KDNA Test']);
  git(['add', '--all']);
  git(['commit', '--quiet', '-m', 'test: public surface fixture']);
  const hostileEnvironment = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_GLOBAL: path.join(poison, 'config'),
    GIT_CONFIG_KEY_0: 'core.useReplaceRefs',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_DIR: path.join(poison, '.git'),
    GIT_INDEX_FILE: path.join(poison, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(poison, 'objects'),
    GIT_WORK_TREE: poison,
  };
  const result = spawnSync(process.execPath, ['scripts/check-public-surface.mjs'], {
    cwd: fixture,
    encoding: 'utf8',
    env: hostileEnvironment,
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /public-surface check passed:/);
  git(['update-index', '--assume-unchanged', 'safe.txt']);
  fs.writeFileSync(path.join(fixture, 'safe.txt'), 'masked working tree bytes\n');
  const hidden = spawnSync(process.execPath, ['scripts/check-public-surface.mjs'], {
    cwd: fixture,
    encoding: 'utf8',
    env: hostileEnvironment,
    shell: false,
  });
  assert.notEqual(hidden.status, 0);
  assert.match(hidden.stderr, /hidden or non-ordinary state/);
});
