'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

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
