'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const EVIDENCE_PATH = 'tests/fixtures/core-0.18-release-evidence.json';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

async function policy() {
  return import('../scripts/public-surface-policy.mjs');
}

test('formal release evidence allows only one parsed git_head hash', async () => {
  const { allowFormalReleaseGitHead } = await policy();
  const text = JSON.stringify({ package: '@aikdna/kdna-core', git_head: SHA }, null, 2);
  const line = '  "git_head": "' + SHA + '"';
  assert.equal(allowFormalReleaseGitHead([SHA], { file: EVIDENCE_PATH, line, text }), true);
});

test('formal release evidence rejects duplicate keys and additional commit hashes', async () => {
  const { allowFormalReleaseGitHead } = await policy();
  const duplicate = '{\n  "git_head": "' + OTHER_SHA + '",\n  "git_head": "' + SHA + '"\n}\n';
  for (const candidate of [OTHER_SHA, SHA]) {
    assert.equal(
      allowFormalReleaseGitHead([candidate], {
        file: EVIDENCE_PATH,
        line: '  "git_head": "' + candidate + '",',
        text: duplicate,
      }),
      false,
    );
  }

  const additional = JSON.stringify({ git_head: SHA, other_commit: OTHER_SHA }, null, 2);
  assert.equal(
    allowFormalReleaseGitHead([SHA], {
      file: EVIDENCE_PATH,
      line: '  "git_head": "' + SHA + '",',
      text: additional,
    }),
    false,
  );
});

test('formal release evidence rejects other fields, paths, and malformed JSON', async () => {
  const { allowFormalReleaseGitHead } = await policy();
  const text = JSON.stringify({ git_head: SHA }, null, 2);
  assert.equal(
    allowFormalReleaseGitHead([SHA], {
      file: EVIDENCE_PATH,
      line: '  "other_commit": "' + SHA + '"',
      text,
    }),
    false,
  );
  assert.equal(
    allowFormalReleaseGitHead([SHA], {
      file: EVIDENCE_PATH + '.private',
      line: '  "git_head": "' + SHA + '"',
      text,
    }),
    false,
  );
  assert.equal(
    allowFormalReleaseGitHead([SHA], {
      file: EVIDENCE_PATH,
      line: '  "git_head": "' + SHA + '"',
      text: '{"git_head":"' + SHA + '"',
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
