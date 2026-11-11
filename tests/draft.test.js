'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { admitSectionRequest, inspectWholeSectionSnapshot } = require('@aikdna/kdna-core/sections-node');
const { createNativeSectionByteReadAuthority, admitSectionBytesNode } = require('@aikdna/kdna-core/sections-bytes-node');
const { admitNativeCreationRequest, createNativeCreationAuthority, createSectionAssetNode } = require('@aikdna/kdna-core/creation-sections-node');
const binding = require('../public-contract-binding.json');
const { DUPLICATE_ROLE_FIX_HINT, scaffoldDraft, compileDraft, validateInput, validateWithCore } = require('../src/draft.js');

function filled() {
  const d = scaffoldDraft();
  d.asset = { id: 'team-update', title: 'Team update', summary: 'How I write updates.', language: 'en', version: '1.0.0' };
  d.scope = 'Weekly team updates.';
  d.actors = [{ id: 'author', name: 'Author' }];
  d.highest_question = 'How should a weekly update be structured?';
  d.boundaries = 'Not for incident response.';
  d.judgments = [
    { id: 'update:order', focus: 'Order', statement: 'Completed, blockers, next.', applies_when: 'Routine weekly updates.', boundaries: 'Not for incidents.' },
    { id: 'update:evidence', focus: 'Evidence', statement: 'Link a result.', applies_when: 'Completed changes.', method: { term: 'observation', roles: { '观察依据': 'Observed in past updates.' } } },
  ];
  d.timestamp = '2026-01-01T00:00:00Z';
  return d;
}

async function create(input) {
  const request = admitNativeCreationRequest({ request_id: 'test:' + randomUUID(), tuple: binding.tuple, operation: 'create_public_asset', timeout_ms: 60000 });
  assert.equal(request.status, 'admitted_request');
  return createSectionAssetNode(input, request.request, createNativeCreationAuthority(() => true));
}

test('compileDraft is deterministic with explicit timestamp', () => {
  assert.deepEqual(compileDraft(filled()), compileDraft(filled()));
  assert.deepEqual(compileDraft(filled()).payload.reading_order, ['update:order', 'update:evidence']);
});

test('draft -> create -> inspect/validate admit', async () => {
  const produced = await create(compileDraft(filled()));
  assert.equal(produced.status, 'produced', JSON.stringify(produced).slice(0, 800));
  const request = admitSectionRequest({ request_id: 'test:' + randomUUID(), tuple: binding.tuple, budget_bytes: 100000000, mode: 'whole_asset', selection: null, handle: null });
  const admission = await admitSectionBytesNode(produced.bytes, request, createNativeSectionByteReadAuthority(() => true));
  assert.equal(admission.status, 'accepted');
  const view = inspectWholeSectionSnapshot(admission.snapshot);
  assert.equal(view.ir.catalog.length, 2);
  assert.equal((await validateWithCore(filled())).status, 'valid');
});

test('scaffold validates structurally only after TODOs are replaced', () => {
  const r = validateInput(scaffoldDraft());
  assert.equal(r.status, 'invalid');
  assert.ok(r.diagnostics.every(d => d.code === 'placeholder_not_replaced'));
  assert.equal(validateInput(filled()).status, 'valid');
});

test('missing required field gives a precise diagnostic', () => {
  const d = filled();
  delete d.judgments[1].applies_when;
  const r = validateInput(d);
  assert.equal(r.status, 'invalid');
  assert.equal(r.diagnostics[0].field, 'judgments[1].applies_when');
  assert.equal(r.diagnostics[0].code, 'missing_field');
  assert.ok(r.diagnostics[0].hint);
  assert.throws(() => compileDraft(d), e => e.diagnostics[0].field === 'judgments[1].applies_when');
});

test('incomplete method roles are named', () => {
  const d = filled();
  d.judgments[0].method = { term: 'tradeoff', roles: { '取舍原则': 'x' } };
  const r = validateInput(d);
  assert.equal(r.diagnostics[0].code, 'method_roles_missing');
  assert.match(r.diagnostics[0].message, /候选方案/);
});

