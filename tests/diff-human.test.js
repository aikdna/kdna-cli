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
