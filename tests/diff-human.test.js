'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createNativeSectionByteReadAuthority, admitSectionBytesNode } = require('@aikdna/kdna-core/sections-bytes-node');
const { admitSectionRequest, inspectWholeSectionSnapshot } = require('@aikdna/kdna-core/sections-node');
const binding = require('../public-contract-binding.json');
const { diffViews, renderDiffHuman } = require('../src/diff.js');
const { renderInspectHuman, renderValidateHuman, renderReadHuman, compactReadResult } = require('../src/human.js');

const EXAMPLES = path.resolve(__dirname, '..', '..', 'kdna', 'examples', 'native-team-update') + '/';
const V1 = EXAMPLES + 'team-update-1.0.0.kdna', V11 = EXAMPLES + 'team-update-1.1.0.kdna';
const have = fs.existsSync(V1) && fs.existsSync(V11);
const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const SEL = ['--mode', 'exact_selection', '--asset-id', 'asset:team-update-format', '--asset-version', '1.0.0', '--judgment-id', 'update:order', '--allow-read'];

async function viewOf(file) {
  const request = admitSectionRequest({ request_id: 'test:1', tuple: binding.tuple, budget_bytes: 100000000, mode: 'whole_asset', selection: null, handle: null });
  const admission = await admitSectionBytesNode(fs.readFileSync(file), request, createNativeSectionByteReadAuthority(() => true));
  assert.equal(admission.status, 'accepted');
  return inspectWholeSectionSnapshot(admission.snapshot);
}
function cli(...args) {
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { text: run.stdout, json: JSON.parse(run.stdout), code: run.status };
}
const clone = value => JSON.parse(JSON.stringify(value));

test('diff: identical assets', { skip: !have }, async () => {
  const view = await viewOf(V1);
  const diff = diffViews(view, view);
  assert.equal(diff.format, 'kdna.diff/1');
  assert.equal(diff.identical, true);
  assert.equal(diff.judgments.unchanged_count, 3);
  assert.deepEqual(diff.judgments.added, []);
  assert.match(renderDiffHuman(diff), /semantically identical/);
});

