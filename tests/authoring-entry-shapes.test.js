'use strict';
// Drift guard for §9 (entry shapes) and the §4/§5 conditional lines of the
// published authoring field reference. The shapes, vocabularies and
// conditional requirements must equal the exact Core this package binds, and
// the conditional claims must match what the installed transport + Core
// actually refuse. This is a documentation check against installed bytes, not
// a second parser; the content contract remains Core's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');

const root = path.resolve(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs/authoring-field-reference.md'), 'utf8');
const local = createRequire(path.join(root, 'package.json'));
const { run } = local('@aikdna/kdna-cli');
const example = JSON.parse(fs.readFileSync(path.join(root, 'examples/team-update/author.json'), 'utf8'));
const START = '<!-- entry-shapes:start -->';
const END = '<!-- entry-shapes:end -->';

function installedContract() {
  const packageJson = require.resolve('@aikdna/kdna-core/package.json');
  return JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(packageJson), 'src/public-contract/generated-contract.json'),
      'utf8',
    ),
  );
}

function markedRegion(text = doc) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  assert.ok(start !== -1 && end !== -1, 'the reference must carry the marked entry-shapes region');
  return text.slice(start, end);
}

function parsedTuples(text = doc) {
  const rows = markedRegion(text)
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('| relation kind') && !/^\|\s*-{3}/.test(line));
  const table = {};
  for (const row of rows) {
    const cells = row
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell, index, all) => index > 0 && index < all.length - 1)
      .map((cell) => cell.replace(/`/g, ''));
    assert.equal(cells.length, 5, `unexpected row shape: ${row}`);
    const roles = cells[2].split(/\s*(?:→|↔)\s*/);
    assert.equal(roles.length, 2, `unexpected role arrow: ${cells[2]}`);
    table[cells[0]] = { direction: cells[1], roles, operator: cells[3], effect: cells[4] };
  }
  return table;
}

function parsedVocabulary(label, text = doc) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markedRegion(text).match(new RegExp('^- ' + escaped + ': (.+)$', 'm'));
  assert.ok(match, `the region must carry the ${label} vocabulary line`);
  return (match[1].match(/`[a-z_]+`/g) || []).map((token) => token.slice(1, -1));
}

test('the four normative tuples equal the installed contract relationship_tuples', () => {
  const contract = installedContract();
  const expected = contract.r2_semantics.relationship_tuples;
  const table = parsedTuples();
  assert.deepEqual(Object.keys(table).sort(), Object.keys(expected).sort());
  for (const kind of Object.keys(expected)) {
    assert.equal(table[kind].direction, expected[kind].direction, kind + ' direction');
    assert.deepEqual(table[kind].roles, expected[kind].roles, kind + ' roles');
    assert.equal(table[kind].operator, expected[kind].operator, kind + ' operator');
    assert.equal(table[kind].effect, expected[kind].effect, kind + ' effect');
  }
});

test('the entry-shape vocabularies equal the installed contract enums', () => {
  const types = installedContract().types;
  assert.deepEqual(parsedVocabulary('`boundary_effect`'), types.BoundaryEffect.enum);
  assert.deepEqual(
    parsedVocabulary('shared text declaration `kind`'),
    types.SharedTextDeclaration.properties.kind.enum,
  );
  assert.deepEqual(parsedVocabulary('declaration unprovided `state`'), types.AuthoredUnprovidedState.enum);
});

test('the §5 form conditionals and the §4 capability mapping match the contract and the reader', () => {
  const types = installedContract().types;
  const branches = types.Judgment.allOf;
  const branch = (form) => branches.find((entry) => entry.if?.properties?.form?.const === form);
  assert.deepEqual(branch('conclusion').then.required, ['result', 'result_contract']);
  assert.deepEqual(branch('conclusion').then.not.required, ['formation_rule']);
  assert.deepEqual(branch('rule').then.required, ['formation_rule', 'result_contract']);
  assert.deepEqual(branch('rule').then.not.required, ['result']);
  assert.ok(doc.includes('`form: "conclusion"` requires `result` and refuses `formation_rule`;'));
  assert.ok(doc.includes('`form: "rule"` requires `formation_rule` and refuses `result`.'));
  const other = branches.find((entry) => entry.if?.properties?.answer_kind?.const === 'other');
  assert.deepEqual(other.then.required, ['answer_other']);
  assert.deepEqual(types.OtherDefinition.required, ['name', 'definition', 'exclusion_reason']);
  assert.ok(doc.includes('`answer_other` carrying all three keys (`name`, `definition`,'));
  assert.deepEqual(types.AssetCapability.enum, ['asserted_answers', 'result_forming_rules', 'mixed']);
  assert.ok(doc.includes('every judgment `conclusion` → `asserted_answers`'));
});

function sink() {
  const lines = [];
  return { lines, write(value) { lines.push(value); return true; } };
}

async function createWith(mutate) {
  const document = JSON.parse(JSON.stringify(example));
  mutate(document);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-entry-shapes-'));
  try {
    const file = path.join(dir, 'authored.json');
    fs.writeFileSync(file, JSON.stringify(document));
    const out = sink();
    const code = await run(['create', file, '--output', path.join(dir, 'out.kdna'), '--allow-create'], out, Readable.from([]));
    const row = out.lines.length ? JSON.parse(out.lines.join('')) : null;
    return { code, row };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function rejectedAt(row, field) {
  return row?.status === 'core_rejected' &&
    Array.isArray(row.core?.diagnostics) &&
    row.core.diagnostics.some((diagnostic) => diagnostic.field === field);
}

test('the shipped example still creates on this source (baseline for the probes)', async () => {
  const { code, row } = await createWith(() => {});
  assert.equal(code, 0, JSON.stringify(row));
  assert.equal(row?.status, 'saved');
});

test('a conclusion without result is refused where the page says', async () => {
  const { code, row } = await createWith((document) => { delete document.payload.judgments[0].result; });
  assert.equal(code, 1);
  assert.ok(rejectedAt(row, '/payload/judgments/0/result'), JSON.stringify(row));
});

test('a rule carrying formation_rule instead of result is the accepted shape', async () => {
  const { code, row } = await createWith((document) => {
    const judgment = document.payload.judgments[0];
    delete judgment.result;
    judgment.form = 'rule';
    judgment.formation_rule = {
      statement: 'probe: derive the answer instead of asserting it',
      condition_refs: [],
      output_contract_ref: judgment.result_contract.id,
    };
    document.payload.asset_capability = 'mixed';
  });
  assert.equal(code, 0, JSON.stringify(row));
  assert.equal(row?.status, 'saved');
});

test('a rule that keeps result is refused', async () => {
  const { code, row } = await createWith((document) => {
    const judgment = document.payload.judgments[0];
    judgment.form = 'rule';
    judgment.formation_rule = {
      statement: 'probe: keep the old result alongside the rule',
      condition_refs: [],
      output_contract_ref: judgment.result_contract.id,
    };
    document.payload.asset_capability = 'mixed';
  });
  assert.equal(code, 1);
  assert.equal(row?.status, 'core_rejected');
  assert.ok(
    (row.core.diagnostics || []).some((diagnostic) => diagnostic.field === '/payload/judgments/0'),
    JSON.stringify(row),
  );
});

test('answer_other without its three keys is refused where the page says', async () => {
  const { code, row } = await createWith((document) => {
    document.payload.judgments[0].answer_kind = 'other';
    document.payload.judgments[0].answer_other = 'undecided';
  });
  assert.equal(code, 1);
  assert.ok(rejectedAt(row, '/payload/judgments/0/answer_other'), JSON.stringify(row));
});

test('a capability contradicting the judgment forms is refused where the page says', async () => {
  const { code, row } = await createWith((document) => {
    document.payload.asset_capability = 'result_forming_rules';
  });
  assert.equal(code, 1);
  assert.ok(rejectedAt(row, '/payload/asset_capability'), JSON.stringify(row));
});

test('the guard fails when a tuple row or a vocabulary entry drifts (negative control)', () => {
  const expected = installedContract().r2_semantics.relationship_tuples;
  const swapped = doc.replace('`side_a` ↔ `side_b`', '`side_b` ↔ `side_a`');
  assert.notEqual(swapped, doc, 'the conflict row must be present for this control to bite');
  assert.notDeepEqual(parsedTuples(swapped).conflict.roles, expected.conflict.roles);
  const thinned = doc.replace('- `boundary_effect`: `exclude`, `limit`, `out_of_domain`', '- `boundary_effect`: `exclude`, `limit`');
  assert.notEqual(thinned, doc);
  assert.notDeepEqual(parsedVocabulary('`boundary_effect`', thinned), installedContract().types.BoundaryEffect.enum);
});
