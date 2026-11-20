"use strict";

// source-pack must be able to revise a released public asset whose container
// carries an unsigned checksums.json integrity index (the form every published
// exemplar ships in), and must still fail closed when a signature covers it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");

const target = process.env.KDNA_CLI_TARGET_ROOT || path.resolve(__dirname, "..");
const pkg = require(path.join(target, "package.json"));
const bin = path.join(target, pkg.bin.kdna);
const binding = require(path.join(target, "public-contract-binding.json"));
const { readStoredContainer, classifySourceContainer, containerHasEntry, withoutEntry } = require(path.join(target, "src/source-input.js"));
const { admitSectionRequest, createSectionReadAuthority, createSectionChecksumsNode } = require("@aikdna/kdna-core/sections-node");

const run = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
const last = (stdout) => JSON.parse(stdout.trim().split("\n").pop());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kdna-source-pack-checksums-"));
const digestA = (file) => "sha256:" + createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function embedChecksums(file) {
  const request = admitSectionRequest({ request_id: "test:" + randomUUID(), tuple: binding.tuple, budget_bytes: 100000000, mode: "whole_asset", selection: null, handle: null });
  const produced = await createSectionChecksumsNode(file, request, createSectionReadAuthority(() => true));
  assert.equal(produced.status, "produced", JSON.stringify(produced));
  fs.writeFileSync(file, Buffer.from(produced.bytes));
}

// Appends one stored entry to a Stored ZIP container (used to model a signed
// container; the signature bytes are never verified because the CLI refuses
// before Core is asked to repack).
function appendStoredEntry(bytes, name, data) {
  const container = readStoredContainer(bytes);
  assert.ok(container);
  const nameBytes = Buffer.from(name, "utf8");
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const entry = { name, local: Buffer.concat([local, nameBytes, data]), central: Buffer.concat([central, nameBytes]) };
  const extended = { entries: [...container.entries, entry], comment: container.comment };
  return withoutEntry(extended, "\u0000never-present");
}

test("source-pack regenerates an unsigned checksums.json and fails closed on signed or unverified originals", async () => {
  const dir = tmp();
  const draft = path.join(dir, "draft.json");
  const base = path.join(dir, "base.kdna");
  const released = path.join(dir, "released.kdna");
  assert.equal(run(["init", "--example", "--mode", "interview", "--output", draft]).status, 0);
  assert.equal(run(["create", "--draft", draft, "--output", base, "--allow-create"]).status, 0);
  fs.copyFileSync(base, released);
  await embedChecksums(released);

  const releasedBytes = fs.readFileSync(released);
  assert.equal(containerHasEntry(releasedBytes, "checksums.json"), true);
  assert.equal(classifySourceContainer(releasedBytes).kind, "refreshable");
  assert.equal(classifySourceContainer(fs.readFileSync(base)).kind, "plain");
  // Stripping the index copies every other entry verbatim: the result is the
  // created container byte for byte.
  assert.deepEqual(Buffer.from(classifySourceContainer(releasedBytes).stripped), fs.readFileSync(base));

  const releasedA = digestA(released);
  const editsPath = path.join(dir, "edits.json");
  const opened = run(["source-open", released, "--expected-a", releasedA, "--output", editsPath, "--allow-source"]);
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  const edits = JSON.parse(fs.readFileSync(editsPath, "utf8"));
  edits.manifest.version = edits.payload.asset.asset_version = "0.1.1";
  edits.manifest.judgment_version = edits.payload.asset.judgment_version = "0.1.1";
  edits.manifest.summary = `${edits.manifest.summary} Revised.`;
  fs.writeFileSync(editsPath, JSON.stringify(edits, null, 2));
  const checkedInput = run(["validate-input", editsPath]);
  assert.equal(checkedInput.status, 0, checkedInput.stdout);

  // 1. Unsigned checksums.json: stale index dropped, edits packed, fresh index derived and self-checked.
  const revised = path.join(dir, "revised.kdna");
  const packed = run(["source-pack", released, "--edits", editsPath, "--expected-a", releasedA, "--output", revised, "--allow-source"]);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const packedRow = last(packed.stdout);
  assert.equal(packedRow.status, "saved");
  assert.equal(packedRow.checksums.status, "regenerated");
  assert.equal(packedRow.checksums.signed, false);
  assert.equal(packedRow.checksums.original_A, releasedA);
  assert.equal(packedRow.checksums.self_check, "accepted");
  assert.equal(packedRow.output.sha256, digestA(revised).slice("sha256:".length));
  assert.equal(containerHasEntry(fs.readFileSync(revised), "checksums.json"), true);

  const validated = run(["validate", revised, "--system", "--json"]);
  assert.equal(validated.status, 0, validated.stdout);
  const validatedRow = last(validated.stdout);
  assert.equal(validatedRow.status, "accepted");
  assert.equal(validatedRow.system.status, "clean");
  assert.equal(validatedRow.system.warning_count, 0);

  const inspected = last(run(["inspect", revised, "--json"]).stdout);
  assert.match(inspected.verification.checksum_integrity.status, /^verified/);
  assert.equal(inspected.asset.asset_version, "0.1.1");

  const diff = run(["diff", released, revised, "--format", "human"]);
  assert.equal(diff.status, 0, diff.stdout);
  assert.match(diff.stdout, /0\.1\.0[\s\S]*0\.1\.1/);
  assert.match(diff.stdout, /Revised\./);

  // 2. A wrong --expected-a never produces a file.
  const wrong = path.join(dir, "wrong.kdna");
  const mismatch = run(["source-pack", released, "--edits", editsPath, "--expected-a", "sha256:" + "0".repeat(64), "--output", wrong, "--allow-source"]);
  assert.equal(mismatch.status, 1);
  assert.equal(fs.existsSync(wrong), false);

  // 3. A signed container is refused before anything is repacked.
  const signed = path.join(dir, "signed.kdna");
  fs.writeFileSync(signed, appendStoredEntry(releasedBytes, "signature.kdsig", Buffer.from("not-a-real-signature")));
  assert.equal(classifySourceContainer(fs.readFileSync(signed)).kind, "signed");
  const signedOut = path.join(dir, "signed-out.kdna");
  const refused = run(["source-pack", signed, "--edits", editsPath, "--expected-a", digestA(signed), "--output", signedOut, "--allow-source"]);
  assert.equal(refused.status, 1);
  assert.equal(last(refused.stdout).code, "KDNA_SOURCE_SIGNED_CHECKSUMS_REFUSED");
  assert.equal(fs.existsSync(signedOut), false);

  // 4. A container without checksums.json packs exactly as before (no checksums field).
  const plainOut = path.join(dir, "plain-out.kdna");
  const plain = run(["source-pack", base, "--edits", editsPath, "--expected-a", digestA(base), "--output", plainOut, "--allow-source"]);
  assert.equal(plain.status, 0, plain.stdout);
  assert.equal(last(plain.stdout).checksums, undefined);
  assert.equal(containerHasEntry(fs.readFileSync(plainOut), "checksums.json"), false);
});
