'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { admitSectionRequest, inspectWholeSectionSnapshot } = require('@aikdna/kdna-core/sections-node');
const { createNativeSectionByteReadAuthority, admitSectionBytesNode } = require('@aikdna/kdna-core/sections-bytes-node');
const { admitNativeCreationRequest, createNativeCreationAuthority, createSectionAssetNode } = require('@aikdna/kdna-core/creation-sections-node');
const { getMethodRoleTable } = require('@aikdna/kdna-core/components');
const binding = require('../public-contract-binding.json');
const { ROLE_ALIASES_EN, DUPLICATE_ROLE_FIX_HINT, scaffoldDraft, compileDraft, validateInput, validateWithCore } = require('../src/draft.js');

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
  assert.deepEqual(miss.missing_required_roles, ['priority_rule']);
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

test('English role aliases cover 100% of Core method_roles, compile to canonical ASCII roles, and omitted method defaults to other', async () => {
  const coreRoles = getMethodRoleTable().roles;
  assert.deepEqual(Object.keys(ROLE_ALIASES_EN).sort(), Object.keys(coreRoles).sort());
  for (const [term, spec] of Object.entries(coreRoles)) {
    const mapped = Object.keys(ROLE_ALIASES_EN[term]).sort();
    const expected = [...spec.required, ...spec.optional].sort();
    assert.deepEqual(mapped, expected, `alias coverage for ${term}`);
  }

  // Omitted method in draft defaults to 'other' (KT-028) rather than assuming 'feeling'
  const omittedCompiled = compileDraft(filled());
  assert.equal(omittedCompiled.payload.judgments[0].method.method.term, 'other');
  assert.ok(omittedCompiled.payload.judgments[0].method.other.name);
  assert.deepEqual(omittedCompiled.payload.judgments[0].method.components.map(c => c.role), ['method_description', 'basis', 'relation']);
  // Legacy Chinese role key in draft compiles to canonical ASCII role
  assert.deepEqual(omittedCompiled.payload.judgments[1].method.components.map(c => c.role), ['observed_basis']);

  for (const mode of ['minimal', 'interview', 'works', 'research']) {
    const enScaffold = scaffoldDraft(mode, { lang: 'en' });
    assert.equal(enScaffold.asset.type, 'domain');
    if (typeof enScaffold.judgments[0].method === 'object') {
      for (const rk of Object.keys(enScaffold.judgments[0].method.roles)) {
        assert.match(rk, /^[a-z_]+$/, `English scaffold role key should be ASCII snake_case: ${rk}`);
      }
    }
    const zhScaffold = scaffoldDraft(mode, { lang: 'zh' });
    assert.equal(zhScaffold.asset.language, 'zh-CN');
    if (typeof zhScaffold.judgments[0].method === 'object') {
      for (const rk of Object.keys(zhScaffold.judgments[0].method.roles)) {
        assert.match(rk, /^[a-z_]+$/, `Chinese scaffold role key should also be ASCII snake_case: ${rk}`);
      }
    }

    for (const lang of ['en', 'zh']) {
      const ex = scaffoldDraft(mode, { lang, example: true });
      const checked = await validateWithCore(ex);
      assert.equal(checked.status, 'valid', `${mode}/${lang}: ` + JSON.stringify(checked));
      assert.deepEqual(checked.advisories, [], `${mode}/${lang} example should have zero advisories`);
      const compiledEx = compileDraft(ex);
      for (const comp of compiledEx.payload.judgments[0].method.components) {
        assert.match(comp.role, /^[a-z_]+$/, `compiled wire role must be ASCII: ${comp.role}`);
      }
    }
  }

  const zhMinimal = compileDraft(scaffoldDraft('minimal', { lang: 'zh', example: true }));
  assert.equal(zhMinimal.payload.judgments[0].method.components[0].role, 'personal_preference');
  assert.match(zhMinimal.payload.judgments[0].method.components[0].statement, /主观偏好/);
});

