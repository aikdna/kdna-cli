"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const target = process.env.KDNA_CLI_TARGET_ROOT || path.resolve(__dirname, "..");
const pkg = require(path.join(target, "package.json"));
const bin = path.join(target, pkg.bin.kdna);

const run = (args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
const last = (stdout) => JSON.parse(stdout.trim().split("\n").pop());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kdna-draft-cli-"));

function filledDraft(dir) {
  const file = path.join(dir, "draft.json");
  const scaffold = run(["init", "--output", file]);
  assert.equal(scaffold.status, 0, scaffold.stdout + scaffold.stderr);
  const draft = JSON.parse(fs.readFileSync(file, "utf8"));
  draft.asset.title = "Brief updates";
  draft.asset.summary = "How I prefer short written updates.";
  draft.scope = "Routine written updates; incident response is out of scope.";
  draft.actors[0].name = "Example author";
  draft.highest_question = "How should a routine update be written?";
  draft.boundaries = null;
  const judgment = draft.judgments[0];
  judgment.focus = "Keep it short";
  judgment.statement = "Lead with the decision, then one line of evidence.";
  judgment.applies_when = "Routine weekly updates.";
  delete judgment.boundaries;
  fs.writeFileSync(file, JSON.stringify(draft, null, 2));
  return file;
}

test("init prints a draft to stdout and saves a new file without replacing one", () => {
  const dir = tmp();
  const printed = run(["init"]);
  assert.equal(printed.status, 0);
  assert.equal(JSON.parse(printed.stdout).format, "kdna.draft/1");
  const file = path.join(dir, "draft.json");
  assert.equal(run(["init", "--output", file]).status, 0);
  const again = run(["init", "--output", file]);
  assert.equal(again.status, 1);
  assert.equal(last(again.stdout).code, "KDNA_OUTPUT_EXISTS");
  assert.equal(run(["init", "--output", path.join(dir, "draft.txt")]).status, 2);
});

test("an untouched scaffold cannot become an asset and every placeholder is named", () => {
  const dir = tmp();
  const file = path.join(dir, "draft.json");
  run(["init", "--output", file]);
  const created = run(["create", "--draft", file, "--output", path.join(dir, "a.kdna"), "--allow-create"]);
  assert.equal(created.status, 1);
  const refusal = last(created.stdout);
  assert.equal(refusal.code, "KDNA_DRAFT_INVALID");
  assert.ok(refusal.diagnostics.some((entry) => entry.code === "placeholder_not_replaced" && entry.field === "asset.title"));
  assert.equal(fs.existsSync(path.join(dir, "a.kdna")), false);
});

test("a filled draft validates, creates, inspects and validates as a 0.6.0 asset", () => {
  const dir = tmp();
  const file = filledDraft(dir);
  const checked = run(["validate-input", file]);
  assert.equal(checked.status, 0, checked.stdout);
  assert.equal(last(checked.stdout).status, "valid");
  const asset = path.join(dir, "a.kdna");
  const created = run(["create", "--draft", file, "--output", asset, "--allow-create"]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  assert.equal(last(created.stdout).status, "saved");
  const inspected = run(["inspect", asset]);
  assert.equal(inspected.status, 0, inspected.stdout);
  const view = last(inspected.stdout);
  assert.equal(view.tuple.container, "0.6.0");
  assert.equal(view.judgment_count, 1);
  assert.equal(run(["validate", asset, "--system"]).status, 0);
});

test("compile output feeds the unchanged create route to the same asset bytes", () => {
  const dir = tmp();
  const file = filledDraft(dir);
  const authored = path.join(dir, "authored.json");
  assert.equal(run(["compile", file, "--output", authored]).status, 0);
  const viaCompile = path.join(dir, "via-compile.kdna");
  const viaDraft = path.join(dir, "via-draft.kdna");
  assert.equal(run(["create", authored, "--output", viaCompile, "--allow-create"]).status, 0);
  assert.equal(run(["create", "--draft", file, "--output", viaDraft, "--allow-create"]).status, 0);
  const compiled = JSON.parse(fs.readFileSync(authored, "utf8"));
  assert.deepEqual(Object.keys(compiled).sort(), ["manifest", "members", "payload"]);
  const hash = (f) => last(run(["inspect", f]).stdout).asset.asset_id;
  assert.equal(hash(viaCompile), hash(viaDraft));
});

test("validate-input names the exact missing fields of a hollow authored input", () => {
  const dir = tmp();
  const file = path.join(dir, "hollow.json");
  fs.writeFileSync(file, JSON.stringify({ manifest: {}, payload: {}, members: [] }));
  const checked = run(["validate-input", file]);
  assert.equal(checked.status, 1);
  const result = last(checked.stdout);
  assert.equal(result.status, "invalid");
  assert.ok(result.diagnostics.some((entry) => entry.field === "/manifest/asset_id" && entry.code === "missing_field"));
  assert.ok(result.diagnostics.every((entry) => typeof entry.hint === "string" && entry.hint.length > 0));
});

test("a Core refusal of create keeps the Core diagnostic and adds field hints", () => {
  const dir = tmp();
  const authored = path.join(target, "examples", "team-update", "author.json");
  const input = JSON.parse(fs.readFileSync(authored, "utf8"));
  delete input.payload.sources;
  const file = path.join(dir, "broken.json");
  fs.writeFileSync(file, JSON.stringify(input));
  const created = run(["create", file, "--output", path.join(dir, "x.kdna"), "--allow-create"]);
  assert.equal(created.status, 1);
  const result = last(created.stdout);
  assert.equal(result.status, "core_rejected");
  assert.ok(Array.isArray(result.core.diagnostics));
  assert.ok(result.input_diagnostics.some((entry) => entry.field === "/payload/sources"));
});

test("draft options are refused where they do not belong", () => {
  const dir = tmp();
  const file = filledDraft(dir);
  assert.equal(run(["create", file, "--draft", file, "--output", path.join(dir, "a.kdna"), "--allow-create"]).status, 2);
  assert.equal(run(["init", file]).status, 2);
  assert.equal(run(["validate-input", file, "--output", "x.json"]).status, 2);
});

test("init --mode supports minimal, interview, works, research and returns exit 2 on unknown mode", () => {
  const minimal = run(["init", "--mode", "minimal"]);
  const def = run(["init"]);
  assert.equal(minimal.status, 0);
  assert.equal(minimal.stdout, def.stdout);
  for (const [mode, expectedTerm] of [["interview", "tradeoff"], ["works", "criteria_comparison"], ["research", "evidence_analysis"]]) {
    const res = run(["init", "--mode", mode]);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.format, "kdna.draft/1");
    assert.equal(parsed.judgments[0].method.term, expectedTerm);
  }
  const bad = run(["init", "--mode", "nonexistent"]);
  assert.equal(bad.status, 2);
  assert.equal(last(bad.stdout).code, "KDNA_INVALID_INIT_MODE");
});

test("duplicate method component roles report duplicate_roles and fix_hint in both validate-input and create", () => {
  const dir = tmp();
  const authored = path.join(target, "examples", "team-update", "author.json");
  const input = JSON.parse(fs.readFileSync(authored, "utf8"));
  input.payload.judgments[0].method = {
    method: { term: "tradeoff" },
    components: [
      { id: "c1", method: { term: "tradeoff" }, role: "候选方案", material_refs: [], statement: "A vs B." },
      { id: "c2", method: { term: "tradeoff" }, role: "比较因素", material_refs: [], statement: "Speed vs clarity." },
      { id: "c3", method: { term: "tradeoff" }, role: "取舍原则", material_refs: [], statement: "Clarity wins." },
      { id: "c4", method: { term: "tradeoff" }, role: "不可兼得之处", material_refs: [], statement: "Extra review round." },
      { id: "c5", method: { term: "tradeoff" }, role: "不可兼得之处", material_refs: [], statement: "Slightly longer text." },
    ],
    bindings: [],
  };
  const file = path.join(dir, "dup-role.json");
  fs.writeFileSync(file, JSON.stringify(input));

  const validated = run(["validate-input", file]);
  assert.equal(validated.status, 1);
  const vRes = last(validated.stdout);
  const dupDiag = vRes.diagnostics.find((d) => d.code === "duplicate_method_roles");
  assert.ok(dupDiag, validated.stdout);
  assert.deepEqual(dupDiag.duplicate_roles, [{ role: "不可兼得之处", component_ids: ["c4", "c5"] }]);
  assert.match(dupDiag.fix_hint, /must appear at most once/);

  const created = run(["create", file, "--output", path.join(dir, "dup.kdna"), "--allow-create"]);
  assert.equal(created.status, 1);
  const cRes = last(created.stdout);
  assert.equal(cRes.status, "core_rejected");
  assert.ok(Array.isArray(cRes.guidance) && cRes.guidance.length > 0, created.stdout);
  assert.deepEqual(cRes.guidance[0].duplicate_roles, [{ role: "不可兼得之处", component_ids: ["c4", "c5"] }]);
  assert.match(cRes.guidance[0].fix_hint, /must appear at most once/);
});

test("validate-input --format human renders non-blocking advisories while keeping exit status 0", () => {
  const dir = tmp();
  const file = filledDraft(dir);
  const draft = JSON.parse(fs.readFileSync(file, "utf8"));
  draft.judgments[0].statement = draft.judgments[0].focus;
  draft.judgments[0].applies_when = "all";
  fs.writeFileSync(file, JSON.stringify(draft, null, 2));

  const jsonRes = run(["validate-input", file]);
  assert.equal(jsonRes.status, 0, jsonRes.stdout);
  const parsed = last(jsonRes.stdout);
  assert.equal(parsed.status, "valid");
  assert.ok(parsed.advisories.some((a) => a.code === "tautological_statement"));
  assert.ok(parsed.advisories.some((a) => a.code === "unbounded_judgment"));
  assert.ok(parsed.advisories.some((a) => a.code === "overbroad_scope"));

  const humanRes = run(["validate-input", file, "--format", "human"]);
  assert.equal(humanRes.status, 0, humanRes.stdout);
  assert.match(humanRes.stdout, /Valid input: yes \(kind draft, judgments 1\)/);
  assert.match(humanRes.stdout, /Advisories \(non-blocking\):/);
  assert.match(humanRes.stdout, /\[tautological_statement\]/);
});

test("init --lang en|zh and --example run end-to-end through validate-input, create, read, protect and diff", () => {
  const dir = tmp();
  const draftPath = path.join(dir, "draft.json");
  const assetPath = path.join(dir, "my-judgments.kdna");
  const lockedPath = path.join(dir, "locked.kdna");
  const pwPath = path.join(dir, "password.txt");
  const revDraftPath = path.join(dir, "revised-draft.json");
  const revAssetPath = path.join(dir, "revised.kdna");

  assert.equal(run(["init", "--example", "--mode", "interview", "--output", draftPath]).status, 0);
  assert.equal(run(["validate-input", draftPath, "--format", "human"]).status, 0);
  assert.equal(run(["create", "--draft", draftPath, "--output", assetPath, "--allow-create"]).status, 0);
  assert.equal(run(["read", assetPath, "--mode", "catalog", "--allow-read", "--format", "human"]).status, 0);
  const compactRead = run(["read", assetPath, "--mode", "exact_selection", "--judgment-id", "decision:first-dilemma", "--allow-read", "--compact"]);
  assert.equal(compactRead.status, 0, compactRead.stdout + compactRead.stderr);
  assert.equal(JSON.parse(compactRead.stdout).judgments[0].id, "decision:first-dilemma");

  fs.writeFileSync(pwPath, "a long passphrase");
  assert.equal(run(["protect", assetPath, "--output", lockedPath, "--password-file", pwPath]).status, 0);
  const lockedHuman = run(["read", lockedPath, "--mode", "exact_selection", "--judgment-id", "decision:first-dilemma", "--allow-read", "--password-file", pwPath, "--format", "human"]);
  assert.equal(lockedHuman.status, 0, lockedHuman.stderr);
  assert.match(lockedHuman.stdout, /Method \(tradeoff\):/);

  assert.equal(run(["init", "--example", "--mode", "works", "--output", revDraftPath]).status, 0);
  assert.equal(run(["create", "--draft", revDraftPath, "--output", revAssetPath, "--allow-create"]).status, 0);
  assert.equal(run(["diff", assetPath, revAssetPath, "--format", "human"]).status, 0);

  const zhInit = run(["init", "--mode", "interview", "--lang", "zh"]);
  assert.equal(zhInit.status, 0);
  assert.equal(JSON.parse(zhInit.stdout).asset.language, "zh-CN");
  assert.equal(run(["init", "--lang", "fr"]).status, 2);
});
