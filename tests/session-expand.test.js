"use strict";
// Retained same-session expansion on a real container, driven through the CLI
// face. The asset is created by this CLI from the committed authored fixture
// (creation is deterministic), read as an exact selection whose closure
// reaches a non-selected judgment member, and that member arrives reduced
// behind its own expansion handle. The session then expands it by the compact
// handle_id the reduced entry carries. Every refusal the resolution can state
// is returned verbatim with its guidance; resolution grants nothing, so a
// wrong selection is still refused by the reader's own admission. The STALE
// refusal needs a foreign snapshot the one-file session cannot produce and is
// covered at the library layer instead.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createRequire } = require("node:module");
const target = process.env.KDNA_CLI_TARGET_ROOT || path.resolve(__dirname, "..");
const local = createRequire(path.join(target, "package.json"));
const { run } = local("@aikdna/kdna-cli");
const binding = JSON.parse(fs.readFileSync(path.join(target, "public-contract-binding.json"), "utf8"));
const FIXTURE = "tests/fixtures/graph-expand-session.authored.json";
const SELECTION = { asset_id: "asset:bytes", asset_version: "1.0.0", judgment_ids: ["j:0"] };
let scratch, asset;
const sink = () => { const lines = []; return { lines, write(text) { lines.push(String(text)); return true; } }; };
test.before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-session-expand-"));
  asset = path.join(scratch, "expand-session.kdna");
  const out = sink();
  const code = await run(["create", path.join(target, FIXTURE), "--output", asset, "--allow-create"], out);
  assert.equal(code, 0, out.lines.join(""));
});
test.after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
// One session per call. Each builder receives the answers so far and returns
// the next request object, or null to end the input.
async function session(builders, options) {
  const answers = [];
  const out = { write(text) { answers.push(String(text)); return true; } };
  const input = (async function* () {
    for (const build of builders) {
      const previous = answers.length;
      const request = await build(answers);
      if (request === null) return;
      yield JSON.stringify(request) + "\n";
      // The answer to this line is written while the generator is suspended
      // here; wait for it before building the next dependent request.
      while (answers.length === previous) await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })();
  const code = await run(["read", asset, "--session", "--allow-read"], out, input, options);
  return { code, answers };
}
const request = (id, extra) => ({ request_id: id, tuple: binding.tuple, budget_bytes: 1000000, selection: SELECTION, handle: null, ...extra });
function reducedMember(answer) {
  return (answer.content?.closure ?? []).find((entry) => entry.state === "reduced" && entry.body_delivery === "deferred");
}
test("a reduced member expands by the compact handle_id within its session", async () => {
  let handleId;
  const { code, answers } = await session([
    () => request("cli:read", { mode: "exact_selection" }),
    (answers) => {
      const answer = JSON.parse(answers[0]);
      assert.equal(answer.status, "ready");
      const member = reducedMember(answer);
      assert.equal(member?.target?.id, "j:1", "the non-selected closure judgment is the reduced member");
      assert.match(member.handle_id, /^retained-handle:/u);
      handleId = member.handle_id;
      return request("cli:expand", { mode: "expand", handle_id: handleId });
    },
  ]);
  assert.equal(code, 0);
  const expanded = JSON.parse(answers[1]);
  assert.equal(expanded.status, "ready", answers[1]);
  const member = (expanded.content?.closure ?? []).find((entry) => entry.role === "judgment" && entry.target?.id === "j:1");
  assert.ok(member, "the expanded member is present");
  assert.equal(member.state ?? "inline", "inline", "the expanded member is delivered in full");
  assert.equal(member.value?.focus, "Explicit issue 1");
});
test("an id this session never issued is refused with its guidance", async () => {
  const { code, answers } = await session([
    () => request("cli:read", { mode: "exact_selection" }),
    () => request("cli:unknown", { mode: "expand", handle_id: "retained-handle:00000000-0000-4000-8000-000000000000" }),
  ]);
  assert.equal(code, 2);
  const refusal = JSON.parse(answers[1]);
  assert.equal(refusal.status, "unavailable");
  assert.equal(refusal.code, "READ_HANDLE_UNKNOWN");
  assert.match(refusal.guidance.action, /fresh read/u);
});
test("a handle_id beside a full handle, or outside expand, is an argument error", async () => {
  const both = await session([
    () => request("cli:read", { mode: "exact_selection" }),
    (answers) => {
      const member = reducedMember(JSON.parse(answers[0]));
      return request("cli:both", { mode: "expand", handle_id: member.handle_id, handle: {} });
    },
  ]);
  assert.equal(both.code, 2);
  assert.equal(JSON.parse(both.answers[1]).code, "KDNA_ARGUMENT_INVALID");
  const wrongMode = await session([
    () => request("cli:read", { mode: "exact_selection" }),
    () => request("cli:wrong-mode", { mode: "whole_asset", handle_id: "retained-handle:whatever" }),
  ]);
  assert.equal(wrongMode.code, 2);
  assert.equal(JSON.parse(wrongMode.answers[1]).code, "KDNA_ARGUMENT_INVALID");
});
test("a valid id expanded under a different selection is refused by the reader's own admission", async () => {
  const { code, answers } = await session([
    () => request("cli:read", { mode: "exact_selection" }),
    (answers) => {
      const member = reducedMember(JSON.parse(answers[0]));
      return {
        ...request("cli:foreign-selection", { mode: "expand", handle_id: member.handle_id }),
        selection: { asset_id: "asset:bytes", asset_version: "1.0.0", judgment_ids: ["j:2"] },
      };
    },
  ]);
  // The reader's own admission rejects: exit 1 for a rejected envelope,
  // distinct from the CLI-side unavailable/argument refusals at exit 2.
  assert.equal(code, 1);
  const refusal = JSON.parse(answers[1]);
  assert.equal(refusal.status, "rejected");
  assert.equal(refusal.diagnostic?.code, "READ_HANDLE_ASSET_MISMATCH");
});
test("an expired handle is refused once the local clock passes its window", async () => {
  const start = 1_760_000_000_000;
  let clock = start;
  const now = () => clock;
  const { code, answers } = await session(
    [
      () => request("cli:read", { mode: "exact_selection" }),
      (answers) => {
        const member = reducedMember(JSON.parse(answers[0]));
        clock = start + 60_001; // the CLI host window is sixty seconds
        return request("cli:expired", { mode: "expand", handle_id: member.handle_id });
      },
    ],
    { now },
  );
  assert.equal(code, 2);
  const refusal = JSON.parse(answers[1]);
  assert.equal(refusal.status, "unavailable");
  assert.equal(refusal.code, "READ_HANDLE_EXPIRED");
  assert.match(refusal.guidance.action, /fresh read/u);
});
