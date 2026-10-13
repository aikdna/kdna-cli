'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../src/public-cli.js');
const binding = require('../public-contract-binding.json');
const fixtures = path.join(__dirname, 'fixtures');
const os = require('node:os');
const { before, after } = require('node:test');
const { Readable } = require('node:stream');
const { admitSectionRequest } = require('@aikdna/kdna-core/sections-node');
const { createNativeSectionByteReadAuthority, admitSectionBytesNode } = require('@aikdna/kdna-core/sections-bytes-node');
let scratch, file;
before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-public-native-'));
  file = path.join(scratch, 'current.kdna');
  const result = await invoke(['create', path.join(fixtures, 'native-graph-cross.authored.json'), '--output', file, '--allow-create']);
  assert.equal(result.code, 0); assert.equal(result.rows[0].status, 'saved');
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const request = (mode = 'exact_selection', handle = null) => ({ request_id: 'cli:test', tuple: binding.tuple, budget_bytes: 1000000, mode, selection: ['catalog', 'whole_asset'].includes(mode) ? null : { asset_id: 'asset:bytes', asset_version: '1.0.0', judgment_ids: ['j:0'] }, handle });
function sink() {
  const chunks = [];
  return { chunks, write(text) { chunks.push(text); return true; } };
}
async function invoke(args, input) {
  const out = sink();
  const code = await run(args, out, input);
  return { code, rows: out.chunks.join('').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('validate delegates current native admission and exact legacy/malformed rejection diagnostics', async () => {
  const request = admitSectionRequest({ request_id: 'validate:control', tuple: binding.tuple, budget_bytes: 100000000, mode: 'whole_asset', selection: null, handle: null });
  const cases = [file, ...JSON.parse(fs.readFileSync(path.join(fixtures, 'core-cases.json'))).map(row => path.join(fixtures, row.file)), ...JSON.parse(fs.readFileSync(path.join(fixtures,'components/component-node-oracles.json'))).rows.map(row=>path.join(fixtures,'components',row.file))];
  for (const candidate of cases) {
    const core = await admitSectionBytesNode(fs.readFileSync(candidate), request, createNativeSectionByteReadAuthority(() => true));
    const { code, rows: [actual] } = await invoke(['validate', candidate, '--json']);
    assert.equal(code, core.status === 'accepted' ? 0 : 1, candidate);
    assert.equal(actual.status, core.status);
    if (core.status !== 'accepted') { const {request_id: actualId, ...a}=actual; const {request_id: controlId, ...c}=core; assert.deepEqual(a,c); }
    else assert.equal(actual.states.action_authorization, 'not_evaluated');
  }
});

test('inspect exposes technical metadata and never grants reading or action authority', async () => {
  const result = await invoke(['inspect', file]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.rows[0].tuple, binding.tuple);
  assert.equal(result.rows[0].judgment_count, 3);
  assert.equal(result.rows[0].states.read_permission, 'not_evaluated');
  assert.equal(result.rows[0].states.writer, 'not_evaluated');
  assert.equal(result.rows[0].content, undefined);
  assert.equal(result.rows[0].ir, undefined);
});

test('local read consent defaults to denial and exact selection preserves required support', async () => {
  const args = ['read', file, '--mode', 'exact_selection', '--asset-id', 'asset:bytes', '--asset-version', '1.0.0', '--judgment-id', 'j:0'];
  const denied = await invoke(args);
  assert.equal(denied.code, 1);
  assert.deepEqual(denied.rows[0], {status:'rejected',code:'KDNA_READ_PERMISSION_REQUIRED',action_authorized:false});
  const allowed = await invoke([...args, '--allow-read']);
  assert.equal(allowed.code, 0);
  // The installed Read package projects the default answer to the body view.
  const body = allowed.rows[0];
  assert.equal(body.view_contract, 'kdna.read.model-view/0.1.0');
  assert.equal(body.view, 'body');
  assert.equal(body.status, 'ready');
  assert.equal(body.fingerprint.recovery.view, 'full');
  assert.ok(body.fingerprint.omitted.envelope.includes('states'));
  for (const role of ['actor', 'boundary', 'exception']) assert.ok(body.content.closure.some(n => n.role === role));
  assert.deepEqual(body.content.closure.filter(n => n.role === 'judgment').map(n => n.value.id), ['j:0']);
  // The explicit full view keeps the enveloped answer and its state record.
  const full = await invoke([...args, '--allow-read', '--view', 'full']);
  assert.equal(full.code, 0);
  assert.equal(full.rows[0].envelope.states.action_authorization, 'not_evaluated');
  assert.deepEqual(full.rows[0].envelope.content.closure, body.content.closure);
});

test('one real session supports all four modes and preserves stable expansion', async () => {
  const out = sink();
  const output = () => out.chunks.map(line => JSON.parse(line));
  async function* input() {
    yield JSON.stringify(request('catalog')) + '\n';
    yield JSON.stringify(request('whole_asset')) + '\n';
    yield JSON.stringify(request()) + '\n';
    const handle = output()[2].envelope.content.expansion_handles.find(h => h.target.id === 'dependency:optional');
    assert.ok(handle);
    yield JSON.stringify(request('expand', handle)) + '\n';
    yield JSON.stringify(request('expand', handle)) + '\n';
  }
  assert.equal(await run(['read', file, '--session', '--allow-read', '--view', 'full'], out, input()), 0);
  const rows = output();
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r, i) => r.envelope.status === (i === 0 ? 'catalog_only' : 'ready')));
  assert.equal(new Set(rows.map(r => r.envelope.snapshot_id)).size, 1);
  assert.deepEqual(rows[3].envelope.content, rows[4].envelope.content);
  assert.deepEqual(rows[3].envelope.content.closure.filter(n => n.role === 'judgment').map(n => n.value.id), ['j:0', 'j:2']);
  const forged = rows[2].envelope.content.expansion_handles.find(h => h.target.id === 'dependency:optional');
  async function* otherSession() { yield JSON.stringify(request('expand', forged)) + '\n'; }
  const rejected = await invoke(['read', file, '--session', '--allow-read'], otherSession());
  assert.equal(rejected.code, 1);
  assert.equal(rejected.rows[0].diagnostic.code, 'READ_HANDLE_STALE');
  assert.equal(rejected.rows[0].body, null); assert.equal(rejected.rows[0].body_bytes, 0);
  // The default session surface projects every answer to the body view.
  async function* defaultSession() { yield JSON.stringify(request('catalog')) + '\n'; yield JSON.stringify(request('whole_asset')) + '\n'; }
  const projected = await invoke(['read', file, '--session', '--allow-read'], defaultSession());
  assert.equal(projected.code, 0);
  assert.equal(projected.rows.length, 2);
  assert.ok(projected.rows.every((row, i) => row.view === 'body' && row.status === (i === 0 ? 'catalog_only' : 'ready') && row.fingerprint.recovery.view === 'full'));
  assert.equal(new Set(projected.rows.map(row => row.fingerprint.snapshot_id)).size, 1);
  assert.deepEqual(projected.rows[1].content.closure, rows[1].envelope.content.closure);
});