test('full input missing an optional collection is named', () => {
  const full = compileDraft(filled());
  delete full.payload.sources;
  const r = validateInput(full);
  assert.equal(r.diagnostics[0].field, '/payload/sources');
  assert.match(r.diagnostics[0].hint, /"sources": \[\]/);
  assert.equal(validateInput(compileDraft(filled())).status, 'valid');
});

test('scaffoldDraft supports minimal, interview, works, research and rejects unknown modes', () => {
  assert.deepEqual(scaffoldDraft('minimal'), scaffoldDraft());
  assert.equal(scaffoldDraft('interview').judgments[0].method.term, 'tradeoff');
  assert.equal(scaffoldDraft('works').judgments[0].method.term, 'criteria_comparison');
  assert.ok(Array.isArray(scaffoldDraft('works').judgments[0].reasons));
  assert.equal(typeof scaffoldDraft('works').judgments[0].example.summary, 'string');
  assert.equal(scaffoldDraft('research').judgments[0].method.term, 'evidence_analysis');
  assert.throws(() => scaffoldDraft('unknown'), e => e.code === 'KDNA_INVALID_INIT_MODE');
});

test('rich draft fields (type, description, keywords, license, reasons, example) compile and pass Core creation', async () => {
  const d = filled();
  d.asset.type = 'domain';
  d.asset.description = 'Detailed guidance for engineering status updates.';
  d.asset.keywords = ['engineering', 'status-update'];
  d.asset.license = { identifier: 'CC-BY-4.0', uri: 'https://creativecommons.org/licenses/by/4.0/' };
  d.judgments[0].reasons = ['Readers scan the top line first during triage.'];
  d.judgments[0].example = {
    summary: 'Routine Friday engineering note',
    context: 'Weekly async engineering sync with five teams.',
    input: 'Three PRs merged and one staging migration blocked.',
    application: 'Put merged PRs first, staging blocker second, Monday plan third.',
    result: 'Lead unblocked staging within ten minutes without reading chat logs.',
  };
  const compiled = compileDraft(d);
  assert.equal(compiled.manifest.asset_type, 'domain');
  assert.equal(compiled.manifest.description, d.asset.description);
  assert.deepEqual(compiled.manifest.keywords, ['engineering', 'status-update']);
  assert.deepEqual(compiled.manifest.license, d.asset.license);
  assert.equal(compiled.payload.reasons.length, 1);
  assert.deepEqual(compiled.payload.judgments[0].reason_refs, ['reason:update:order:1']);
  assert.equal(compiled.payload.examples.length, 1);
  assert.equal(compiled.payload.examples[0].results[0].statement, d.judgments[0].example.result);
  const checked = await validateWithCore(d);
  assert.equal(checked.status, 'valid', JSON.stringify(checked));
});

test('validateFull accepts all optional 0.6.0 manifest, payload, and rule/conclusion judgment keys', async () => {
  const exampleAuthored = require('../examples/team-update/author.json');
  const validExample = await validateWithCore(exampleAuthored);
  assert.equal(validExample.status, 'valid', JSON.stringify(validExample));
  assert.equal(validExample.input_kind, 'authored');

  const full = compileDraft(filled());
  Object.assign(full.manifest, {
    creator: { actor_ref: 'actor:author', display_name: 'Author' },
    content_digest: 'sha256:' + '0'.repeat(64),
    authoring: { tool: 'kdna-cli', mode: 'native' },
    access: { visibility: 'public' },
    license: { identifier: 'CC-BY-4.0' },
    description: 'Full manifest optional fields check.',
    keywords: ['kdna'],
  });
  Object.assign(full.payload, {
    attributions: [],
    cohesion: { kind: 'system' },
    content_risk: { state: 'none', value: null },
  });
  Object.assign(full.payload.judgments[0], {
    answer_other: null,
    answer_parts: [],
    lifecycle: { status: 'active' },
  });
  // Rule judgment requires formation_rule and forbids result
  const ruleJudgment = structuredClone(full.payload.judgments[1]);
  ruleJudgment.id = 'update:rule-check';
  ruleJudgment.form = 'rule';
  delete ruleJudgment.result;
  ruleJudgment.formation_rule = { statement: 'Derive status from linked issue state.' };
  full.payload.judgments.push(ruleJudgment);

  const localRes = validateInput(full);
  assert.equal(localRes.status, 'valid', JSON.stringify(localRes));
  assert.equal(localRes.judgment_count, 3);

  // Rule judgment with result or without formation_rule is flagged
  const badRule = structuredClone(full);
  badRule.payload.judgments[2].result = full.payload.judgments[0].result;
  delete badRule.payload.judgments[2].formation_rule;
  const badRes = validateInput(badRule);
  assert.equal(badRes.status, 'invalid');
  assert.ok(badRes.diagnostics.some(d => d.field === '/payload/judgments/2/formation_rule' && d.code === 'missing_field'));
  assert.ok(badRes.diagnostics.some(d => d.field === '/payload/judgments/2/result' && d.code === 'invalid_value'));
});