test('extended kdna.draft/1 (creator, worldview, value_order, sources, sections, relationships, exceptions, misuse, rule, answer_other) compiles and passes Core', async () => {
  const rich = {
    format: 'kdna.draft/1',
    asset: {
      id: 'rich-system-test',
      type: 'domain',
      title: 'Rich Extended System Fixture',
      summary: 'Verifies all extended kdna.draft/1 constructs against Core 0.37.11.',
      language: 'en',
      version: '1.0.0',
      keywords: ['governance', 'review'],
      license: { identifier: 'Apache-2.0' },
    },
    scope: 'Routine operational decisions; live catastrophic incidents follow emergency playbooks.',
    actors: [{ id: 'lead', name: 'Alex Rivera', kind: 'person' }],
    creator: { id: 'lead', name: 'Alex Rivera', kind: 'person' },
    highest_question: 'How should routine review rules, open questions, and emergency exceptions work together?',
    boundaries: 'Applies to routine review workflows; does not override statutory compliance.',
    exceptions: [{
      when: 'A verified active SEV-1 outage requires immediate service restoration',
      statement: 'Waive routine asset-wide pacing limits during verified SEV-1 containment.',
      then: 'waive',
    }],
    misuse: ['Do not apply these operational guidelines as legal advice.'],
    worldview: ['Small reversible experiments beat large speculative rewrites.'],
    value_order: ['Data integrity over delivery speed', 'Clarity over cleverness'],
    sources: [{
      id: 'src:handbook',
      title: 'Operations Handbook',
      identity: 'Internal Operations Handbook 2026',
      version: '2026.1',
      uri: 'https://example.org/handbook',
    }],
    sections: [
      { id: 'sec:core', number: 'I', title: 'Core Standards & Rules', judgments: ['j:throttle', 'j:rule-triage'] },
      { id: 'sec:limits', number: 'II', title: 'Brakes & Open Frontier', judgments: ['j:brake', 'j:open-question'] },
    ],
    relationships: [
      { kind: 'qualify', from: 'j:brake', to: 'j:throttle', statement: 'Emergency brake qualifies the default net-health threshold.' },
      { kind: 'conflict', from: 'j:throttle', to: 'j:rule-triage', statement: 'Speed of triage can conflict with deep net-health review.' },
      { kind: 'support', from: 'j:brake', to: 'j:rule-triage', statement: 'Safety floor supports triage priority.' },
      { kind: 'complement', from: 'j:open-question', to: 'j:throttle', statement: 'Open frontier tracks evolving AI-assisted review scope.' },
    ],
    judgments: [
      {
        id: 'j:throttle',
        focus: 'When to approve a routine change based on net code health',
        statement: 'Approve changes that measurably improve overall health once blocking defects are resolved.',
        applies_when: 'Reviewing routine pull requests outside active outage mitigation.',
        boundaries: 'Never applies when a change introduces untested data-migration failure paths.',
        exceptions: [{
          when: 'An active P0 outage requires a surgical ten-line hotfix',
          statement: 'During verified outage containment, replace polish checks with minimal-blast-radius restoration.',
          then: 'replace_boundary',
          replace_boundary: 'Require only zero irreversible data loss and a mandatory post-incident follow-up ticket.',
        }],
        misuse: ['Do not treat net improvement as license to skip security review.'],
        source_refs: ['src:handbook'],
        answer_kind: 'guidance',
        method: {
          term: 'criteria_comparison',
          roles: {
            criterion: 'Net maintainability improves and zero blocking defects remain.',
            comparison_method: 'Check correctness, failure paths, and complexity delta against baseline.',
            decision_rule: 'Approve when blocking issues are zero and net health improves.',
          },
        },
      },
      {
        id: 'j:rule-triage',
        focus: 'How to route incoming review comments into blocking versus non-blocking tiers',
        form: 'rule',
        statement: 'Classify defects touching correctness, security, or data integrity as blocking; label style nits explicitly.',
        formation_rule: {
          statement: 'If a defect can cause data loss, auth bypass, or crash, mark [blocking]; otherwise prefix with Nit:.',
          conditions: ['The change touches production runtime code or persisted schemas.'],
        },
        applies_when: 'Posting review feedback on any team pull request.',
        boundaries: 'Outside style-only formatting PRs handled by automated linters.',
        source_refs: ['src:handbook'],
        answer_kind: 'classification',
        method: {
          term: 'criteria_comparison',
          roles: {
            criterion: 'Risk of correctness, security, or durability failure.',
            comparison_method: 'Inspect affected code paths against severity tiers.',
            decision_rule: 'Mark high-consequence defects blocking and style polish optional.',
          },
        },
      },
      {
        id: 'j:brake',
        focus: 'Hard safety floor that cannot be traded for review velocity',
        statement: 'Hold any change that breaks authorization ownership checks or drops rollback safety.',
        applies_when: 'Evaluating changes to authentication, authorization, or schema migrations.',
        boundaries: 'Does not apply to throwaway local prototypes never merged to main.',
        source_refs: ['src:handbook'],
        answer_kind: 'determination',
        method: {
          term: 'tradeoff',
          roles: {
            options: 'Merge quickly under deadline pressure versus hold for security and rollback checks.',
            factors: 'Short-term schedule versus irreversible security or data corruption.',
            priority_rule: 'Security and rollback safety always outrank short-term delivery speed.',
            accepted_cost: 'Accept short-term review delay.',
          },
        },
      },
      {
        id: 'j:open-question',
        focus: 'Whether fully automated AI pre-approvals should ever bypass human sign-off',
        statement: 'Still undecided; we keep human sign-off mandatory while collecting failure telemetry.',
        applies_when: 'Evaluating future automation of low-risk dependency bumps.',
        boundaries: 'Applies only to future policy exploration, not current production merges.',
        answer_kind: 'other',
        answer_other: 'Open operational question pending six months of false-negative telemetry.',
        source_refs: ['src:handbook'],
      },
    ],
    timestamp: '2026-11-25T00:00:00Z',
  };

  const compiled = compileDraft(rich);
  assert.deepEqual(compiled.manifest.creator, { id: 'actor:lead', name: 'Alex Rivera', kind: 'person' });
  assert.equal(compiled.payload.attributions.state, 'provided');
  assert.equal(compiled.payload.attributions.value[0].role, 'creator');
  assert.match(compiled.payload.attributions.value[0].statement, /compiled|sources/i);
  assert.equal(compiled.payload.asset_capability, 'mixed');
  assert.deepEqual(compiled.payload.reading_order, ['j:throttle', 'j:rule-triage', 'j:brake', 'j:open-question']);
  assert.equal(compiled.payload.extensions.length, 1);
  assert.equal(compiled.payload.extensions[0].id, 'extension:reading-sections');
  assert.equal(compiled.payload.extensions[0].critical, false);
  assert.equal(compiled.payload.extensions[0].definition, 'kdna.reading-sections/1');
  assert.equal(compiled.payload.relationships.length, 4);
  assert.equal(compiled.payload.shared_declarations.length, 2);
  assert.equal(compiled.payload.sources.length, 1);
  assert.match(compiled.payload.sources[0].identity, /https:\/\/example\.org\/handbook/);
  assert.equal(compiled.payload.source_uses.length, 4);
  assert.equal(compiled.payload.exceptions.length, 1);
  assert.equal(compiled.payload.misuse.length, 1);

  // Critical Reader v0.3.4 invariant: judgment exception condition owner_ref MUST be kind:"judgment"
  const jExcCond = compiled.payload.conditions.find(c => c.id === 'condition:j:throttle:exception:1');
  assert.deepEqual(jExcCond.owner_ref, { kind: 'judgment', id: 'j:throttle' });
  const aExcCond = compiled.payload.conditions.find(c => c.id === 'condition:asset:rich-system-test:exception:1');
  assert.deepEqual(aExcCond.owner_ref, { kind: 'asset', id: 'uid:rich-system-test' });
  assert.deepEqual(compiled.payload.judgments[0].boundaries.value[0].exception_refs, ['exception:j:throttle:1']);
  assert.deepEqual(compiled.payload.declarations.boundaries.value[0].exception_refs, ['exception:asset:rich-system-test:1']);
  assert.equal(compiled.payload.judgments[1].form, 'rule');
  assert.equal(compiled.payload.judgments[1].result, undefined);
  assert.equal(compiled.payload.judgments[1].formation_rule.output_contract_ref, 'result-contract:j:rule-triage');
  assert.equal(compiled.payload.judgments[3].answer_kind, 'other');
  assert.ok(compiled.payload.judgments[3].answer_other.name && compiled.payload.judgments[3].answer_other.definition && compiled.payload.judgments[3].answer_other.exclusion_reason);

  const checked = await validateWithCore(rich);
  assert.equal(checked.status, 'valid', JSON.stringify(checked));

  // Pure rule asset computes asset_capability = 'result_forming_rules'
  const ruleOnly = structuredClone(rich);
  ruleOnly.sections = [{ title: 'Rules', judgments: ['j:rule-triage'] }];
  ruleOnly.relationships = [];
  ruleOnly.judgments = [ruleOnly.judgments[1]];
  assert.equal(compileDraft(ruleOnly).payload.asset_capability, 'result_forming_rules');
  assert.equal((await validateWithCore(ruleOnly)).status, 'valid');

  // Out-of-order draft.judgments vs draft.sections MUST reorder payload.judgments & Core catalog to contiguous section order
  const scrambled = structuredClone(rich);
  // Interleave raw draft.judgments: [j:brake (sec II), j:throttle (sec I), j:open-question (sec II), j:rule-triage (sec I)]
  scrambled.judgments = [rich.judgments[2], rich.judgments[0], rich.judgments[3], rich.judgments[1]];
  scrambled.sections = [
    { id: 'sec:1', number: 'I', title: 'Chapter I', judgments: ['j:throttle', 'j:rule-triage'] },
    { id: 'sec:2', number: 'II', title: 'Chapter II', judgments: ['j:brake', 'j:open-question'] },
  ];
  const compiledScrambled = compileDraft(scrambled);
  assert.deepEqual(
    compiledScrambled.payload.judgments.map(j => j.id),
    ['j:throttle', 'j:rule-triage', 'j:brake', 'j:open-question'],
  );
  assert.deepEqual(
    compiledScrambled.payload.reading_order,
    ['j:throttle', 'j:rule-triage', 'j:brake', 'j:open-question'],
  );
  const producedScrambled = await create(compiledScrambled);
  assert.equal(producedScrambled.status, 'produced', JSON.stringify(producedScrambled).slice(0, 800));
  const reqScrambled = admitSectionRequest({ request_id: 'test:sections-order', tuple: binding.tuple, budget_bytes: 100000000, mode: 'whole_asset', selection: null, handle: null });
  const admScrambled = await admitSectionBytesNode(producedScrambled.bytes, reqScrambled, createNativeSectionByteReadAuthority(() => true));
  assert.equal(admScrambled.status, 'accepted');
  const catalogIds = inspectWholeSectionSnapshot(admScrambled.snapshot).ir.catalog.map(c => c.judgment_id);
  assert.deepEqual(catalogIds, ['j:throttle', 'j:rule-triage', 'j:brake', 'j:open-question']);
  assert.deepEqual(
    scrambled.sections.map(s => catalogIds.indexOf(s.judgments[0])),
    [0, 2],
    'Reader section anchors must land at exact contiguous chapter start indices',
  );
});

