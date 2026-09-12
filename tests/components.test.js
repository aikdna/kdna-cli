'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const target = process.env.KDNA_COMPONENT_CLI_TARGET || path.resolve(__dirname, '..');
const local = createRequire(path.join(target, 'package.json'));
const { run } = local('@aikdna/kdna-cli');
const { admitNode } = local('@aikdna/kdna-core/node');
const binding = JSON.parse(fs.readFileSync(path.join(target, 'public-contract-binding.json')));
const fixtures = path.join(__dirname, 'fixtures/components');
const oracle = JSON.parse(fs.readFileSync(path.join(fixtures, 'component-node-oracles.json')));
const request = (mode = 'exact_selection') => ({ request_id: 'cli:component', tuple: binding.tuple, budget_bytes: 1000000, mode, selection: mode === 'catalog' ? null : { asset_id: 'asset:bytes', asset_version: '1.0.0', judgment_id: 'j:0' }, handle: null });
async function invoke(args, requests = []) {
  const lines = [];
  const out = { write(text) { lines.push(text); return true; } };
  const code = await run(args, out, Readable.from(requests.map(r => JSON.stringify(r) + '\n')));
  return { code, rows: lines.map(JSON.parse) };
}
for (const row of oracle.rows) test('component admission and Read: ' + row.name, async () => {
  const file = path.join(fixtures, row.file);
  const core = await admitNode(file);
  assert.equal(core.status, row.result.status);
  assert.equal(core.reason, row.result.reason);
  for (const command of ['inspect', 'validate']) {
    const { code, rows: [actual] } = await invoke([command, file]);
    assert.equal(code, core.status === 'accepted' ? 0 : 1);
    assert.equal(actual.status, core.status);
    for (const field of ['writer', 'confirmation', 'read_permission', 'action_authorization']) assert.equal(actual.states[field], 'not_evaluated');
    assert.equal(actual.content, undefined); assert.equal(actual.ir, undefined); assert.equal(actual.snapshot, undefined);
    if (core.status === 'rejected') {
      assert.deepEqual(actual.states, { writer: 'not_evaluated', confirmation: 'not_evaluated', read_permission: 'not_evaluated', action_authorization: 'not_evaluated', ...core.states });
      for (const field of ['reason', 'diagnostics', 'component_failure']) assert.deepEqual(actual[field], core[field]);
    } else if (command === 'inspect') {
      assert.deepEqual(actual.tuple, binding.tuple);
      assert.equal(actual.ir_digest, row.result.data.ir_digest);
    }
  }
  const read = await invoke(['read', file, '--session', '--allow-read'], [request()]);
  assert.equal(read.code, core.status === 'accepted' ? 0 : 1);
  const envelope = read.rows[0].envelope;
  assert.equal(envelope.states.action_authorization, 'not_evaluated');
  if (core.status === 'rejected') {
    assert.equal(envelope.content, null);
    assert.equal(envelope.states.core, core.states.core);
    assert.equal(envelope.states.interpretation, core.states.interpretation);
    assert.equal(envelope.diagnostics[0].code, core.reason);
  } else {
    assert.equal(envelope.status, 'ready');
    const ir = row.result.data.ir;
    const closure = ir.mandatory_closures.find(c => c.selection.judgment_id === 'j:0');
    assert.deepEqual(envelope.content.closure, closure.node_ids.map(id => ir.nodes.find(n => n.id === id)));
  }
});
test('supported bodies and method declaration presence survive retained-snapshot sessions', async () => {
  for (const name of ['all-profiles', 'undeclared', 'presence-undeclared', 'presence-declared']) {
    const row = oracle.rows.find(r => r.name === name), file = path.join(fixtures, row.file);
    const result = await invoke(['read', file, '--session', '--allow-read'], [request('catalog'), request(), request()]);
    assert.equal(result.code, 0);
    assert.equal(new Set(result.rows.map(r => r.envelope.snapshot_id)).size, 1);
    const methods = r => r.envelope.content.closure.filter(n => n.role === 'method');
    assert.deepEqual(methods(result.rows[1]), row.result.data.ir.nodes.filter(n => n.role === 'method'));
    assert.deepEqual(methods(result.rows[2]), methods(result.rows[1]));
    if (name === 'all-profiles') assert.deepEqual([...new Set(methods(result.rows[1])[0].value.component_interpretations.map(c => c.component_type))].sort(), ['candidate-set', 'discriminator-set', 'taxonomy']);
  }
});
test('component reading preserves explicit consent, zero budget and tuple rejection', async () => {
  const file = path.join(fixtures, 'component-all-profiles.kdna');
  const denied = await invoke(['read', file]);
  assert.equal(denied.code, 1); assert.equal(denied.rows[0].envelope.content, null);
  assert.equal(denied.rows[0].envelope.diagnostics[0].code, 'READ_HOST_DENIED');
  const zero = await invoke(['read', file, '--allow-read', '--budget', '0']);
  assert.equal(zero.code, 1); assert.equal(zero.rows[0].channel, 'no_body_control'); assert.equal(zero.rows[0].control.body_bytes, 0);
  const old = request(); old.tuple = { ...old.tuple, read: 'kdna.read/0.1.0' };
  const wrong = await invoke(['read', file, '--session', '--allow-read'], [old]);
  assert.equal(wrong.code, 1); assert.equal(wrong.rows[0].channel, 'read_envelope');
  assert.equal(wrong.rows[0].envelope.content, null);
  assert.equal(wrong.rows[0].envelope.diagnostics[0].code, 'READ_MIXED_VERSION_TUPLE');
});
