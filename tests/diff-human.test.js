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

test('compact and human read preserve full mandatory safety closure, relationships, CJK wrapping, and human rejections', async () => {
  const projected = {
    view_contract: 'kdna.read.model-view/0.2.0',
    view: 'body',
    status: 'ready',
    fingerprint: {
      request_id: 'cli:closure-test',
      snapshot_id: 'section-snapshot:closure-test',
      asset: { asset_id: 'asset:closure-fixture', asset_version: '1.0.0', judgment_version: '1.0.0' },
      attested: { A: 'sha256:' + 'a'.repeat(64), C: 'sha256:' + 'b'.repeat(64), E: 'sha256:' + 'c'.repeat(64) },
    },
    content: {
      selected: { asset_id: 'asset:closure-fixture', asset_version: '1.0.0', judgment_ids: ['judgment:claim'] },
      declarations: [{
        id: 'ad:1',
        role: 'asset_declaration',
        value: {
          title: '判断系统闭包测试作品',
          scope: { statement: '适用于验证按需读取时的强制安全闭包与反误用规则保留。' },
          declarations: {
            highest_question: { state: 'provided', value: '如何在裁剪结构冗余的同时完整保留边界与关系闭包？' },
            boundaries: { state: 'provided' },
          },
        },
      }],
      closure: [
        {
          id: 'b:1',
          role: 'boundary',
          owner: { kind: 'asset', id: 'uid:closure-fixture' },
          owner_judgment_id: null,
          value: {
            id: 'boundary:asset-scope',
            effect: 'limit',
            statement: '本测试资产仅用于验证按需选读的强制闭包投射，不得把读取成功当作判断已经得到现实效果证明或取代人工授权决定。',
            applies_to: { kind: 'asset' },
          },
        },
        {
          id: 'm:1',
          role: 'misuse',
          owner: { kind: 'asset', id: 'uid:closure-fixture' },
          owner_judgment_id: null,
          value: { id: 'misuse:no-silent-override', statement: '禁止在未核对任务相关性时机械套用全部判断。' },
        },
        {
          id: 'sd:1',
          role: 'shared_declaration',
          owner: { kind: 'asset', id: 'uid:closure-fixture' },
          owner_judgment_id: null,
          value: { id: 'shared:order', kind: 'value_order', value: ['边界完整性优先于字节压缩率', '显式确认优先于静默升级'] },
        },
        {
          id: 'r:1',
          role: 'reason',
          owner: { kind: 'asset', id: 'uid:closure-fixture' },
          owner_judgment_id: null,
          value: { id: 'reason:claim:1', role: 'support', judgment_ref: 'judgment:claim', statement: '一旦剥离资产级边界与限定关系，下游Agent就会在越界场景误用孤立结论。' },
        },
        {
          id: 'ex:1',
          role: 'example',
          owner: { kind: 'asset', id: 'uid:closure-fixture' },
          owner_judgment_id: null,
          value: {
            id: 'example:claim',
            title: '选读带限定关系的判断',
            context: '调用方仅请求单条目标判断。',
            adopted_judgments: [{ kind: 'local', judgment_id: 'judgment:claim' }],
            application: '连同资产边界、反误用声明及上游限定判断一并保留。',
            results: [{ id: 'res:1', kind: 'disposition', statement: '避免断章取义。' }],
          },
        },
        {
          id: 'mat:1',
          role: 'material',
          owner: { kind: 'asset', id: 'uid:closure-fixture' },
          owner_judgment_id: null,
          value: { id: 'material:spec', kind: 'foundation', statement: '公共契约要求按需选读返回强制闭包。' },
        },
        {
          id: 'j:claim',
          role: 'judgment',
          owner: { kind: 'asset', id: 'uid:closure-fixture' },
          value: {
            id: 'judgment:claim',
            focus: '紧凑模式下的闭包完整性',
            scope: { statement: '调用 kdna read --compact 读取单条或多条判断时。' },
            core_expression: { kind: 'authored', statement: '裁剪重复包装字段时，必须保留资产边界、反误用声明、判断间关系及支撑理由。' },
            method: {
              method: { term: 'tradeoff' },
              components: [
                { id: 'c1', method: { term: 'tradeoff' }, role: '取舍原则', statement: '安全闭包完整性优先于极限体积压缩。' },
              ],
            },
            reason_refs: ['reason:claim:1'],
            material_refs: ['material:spec'],
            boundaries: { state: 'provided', value: [{ id: 'b:j1', effect: 'limit', statement: '仅裁剪IR包装噪音，不改变Core原始语义。' }] },
            result_contract: { id: 'rc:1' },
          },
        },
        {
          id: 'j:qualifier',
          role: 'judgment',
          owner: { kind: 'asset', id: 'uid:closure-fixture' },
          value: {
            id: 'judgment:qualifier',
            focus: '上游限定前提',
            scope: { statement: '解释主判断的适用前提时。' },
            core_expression: { kind: 'authored', statement: '紧凑投影本身不构成新的协议层，完整信封仍由 --view raw 提供。' },
          },
        },
      ],
      relationships: [{
        id: 'rel:qualify:1',
        kind: { term: 'qualify' },
        participants: [
          { role: { term: 'qualifier' }, judgment_ref: 'judgment:qualifier' },
          { role: { term: 'qualified' }, judgment_ref: 'judgment:claim' },
        ],
        statement: '上游前提限定了紧凑投影的职责边界。',
      }],
    },
  };

  const compact = compactReadResult(projected);
  assert.equal(compact.declarations.boundaries.state, 'provided');
  assert.equal(compact.declarations.boundaries.value[0].id, 'boundary:asset-scope');
  assert.equal(compact.declarations.misuse.value[0].id, 'misuse:no-silent-override');
  assert.equal(compact.declarations.shared_declarations[0].id, 'shared:order');
  assert.equal(compact.related_judgments.length, 1);
  assert.equal(compact.related_judgments[0].id, 'judgment:qualifier');
  assert.equal(compact.relationships.length, 1);
  assert.equal(compact.relationships[0].kind.term, 'qualify');
  assert.equal(compact.reasons[0].id, 'reason:claim:1');
  assert.equal(compact.materials[0].id, 'material:spec');
  assert.equal(compact.examples[0].id, 'example:claim');

  for (const source of [projected, compact]) {
    const human = renderReadHuman(source);
    assert.match(human, /Asset boundaries:/);
    assert.match(human, /- \[limit\] 本测试资产仅用于验证/);
    assert.doesNotMatch(human, /- \[limit\]\s*\n/, 'CJK line wrapper must not strand - [limit] alone on a line');
    assert.match(human, /Asset anti-misuse:/);
    assert.match(human, /Shared declarations:/);
    assert.match(human, /Method \(tradeoff\):/);
    assert.match(human, /Reasons:/);
    assert.match(human, /Examples:/);
    assert.match(human, /Related judgment \(closure\) judgment:qualifier/);
    assert.match(human, /Relationships \(1\):/);
    for (const line of human.split('\n')) assert.ok(line.length <= 100, 'CJK wrapped line length <= 100: ' + line);
  }

  // Human error routing never emits raw JSON or suggests --view raw on inspect/diff
  const badInspect = spawnSync(process.execPath, [CLI, 'inspect', '/nonexistent/missing.kdna', '--format', 'human'], { encoding: 'utf8' });
  assert.equal(badInspect.status, 1);
  assert.ok(!badInspect.stdout.trimStart().startsWith('{'));
  assert.doesNotMatch(badInspect.stdout, /--view raw/);

  const badDiff = spawnSync(process.execPath, [CLI, 'diff', '/nonexistent/a.kdna', '/nonexistent/b.kdna', '--format', 'human'], { encoding: 'utf8' });
  assert.equal(badDiff.status, 1);
  assert.ok(!badDiff.stdout.trimStart().startsWith('{'));
  assert.match(badDiff.stdout, /^diff: rejected KDNA_ASSET_INPUT_INVALID/);

  if (have) {
    const deniedHuman = spawnSync(process.execPath, [CLI, 'read', V1, '--mode', 'catalog', '--format', 'human'], { encoding: 'utf8' });
    assert.equal(deniedHuman.status, 1);
    assert.ok(!deniedHuman.stdout.trimStart().startsWith('{'));
    assert.match(deniedHuman.stdout, /KDNA_READ_PERMISSION_REQUIRED/);
  }
});

