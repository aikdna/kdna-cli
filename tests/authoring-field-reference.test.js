'use strict';
// Drift guard: the published authoring field reference must match the transport
// this repository actually ships, in both directions. A page that lists fewer
// top-level keys than the reader requires is as wrong as one that lists keys the
// reader refuses, so this guard checks the declared shape against the real
// reader instead of only checking that the example's keys appear in the text.
// This is a documentation check, not a validator: the content contract remains
// Core's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAuthoredInput } = require('../src/authored-input.js');

const root = path.resolve(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs/authoring-field-reference.md'), 'utf8');
const example = JSON.parse(
  fs.readFileSync(path.join(root, 'examples/team-update/author.json'), 'utf8'),
);
const TOP_LEVEL_PREFIX = 'Top-level keys:';

function slice(startMarker, endMarker) {
  const start = doc.indexOf(startMarker);
  assert.notEqual(start, -1, `section not found: ${startMarker}`);
  const end = doc.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `section end not found: ${endMarker}`);
  return doc.slice(start, end);
}

function listedKeys(startMarker, endMarker) {
  return new Set(
    (slice(startMarker, endMarker).match(/`[A-Za-z0-9_.]+`/g) || []).map((t) => t.slice(1, -1)),
  );
}

function declaredTopLevel(text = doc) {
  const line = text.split('\n').find((entry) => entry.startsWith(TOP_LEVEL_PREFIX));
  assert.ok(line, `the reference must declare its key set on a "${TOP_LEVEL_PREFIX}" line`);
  const keys = (line.match(/`[A-Za-z0-9_]+`/g) || []).map((t) => t.slice(1, -1));
  assert.ok(keys.length > 0, 'the declared key set must not be empty');
  return keys;
}

function missingKeys(keys, documented) {
  return [...keys].filter((key) => !documented.has(key));
}

// The reader returns exactly the top-level keys it accepted, so a round trip
// through it reports the accepted set rather than restating the page.
async function acceptedTopLevel(document) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-field-ref-')), 'authored.json');
  fs.writeFileSync(file, JSON.stringify(document));
  const accepted = await readAuthoredInput(file);
  return Object.keys(accepted).sort();
}

function exampleDocument() {
  return JSON.parse(JSON.stringify(example));
}

test('the declared top-level key set is exactly the accepted one (two-way)', async () => {
  const declared = declaredTopLevel();
  assert.deepEqual([...declared].sort(), ['manifest', 'members', 'payload']);
  const accepted = await acceptedTopLevel(exampleDocument());
  assert.deepEqual(declared.slice().sort(), accepted);
  for (const key of declared) {
    const document = exampleDocument();
    delete document[key];
    await assert.rejects(() => acceptedTopLevel(document), `removing ${key} must be refused`);
  }
  const extra = exampleDocument();
  extra.not_a_creation_key = true;
  await assert.rejects(() => acceptedTopLevel(extra), 'a fourth top-level key must be refused');
});

test('the members section documents exactly the four accepted entry keys', async () => {
  const documented = listedKeys(
    '## 2. `members[]` (attachment descriptors)',
    '## 3. `manifest` required keys',
  );
  const entryKeys = ['name', 'type', 'mode', 'bytes_base64'];
  assert.deepEqual(missingKeys(entryKeys, documented), []);
  const member = { name: 'attachments/a.bin', type: 'file', mode: 420, bytes_base64: 'AAH/' };
  const accepted = exampleDocument();
  accepted.members = [member];
  await acceptedTopLevel(accepted);
  for (const key of entryKeys) {
    const mutated = { ...member };
    delete mutated[key];
    const withMissing = exampleDocument();
    withMissing.members = [mutated];
    await assert.rejects(() => acceptedTopLevel(withMissing), `member without ${key} must be refused`);
  }
  const withExtra = exampleDocument();
  withExtra.members = [{ ...member, extra: 1 }];
  await assert.rejects(() => acceptedTopLevel(withExtra), 'a fifth member key must be refused');
});

test('the guard fails when the page lists fewer top-level keys than the reader accepts', () => {
  const stale = doc.replace(
    'Top-level keys: `manifest`, `payload`, `members`.',
    'Top-level keys: `manifest`, `payload`.',
  );
  assert.notEqual(stale, doc, 'the retired wording must be present for this negative control to bite');
  assert.notDeepEqual(declaredTopLevel(stale).slice().sort(), ['manifest', 'members', 'payload']);
});

test('the reference covers every key of the known-good example', () => {
  const manifestKeys = listedKeys('## 3. `manifest` required keys', '## 4. `payload` required keys');
  const payloadKeys = listedKeys('## 4. `payload` required keys', '## 5. `payload.judgments[]`');
  const judgmentKeys = listedKeys('## 5. `payload.judgments[]`', '## 6. `judgment.method.components[]`');
  const componentKeys = listedKeys('## 6. `judgment.method.components[]`', '## 7. Before you create');

  assert.deepEqual(missingKeys(Object.keys(example.manifest), manifestKeys), []);
  assert.deepEqual(missingKeys(Object.keys(example.payload), payloadKeys), []);
  const judgment = example.payload.judgments[0];
  assert.deepEqual(missingKeys(Object.keys(judgment), judgmentKeys), []);
  assert.deepEqual(missingKeys(Object.keys(judgment.method.components[0]), componentKeys), []);
});

test('the guard fails when an input key is not documented (negative control)', () => {
  const manifestKeys = listedKeys('## 3. `manifest` required keys', '## 4. `payload` required keys');
  const mutated = { ...example.manifest, an_undocumented_key: true };
  assert.deepEqual(missingKeys(Object.keys(mutated), manifestKeys), ['an_undocumented_key']);
});
