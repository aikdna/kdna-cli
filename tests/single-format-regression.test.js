/**
 * single-format-regression.test.js — CLI single-format regression tests.
 *
 * These tests prove that kdna-cli, when linked against the local Core candidate
 * tarball, can exercise the full single-format toolchain.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const cliBin = path.join(__dirname, '..', 'src', 'cli.js');
const core = require('@aikdna/kdna-core');
const cbor = require('cbor-x');

const LEGACY_MIMETYPE = ['application/vnd', 'aikdna', 'kdna+zip'].join('.');

function run(args, opts = {}) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function makeMinimalSourceDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mimetype'), 'application/vnd.kdna.asset');
  fs.writeFileSync(
    path.join(dir, 'kdna.json'),
    JSON.stringify({
      format_version: '0.1.0',
      asset_id: 'kdna:test:single-format',
      asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      asset_type: 'sample',
      title: 'Single-format regression',
      version: '1.0.0',
      judgment_version: '1.0.0',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      creator: { name: 'Test' },
      compatibility: {
        min_loader_version: '0.18.1',
        profile: 'kdna.payload.judgment',
        profile_version: '0.1.0',
      },
      payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
      access: 'public',
    }),
  );
  const payload = {
    profile: 'kdna.payload.judgment',
    profile_version: '0.1.0',
    core: { highest_question: 'Q', axioms: [{ id: 'a1', one_sentence: 'Test.' }] },
  };
  fs.writeFileSync(path.join(dir, 'payload.kdnab'), cbor.encode(payload));
  const checks = core.buildChecksums(dir);
  fs.writeFileSync(path.join(dir, 'checksums.json'), JSON.stringify(checks, null, 2));
}

test('CLI validate works against local Core candidate tarball', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-reg-'));
  try {
    const src = path.join(tmp, 'src');
    makeMinimalSourceDir(src);
    const r = run(['validate', src]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overall_valid, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI inspect works against local Core candidate tarball', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-reg-'));
  try {
    const src = path.join(tmp, 'src');
    makeMinimalSourceDir(src);
    const r = run(['inspect', src, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.format_version, '0.1.0');
    assert.equal(out.asset_id, 'kdna:test:single-format');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI plan-load works against local Core candidate tarball', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-reg-'));
  try {
    const src = path.join(tmp, 'src');
    const packed = path.join(tmp, 'single.kdna');
    makeMinimalSourceDir(src);
    core.pack(src, packed);
    const r = run(['plan-load', packed, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.state, 'ready');
    assert.equal(out.can_load_now, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI validate --runtime works against local Core candidate tarball', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-reg-'));
  try {
    const src = path.join(tmp, 'src');
    const packed = path.join(tmp, 'single.kdna');
    makeMinimalSourceDir(src);
    core.pack(src, packed);
    const r = run(['validate', packed, '--runtime']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.overall_valid, true);
    assert.equal(out.runtime_load_plan.can_load_now, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI pack/unpack round-trip produces current mimetype', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-reg-'));
  try {
    const src = path.join(tmp, 'src');
    makeMinimalSourceDir(src);
    const packed = path.join(tmp, 'single.kdna');
    const r1 = run(['pack', src, packed]);
    assert.equal(r1.status, 0, r1.stderr);

    const mimetype = core.detectContainerFormat(packed);
    assert.equal(mimetype, 'kdna', 'packed container must detect as kdna');

    const unpacked = path.join(tmp, 'unpacked');
    const r2 = run(['unpack', packed, unpacked]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(
      fs.readFileSync(path.join(unpacked, 'mimetype'), 'utf8').trim(),
      'application/vnd.kdna.asset',
    );

    const r3 = run(['validate', unpacked]);
    assert.equal(r3.status, 0, r3.stderr);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Core detects current source directories and rejects unrelated directories', () => {
  assert.equal(core.isKdnaSourceDir(path.join(__dirname, '..', 'fixtures', 'minimal')), true);
  const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-unrelated-'));
  try {
    assert.equal(core.isKdnaSourceDir(unrelated), false);
  } finally {
    fs.rmSync(unrelated, { recursive: true, force: true });
  }
});

test('CLI inspect rejects a packaged container with a predecessor mimetype', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-old-mime-'));
  try {
    const packed = path.join(tmp, 'old-mime.kdna');
    const packedResult = run(['pack', path.join(__dirname, '..', 'fixtures', 'minimal'), packed]);
    assert.equal(packedResult.status, 0, packedResult.stderr);
    const bytes = fs.readFileSync(packed);
    const current = Buffer.from('application/vnd.kdna.asset');
    const offset = bytes.indexOf(current);
    assert.ok(offset >= 0, 'current mimetype entry not found');
    Buffer.from(LEGACY_MIMETYPE.padEnd(current.length)).copy(bytes, offset, 0, current.length);
    fs.writeFileSync(packed, bytes);

    assert.equal(core.detectContainerFormat(packed), null);
    const inspected = run(['inspect', packed, '--json']);
    assert.notEqual(inspected.status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI rejects source dir with legacy mimetype', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-reg-'));
  try {
    const src = path.join(tmp, 'src');
    makeMinimalSourceDir(src);
    fs.writeFileSync(path.join(src, 'mimetype'), LEGACY_MIMETYPE);
    const r = run(['validate', src]);
    assert.notEqual(r.status, 0, 'legacy mimetype must be rejected');
    assert.ok(!/overall_valid.*true/.test(r.stdout + r.stderr));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dev-pack produces the current mimetype and manifest contract', () => {
  const devPack = require('../src/dev-pack');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-reg-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'KDNA_Core.json'),
      JSON.stringify({
        meta: {
          domain: 'test',
          version: '0.1.0',
          created: '2026-01-01',
          purpose: 'test',
          load_condition: 'always',
        },
        axioms: [{ id: 'a1', one_sentence: 'Test.' }],
        ontology: [],
      }),
    );
    fs.writeFileSync(
      path.join(tmp, 'KDNA_Patterns.json'),
      JSON.stringify({
        meta: {
          domain: 'test',
          version: '0.1.0',
          created: '2026-01-01',
          purpose: 'test',
          load_condition: 'always',
        },
        terminology: { standard_terms: [], banned_terms: [] },
        misunderstandings: [],
        self_check: [],
      }),
    );
    const result = devPack.packKdna(tmp, { name: '@test/regression', version: '0.1.0' });
    assert.equal(result.entries.mimetype, 'application/vnd.kdna.asset');
    const manifest = JSON.parse(result.entries['kdna.json']);
    assert.equal(manifest.format_version, '0.1.0');
    assert.equal(manifest[['kdna', 'version'].join('_')], undefined);
    assert.equal(manifest.container, undefined, 'non-current container block removed');
    const obsoleteSpecField = ['spec', 'version'].join('_');
    assert.equal(manifest[obsoleteSpecField], undefined, `${obsoleteSpecField} removed`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Encrypted asset lifecycle ─────────────────────────────────────

test('encrypted asset: pack → protect → validate → plan-load needs_password', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-enc-'));
  try {
    const src = path.join(tmp, 'src');
    makeMinimalSourceDir(src);
    // Pack to .kdna
    const kdna = path.join(tmp, 'plain.kdna');
    const r1 = run(['pack', src, kdna]);
    assert.equal(r1.status, 0, `pack failed: ${r1.stderr}`);

    // Protect with password
    const prot = path.join(tmp, 'protected.kdna');
    const r2 = run([
      'protect',
      kdna,
      '--out',
      prot,
      '--password',
      'test123',
      '--entries',
      'payload.kdnab',
    ]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(fs.existsSync(prot), 'protected file should exist');

    // Validate protected
    const r3 = run(['validate', prot, '--json']);
    const v3 = JSON.parse(r3.stdout);
    assert.equal(v3.format_valid, true, `format invalid: ${v3.problems}`);

    // Plan-load = needs_password
    const r4 = run(['plan-load', prot, '--json']);
    const p4 = JSON.parse(r4.stdout);
    assert.equal(p4.state, 'needs_password');

    // Wrong password fails
    const r5 = run(['load', prot, '--as=json', '--password=wrong']);
    assert.notEqual(r5.status, 0, 'wrong password should fail');

    // Correct password loads Capsule
    const r6 = run(['load', prot, '--as=json', '--password=test123']);
    assert.equal(r6.status, 0, `correct password load failed: ${r6.stderr}`);
    const c6 = JSON.parse(r6.stdout);
    assert.equal(c6.type, 'kdna.runtime-capsule');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('compatibility scrypt asset remains loadable and unlockable', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-scrypt-compat-'));
  try {
    const src = path.join(tmp, 'src');
    makeMinimalSourceDir(src);
    const manifestPath = path.join(src, 'kdna.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.access = 'licensed';
    manifest.payload.encrypted = true;
    manifest.entitlement = { profile: 'password', offline: true, revocable: false };
    manifest.encryption = {
      profile: core.PASSWORD_PROTECTED_SCRYPT_PROFILE,
      encrypted_entries: ['payload.kdnab'],
    };
    const plaintext = fs.readFileSync(path.join(src, 'payload.kdnab'));
    const envelope = core.encryptProtectedEntryScrypt(plaintext, {
      entryName: 'payload.kdnab',
      manifest,
      password: 'compat-password',
    });
    const encrypted = cbor.encode(envelope);
    manifest.payload.digest = `sha256:${require('node:crypto').createHash('sha256').update(encrypted).digest('hex')}`;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(src, 'payload.kdnab'), encrypted);
    fs.writeFileSync(
      path.join(src, 'checksums.json'),
      JSON.stringify(core.buildChecksums(src), null, 2),
    );

    const protectedAsset = path.join(tmp, 'scrypt.kdna');
    assert.equal(run(['pack', src, protectedAsset]).status, 0);
    const loaded = run(['load', protectedAsset, '--as=json', '--password=compat-password']);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(JSON.parse(loaded.stdout).type, 'kdna.runtime-capsule');

    const unlocked = path.join(tmp, 'unlocked.kdna');
    const unlock = run([
      'protect',
      'unlock',
      protectedAsset,
      '--out',
      unlocked,
      '--password',
      'compat-password',
    ]);
    assert.equal(unlock.status, 0, unlock.stderr);
    const unlockedLoad = run(['load', unlocked, '--as=json']);
    assert.equal(unlockedLoad.status, 0, unlockedLoad.stderr);
    assert.equal(JSON.parse(unlockedLoad.stdout).access, 'public');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('encrypted demo creates valid fixture', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-demo-enc-'));
  try {
    const target = path.join(tmp, 'enc-demo');
    const r = run(['demo', 'judgment', target, '--password', 'demo123']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(target, 'payload.kdnab')), 'payload must exist');
    assert.ok(fs.existsSync(path.join(target, 'kdna.json')), 'manifest must exist');

    const m = JSON.parse(fs.readFileSync(path.join(target, 'kdna.json'), 'utf8'));
    assert.equal(m.payload.encrypted, true);
    assert.equal(m.payload.encoding, 'cbor');
    assert.ok(m.encryption.encrypted_entries.includes('payload.kdnab'));

    // Payload must be CBOR-encoded envelope (not JSON)
    const payloadBuf = fs.readFileSync(path.join(target, 'payload.kdnab'));
    const cbor = require('cbor-x');
    let envelope;
    try {
      envelope = cbor.decode(payloadBuf);
    } catch {
      assert.fail('encrypted demo payload must be valid CBOR envelope');
    }
    assert.ok(envelope.profile, 'envelope must have profile field');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
