'use strict';
// End-to-end guard for the honest authoring encodings the field reference
// documents: a method the author never stated stays explicit, an undecided
// in-domain question is kept, and the substitutions the guidance forbids are
// shown to pass admission, so the risk is pinned rather than assumed away.
// The negative cases assert the exact coordinates a rejected input reports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const local = createRequire(path.join(root, 'package.json'));
const { run } = local('@aikdna/kdna-cli');
const example = JSON.parse(fs.readFileSync(path.join(root, 'examples/team-update/author.json'), 'utf8'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-authoring-fidelity-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function sink() {
  const lines = [];
  return { lines, write(value) { lines.push(value); return true; } };
}

async function invoke(argv) {
  const out = sink();
  const code = await run(argv, out);
  const rows = out.lines.join('').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { code, rows, last: rows[rows.length - 1] };
}

function variant(name, mutate) {
  const document = JSON.parse(JSON.stringify(example));
  document.manifest.asset_id = 'asset:' + name;
  document.manifest.asset_uid = 'uid:' + name;
  document.payload.asset.asset_id = 'asset:' + name;
  mutate(document);
  const file = path.join(scratch, name + '.authored.json');
  fs.writeFileSync(file, JSON.stringify(document));
  return { file, output: path.join(scratch, name + '.kdna'), asset_id: 'asset:' + name };
}

async function create(input) {
  return invoke(['create', input.file, '--output', input.output, '--allow-create']);
}

async function readJudgment(input, judgmentId) {
  return invoke(['read', input.output, '--mode', 'exact_selection', '--asset-id', input.asset_id,
    '--asset-version', '1.0.0', '--judgment-id', judgmentId, '--budget', '60000',
    '--view', 'body', '--allow-read']);
}

function judgmentOf(document, id) {
  return document.payload.judgments.find((j) => j.id === id);
}

test('a method the author never stated survives as an explicit other-encoding', async () => {
  const input = variant('fidelity-method-not-stated', (document) => {
    judgmentOf(document, 'update:order').method = {
      method: { term: 'other' },
      other: {
        name: 'Method not stated',
        definition: 'The author states the judgment but has not said how it was formed.',
        exclusion_reason: 'No method term is the author’s statement.',
      },
      components: [
        { id: 'component:order:method-note', method: { term: 'other' }, role: '方法说明', material_refs: [], statement: 'The author has not stated any method.' },
        { id: 'component:order:basis-note', method: { term: 'other' }, role: '判断依据', material_refs: [], statement: 'No basis was stated; the record keeps that absence.' },
        { id: 'component:order:relation-note', method: { term: 'other' }, role: '作用关系', material_refs: [], statement: 'No formation relationship is claimed.' },
      ],
      bindings: [],
    };
  });
  const created = await create(input);
  assert.equal(created.last.status, 'saved', JSON.stringify(created.last));
  const read = await readJudgment(input, 'update:order');
  assert.equal(read.last.status, 'ready', JSON.stringify(read.last));
  const serialized = JSON.stringify(read.last);
  assert.ok(serialized.includes('Method not stated'), 'the stated absence reaches the default body');
  assert.ok(serialized.includes('方法说明'), 'the mandated role components reach the default body');
});

test('an undecided question inside the author’s domain is accepted and readable', async () => {
  const input = variant('fidelity-undecided-in-domain', (document) => {
    document.payload.judgments.push({
      id: 'update:estimates',
      focus: 'Estimates in the weekly update',
      subject: { actor_ids: ['actor:sample-team-author'], statement: 'The example author’s routine weekly team update' },
      scope: { statement: document.payload.scope.statement },
      answer_kind: 'other',
      answer_other: {
        name: 'Undecided',
        definition: 'The author has not yet decided this question; it remains open in their domain.',
        exclusion_reason: 'No listed answer kind fits an undecided question.',
      },
      parent_ref: null,
      form: 'conclusion',
      core_expression: { kind: 'authored', statement: 'I haven’t decided whether estimates belong in the update.', qualification_refs: [] },
      method: {
        method: { term: 'feeling' },
        components: [{ id: 'component:estimates', method: { term: 'feeling' }, role: '个人感受', material_refs: [], statement: 'The author’s felt indecision; not a resolved answer.' }],
        bindings: [],
      },
      material_refs: [], reason_refs: [], content_uses: [], ports: [], inputs: [],
      boundaries: { state: 'none', value: null },
      exceptions: { state: 'none', value: null },
      misuse: { state: 'none', value: null },
      extensions: [],
      result_contract: {
        id: 'result-contract:update:estimates',
        form: { term: 'scalar', vocabulary: 'core' },
        shape: { kind: 'scalar', scalar_type: 'text' },
        minimum: 1, maximum: 1,
        allowed_result_types: [{ term: 'text', vocabulary: 'core' }],
      },
      result: {
        contract_ref: 'result-contract:update:estimates',
        result_type: { term: 'text', vocabulary: 'core' },
        value: { kind: 'text', value: 'I haven’t decided whether estimates belong in the update.' },
      },
    });
    document.payload.reading_order.push('update:estimates');
  });
  const created = await create(input);
  assert.equal(created.last.status, 'saved', JSON.stringify(created.last));
  const read = await readJudgment(input, 'update:estimates');
  assert.equal(read.last.status, 'ready', JSON.stringify(read.last));
  assert.ok(JSON.stringify(read.last).includes('has not yet decided'), 'the undecided state reaches the default body');
});

// The guidance forbids both substitutions below; admission cannot detect them,
// so they are pinned here as the documented risk rather than hidden.
test('an encoder-chosen method term passes admission indistinguishably', async () => {
  const input = variant('fidelity-encoder-chosen-term', (document) => {
    judgmentOf(document, 'update:order').method = {
      method: { term: 'experience' },
      components: [{ id: 'component:order:habit', method: { term: 'experience' }, role: '经验要点', material_refs: [], statement: 'The author’s longstanding habit.' }],
      bindings: [],
    };
  });
  const created = await create(input);
  assert.equal(created.last.status, 'saved', JSON.stringify(created.last));
});

test('the forbidden out-of-domain rewrite of an open question passes admission too', async () => {
  const input = variant('fidelity-moved-out-of-domain', (document) => {
    document.payload.declarations.boundaries = {
      state: 'provided',
      value: [{
        id: 'boundary:estimates', effect: 'out_of_domain',
        statement: 'Whether estimates belong in the update is outside this note’s scope.',
        declared_by: 'actor:sample-team-author', applies_to: { kind: 'asset' }, exception_refs: [],
      }],
    };
  });
  const created = await create(input);
  assert.equal(created.last.status, 'saved', JSON.stringify(created.last));
});

test('a missing method and an empty component list report their exact coordinates', async () => {
  const omitted = variant('fidelity-method-omitted', (document) => {
    delete judgmentOf(document, 'update:order').method;
  });
  const missing = await create(omitted);
  assert.equal(missing.code, 1);
  assert.equal(missing.last.status, 'core_rejected');
  assert.equal(missing.last.core.diagnostics[0].field, '/payload/judgments/0/method');

  const emptied = variant('fidelity-components-empty', (document) => {
    const method = judgmentOf(document, 'update:order').method;
    method.components = [];
  });
  const empty = await create(emptied);
  assert.equal(empty.code, 1);
  assert.equal(empty.last.status, 'core_rejected');
  assert.equal(empty.last.core.diagnostics[0].field, '/payload/judgments/0/method/components');
});

test('a method-role rejection carries an actionable guidance sibling from the installed Core', async () => {
  const emptied = variant('fidelity-guidance-empty-components', (document) => {
    judgmentOf(document, 'update:order').method.components = [];
  });
  const rejected = await create(emptied);
  assert.equal(rejected.code, 1);
  assert.equal(rejected.last.status, 'core_rejected');
  assert.equal(rejected.last.core.diagnostics[0].field, '/payload/judgments/0/method/components');
  assert.deepEqual(rejected.last.guidance, [{
    field: '/payload/judgments/0/method/components',
    reason: 'method_component_roles',
    term: 'feeling',
    missing: ['个人感受'],
    expected: ['个人感受'],
    optional: ['体验说明', '偏好变化'],
  }]);

  const wrongRole = variant('fidelity-guidance-wrong-role', (document) => {
    judgmentOf(document, 'update:order').method.components[0].role = '经验要点';
  });
  const wrong = await create(wrongRole);
  assert.equal(wrong.last.status, 'core_rejected');
  assert.equal(wrong.last.guidance[0].reason, 'method_component_roles');
  assert.deepEqual(wrong.last.guidance[0].missing, ['个人感受']);

  const omitted = variant('fidelity-guidance-method-missing', (document) => {
    delete judgmentOf(document, 'update:order').method;
  });
  const noMethod = await create(omitted);
  assert.equal(noMethod.last.core.diagnostics[0].field, '/payload/judgments/0/method');
  assert.equal(noMethod.last.guidance[0].reason, 'method_missing');
  assert.equal(noMethod.last.guidance[0].field, '/payload/judgments/0/method');
});

test('an accepted creation carries no guidance key and the five core fields stay intact on rejection', async () => {
  const accepted = variant('fidelity-guidance-absent', () => {});
  const created = await create(accepted);
  assert.equal(created.last.status, 'saved');
  assert.equal(Object.hasOwn(created.last, 'guidance'), false);

  const emptied = variant('fidelity-guidance-fields', (document) => {
    judgmentOf(document, 'update:order').method.components = [];
  });
  const rejected = await create(emptied);
  const diagnostic = rejected.last.core.diagnostics[0];
  assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'field', 'severity', 'stage', 'subject']);
  assert.deepEqual(Object.keys(rejected.last.core).sort(), ['component_failure', 'diagnostics', 'reason', 'states', 'status']);
});
