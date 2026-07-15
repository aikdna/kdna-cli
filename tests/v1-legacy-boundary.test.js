/**
 * v1-legacy-boundary.test.js — single-format detection and routing boundaries.
 *
 * Verifies that the unified KDNA asset format is detected and routed correctly,
 * and that legacy pre-single-format inputs are rejected cleanly.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const os = require('node:os');

const { MIMETYPE, isKdnaSourceDir, detectContainerFormat } = require('@aikdna/kdna-core');
const cbor = require('cbor-x');
const cliBin = path.join(__dirname, '..', 'src', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ── Build minimal single-format container ──────────────────────────

function makeSingleFormatKdna(target, opts = {}) {
  const payload = {
    profile: 'judgment-profile-v1',
    core: {
      highest_question: 'q',
      axioms: [{ id: 'a1', one_sentence: 'Test.' }],
    },
  };
  const manifest = {
    kdna_version: '1.0',
    asset_id: 'kdna:test:single-format',
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    asset_type: 'sample',
    title: 'Single-format test asset',
    version: '1.0.0',
    judgment_version: '1.0.0',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    creator: { name: 'Test' },
    compatibility: { min_loader_version: '1.0.0', profile: 'judgment-profile-v1' },
    payload: { path: 'payload.kdnab', encoding: 'json', encrypted: false },
  };
  const files = {};
  files.mimetype = Buffer.from(MIMETYPE, 'utf8');
  files['kdna.json'] = Buffer.from(JSON.stringify(manifest), 'utf8');
  files['payload.kdnab'] = Buffer.from(cbor.encode(payload), 'utf8');

  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const entries = Object.keys(files);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const name of entries) {
    const data = files[name];
    const crc = crc32(data);
    const compressed = name === 'mimetype' ? data : zlib.deflateRawSync(data);
    const method = name === 'mimetype' ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, compressed);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    centrals.push(cd);

    offset += local.length + compressed.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of centrals) cdSize += c.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeFileSync(target, Buffer.concat([...locals, ...centrals, eocd]));
}

// ── Detection boundary ─────────────────────────────────────────────

test('single-format container (application/vnd.kdna.asset) is detected as kdna', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-single-'));
  try {
    const file = path.join(tmp, 'single.kdna');
    makeSingleFormatKdna(file);
    assert.equal(detectContainerFormat(file), 'kdna', 'Must identify as kdna');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('legacy mimetype container is NOT detected as kdna', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-'));
  try {
    const file = path.join(tmp, 'legacy.kdna');
    makeSingleFormatKdna(file);
    // Mutate the mimetype entry in place to the old value (same length after padding)
    const buf = fs.readFileSync(file);
    const oldMime = ['application/vnd', 'aikdna', 'kdna+zip'].join('.');
    const newMime = 'application/vnd.kdna.asset';
    const idx = buf.indexOf(Buffer.from(newMime));
    assert.ok(idx >= 0, 'mimetype entry not found');
    const replacement = Buffer.from(oldMime.padEnd(newMime.length, ' '), 'utf8');
    replacement.copy(buf, idx, 0, newMime.length);
    fs.writeFileSync(file, buf);
    assert.equal(detectContainerFormat(file), null, 'Legacy mimetype must NOT identify as kdna');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('KDNA source dir is detected', () => {
  assert.equal(isKdnaSourceDir(path.join(__dirname, '..', 'fixtures', 'minimal')), true);
});

test('random dir is NOT detected as KDNA source dir', () => {
  assert.equal(isKdnaSourceDir(os.tmpdir()), false);
});

test('detectContainerFormat on packed fixture returns kdna', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-single-'));
  try {
    const src = path.join(__dirname, '..', 'fixtures', 'minimal');
    spawnSync(process.execPath, [cliBin, 'pack', src, path.join(tmp, 'single.kdna')], {
      stdio: 'ignore',
    });
    assert.equal(detectContainerFormat(path.join(tmp, 'single.kdna')), 'kdna');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── CLI routing boundary ───────────────────────────────────────────

test('CLI inspect on single-format .kdna works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-single-'));
  try {
    const file = path.join(tmp, 'single.kdna');
    makeSingleFormatKdna(file);
    const r = run(['inspect', file, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.kdna_version, '1.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI validate on single-format .kdna works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-single-'));
  try {
    const file = path.join(tmp, 'single.kdna');
    makeSingleFormatKdna(file);
    const r = run(['validate', file]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(/overall_valid.*true/.test(r.stdout), 'must report overall_valid=true');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI load on single-format .kdna works', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-single-'));
  try {
    const file = path.join(tmp, 'single.kdna');
    makeSingleFormatKdna(file);
    const r = run(['load', file, '--profile=compact', '--as=json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.profile, 'compact');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI inspect on legacy mimetype .kdna is rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-'));
  try {
    const file = path.join(tmp, 'legacy.kdna');
    makeSingleFormatKdna(file);
    const buf = fs.readFileSync(file);
    const oldMime = ['application/vnd', 'aikdna', 'kdna+zip'].join('.');
    const newMime = 'application/vnd.kdna.asset';
    const idx = buf.indexOf(Buffer.from(newMime));
    assert.ok(idx >= 0);
    const replacement = Buffer.from(oldMime.padEnd(newMime.length, ' '), 'utf8');
    replacement.copy(buf, idx, 0, newMime.length);
    fs.writeFileSync(file, buf);
    const r = run(['inspect', file, '--json']);
    assert.notEqual(r.status, 0, 'legacy mimetype asset must be rejected');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Single-format route still works ────────────────────────────────

test('single-format inspect still works on minimal fixture', () => {
  const r = run(['inspect', path.join(__dirname, '..', 'fixtures', 'minimal')]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kdna_version, '1.0');
  assert.equal(out.asset_id, 'kdna:example:deployment-review');
});

test('single-format load still works on minimal fixture', () => {
  const r = run([
    'load',
    path.join(__dirname, '..', 'fixtures', 'minimal'),
    '--profile=compact',
    '--as=json',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.profile, 'compact');
  assert.ok(out.content.highest_question);
});

// ── Forbidden terms ────────────────────────────────────────────────

const FORBIDDEN = [
  'trusted',
  'recommended',
  'high_quality',
  'officially_approved',
  'quality_badge',
];

test('single-format output does not contain forbidden trust terms', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-single-'));
  try {
    const file = path.join(tmp, 'single.kdna');
    makeSingleFormatKdna(file);
    const r = run(['inspect', file]);
    const merged = r.stdout + r.stderr;
    for (const t of FORBIDDEN) {
      assert.ok(!merged.includes(t), `forbidden term '${t}' in single-format output`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