test('extended draft validation rejects dangling refs, missing boundaries for exceptions, composite answer_kind, and gives typo hints', () => {
  const d = filled();
  d.relation = [];
  d.judgments[0].reason = ['typo'];
  d.judgments[0].answer_kind = 'composite';
  d.judgments[1].answer_kind = 'other';
  d.judgments[1].exceptions = [{ when: 'Emergency happens', then: 'waive' }];
  d.judgments[1].source_refs = ['src:missing'];
  d.relationships = [{ kind: 'qualify', from: 'update:order', to: 'update:order', statement: 'Self edge.' }];
  d.sections = [{ title: 'Only one', judgments: ['update:order'] }];
  const r = validateInput(d);
  assert.equal(r.status, 'invalid');
  const byField = field => r.diagnostics.find(x => x.field === field);
  assert.match(byField('relation').hint, /Did you mean "relationships"\?/);
  assert.match(byField('judgments[0].reason').hint, /Did you mean "reasons"\?/);
  assert.equal(byField('judgments[0].answer_kind').code, 'invalid_value');
  assert.equal(byField('judgments[1].answer_other').code, 'missing_field');
  assert.equal(byField('judgments[1].boundaries').code, 'missing_field');
  assert.equal(byField('judgments[1].source_refs[0]').code, 'unknown_reference');
  assert.equal(byField('relationships[0].to').code, 'invalid_value');
  assert.equal(byField('sections').code, 'incomplete_sections');
});

