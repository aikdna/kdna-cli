'use strict';
// The explicit 0.5 -> 0.6 conversion command, driven through the real CLI face
// on real containers. The positive case converts the tracked synthetic 0.5
// source (fixtures/migration-source-0.5.kdna, byte-identical to the Core
// suite's fixture) and pins the canonical migrated bytes; every refusal case
// uses a crafted in-memory variant rebuilt from that same fixture, and none of
// them may leave an output file. The read-side refusal surface must stay
// unchanged: validate() still refuses the 0.5 source.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { inflateRawSync } = require("node:zlib");

const target = process.env.KDNA_CLI_TARGET_ROOT || path.resolve(__dirname, "..");
const local = createRequire(path.join(target, "package.json"));
const { run } = local("@aikdna/kdna-cli");
const FIXTURE = path.join(__dirname, "fixtures", "migration-source-0.5.kdna");
const fixtureBytes = fs.readFileSync(FIXTURE);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digestOf = (bytes) => "sha256:" + sha256(bytes);
const sink = () => { const lines = []; return { lines, write(value) { lines.push(String(value)); return true; } }; };

let scratch;
test.before(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-cli-convert-")); });
test.after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });

async function invoke(argv) {
  const out = sink();
  const code = await run(argv, out);
  const text = out.lines.join("");
  return { code, text, row: text.trim() ? JSON.parse(text.trim()) : null };
}
function outPath(name) { return path.join(scratch, name + ".kdna"); }
async function convert(sourcePath, name, overrides = {}) {
  const bytes = fs.readFileSync(sourcePath);
  return invoke(["convert", sourcePath, "--expected-a", digestOf(bytes), "--output", outPath(name), "--allow-source", ...(overrides.extra ?? [])]);
}
function failureCode(row) {
  assert.ok(["source_failed", "core_rejected"].includes(row.status), JSON.stringify(row));
  return row.status === "source_failed" ? row.diagnostic.code : row.core.reason;
}

// Minimal ZIP reader for the tracked fixture (regular stored/deflate members).
function readZipMembers(bytes) {
  const eocd = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(eocd), 0x06054b50);
  const count = bytes.readUInt16LE(eocd + 10), cdSize = bytes.readUInt32LE(eocd + 12), cdStart = bytes.readUInt32LE(eocd + 16);
  const members = new Map();
  let at = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cdStart + at), 0x02014b50);
    const method = bytes.readUInt16LE(cdStart + at + 10), size = bytes.readUInt32LE(cdStart + at + 24), nl = bytes.readUInt16LE(cdStart + at + 28), xl = bytes.readUInt16LE(cdStart + at + 30), cl = bytes.readUInt16LE(cdStart + at + 32), start = bytes.readUInt32LE(cdStart + at + 42);
    const name = bytes.subarray(cdStart + at + 46, cdStart + at + 46 + nl).toString("utf8");
    const header = bytes.readUInt16LE(start + 26);
    const dataStart = start + 30 + header;
    const raw = bytes.subarray(dataStart, dataStart + size);
    members.set(name, method === 0 ? raw : inflateRawSync(raw));
    at += 46 + nl + xl + cl;
  }
  assert.equal(at, cdSize);
  return members;
}
// In-memory ZIP rebuild (regular files, stored members) for crafted negatives.
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function buildZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, value] of entries) {
    const nameBuf = Buffer.from(name), data = Buffer.from(value);
    let crc = 0xffffffff; for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); crc = (crc ^ 0xffffffff) >>> 0;
    const localHeader = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf]);
    locals.push(localHeader, data);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
    offset += localHeader.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, directory, eocd]);
}
function rebuiltFixture(name, mutateManifest, extraEntries = []) {
  const entries = readZipMembers(fixtureBytes);
  const manifest = JSON.parse(entries.get("kdna.json").toString("utf8"));
  mutateManifest(manifest);
  const file = path.join(scratch, name + ".kdna");
  fs.writeFileSync(file, buildZip([
    ["mimetype", entries.get("mimetype")],
    ["kdna.json", Buffer.from(JSON.stringify(manifest))],
    ["payload.kdnab", entries.get("payload.kdnab")],
    ...extraEntries,
  ]));
  return file;
}

test("the tracked fixture is the canonical 0.5 source", () => {
  assert.equal(sha256(fixtureBytes), "35cc7c7ccda8dcf18adda438628a07f665491f2e06c79ff7cf99e7dc8295aff6");
  assert.equal(fixtureBytes.length, 5725);
});

