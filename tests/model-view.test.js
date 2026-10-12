"use strict";
// The body projection is a capability of the installed Read package, not of this
// CLI. These tests pin both sides of that boundary: with the capability absent
// every byte of the default output is what this CLI printed before --view
// existed, and with the capability present the default surface is the body view.
// Each side is asserted only when it applies, so the suite stays true once a
// Read artifact that provides the projection is the installed one.
const test = require("node:test"), assert = require("node:assert/strict");
const { before, after } = require("node:test");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const target = process.env.KDNA_CLI_TARGET_ROOT || path.resolve(__dirname, "..");
const local = createRequire(path.join(target, "package.json"));
const { run } = local("@aikdna/kdna-cli");
const pkg = local("@aikdna/kdna-cli/package.json");
const bin = path.join(target, pkg.bin.kdna);
const fixtures = process.env.KDNA_CLI_FIXTURES || path.join(__dirname, "fixtures");
// One current native asset in owned scratch: the committed graph fixtures are
// older container versions this reader rejects, so the read surface has to be
// exercised on a current one.
let file = path.join(fixtures, "native-graph-cross.kdna"), scratch;
before(async () => {
  if (process.env.KDNA_CLI_FIXTURES) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-model-view-"));
  file = path.join(scratch, "native-graph-cross.kdna");
  const out = sink();
  assert.equal(await run(["create", path.join(fixtures, "native-graph-cross.authored.json"), "--output", file, "--allow-create"], out), 0);
  assert.equal(JSON.parse(out.lines.join("")).status, "saved");
});
after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
const projection = (() => {
  try {
    const module = local("@aikdna/kdna-read");
    return typeof module.projectModelView === "function" ? module : null;
  } catch {
    return null;
  }
})();
// Built per call: the asset is created in the before hook above.
const readArgs = () => ["read", file, "--mode", "whole_asset", "--allow-read"];
function sink() {
  const lines = [];
  return { lines, write(value) { lines.push(value); return true; } };
}
async function invoke(argv) {
  const out = sink();
  const code = await run(argv, out);
  const text = out.lines.join("");
  return { code, text, rows: text.trim().split("\n").filter(Boolean).map(JSON.parse) };
}
function binary(argv, input) {
  return spawnSync(process.execPath, [bin, ...argv], { input, encoding: "utf8", env: process.env, timeout: 15000 });
}
// Two invocations of the same command cannot be byte-identical: each run mints
// its own UUID identifiers and clocks, and the receipts bind them. Rather than
// hand-maintain a list of those fields, the test derives the run-local path set
// from two runs of the unchanged path and then requires that the default output
// differs from that path only inside that set. A projection appearing in the
// default would differ in structural paths the old path never varies, and fail.
function diffPaths(left, right, prefix = "", out = []) {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) out.push(prefix + "[]");
    else left.forEach((item, index) => diffPaths(item, right[index], prefix + "/" + index, out));
    return out;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) diffPaths(left[key], right[key], prefix + "/" + key, out);
    return out;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) out.push(prefix);
  return out;
}

test("the default read output is the full surface when the installed Read package cannot project", async () => {
  if (projection) return;
  const shown = await invoke(readArgs()), explicit = await invoke([...readArgs(), "--view", "full"]), again = await invoke([...readArgs(), "--view", "full"]);
  assert.equal(shown.code, 0, JSON.stringify(shown.rows));
  assert.equal(explicit.code, 0, JSON.stringify(explicit.rows));
  const runLocal = new Set(diffPaths(explicit.rows[0], again.rows[0]));
  assert.ok(runLocal.size > 0, "two runs of the same command must differ, or this control proves nothing");
  const changed = diffPaths(shown.rows[0], explicit.rows[0]);
  for (const path of changed) assert.ok(runLocal.has(path), `the default changed something the old path does not vary: ${path}`);
  assert.equal(Object.hasOwn(shown.rows[0], "view_contract"), false, "no body view may be claimed");
  assert.equal(Object.hasOwn(shown.rows[0].envelope.content, "asset_index"), true, "the moved material stays on the default surface");
  assert.deepEqual(Object.keys(shown.rows[0]).sort(), Object.keys(explicit.rows[0]).sort(), "same top-level shape");
  assert.deepEqual(Object.keys(shown.rows[0].envelope).sort(), Object.keys(explicit.rows[0].envelope).sort(), "same envelope shape");
});

test("the default read output is the body view when the installed Read package provides it", async () => {
  if (!projection) return;
  const body = await invoke(readArgs()), full = await invoke([...readArgs(), "--view", "full"]);
  assert.equal(body.code, 0, JSON.stringify(body.rows));
  assert.equal(body.rows[0].view_contract, "kdna.read.model-view/0.1.0");
  assert.equal(Object.hasOwn(body.rows[0], "fingerprint"), true);
  assert.equal(Object.hasOwn(body.rows[0].content, "asset_index"), false);
  assert.equal(Object.hasOwn(body.rows[0].content, "expansion_handles"), false);
  assert.equal(Object.hasOwn(full.rows[0], "view_contract"), false);
  assert.equal(Object.hasOwn(full.rows[0].envelope.content, "asset_index"), true);
  assert.notEqual(body.text, full.text);
});

test("an explicit body request is refused when the capability is absent, never substituted", async () => {
  if (projection) return;
  const refused = await invoke([...readArgs(), "--view", "body"]);
  assert.equal(refused.code, 2);
  assert.equal(refused.rows[0].code, "KDNA_MODEL_VIEW_UNAVAILABLE");
  assert.equal(refused.rows[0].action_authorized, false);
});

test("an unknown view is an argument error, never a silent fallback", async () => {
  for (const value of ["summary", "BODY", ""]) assert.equal((await invoke([...readArgs(), "--view", value])).code, 2, value);
  assert.equal((await invoke([...readArgs(), "--view"])).code, 2, "a view flag without a value");
});

test("--view may accompany a session because it names the output surface, not the request", () => {
  const withView = binary(["read", file, "--session", "--allow-read", "--view", "full"], "");
  assert.equal(withView.status, 0, withView.stderr);
  const withMode = binary(["read", file, "--session", "--allow-read", "--mode", "catalog"], "");
  assert.equal(withMode.status, 2, "a per-line request option stays refused with --session");
});