test('budget and session transport errors fail closed', async () => {
  const zero = await invoke(['read', file, '--budget', '0', '--allow-read']);
  assert.equal(zero.rows[0].channel, 'no_body_control');
  assert.equal(zero.rows[0].control.body_bytes, 0);
  for (const budget of ['-1', '9007199254740992', '1e3', '01']) assert.equal((await invoke(['read', file, '--budget', budget, '--allow-read'])).code, 2);
  async function* malformed() { yield Buffer.from([0xff, 10]); }
  assert.equal((await invoke(['read', file, '--session', '--allow-read'], malformed())).rows[0].code, 'KDNA_SESSION_JSON_INVALID');
  async function* oversized() { yield Buffer.alloc(1048577, 32); }
  assert.equal((await invoke(['read', file, '--session', '--allow-read'], oversized())).rows[0].code, 'KDNA_SESSION_INPUT_TOO_LARGE');
  assert.equal((await invoke(['read', file, '--session', '--mode', 'catalog'])).code, 2);
  assert.equal((await invoke(['read', file, '--allow-read', '--allow-read'])).code, 2);
});

test('Plan, load and retired commands cannot authorize actions or execute the old runtime', async () => {
  for (const command of ['plan', 'load', 'pack', 'encrypt', 'migrate', 'convert', 'eval', 'route', 'use', 'compose', 'create', 'fork']) {
    const result = await invoke([command, file]);
    assert.equal(result.code, 2, command);
    assert.equal(result.rows[0].status, 'unavailable');
    assert.equal(result.rows[0].action_authorized, false);
  }
  assert.notEqual(require('../package.json').private, true);
  assert.deepEqual(require('../package.json').files, ['LICENSE', 'LICENSE-DOCS', 'NOTICE', 'README.md', 'public-contract-binding.json', 'src/cli.js', 'src/public-cli.js', 'src/authored-input.js', 'src/source-input.js', 'SECURITY.md', 'docs/authoring-field-reference.md', 'docs/asset-authorization.md', 'docs/consumption-runtime.md', 'docs/native-delivery.md', 'examples/native-workflow.cjs', 'examples/team-update/author.json', 'examples/team-update/README.md']);
});

test('the actual executable handles version, valid input, rejection and unavailable Plan', () => {
  const cli = path.join(__dirname, '../src/cli.js');
  for (const [args, code] of [[['--version'], 0], [['validate', file], 0], [['validate', path.join(fixtures, 'hostile-json-invalid-utf8.kdna')], 1], [['plan', file], 2]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, code, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.endsWith('\n'));
  }
});
