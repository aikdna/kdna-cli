"use strict";
// The full print must equal, field for field, what the published 0.40.1 CLI
// printed on the same deterministic asset: the selection reduction is filtered
// out of the full surface instead of silently changing it. The golden fixture
// was produced by scripts/generate-view-full-golden.cjs from a registry install
// of @aikdna/kdna-cli@0.40.1; only the volatile identifiers, timestamps and
// volatile-input digests listed in that script are normalized. Re-running the
// generator regenerates the golden from the registry install.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { normalize, FIXTURE, SELECTION } = require("../scripts/generate-view-full-golden.cjs");
const target = process.env.KDNA_CLI_TARGET_ROOT || path.resolve(__dirname, "..");
const local = createRequire(path.join(target, "package.json"));
const { run } = local("@aikdna/kdna-cli");
// The installed Read package's own response meter, reached by file because the
// package does not export it; the recomputation must use the exact routine that
// produced the printed counters.
const readRoot = path.dirname(local.resolve("@aikdna/kdna-read/package.json"));
const { measureInternalResponse } = require(path.join(readRoot, "src/retained-response-meter.js"));
const golden = require("./fixtures/view-full-golden.json");
let scratch, asset;
const sink = () => { const lines = []; return { lines, write(text) { lines.push(String(text)); return true; } }; };
test.before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-view-full-golden-"));
  asset = path.join(scratch, "golden-asset.kdna");
  const out = sink();
  const code = await run(["create", path.join(target, FIXTURE), "--output", asset, "--allow-create"], out);
  assert.equal(code, 0, out.lines.join(""));
  const saved = JSON.parse(out.lines.join(""));
  assert.equal(saved.output.sha256, golden.provenance.asset.sha256, "the fixture must create the exact golden asset bytes");
  assert.equal(saved.output.bytes, golden.provenance.asset.bytes);
});
test.after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
test("the full print matches the published 0.40.1 baseline field for field", async () => {
  const out = sink();
  const code = await run(
    ["read", asset, "--mode", SELECTION.mode, "--asset-id", SELECTION.asset_id, "--asset-version", SELECTION.asset_version, "--judgment-id", SELECTION.judgment_ids[0], "--allow-read", "--view", "full"],
    out,
  );
  assert.equal(code, 0, out.lines.join(""));
  const answer = JSON.parse(out.lines.join(""));
  // In-run self-consistency: the printed counters are the canonical byte size
  // of the printed envelope; recompute them with the meter that produced them.
  const recomputed = structuredClone(answer.envelope);
  measureInternalResponse(recomputed);
  assert.equal(answer.envelope.budget.actual_bytes, recomputed.budget.actual_bytes);
  assert.equal(answer.envelope.budget.required_bytes, recomputed.budget.required_bytes);
  assert.deepEqual(normalize(answer), golden.output);
});