test('K22-respecting advisories fire on short focus, unbounded absolutism, isolated 6+ judgments, and research provenance mismatch while sparing small taste drafts', () => {
  // Small taste draft (4 preference judgments omitting method) should NOT trigger uniform_default_method
  const taste = filled();
  taste.judgments = [1, 2, 3, 4].map(n => ({
    id: `taste:${n}`,
    focus: `Visual framing choice number ${n} in street photography`,
    statement: `Prefer natural light framing rule ${n} for personal prints.`,
    applies_when: 'Personal street photography portfolio culling.',
    boundaries: 'Does not apply to commercial studio briefs.',
    answer_kind: 'preference',
  }));
  const tasteRes = validateInput(taste);
  assert.equal(tasteRes.status, 'valid');
  assert.ok(!tasteRes.advisories.some(a => a.code === 'uniform_default_method'), JSON.stringify(tasteRes.advisories));

  // Large isolated research draft with short focus, absolutism, feeling method, and missing source_refs
  const messy = filled();
  messy.sources = [{ id: 'src:1', identity: 'Reference study 2026' }];
  messy.judgments = [1, 2, 3, 4, 5, 6].map(n => ({
    id: `j:${n}`,
    focus: n === 1 ? 'Short' : `Distinct research question number ${n} in study`,
    statement: n === 1 ? 'Always apply this rule without exception.' : `Evidence-backed stance ${n}.`,
    applies_when: 'Evaluating peer-reviewed benchmarks.',
    ...(n === 1 ? {} : { boundaries: 'Stops when fresh benchmarks contradict.' }),
    method: n === 2 ? 'feeling' : 'other',
  }));
  const messyRes = validateInput(messy);
  assert.equal(messyRes.status, 'valid');
  const codes = new Set(messyRes.advisories.map(a => a.code));
  assert.ok(codes.has('vague_or_short_focus'));
  assert.ok(codes.has('unbounded_absolutism'));
  assert.ok(codes.has('isolated_multi_judgment'));
  assert.ok(codes.has('research_provenance_mismatch'));
});
