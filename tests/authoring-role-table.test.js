'use strict';
// Drift guard: the method-role table in the published authoring field
// reference must equal the method_roles registry of the exact Core this
// package binds. The roles are a closed vocabulary: a table that lists fewer
// roles than the installed contract refuses sends authors into unexplained
// rejections, and one that lists more invents vocabulary. This is a
// documentation check against the installed contract bytes, not a second
// parser; the content contract remains Core's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs/authoring-field-reference.md'), 'utf8');
const START = '<!-- method-role-table:start -->';
const END = '<!-- method-role-table:end -->';

function installedMethodRoles() {
  const packageJson = require.resolve('@aikdna/kdna-core/package.json');
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(packageJson), 'src/public-contract/generated-contract.json'),
      'utf8',
    ),
  );
  return contract.r2_semantics.method_roles;
}

function parseTable(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  assert.ok(start !== -1 && end !== -1, 'the reference must carry the marked role table');
  const rows = text
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('| method term') && !/^\|\s*-{3}/.test(line));
  const table = {};
  for (const row of rows) {
    const cells = row
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell, index, all) => index > 0 && index < all.length - 1);
    assert.equal(cells.length, 3, `unexpected row shape: ${row}`);
    const term = /^`([a-z_]+)`$/.exec(cells[0]);
    assert.ok(term, `unknown method term format: ${cells[0]}`);
    table[term[1]] = { required: cells[1].split('、'), optional: cells[2].split('、') };
  }
  return table;
}

test('the role table equals the installed contract method_roles exactly', () => {
  const expected = installedMethodRoles();
  const table = parseTable(doc);
  assert.deepEqual(Object.keys(table).sort(), Object.keys(expected).sort(), 'term sets must match');
  for (const term of Object.keys(expected)) {
    assert.deepEqual(table[term].required, expected[term].required, `${term} required roles`);
    assert.deepEqual(table[term].optional, expected[term].optional, `${term} optional roles`);
  }
});

test('the guard fails when a row loses a role or a term disappears (negative control)', () => {
  const expected = installedMethodRoles();
  const mutated = doc.replace(
    '| `feeling` | 个人感受 | 体验说明、偏好变化 |',
    '| `feeling` | 体验说明 | 偏好变化 |',
  );
  assert.notEqual(mutated, doc, 'the current table row must be present for this control to bite');
  assert.notDeepEqual(parseTable(mutated).feeling.required, expected.feeling.required);
  const missingTerm = doc.replace(/^\| `tradeoff`.*\n/m, '');
  assert.notEqual(missingTerm, doc);
  assert.notDeepEqual(Object.keys(parseTable(missingTerm)).sort(), Object.keys(expected).sort());
});