test('diff: real 1.0.0 vs 1.1.0 assets report manifest and node changes', { skip: !have }, async () => {
  const left = await viewOf(V1), right = await viewOf(V11);
  const diff = diffViews(left, right);
  assert.equal(diff.identical, false);
  assert.ok(diff.manifest.changed.some(c => c.field === 'asset.asset_version' && c.left === '1.0.0' && c.right === '1.1.0'));
  assert.ok(diff.manifest.changed.some(c => c.field === 'declaration.title'));
  assert.ok(diff.declarations.added.length > 0, 'the 1.1.0 revision adds actor/component/revision nodes');
  assert.deepEqual(diff.digests.changed.map(c => c.field).includes('digests.A'), true);
  const text = renderDiffHuman(diff);
  assert.match(text, /^KDNA diff/);
  assert.match(text, /\+ asset:team-update-format @ 1\.1\.0/);
  assert.match(text, /~ declaration\.title/);
  assert.match(text, /Summary: .*judgments: \+0 -0 ~\d+/);
  assert.ok(!/\u001b\[/.test(text));
  for (const line of text.split('\n')) assert.ok(line.length <= 140, 'wrapped: ' + line.length);
  // deterministic and JSON-serialisable
  assert.equal(JSON.stringify(diffViews(left, right)), JSON.stringify(diff));
});

test('diff: added / removed / changed judgments, conditions and relations', { skip: !have }, async () => {
  const left = await viewOf(V1);
  const right = clone(left);
  const nodes = right.ir.nodes;
  const rationale = nodes.findIndex(n => n.role === 'judgment' && n.target.id === 'update:rationale');
  nodes.splice(rationale, 1); // removed
  const order = nodes.find(n => n.role === 'judgment' && n.target.id === 'update:order');
  order.value.focus = 'Weekly update order (revised)';
  order.value.core_expression.statement = 'Blockers first.'; // changed (two fields)
  const extra = clone(order);
  extra.id = 'judgment:zzz'; extra.target.id = 'update:new'; extra.value.id = 'update:new'; extra.value.focus = 'A new one';
  nodes.push(extra); // added
  nodes.push({ id: 'condition:1', role: 'condition', target: { kind: 'condition', id: 'cond:1' }, owner: order.owner, owner_judgment_id: null, value: { id: 'cond:1', statement: 'only on Mondays' } });
  right.ir.relationships = [{ id: 'rel:1', kind: { term: 'support' }, participants: [{ role: { term: 'supporter' }, judgment_ref: 'update:new' }, { role: { term: 'claim' }, judgment_ref: 'update:order' }] }];
  const diff = diffViews(left, right);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.judgments.added, [{ id: 'update:new', focus: 'A new one' }]);
  assert.deepEqual(diff.judgments.removed.map(e => e.id), ['update:rationale']);
  assert.equal(diff.judgments.changed.length, 1);
  assert.equal(diff.judgments.changed[0].id, 'update:order');
  const paths = diff.judgments.changed[0].fields.map(f => f.path);
  assert.deepEqual(paths, ['core_expression.statement', 'focus']);
  assert.equal(diff.judgments.unchanged_count, 1);
  assert.equal(diff.conditions.added.length, 1);
  assert.equal(diff.relations.added.filter(e => e.id.startsWith('relationship|')).length, 1);
  const text = renderDiffHuman(diff);
  assert.match(text, /Judgments \(\+1 -1 ~1, 1 unchanged\)/);
  assert.match(text, /\n  - update:rationale/);
  assert.match(text, /\n  \+ update:new  A new one/);
  assert.match(text, /\n  ~ update:order/);
  assert.match(text, /- "Blockers first\."|\+ "Blockers first\."/);
  assert.match(text, /Conditions \(\+1/);
  assert.match(text, /Relations \(\+\d/);
});

test('diff: renderer degrades on unknown input', () => {
  assert.match(renderDiffHuman(null), /Not a kdna\.diff\/1/);
  assert.match(renderDiffHuman({ format: 'kdna.diff/1' }), /KDNA diff/);
  const empty = diffViews({}, {});
  assert.equal(empty.identical, true);
});

test('human: inspect and validate', { skip: !have }, () => {
  const inspect = cli('inspect', V1).json;
  const text = renderInspectHuman(inspect);
  assert.match(text, /KDNA asset: asset:team-update-format version 1\.0\.0/);
  assert.match(text, /Judgments: 3/);
  assert.match(text, /A \(container bytes\): sha256:[0-9a-f]{12}…/);
  assert.ok(!text.includes(inspect.digests.A.observed));
  assert.match(text, /core: valid/);
  const validate = cli('validate', V1, '--system').json;
  const vtext = renderValidateHuman(validate);
  assert.match(vtext, /Valid: yes/);
  assert.match(vtext, /System checks: clean/);
  const warned = clone(validate);
  warned.system = { status: 'warnings', warning_count: 1, warnings: [{ code: 'KDNA_SYSTEM_SUPPORT_CYCLE', message: 'cycle', detail: { judgment_ids: ['a', 'b'] } }] };
  warned.diagnostics = [{ code: 'X_DIAG', stage: 's' }];
  const wtext = renderValidateHuman(warned);
  assert.match(wtext, /1 warning; warnings never change acceptance/);
  assert.match(wtext, /KDNA_SYSTEM_SUPPORT_CYCLE/);
  assert.match(wtext, /X_DIAG/);
});

test('human: read shapes (body, raw, catalog, rejections)', { skip: !have }, () => {
  const body = cli('read', V1, ...SEL).json;
  const text = renderReadHuman(body);
  assert.match(text, /Read: ready \[view body\]/);
  assert.match(text, /Asset: asset:team-update-format version 1\.0\.0/);
  assert.match(text, /Judgment update:order - Weekly update order/);
  assert.match(text, /completed changes first, then current blockers/);
  const raw = cli('read', V1, ...SEL, '--view', 'raw').json;
  const rawText = renderReadHuman(raw);
  assert.match(rawText, /Read: ready \(exact_selection\)/);
  assert.match(rawText, /Expansion handles \(1\)/);
  assert.match(rawText, /Budget: required \d+ bytes, limit 1000000 bytes/);
  assert.match(rawText, /completed changes first/);
  const catalog = renderReadHuman(cli('read', V1, '--mode', 'catalog', '--allow-read').json);
  assert.match(catalog, /Catalog \(3 judgments\)/);
  assert.match(catalog, /update:evidence {2}Evidence in a completed-change update/);
  const budget = cli('read', V1, ...SEL, '--view', 'raw', '--budget', '3000').json;
  const btext = renderReadHuman(budget);
  assert.match(btext, /Code: READ_BUDGET_INSUFFICIENT/);
  assert.match(btext, /Budget: required 2\d{4} bytes, limit 3000 bytes/);
  assert.match(btext, /Next: Retry with a larger --budget/);
  const control = renderReadHuman(cli('read', V1, ...SEL, '--budget', '100').json);
  assert.match(control, /READ_RESPONSE_BUDGET_TOO_SMALL/);
  const nope = renderReadHuman(cli('read', V1, ...SEL.slice(0, 6), '--judgment-id', 'nope', '--allow-read').json);
  assert.match(nope, /READ_SELECTION_NOT_FOUND/);
  assert.match(nope, /Next: Run `kdna read/);
  const denied = renderReadHuman(cli('read', V1, '--mode', 'catalog').json);
  assert.match(denied, /KDNA_READ_PERMISSION_REQUIRED/);
  assert.match(denied, /--allow-read/);
});

test('human: unknown shapes never throw', () => {
  for (const value of [null, undefined, 42, 'x', [], {}, { status: 'weird' }, { envelope: 7 }, { content: { closure: 'no' }, view_contract: 'x' }, { status: 'accepted', states: 3, digests: 'z' }]) {
    for (const render of [renderInspectHuman, renderValidateHuman, renderReadHuman]) {
      const text = render(value);
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
    }
    assert.doesNotThrow(() => compactReadResult(value));
  }
  assert.match(renderReadHuman({ status: 'weird', code: 'SOME_CODE' }), /SOME_CODE/);
});

test('compact: strips repeated asset-level bloat but keeps the judgment body', { skip: !have }, () => {
  const body = cli('read', V1, ...SEL).json;
  const compact = compactReadResult(body);
  const before = JSON.stringify(body).length, after = JSON.stringify(compact).length;
  assert.ok(before > 9000, 'baseline body view is large: ' + before);
  assert.ok(after < before / 2.5, `compact ${after} should be far below ${before}`);
  assert.equal(compact.status, 'ready');
  assert.equal(compact.request_id, body.fingerprint.request_id);
  assert.deepEqual(compact.asset.asset_id, 'asset:team-update-format');
  assert.equal(compact.asset.asset_version, '1.0.0');
  assert.equal(compact.judgments.length, 1);
  assert.equal(compact.judgments[0].id, 'update:order');
  assert.match(compact.judgments[0].body.core_expression.statement, /completed changes first/);
  assert.equal(compact.judgments[0].body.result_contract, undefined);
  assert.equal(compact.judgments[0].body.method_interpretation, undefined);
  for (const dropped of ['content', 'closure', 'references', 'provenance', 'fingerprint']) assert.equal(compact[dropped], undefined);
  assert.ok(compact.attested.A.startsWith('sha256:'));
  // nothing in the compact output repeats the asset declaration or the judgment body
  const serialised = JSON.stringify(compact);
  assert.equal(serialised.split('completed changes first').length - 1, 2, 'once in core_expression, once in result (authored body only)');
  assert.ok(!serialised.includes('asset_declaration:'));
  // the human reader copes with the compact output too, and catalog-only keeps just id+focus
  const catalog = compactReadResult(cli('read', V1, '--mode', 'catalog', '--allow-read').json);
  assert.deepEqual(catalog.catalog.map(e => e.judgment_id), ['update:order', 'update:evidence', 'update:rationale']);
  assert.deepEqual(Object.keys(catalog.catalog[0]).sort(), ['focus', 'judgment_id']);
  // rejected / non-model-view input is returned unchanged
  const rejected = cli('read', V1, ...SEL, '--view', 'raw', '--budget', '3000').json;
  assert.equal(compactReadResult(rejected), rejected);
  // --compact + --format human preserves full human-rendered judgment bodies instead of dropping content
  const compactHuman = spawnSync(process.execPath, [CLI, 'read', V1, ...SEL, '--compact', '--format', 'human'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(compactHuman.status, 0, compactHuman.stderr);
  assert.match(compactHuman.stdout, /Judgment update:order/);
  assert.match(compactHuman.stdout, /completed changes first/);
});