test('diff deduplicates judgment-owned IR mirror nodes and identical result/core_expression statement edits', { skip: !have }, async () => {
  const left = await viewOf(V1), right = await viewOf(V11);
  const diff = diffViews(left, right);
  assert.ok(!diff.declarations.changed.some(c => c.id.startsWith('result|') || c.id.startsWith('method_component|')));
  const text = renderDiffHuman(diff);
  const changedSection = text.slice(text.indexOf('~ update:order'), text.indexOf('Relations'));
  assert.match(changedSection, /core_expression\.statement/);
  assert.doesNotMatch(changedSection, /result\.value\.value/);
});

const WHITEPAPER = path.resolve(__dirname, '..', '..', 'kdna-assets', 'references', 'public', 'kdna-whitepaper', 'kdna-whitepaper-1.0.1.zh-CN.kdna');
const WHITEPAPER_EN = path.resolve(__dirname, '..', '..', 'kdna-assets', 'references', 'public', 'kdna-whitepaper', 'kdna-whitepaper-1.0.1.en.kdna');
test('flagship whitepaper whole_asset succeeds with default 4 MB budget and --compact retains closure', { skip: !fs.existsSync(WHITEPAPER) }, () => {
  const whole = spawnSync(process.execPath, [CLI, 'read', WHITEPAPER, '--mode', 'whole_asset', '--allow-read'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(whole.status, 0, whole.stderr);
  assert.equal(JSON.parse(whole.stdout).status, 'ready');

  const compactRun = spawnSync(process.execPath, [CLI, 'read', WHITEPAPER, '--mode', 'exact_selection', '--judgment-id', 'judgment:creator-contribution', '--allow-read', '--compact'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(compactRun.status, 0, compactRun.stderr);
  const compact = JSON.parse(compactRun.stdout);
  assert.ok(compact.declarations?.boundaries?.value?.length > 0, 'asset-wide boundaries preserved');
  assert.ok(compact.declarations?.misuse?.value?.length > 0, 'asset-wide misuse preserved');
  assert.ok(compact.relationships?.length > 0, 'qualify relationship preserved');
  assert.ok(compact.related_judgments?.some(j => j.id === 'judgment:stronger-ai'), 'mandatory closure qualifier judgment preserved');
});

test('renderReadHuman displays English method-role aliases on English assets and Chinese roles on Chinese assets', () => {
  const enProjected = {
    view_contract: 'kdna.read.model-view/0.2.0',
    view: 'body',
    status: 'ready',
    mode: 'exact_selection',
    asset: { asset_id: 'asset:en-fixture', asset_version: '1.0.1', title: 'English Fixture', languages: ['en'] },
    selection: { asset_id: 'asset:en-fixture', asset_version: '1.0.1', judgment_ids: ['j:en'] },
    content: {
      closure: [{
        id: 'j:en',
        role: 'judgment',
        value: {
          id: 'j:en',
          focus: 'English role rendering',
          scope: { statement: 'When reading an English judgment work in human mode.' },
          core_expression: { kind: 'authored', statement: 'Render human method roles in English while leaving wire JSON untouched.' },
          method: {
            method: { term: 'interpretation' },
            components: [
              { id: 'c1', method: { term: 'interpretation' }, role: '解读对象', statement: 'Canonical role token in Core IR.' },
              { id: 'c2', method: { term: 'interpretation' }, role: '解释关系', statement: 'Display-layer alias mapping for human text.' },
            ],
          },
        },
      }],
    },
  };
  for (const input of [enProjected, compactReadResult(enProjected)]) {
    const out = renderReadHuman(input);
    assert.match(out, /- \[subject_interpreted\] Canonical role token in Core IR\./);
    assert.match(out, /- \[interpretive_link\] Display-layer alias mapping for human text\./);
    assert.ok(!/[\u4e00-\u9fff]/u.test(out), 'English human output must not leak raw Chinese role keys: ' + out);
  }
  if (fs.existsSync(WHITEPAPER_EN)) {
    const enCli = spawnSync(process.execPath, [CLI, 'read', WHITEPAPER_EN, '--mode', 'exact_selection', '--judgment-id', 'judgment:work-itself,judgment:creation-restraint,judgment:safe-consumption', '--format', 'human', '--allow-read'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(enCli.status, 0, enCli.stderr);
    assert.match(enCli.stdout, /\[subject_interpreted\]/);
    assert.ok(!/[\u4e00-\u9fff]/u.test(enCli.stdout), 'English whitepaper --format human must contain zero Chinese characters');
  }
});

test('clean human diff hides IR reference & ID wiring noise by default, shows --verbose and downstream impact', { skip: !have }, async () => {
  const left = await viewOf(V1), right = await viewOf(V11);
  const diff = diffViews(left, right);
  const clean = renderDiffHuman(diff);
  const verbose = renderDiffHuman(diff, { verbose: true });

  // Clean default hides internal IR reference edges and internal ID wiring noise
  assert.doesNotMatch(clean, /reference\|judgment:/);
  assert.match(clean, /internal IR reference edge changes? hidden; pass --verbose to show/);
  assert.doesNotMatch(clean, /method\.components\[0\]\.id/);
  assert.match(clean, /internal ID\/wiring field changes? hidden; pass --verbose to inspect/);

  // Verbose mode restores 100% lossless internal details
  assert.match(verbose, /reference\|judgment:update:order->method_component:/);
  assert.match(verbose, /method\.components\[0\]\.id/);

  // CLI flag --verbose works cleanly
  const cliClean = spawnSync(process.execPath, [CLI, 'diff', V1, V11, '--format', 'human'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(cliClean.status, 0, cliClean.stderr);
  assert.doesNotMatch(cliClean.stdout, /reference\|judgment:/);
  const cliVerbose = spawnSync(process.execPath, [CLI, 'diff', V1, V11, '--format', 'human', '--verbose'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(cliVerbose.status, 0, cliVerbose.stderr);
  assert.match(cliVerbose.stdout, /reference\|judgment:update:order->method_component:/);

  // Downstream impact (`affected_by_change`) surfaces related judgments when a supporter/qualifier/conflict peer changes
  const modLeft = clone(left), modRight = clone(left);
  modLeft.ir.relationships = [
    { id: 'rel:sup', kind: { term: 'support' }, participants: [{ role: { term: 'supporter' }, judgment_ref: 'update:order' }, { role: { term: 'claim' }, judgment_ref: 'update:evidence' }] },
    { id: 'rel:comp', kind: { term: 'complement' }, participants: [{ role: { term: 'supplement' }, judgment_ref: 'update:order' }, { role: { term: 'base' }, judgment_ref: 'update:rationale' }] },
  ];
  modRight.ir.relationships = clone(modLeft.ir.relationships);
  const orderNode = modRight.ir.nodes.find(n => n.role === 'judgment' && n.target.id === 'update:order');
  orderNode.value.core_expression.statement = 'Blockers always lead before shipped changes.';
  const impactDiff = diffViews(modLeft, modRight);
  assert.equal(impactDiff.affected_by_change.length, 1);
  assert.equal(impactDiff.affected_by_change[0].judgment_id, 'update:evidence');
  assert.equal(impactDiff.affected_by_change[0].affected_by[0].kind, 'support');
  const impactText = renderDiffHuman(impactDiff);
  assert.match(impactText, /Affected related judgments \(1 downstream to review\)/);
  assert.match(impactText, /update:evidence.*support from update:order/);
  assert.doesNotMatch(impactText, /update:rationale.*complement/);
});

test('kdna review renders complete one-page author review sheet and enforces --allow-read & non-overwrite', { skip: !have }, () => {
  const os = require('node:os');
  // Without --allow-read, refuses with KDNA_READ_PERMISSION_REQUIRED
  const denied = spawnSync(process.execPath, [CLI, 'review', V1], { encoding: 'utf8' });
  assert.equal(denied.status, 1);
  assert.match(denied.stdout, /KDNA_READ_PERMISSION_REQUIRED/);

  // Markdown default includes Quick Sign-off Summary table at top before full details, with zero JSON dumps or broken object interpolations
  const mdRun = spawnSync(process.execPath, [CLI, 'review', V1, '--allow-read'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(mdRun.status, 0, mdRun.stderr);
  assert.match(mdRun.stdout, /^# A sample author/);
  assert.match(mdRun.stdout, /## 1\. Quick Sign-off Summary \(3 Judgments\)/);
  assert.match(mdRun.stdout, /\| # \| Judgment ID \| Core Question \| Core Claim \| Guardrails \| Sign-off \|/);
  assert.match(mdRun.stdout, /\| 1 \| `update:order` \|.*\| \[ \] \|/);
  assert.ok(
    mdRun.stdout.indexOf('## 1. Quick Sign-off Summary') < mdRun.stdout.indexOf('Full Judgment-by-Judgment Review Sheet'),
    'Quick Sign-off Summary table must appear before detailed judgment review sections'
  );
  assert.match(mdRun.stdout, /`update:order`/);
  assert.match(mdRun.stdout, /`update:evidence`/);
  assert.match(mdRun.stdout, /`update:rationale`/);
  assert.ok(!mdRun.stdout.includes('[object Object]'), 'review output must never contain [object Object]');
  assert.ok(!/\bundefined\b/.test(mdRun.stdout), 'review output must never contain literal undefined');
  assert.ok(!/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/u.test(mdRun.stdout), 'English review sheet must contain zero CJK/fullwidth characters');

  // JSON format returns kdna.review/1 and unwraps kernel.purpose safely (never an object)
  const jsonRun = spawnSync(process.execPath, [CLI, 'review', V1, '--allow-read', '--format', 'json'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.format, 'kdna.review/1');
  assert.equal(parsed.judgment_count, 3);
  assert.ok(parsed.asset.purpose === null || typeof parsed.asset.purpose === 'string');

  // Also verify Whitepaper & writing-craft (when available on disk) render authored purpose with 0 [object Object] / 0 undefined
  const extraAssets = [
    WHITEPAPER_EN,
    path.resolve(__dirname, '..', '..', '..', 'private', 'kdna-library', 'dist', 'assets', 'kdna-whitepaper-1.0.2.zh-CN.kdna'),
    path.resolve(__dirname, '..', '..', '..', 'private', 'kdna-library', 'staged', 'modern', 'out', 'kdna-writing-craft-1.0.0.zh-CN.kdna'),
    path.resolve(__dirname, '..', '..', '..', 'private', 'kdna-library', 'staged', 'modern', 'out', 'kdna-writing-craft-1.0.0.en.kdna'),
  ];
  for (const extra of extraAssets) {
    if (!fs.existsSync(extra)) continue;
    const rev = spawnSync(process.execPath, [CLI, 'review', extra, '--allow-read'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(rev.status, 0, rev.stderr);
    assert.ok(!rev.stdout.includes('[object Object]'), `review of ${path.basename(extra)} must not contain [object Object]`);
    assert.ok(!/\bundefined\b/.test(rev.stdout), `review of ${path.basename(extra)} must not contain literal undefined`);
    assert.match(rev.stdout, /\*\*(Purpose|核心目的)\*\*:/, `review of ${path.basename(extra)} should render authored kernel.purpose statement`);
  }

  // --output saves once, refuses overwriting, infers JSON for .json suffix, and rejects mismatched format/extension
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-review-test-'));
  try {
    // Minimal scaffolded asset (`init --example` -> `create --draft`) also has 0 [object Object] / 0 undefined
    const minDraft = path.join(tmpDir, 'min-draft.json');
    const minAsset = path.join(tmpDir, 'min.kdna');
    assert.equal(spawnSync(process.execPath, [CLI, 'init', '--example', '--output', minDraft], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync(process.execPath, [CLI, 'create', '--draft', minDraft, '--output', minAsset, '--allow-create'], { encoding: 'utf8' }).status, 0);
    const minRev = spawnSync(process.execPath, [CLI, 'review', minAsset, '--allow-read'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(minRev.status, 0, minRev.stderr);
    assert.ok(!minRev.stdout.includes('[object Object]'));
    assert.ok(!/\bundefined\b/.test(minRev.stdout));

    const outFile = path.join(tmpDir, 'sheet.md');
    const saved = spawnSync(process.execPath, [CLI, 'review', V1, '--allow-read', '--output', outFile], { encoding: 'utf8' });
    assert.equal(saved.status, 0, saved.stderr);
    assert.ok(fs.existsSync(outFile));
    assert.equal(fs.readFileSync(outFile, 'utf8'), mdRun.stdout);
    const overwrite = spawnSync(process.execPath, [CLI, 'review', V1, '--allow-read', '--output', outFile], { encoding: 'utf8' });
    assert.equal(overwrite.status, 1);
    assert.match(overwrite.stdout, /KDNA_OUTPUT_EXISTS/);

    // --output *.json infers JSON format automatically; mismatched --format markdown --output *.json rejects
    const outJson = path.join(tmpDir, 'sheet.json');
    const savedJson = spawnSync(process.execPath, [CLI, 'review', V1, '--allow-read', '--output', outJson], { encoding: 'utf8' });
    assert.equal(savedJson.status, 0, savedJson.stderr);
    assert.equal(JSON.parse(fs.readFileSync(outJson, 'utf8')).format, 'kdna.review/1');
    const badCombo = spawnSync(process.execPath, [CLI, 'review', V1, '--allow-read', '--format', 'markdown', '--output', path.join(tmpDir, 'bad.json')], { encoding: 'utf8' });
    assert.equal(badCombo.status, 2);
    assert.match(badCombo.stdout, /KDNA_ARGUMENT_INVALID/);

    // Password-protected asset: refuses without password (no body leak) and renders with --password-file
    const pwFile = path.join(tmpDir, 'pw.txt');
    const protAsset = path.join(tmpDir, 'protected.kdna');
    fs.writeFileSync(pwFile, 'review-secret-pass-42\n');
    const protRun = spawnSync(process.execPath, [CLI, 'protect', V1, '--output', protAsset, '--password-file', pwFile], { encoding: 'utf8' });
    assert.equal(protRun.status, 0, protRun.stderr);
    const lockedRev = spawnSync(process.execPath, [CLI, 'review', protAsset, '--allow-read'], { encoding: 'utf8' });
    assert.equal(lockedRev.status, 1);
    assert.doesNotMatch(lockedRev.stdout, /update:order/);
    const unlockedRev = spawnSync(process.execPath, [CLI, 'review', protAsset, '--allow-read', '--password-file', pwFile], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(unlockedRev.status, 0, unlockedRev.stderr);
    assert.match(unlockedRev.stdout, /`update:order`/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('diff: long 500+ and 2000+ char judgment tail edits are never clipped in human or --verbose output', { skip: !have }, async () => {
  const base = await viewOf(V1);

  // Case 1: 540+ char judgment with ONLY the last 20 characters edited — must print complete before/after in BOTH modes.
  const prefix500 = 'When writing an async team update across engineering, design, and operations, lead with verifiable completed outcomes, name concrete blockers and explicit owners, and record measurable risks rather than chronological calendars. '.repeat(3) + 'HEAD_SENTINEL_500: ';
  const oldTail500 = 'OLD_TAIL_RULE_ALPHA!';
  const newTail500 = 'NEW_TAIL_RULE_OMEGA!';
  assert.ok((prefix500 + oldTail500).length > 500);

  const left500 = clone(base), right500 = clone(base);
  left500.ir.nodes.find(n => n.role === 'judgment' && n.target.id === 'update:order').value.core_expression.statement = prefix500 + oldTail500;
  right500.ir.nodes.find(n => n.role === 'judgment' && n.target.id === 'update:order').value.core_expression.statement = prefix500 + newTail500;

  const diff500 = diffViews(left500, right500);
  const human500 = renderDiffHuman(diff500);
  const verbose500 = renderDiffHuman(diff500, { verbose: true });
  for (const [label, rendered] of [['human', human500], ['verbose', verbose500]]) {
    assert.ok(rendered.includes('HEAD_SENTINEL_500:'), `${label} 500+ char diff must include beginning context`);
    assert.ok(rendered.includes(oldTail500), `${label} 500+ char diff must show exact removed tail`);
    assert.ok(rendered.includes(newTail500), `${label} 500+ char diff must show exact added tail`);
  }

  // Case 2: 2000+ char extra-long judgment with ONLY the last 20 characters edited:
  // default human must show focused diff context containing the exact changed tail;
  // --verbose must never truncate anywhere (both head and tail present).
  const head2000 = 'ULTRA_LONG_HEAD_MARKER: ' + 'This extended guidance paragraph documents detailed operational review trade-offs across multiple release cycles. '.repeat(18);
  const oldTail2000 = 'TAIL_BEFORE_VER_ONE!';
  const newTail2000 = 'TAIL_AFTER_VER_TWO!!';
  assert.ok((head2000 + oldTail2000).length > 2000);

  const left2000 = clone(base), right2000 = clone(base);
  left2000.ir.nodes.find(n => n.role === 'judgment' && n.target.id === 'update:order').value.core_expression.statement = head2000 + oldTail2000;
  right2000.ir.nodes.find(n => n.role === 'judgment' && n.target.id === 'update:order').value.core_expression.statement = head2000 + newTail2000;

  const diff2000 = diffViews(left2000, right2000);
  const human2000 = renderDiffHuman(diff2000);
  const verbose2000 = renderDiffHuman(diff2000, { verbose: true });
  assert.ok(human2000.includes(oldTail2000), 'default human 2000+ char diff must focus on and show removed tail');
  assert.ok(human2000.includes(newTail2000), 'default human 2000+ char diff must focus on and show added tail');
  assert.ok(verbose2000.includes('ULTRA_LONG_HEAD_MARKER:'), '--verbose must never truncate beginning of 2000+ char string');
  assert.ok(verbose2000.includes(oldTail2000), '--verbose must never truncate removed tail of 2000+ char string');
  assert.ok(verbose2000.includes(newTail2000), '--verbose must never truncate added tail of 2000+ char string');
});

test('read --format human and kdna review render Core 0.6.0 conditional exceptions (when + waive/replace_limit), rule judgments, and answer_kind=other', () => {
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-human-exc-'));
  try {
    for (const [lang, isZh] of [['en', false], ['zh-CN', true]]) {
      const draftPath = path.join(tmpDir, `draft-${lang}.json`);
      const assetPath = path.join(tmpDir, `asset-${lang}.kdna`);
      const draft = {
        format: 'kdna.draft/1',
        asset: {
          id: `exc-rule-open-${lang.toLowerCase()}`,
          type: 'domain',
          title: isZh ? '例外与规则渲染验证资产' : 'Exception Rule Open Render Test',
          summary: isZh ? '验证条件例外、规则与开放议题在人类可读与审稿输出中的完整呈现。' : 'Verifies conditional exceptions, rules, and open answers in human read and review.',
          language: lang,
          version: '1.0.0',
        },
        scope: isZh ? '常规评审流程，不含突发安全止血。' : 'Routine reviews outside active security containment.',
        actors: [{ id: 'author', name: isZh ? '测试作者' : 'Test Author', kind: 'person' }],
        highest_question: isZh ? '如何在保留安全阀的同时处理未定议题？' : 'How should conditional guardrails and open questions be rendered?',
        boundaries: isZh ? '仅适用于常规工作流。' : 'Applies only to routine workflows.',
        exceptions: [{
          when: isZh ? '线上出现已核实的 P0 级事故' : 'A verified P0 production outage is active',
          statement: isZh ? 'P0 事故期间豁免资产级常规节拍限制。' : 'Waive routine asset pacing during active P0 outage.',
          then: 'waive',
        }],
        judgments: [
          {
            id: 'j:exc',
            focus: isZh ? '常规净改进门槛在故障止血时的条件替代' : 'Conditional replacement of routine net-health threshold during outages',
            statement: isZh ? '常规评审要求净健康度提升。' : 'Routine reviews require measurable net health improvement.',
            applies_when: isZh ? '评审日常代码变更时。' : 'Reviewing routine pull requests.',
            boundaries: isZh ? '禁止引入未测试的数据迁移分支。' : 'Never applies when untested data migrations are introduced.',
            exceptions: [{
              when: isZh ? '核心交易链路中断需要十行内外科止血补丁' : 'Core checkout is down and needs a ten-line surgical patch',
              statement: isZh ? '止血期间以最小爆炸半径替代常规整洁度要求。' : 'Suspend polish checks in favor of minimal-blast-radius restoration.',
              then: 'replace_boundary',
              replace_boundary: isZh ? '仅要求不造成不可逆数据损坏并登记事后复盘单。' : 'Require only zero irreversible data loss plus a mandatory post-incident ticket.',
            }],
          },
          {
            id: 'j:rule',
            focus: isZh ? '根据故障面自动分级评审意见的规则' : 'Rule for triaging review defects by failure surface',
            form: 'rule',
            statement: isZh ? '按影响面将评审意见分为阻断与建议两档。' : 'Classify review comments into blocking versus nit tiers.',
            formation_rule: {
              statement: isZh ? '触及权限或资金一致性的问题一律标为阻断，其余标为建议。' : 'Mark authorization or ledger integrity defects blocking; label style polish Nit.',
              conditions: [isZh ? '变更触及鉴权中间件或账务写路径。' : 'Diff touches auth middleware or ledger write paths.'],
            },
            applies_when: isZh ? '撰写评审意见时。' : 'Writing code review comments.',
            boundaries: isZh ? '纯文档排版修订不适用。' : 'Excludes pure typography documentation edits.',
          },
          {
            id: 'j:open',
            focus: isZh ? '是否允许自动化机器人免人工复核合入依赖升级' : 'Whether automated bots may auto-merge dependency bumps without human sign-off',
            statement: isZh ? '目前尚未定论，暂保留人工确认。' : 'Remains undecided while false-negative telemetry is gathered.',
            applies_when: isZh ? '讨论依赖升级自动化策略时。' : 'Evaluating dependency-bump automation policies.',
            boundaries: isZh ? '仅用于未来策略评估。' : 'Applies only to future policy evaluation.',
            answer_kind: 'other',
            answer_other: isZh ? '仍在收集六个月误报率数据，暂不锁定结论。' : 'Open policy question pending six months of telemetry.',
          },
        ],
      };
      fs.writeFileSync(draftPath, JSON.stringify(draft, null, 2));
      const created = spawnSync(process.execPath, [CLI, 'create', '--draft', draftPath, '--output', assetPath, '--allow-create'], { encoding: 'utf8' });
      assert.equal(created.status, 0, created.stdout + created.stderr);

      // 1. read --mode exact_selection --format human (non-compact & compact)
      for (const extra of [[], ['--compact']]) {
        const readRun = spawnSync(process.execPath, [
          CLI, 'read', assetPath, '--mode', 'exact_selection',
          '--judgment-id', 'j:exc,j:rule,j:open', '--allow-read', '--format', 'human', ...extra,
        ], { encoding: 'utf8' });
        assert.equal(readRun.status, 0, readRun.stdout + readRun.stderr);
        const out = readRun.stdout;
        const flat = out.replace(/\s+/g, ' ');
        if (isZh) {
          assert.match(out, /Asset exceptions:/);
          assert.match(flat, /触发条件：线上出现已核实的 P0 级事故/);
          assert.match(flat, /效果：豁免原限制/);
          assert.match(flat, /触发条件：核心交易链路中断需要十行内外科止血补丁/);
          assert.match(flat, /替代限制：仅要求不造成不可逆数据损坏并登记事后复盘单/);
          assert.match(flat, /Form: rule（结果形成规则）/);
          assert.match(flat, /Formation rule: 触及权限或资金一致性的问题一律标为阻断/);
          assert.match(flat, /变更触及鉴权中间件或账务写路径/);
          assert.match(flat, /开放\/待定/);
          assert.match(flat, /仍在收集六个月误报率数据/);
        } else {
          assert.match(out, /Asset exceptions:/);
          assert.match(flat, /When: A verified P0 production outage is active/);
          assert.match(flat, /Effect: waive/);
          assert.match(flat, /When: Core checkout is down and needs a ten-line surgical patch/);
          assert.match(flat, /Replacement limit: Require only zero irreversible data loss/);
          assert.match(flat, /Form: rule \(result-forming rule\)/);
          assert.match(flat, /Formation rule: Mark authorization or ledger integrity defects blocking/);
          assert.match(flat, /Diff touches auth middleware or ledger write paths/);
          assert.match(flat, /\[open\/undecided\]/);
          assert.match(flat, /Open policy question pending six months of telemetry/);
          assert.ok(!/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/u.test(out), 'English human read must contain zero CJK/fullwidth characters: ' + out);
        }
      }

      // 2. kdna review (markdown)
      const revRun = spawnSync(process.execPath, [CLI, 'review', assetPath, '--allow-read'], { encoding: 'utf8' });
      assert.equal(revRun.status, 0, revRun.stdout + revRun.stderr);
      const rev = revRun.stdout;
      if (isZh) {
        assert.match(rev, /触发条件：线上出现已核实的 P0 级事故/);
        assert.match(rev, /效果：豁免原限制/);
        assert.match(rev, /触发条件：核心交易链路中断需要十行内外科止血补丁/);
        assert.match(rev, /替代限制：仅要求不造成不可逆数据损坏并登记事后复盘单/);
        assert.match(rev, /\[规则\]/);
        assert.match(rev, /\*\*形成规则\*\*:/);
        assert.match(rev, /\[待定\]/);
        assert.match(rev, /\*\*回答类型\*\*:/);
      } else {
        assert.match(rev, /When: A verified P0 production outage is active/);
        assert.match(rev, /Effect: waive/);
        assert.match(rev, /When: Core checkout is down and needs a ten-line surgical patch/);
        assert.match(rev, /Replacement limit: Require only zero irreversible data loss/);
        assert.match(rev, /\[Rule\]/);
        assert.match(rev, /\*\*Formation Rule\*\*:/);
        assert.match(rev, /\[Open\]/);
        assert.match(rev, /\*\*Answer Kind\*\*:/);
        assert.ok(!/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/u.test(rev), 'English review must contain zero CJK/fullwidth characters: ' + rev);
      }
    }

    // Also verify real code-review-system exemplar (when present on disk) renders `When:` + `Replacement limit:` in BOTH read --format human and review
    const crPath = path.resolve(__dirname, '..', '..', '..', 'private', 'kdna-library', 'staged', 'modern', 'out', 'kdna-code-review-system-1.0.2.en.kdna');
    if (fs.existsSync(crPath)) {
      const crRead = spawnSync(process.execPath, [CLI, 'read', crPath, '--mode', 'exact_selection', '--judgment-id', 'judgment:approve-on-net-code-health-improvement', '--allow-read', '--format', 'human'], { encoding: 'utf8', maxBuffer: 1 << 26 });
      assert.equal(crRead.status, 0, crRead.stderr);
      const crFlat = crRead.stdout.replace(/\s+/g, ' ');
      assert.match(crFlat, /When: An active P0\/SEV-1 production outage/);
      assert.match(crFlat, /Replacement limit: Require only that the surgical patch stops the live outage/);
      const crRev = spawnSync(process.execPath, [CLI, 'review', crPath, '--allow-read'], { encoding: 'utf8', maxBuffer: 1 << 26 });
      assert.equal(crRev.status, 0, crRev.stderr);
      assert.match(crRev.stdout, /When: An active P0\/SEV-1 production outage/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