test('validateFull pinpoints duplicate, invalid, and missing roles in method.components', () => {
  const full = compileDraft(filled());
  full.payload.judgments[0].method = {
    method: { term: 'tradeoff' },
    components: [
      { id: 'c1', method: { term: 'tradeoff' }, role: '候选方案', material_refs: [], statement: 'Option A vs Option B.' },
      { id: 'c2', method: { term: 'tradeoff' }, role: '比较因素', material_refs: [], statement: 'Latency vs clarity.' },
      { id: 'c3', method: { term: 'tradeoff' }, role: '不可兼得之处', material_refs: [], statement: 'First cost.' },
      { id: 'c4', method: { term: 'tradeoff' }, role: '不可兼得之处', material_refs: [], statement: 'Second cost.' },
      { id: 'c5', method: { term: 'tradeoff' }, role: '非标准角色', material_refs: [], statement: 'Unknown role.' },
    ],
    bindings: [],
  };
  const r = validateInput(full);
  assert.equal(r.status, 'invalid');
  const dup = r.diagnostics.find(d => d.code === 'duplicate_method_roles');
  assert.ok(dup);
  assert.deepEqual(dup.duplicate_roles, [{ role: '不可兼得之处', component_ids: ['c3', 'c4'] }]);
  assert.equal(dup.fix_hint, DUPLICATE_ROLE_FIX_HINT);
  const inv = r.diagnostics.find(d => d.code === 'invalid_method_roles');
  assert.ok(inv);
  assert.deepEqual(inv.invalid_roles, ['非标准角色']);
  const miss = r.diagnostics.find(d => d.code === 'missing_method_roles');
  assert.ok(miss);
  assert.deepEqual(miss.missing_required_roles, ['取舍原则']);
});

test('MP4 structural advisories stay non-blocking while flagging tautology, unbounded scope, duplicate focus, and uniform default methods', () => {
  const d = filled();
  d.boundaries = null;
  d.judgments = [
    {
      id: 'j:1',
      focus: 'Same focus question',
      statement: 'Same focus question',
      applies_when: 'all',
    },
    {
      id: 'j:2',
      focus: 'Same focus question',
      statement: 'Distinct conclusion.',
      applies_when: 'Routine weekly team updates.',
      method: { term: 'observation', roles: { '观察依据': 'Distinct conclusion.' } },
    },
    {
      id: 'j:3',
      focus: 'Third focus',
      statement: 'Third conclusion.',
      applies_when: 'Routine weekly team updates.',
    },
    {
      id: 'j:4',
      focus: 'Fourth focus',
      statement: 'Fourth conclusion.',
      applies_when: 'Routine weekly team updates.',
    },
  ];
  const r = validateInput(d);
  assert.equal(r.status, 'valid');
  const codes = new Set(r.advisories.map(a => a.code));
  assert.ok(codes.has('tautological_statement'));
  assert.ok(codes.has('method_repeats_statement'));
  assert.ok(codes.has('unbounded_judgment'));
  assert.ok(codes.has('overbroad_scope'));
  assert.ok(codes.has('duplicate_focus'));
  assert.ok(codes.has('uniform_default_method'));
});