test("a current 0.5 source converts to the canonical 0.6 bytes and validates", async () => {
  const result = await convert(FIXTURE, "canonical");
  assert.equal(result.code, 0, result.text);
  assert.equal(result.row.status, "saved");
  assert.equal(result.row.output.bytes, 21845);
  assert.equal(result.row.output.sha256, "d5c3c752fde0a1568587e3503ade61705d377de322dd1155ae67183e160e9bb6");
  const origin = result.row.observation.origin;
  assert.equal(origin.source_format_version, "0.5.0");
  assert.equal(origin.source_container_digest, digestOf(fixtureBytes));
  const actions = result.row.observation.member_actions;
  assert.ok(actions.some((a) => a.name === "payload.kdnab" && a.action === "removed"));
  assert.ok(actions.some((a) => a.name === "sections/pack-0.kdnab" && a.action === "added"));
  const validated = await invoke(["validate", outPath("canonical")]);
  assert.equal(validated.code, 0, validated.text);
  assert.equal(validated.row.status, "accepted");
  assert.equal(validated.row.states.core, "valid");
});

test("converting the same source twice produces byte-identical containers", async () => {
  const first = await convert(FIXTURE, "det-a");
  const second = await convert(FIXTURE, "det-b");
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.ok(fs.readFileSync(outPath("det-a")).equals(fs.readFileSync(outPath("det-b"))));
});

test("a historical container version stamp is refused by name before conversion", async () => {
  // The stamp uses a member of the Core route's historical version set; the
  // probe is the current fixture restamped, so this exercises the version gate
  // (the full historical-generation refusal is covered by the Core suite).
  const file = rebuiltFixture("historical", (manifest) => { manifest.format_version = "0.1.0"; });
  const result = await convert(file, "historical-out");
  assert.equal(result.code, 1);
  assert.equal(failureCode(result.row), "MIGRATION_SOURCE_UNSUPPORTED_VERSION");
  assert.equal(fs.existsSync(outPath("historical-out")), false);
});

test("a protected source is refused by name and never converts the encrypted bytes", async () => {
  const file = rebuiltFixture("protected", (manifest) => { manifest.payload.encrypted = true; });
  const result = await convert(file, "protected-out");
  assert.equal(result.code, 1);
  assert.equal(failureCode(result.row), "MIGRATION_SOURCE_PROTECTED_UNSUPPORTED");
  assert.equal(fs.existsSync(outPath("protected-out")), false);
});

test("checksum or signature members are refused by name and never dropped", async () => {
  const file = rebuiltFixture("extension", () => {}, [["checksums.json", Buffer.from("{}")]]);
  const result = await convert(file, "extension-out");
  assert.equal(result.code, 1);
  assert.equal(failureCode(result.row), "MIGRATION_SOURCE_EXTENSION_UNSUPPORTED");
  assert.equal(fs.existsSync(outPath("extension-out")), false);
});

test("an unclassifiable version is refused as input-invalid", async () => {
  const file = rebuiltFixture("future", (manifest) => { manifest.format_version = "0.7.0"; });
  const result = await convert(file, "future-out");
  assert.equal(result.code, 1);
  assert.equal(failureCode(result.row), "SOURCE_INPUT_INVALID");
  assert.equal(fs.existsSync(outPath("future-out")), false);
});

test("a binding mismatch leaves no output", async () => {
  const result = await invoke(["convert", FIXTURE, "--expected-a", "sha256:" + "0".repeat(64), "--output", outPath("mismatch-out"), "--allow-source"]);
  assert.equal(result.code, 1);
  assert.equal(failureCode(result.row), "SOURCE_EXPECTED_ASSET_MISMATCH");
  assert.equal(fs.existsSync(outPath("mismatch-out")), false);
});

test("missing explicit consent refuses before reading and leaves no output", async () => {
  const bytes = fs.readFileSync(FIXTURE);
  const result = await invoke(["convert", FIXTURE, "--expected-a", digestOf(bytes), "--output", outPath("denied-out")]);
  assert.equal(result.code, 1);
  assert.equal(result.row.status, "rejected");
  assert.equal(result.row.code, "KDNA_SOURCE_PERMISSION_REQUIRED");
  assert.equal(fs.existsSync(outPath("denied-out")), false);
});

test("an existing output file is never replaced", async () => {
  const file = outPath("exists-out");
  fs.writeFileSync(file, "keep-me");
  const result = await convert(FIXTURE, "exists-out");
  assert.equal(result.code, 1);
  assert.equal(result.row.status, "save_failed");
  assert.equal(result.row.code, "KDNA_OUTPUT_EXISTS");
  assert.equal(fs.readFileSync(file, "utf8"), "keep-me");
});

test("the read-side refusal surface for 0.5 sources is unchanged", async () => {
  const validated = await invoke(["validate", FIXTURE]);
  assert.equal(validated.code, 1);
  assert.equal(validated.row.status, "rejected");
  assert.equal(validated.row.reason, "READ_UNSUPPORTED_VERSION");
  assert.equal(validated.row.diagnostic.field, "/payload.kdnab");
});
