'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../src/public-cli.js');
const binding = require('../public-contract-binding.json');
const fixtures = path.join(__dirname, 'fixtures');
const file = path.join(fixtures, 'graph-cross.kdna');
const request = (mode = 'exact_selection', handle = null) => ({ request_id: 'cli:test', tuple: binding.tuple, budget_bytes: 1000000, mode, selection: ['catalog', 'whole_asset'].includes(mode) ? null : { asset_id: 'asset:bytes', asset_version: '1.0.0', judgment_id: 'j:0' }, handle });
function sink() {
  const chunks = [];
  return { chunks, write(text) { chunks.push(text); return true; } };
}
async function invoke(args, input) {
  const out = sink();
  const code = await run(args, out, input);
  return { code, rows: out.chunks.join('').trim().split('\n').filter(Boolean).map(JSON.parse) };
}

test('validate delegates every real container and preserves public diagnostic classification', async () => {
  for (const row of JSON.parse(fs.readFileSync(path.join(fixtures, 'core-cases.json')))) {
    const { code, rows } = await invoke(['validate', path.join(fixtures, row.file), '--json']);
    assert.equal(code, row.result.status === 'accepted' ? 0 : 1, row.name);
    assert.equal(rows[0].status, row.result.status, row.name);
    assert.equal(rows[0].reason, row.result.reason, row.name);
    assert.deepEqual(rows[0].diagnostics, row.result.diagnostics ?? [], row.name);
    assert.equal(rows[0].states.action_authorization, 'not_evaluated');
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
  assert.equal(denied.rows[0].envelope.diagnostics[0].code, 'READ_HOST_DENIED');
  assert.equal(denied.rows[0].envelope.content, null);
  const allowed = await invoke([...args, '--allow-read']);
  assert.equal(allowed.code, 0);
  const body = allowed.rows[0].envelope;
  assert.equal(body.states.action_authorization, 'not_evaluated');
  for (const role of ['actor', 'boundary', 'exception']) assert.ok(body.content.closure.some(n => n.role === role));
  assert.deepEqual(body.content.closure.filter(n => n.role === 'judgment').map(n => n.value.id), ['j:0']);
});

test('one real session supports all four modes and preserves stable expansion', async () => {
  const out = sink();
  const output = () => out.chunks.map(line => JSON.parse(line));
  async function* input() {
    yield JSON.stringify(request('catalog')) + '\n';
    yield JSON.stringify(request('whole_asset')) + '\n';
    yield JSON.stringify(request()) + '\n';
    const handle = output()[2].envelope.content.expansion_handles[0];
    assert.ok(handle);
    yield JSON.stringify(request('expand', handle)) + '\n';
    yield JSON.stringify(request('expand', handle)) + '\n';
  }
  assert.equal(await run(['read', file, '--session', '--allow-read'], out, input()), 0);
  const rows = output();
  assert.equal(rows.length, 5);
  assert.ok(rows.every(r => r.envelope.status === 'ready'));
  assert.equal(new Set(rows.map(r => r.envelope.snapshot_id)).size, 1);
  assert.deepEqual(rows[3].envelope.content, rows[4].envelope.content);
  assert.deepEqual(rows[3].envelope.content.closure.filter(n => n.role === 'judgment').map(n => n.value.id), ['j:0', 'j:2']);
  const forged = rows[2].envelope.content.expansion_handles[0];
  async function* otherSession() { yield JSON.stringify(request('expand', forged)) + '\n'; }
  const rejected = await invoke(['read', file, '--session', '--allow-read'], otherSession());
  assert.equal(rejected.code, 1);
  assert.equal(rejected.rows[0].envelope.diagnostics[0].code, 'READ_HANDLE_UNTRUSTED');
});

test('budget and session transport errors fail closed', async () => {
  const zero = await invoke(['read', file, '--budget', '0', '--allow-read']);
  assert.equal(zero.rows[0].channel, 'no_body_control');
  assert.equal(zero.rows[0].control.body_bytes, 0);
  for (const budget of ['-1', '9007199254740992', '1e3', '01']) assert.equal((await invoke(['read', file, '--budget', budget])).code, 2);
  async function* malformed() { yield Buffer.from([0xff, 10]); }
  assert.equal((await invoke(['read', file, '--session'], malformed())).rows[0].code, 'KDNA_SESSION_JSON_INVALID');
  async function* oversized() { yield Buffer.alloc(1048577, 32); }
  assert.equal((await invoke(['read', file, '--session'], oversized())).rows[0].code, 'KDNA_SESSION_INPUT_TOO_LARGE');
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
  assert.deepEqual(require('../package.json').files, ['LICENSE', 'NOTICE', 'README.md', 'public-contract-binding.json', 'src/cli.js', 'src/public-cli.js', 'src/authored-input.js', 'src/source-input.js', 'SECURITY.md', 'docs/asset-authorization.md', 'docs/consumption-runtime.md', 'docs/native-delivery.md', 'examples/native-workflow.cjs', 'examples/team-update/author.json', 'examples/team-update/README.md']);
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
