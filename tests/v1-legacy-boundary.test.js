/**
 * v1-legacy-boundary.test.js — verify v1 route never captures legacy v2 input.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const os = require('node:os');

const {
  isV1SourceDir,
  detectContainerFormat,
  MIMETYPE_V2,
} = require('@aikdna/kdna-core');
const cliBin = path.join(__dirname, '..', 'src', 'cli.js');

function run(args) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ── Build minimal legacy v2 container that is NOT v1 ──────────────

function makeLegacyV2Kdna(target) {
  const files = {};
  files.mimetype = Buffer.from(MIMETYPE_V2, 'utf8');
  files['kdna.json'] = Buffer.from(
    JSON.stringify({
      format: 'kdna',
      format_version: '2.0',
      spec_version: '1.0-rc',
      name: '@test/legacy-v2',
      version: '0.1.0',
      judgment_version: '2026.01',
      access: 'open',
      status: 'experimental',
      description: 'Legacy v2 conformance fixture.',
      author: { name: 'Test', id: 'test' },
      license: { type: 'CC0-1.0' },
      languages: ['en'],
      default_language: 'en',
      quality_badge: 'untested',
      risk_level: 'R0',
    }),
    'utf8',
  );
  files['KDNA_Core.json'] = Buffer.from(
    JSON.stringify({
      meta: {
        domain: 'legacy_v2',
        version: '0.1.0',
        created: '2026-01-01',
        purpose: 'test',
        load_condition: 'always',
      },
      axioms: [{ id: 'a1', one_sentence: 'Test.' }],
      ontology: [],
    }),
    'utf8',
  );

  // Build minimal ZIP with v2 mimetype
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

  const entries = ['mimetype', 'kdna.json', 'KDNA_Core.json'];
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
    local.writeUInt16LE(1, 12);
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
    cd.writeUInt16LE(1, 14);
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

test('legacy v2 container (vnd.aikdna.kdna+zip) is NOT detected as v1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-'));
  try {
    const file = path.join(tmp, 'legacy-v2.kdna');
    makeLegacyV2Kdna(file);
    assert.equal(detectContainerFormat(file), 'v2', 'Must identify as v2');
    assert.notEqual(detectContainerFormat(file), 'v1', 'Must NOT identify as v1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('v1 source dir IS detected as v1', () => {
  assert.equal(isV1SourceDir(path.join(__dirname, '..', 'fixtures', 'v1-minimal')), true);
});

test('random dir is NOT detected as v1', () => {
  assert.equal(isV1SourceDir(os.tmpdir()), false);
});

test('detectContainerFormat on v1 fixture returns v1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-'));
  try {
    const v1dir = path.join(__dirname, '..', 'fixtures', 'v1-minimal');
    // Pack a v1 container
    spawnSync(process.execPath, [cliBin, 'pack', v1dir, path.join(tmp, 'v1.kdna')], {
      stdio: 'ignore',
    });
    assert.equal(detectContainerFormat(path.join(tmp, 'v1.kdna')), 'v1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── CLI routing boundary ───────────────────────────────────────────

test('CLI inspect on legacy v2 .kdna is NOT routed to v1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-'));
  try {
    const file = path.join(tmp, 'legacy-v2.kdna');
    makeLegacyV2Kdna(file);
    const r = run(['inspect', file]);
    // Must NOT produce v1 inspect output (asset_uid/title/etc are v1-only fields)
    let output;
    try {
      output = JSON.parse(r.stdout);
    } catch {
      output = {};
    }
    assert.ok(!output.asset_uid, 'v1 inspect output must NOT appear for legacy v2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI validate on legacy v2 .kdna is NOT routed to v1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-'));
  try {
    const file = path.join(tmp, 'legacy-v2.kdna');
    makeLegacyV2Kdna(file);
    const r = run(['validate', file]);
    // Must NOT produce v1 validate output (overall_valid/formAT_valid etc are v1-only)
    assert.ok(
      !/overall_valid.*true/.test(r.stdout),
      'v1 validate output must NOT appear for legacy v2',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI load on legacy v2 .kdna is NOT routed to v1', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-'));
  try {
    const file = path.join(tmp, 'legacy-v2.kdna');
    makeLegacyV2Kdna(file);
    const r = run(['load', file, '--profile=compact', '--as=json']);
    // Must NOT produce v1 load output (profile/status/content fields are v1-only)
    assert.ok(!/profile.*compact/.test(r.stdout), 'v1 load output must NOT appear for legacy v2');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── v1 route still works ───────────────────────────────────────────

test('v1 inspect still works after legacy fallback additions', () => {
  const r = run(['inspect', path.join(__dirname, '..', 'fixtures', 'v1-minimal')]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kdna_version, '1.0');
  assert.equal(out.asset_id, 'kdna:example:atomspeak-core');
});

test('v1 load still works after legacy fallback additions', () => {
  const r = run([
    'load',
    path.join(__dirname, '..', 'fixtures', 'v1-minimal'),
    '--profile=compact',
    '--as=json',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.profile, 'compact');
  assert.ok(out.content.highest_question);
});

// ── Forbidden terms in legacy fallback ─────────────────────────────

const FORBIDDEN = [
  'trusted',
  'recommended',
  'high_quality',
  'officially_approved',
  'quality_badge',
];

test('legacy v2 fallback output does not contain forbidden trust terms', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-legacy-'));
  try {
    const file = path.join(tmp, 'legacy-v2.kdna');
    makeLegacyV2Kdna(file);
    const r = run(['inspect', file]);
    // Whatever output we get, it must not contain forbidden terms
    const merged = r.stdout + r.stderr;
    for (const t of FORBIDDEN) {
      assert.ok(!merged.includes(t), `forbidden term '${t}' in legacy fallback output`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
