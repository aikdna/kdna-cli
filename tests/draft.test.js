'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { admitSectionRequest, inspectWholeSectionSnapshot } = require('@aikdna/kdna-core/sections-node');
const { createNativeSectionByteReadAuthority, admitSectionBytesNode } = require('@aikdna/kdna-core/sections-bytes-node');
const { admitNativeCreationRequest, createNativeCreationAuthority, createSectionAssetNode } = require('@aikdna/kdna-core/creation-sections-node');
const binding = require('../public-contract-binding.json');
const { scaffoldDraft, compileDraft, validateInput, validateWithCore } = require('../src/draft.js');

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
