'use strict';
// Drift guard: the published authoring field reference must keep covering every
// key the repository's only known-good creation input actually uses. This is a
// documentation check, not a validator: the contract remains Core's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs/authoring-field-reference.md'), 'utf8');
const example = JSON.parse(
  fs.readFileSync(path.join(root, 'examples/team-update/author.json'), 'utf8'),
);

function listedKeys(sectionStart, sectionEnd) {
  const start = doc.indexOf(sectionStart);
  assert.notEqual(start, -1, `section not found: ${sectionStart}`);
  const end = doc.indexOf(sectionEnd, start + sectionStart.length);
  assert.notEqual(end, -1, `section end not found: ${sectionEnd}`);
  return new Set(
    (doc.slice(start, end).match(/`[A-Za-z0-9_.]+`/g) || []).map((t) => t.slice(1, -1)),
  );
}

function missingKeys(keys, documented) {
  return [...keys].filter((key) => !documented.has(key));
}

test('the authoring reference covers every key of the known-good example', () => {
  const manifestKeys = listedKeys(
    '## 2. `manifest` required keys',
    '## 3. `payload` required keys',
  );
  const payloadKeys = listedKeys('## 3. `payload` required keys', '## 4. `payload.judgments[]`');
  const judgmentKeys = listedKeys(
    '## 4. `payload.judgments[]`',
    '## 5. `judgment.method.components[]`',
  );
  const componentKeys = listedKeys(
    '## 5. `judgment.method.components[]`',
    '## 6. Before you create',
  );

  assert.deepEqual(missingKeys(Object.keys(example.manifest), manifestKeys), []);
  assert.deepEqual(missingKeys(Object.keys(example.payload), payloadKeys), []);
  const judgment = example.payload.judgments[0];
  assert.deepEqual(missingKeys(Object.keys(judgment), judgmentKeys), []);
  assert.deepEqual(missingKeys(Object.keys(judgment.method.components[0]), componentKeys), []);
});

test('the guard fails when an input key is not documented (negative control)', () => {
  const manifestKeys = listedKeys(
    '## 2. `manifest` required keys',
    '## 3. `payload` required keys',
  );
  const mutated = { ...example.manifest, an_undocumented_key: true };
  assert.deepEqual(missingKeys(Object.keys(mutated), manifestKeys), ['an_undocumented_key']);
});
