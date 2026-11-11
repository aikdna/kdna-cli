'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const protect = require('../src/protect');
const binding = require('../public-contract-binding.json');
const sectionsBytes = require('@aikdna/kdna-core/sections-bytes-node');
const sectionsNode = require('@aikdna/kdna-core/sections-node');

const FIXTURE = path.resolve(__dirname, '..', '..', 'kdna', 'examples', 'native-team-update', 'team-update-1.0.0.kdna');
const PASS = new TextEncoder().encode('test-passphrase-2026');
const enc = s => new TextEncoder().encode(s);
const plain = () => new Uint8Array(fs.readFileSync(FIXTURE));

test('protect, admit, wrong password, selection read, ir digest parity', { skip: !fs.existsSync(FIXTURE) }, async () => {
  const bytes = plain();
  assert.equal(protect.isProtectedBytes(bytes), false);
  const produced = await protect.protectAsset(bytes, PASS);
  assert.equal(produced.status, 'produced');
  assert.notDeepEqual(Buffer.from(produced.bytes), Buffer.from(bytes));
  assert.equal(protect.isProtectedBytes(produced.bytes), true);
  assert.equal((await protect.protectAsset(produced.bytes, PASS)).status, 'failed');

  const wrong = await protect.admitProtectedWithPassword(produced.bytes, enc('wrong'));
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.code, 'PROTECTION_AUTHENTICATION_FAILED');
  assert.ok(!JSON.stringify(wrong).includes('wrong'));

  const admitted = await protect.admitProtectedWithPassword(produced.bytes, PASS);
  assert.equal(admitted.status, 'accepted');
  try {
    assert.deepEqual(admitted.view.tuple, binding.tuple);
    const ids = admitted.view.ir.nodes.filter(n => n.id.startsWith('judgment:')).map(n => n.id);
    const catalog = await protect.readProtected(admitted, { mode: 'catalog' });
    assert.equal(catalog.channel, 'read_envelope');
    assert.equal(catalog.envelope.status, 'catalog_only');
    const whole = await protect.readProtected(admitted, { mode: 'whole_asset' });
    assert.equal(whole.envelope.status, 'ready');
    const sel = await protect.readProtected(admitted, { mode: 'exact_selection',
      selection: { asset_id: admitted.view.asset.asset_id, asset_version: admitted.view.asset.asset_version, judgment_ids: ['update:order', 'update:evidence'] } });
    assert.equal(sel.channel, 'read_envelope');
    const text = JSON.stringify(sel);
    assert.ok(sel.envelope.status === 'ready', text.slice(0, 400));
    assert.ok(ids.length >= 3);

    // Plain path parity: same logical content => same IR digest.
    const plainBytes = plain();
    const plainRequest = sectionsNode.admitSectionRequest({ request_id: 'test:plain', tuple: binding.tuple, budget_bytes: 1000000, mode: 'whole_asset', selection: null, handle: null });
    const plainAdmission = await sectionsBytes.admitSectionBytesNode(plainBytes, plainRequest, sectionsBytes.createNativeSectionByteReadAuthority(() => true));
    assert.equal(plainAdmission.status, 'accepted');
    const plainView = sectionsNode.inspectWholeSectionSnapshot(plainAdmission.snapshot);
    // The plain view exposes no ir_digest; compare the IR body (the protected ir_digest is Core's digest of it).
    // Only the asset declaration differs (it records the protection metadata); all other nodes are identical.
    const body = view => view.ir.nodes.filter(n => !n.id.startsWith('asset_declaration:'));
    assert.deepEqual(body(admitted.view), body(plainView));
    assert.match(admitted.view.ir_digest, /^sha256:[0-9a-f]{64}$/);
  } finally { admitted.dispose(); }
});

test('readPasswordSource strips one newline and rejects empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-pw-'));
  const f = path.join(dir, 'pw');
  fs.writeFileSync(f, 'secret\n');
  assert.equal(Buffer.from(protect.readPasswordSource({ file: f })).toString(), 'secret');
  fs.writeFileSync(f, '\n');
  assert.throws(() => protect.readPasswordSource({ file: f }), { code: 'KDNA_PASSWORD_INVALID' });
  assert.throws(() => protect.readPasswordSource({}), { code: 'KDNA_PASSWORD_SOURCE_REQUIRED' });
  fs.rmSync(dir, { recursive: true });
});

test('interop fixture generation (optional)', { skip: !process.env.KDNA_WRITE_PROTECT_FIXTURE }, async () => {
  const out = process.env.KDNA_WRITE_PROTECT_FIXTURE;
  const r = await protect.protectAsset(plain(), PASS);
  assert.equal(r.status, 'produced');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, r.bytes);
  console.log(out, 'sha256:' + createHash('sha256').update(r.bytes).digest('hex'));
});
