"use strict";
// System-integrity warnings and change propagation, driven through the real
// CLI face on real containers. The warning checks must never refuse a
// structurally valid asset: every case below is created by this CLI first, so
// acceptance and warning-only behavior are proven on the same artifact.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const target = process.env.KDNA_CLI_TARGET_ROOT || path.resolve(__dirname, "..");
const local = createRequire(path.join(target, "package.json"));
const { run } = local("@aikdna/kdna-cli");
const FIXTURE = path.join(__dirname, "fixtures", "graph-expand-session.authored.json");
const sink = () => { const lines = []; return { lines, write(value) { lines.push(String(value)); return true; } }; };
let scratch;
test.before(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-system-checks-")); });
test.after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
async function invoke(argv) {
  const out = sink();
  const code = await run(argv, out);
  const text = out.lines.join("");
  return { code, text, row: text.trim() ? JSON.parse(text.trim()) : null };
}
function authored(mutate) {
  const doc = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  mutate(doc.payload);
  return doc;
}
function writeAuthored(name, doc) {
  const file = path.join(scratch, name + ".authored.json");
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}
function relation(id, kind, participants) {
  const operator = { support: "supports", qualify: "qualifies", conflict: "conflicts_with", complement: "complements" }[kind];
  const effect = { support: "offers_support", qualify: "limits_interpretation", conflict: "preserves_disagreement", complement: "adds_perspective" }[kind];
  return { id, kind: { term: kind }, direction: kind === "conflict" ? "undirected" : "directed",
    operator: { term: operator }, effect: { term: effect }, statement: `Synthetic ${kind} for the system-check regression.`,
    participants: participants.map(([role, ref]) => ({ role: { term: role }, judgment_ref: ref })) };
}
async function create(name, doc) {
  const file = path.join(scratch, name + ".kdna");
  const result = await invoke(["create", writeAuthored(name, doc), "--output", file, "--allow-create"]);
  assert.equal(result.code, 0, result.text);
  assert.equal(result.row.status, "saved");
  return file;
}
const warningCodes = row => (row.system?.warnings ?? []).map(warning => warning.code);

test("--system warns on each system-integrity class without refusing the asset", async () => {
  const doc = authored(payload => {
    payload.relationships = [
      relation("relationship:cycle-01", "support", [["supporter", "j:0"], ["claim", "j:1"]]),
      relation("relationship:cycle-10", "support", [["supporter", "j:1"], ["claim", "j:0"]]),
      relation("relationship:pair-conflict", "conflict", [["side_a", "j:0"], ["side_b", "j:1"]]),
      relation("relationship:qualify-23", "qualify", [["qualifier", "j:2"], ["qualified", "j:0"]]),
    ];
    payload.judgments.find(judgment => judgment.id === "j:2").lifecycle =
      { status: "withdrawn", superseded_by: [], statement: "Withdrawn in the system-check regression." };
    payload.shared_declarations = [
      { id: "shared:order-dup", subject: { actor_ids: ["actor:boundary"], statement: "Repeated ordering" }, applies_to: { kind: "asset" }, kind: "value_order", value: ["first", "first"] },
      { id: "shared:order-scoped", subject: { actor_ids: ["actor:boundary"], statement: "Scoped ordering" }, applies_to: { kind: "judgments", judgment_refs: ["j:0", "j:1"] }, kind: "value_order", value: ["only one entry"] },
    ];
  });
  const file = await create("warnings", doc);
  const result = await invoke(["validate", file, "--system"]);
  assert.equal(result.code, 0, "warnings never refuse a structurally valid asset");
  assert.equal(result.row.status, "accepted");
  assert.equal(result.row.format_valid, true);
  assert.equal(result.row.system.status, "warnings");
  assert.equal(result.row.system.warning_count, result.row.system.warnings.length);
  assert.deepEqual([...warningCodes(result.row)].sort(), [
    "KDNA_SYSTEM_SUPPORT_CONFLICT_PAIR",
    "KDNA_SYSTEM_SUPPORT_CYCLE",
    "KDNA_SYSTEM_VALUE_ORDER_DUPLICATE",
    "KDNA_SYSTEM_VALUE_ORDER_MISSING_ENTRIES",
    "KDNA_SYSTEM_WITHDRAWN_UPSTREAM",
  ]);
  const cycle = result.row.system.warnings.find(warning => warning.code === "KDNA_SYSTEM_SUPPORT_CYCLE");
  assert.deepEqual(cycle.detail.judgment_ids, ["j:0", "j:1"]);
  assert.deepEqual(cycle.detail.relation_ids, ["relationship:cycle-01", "relationship:cycle-10"]);
  const withdrawn = result.row.system.warnings.find(warning => warning.code === "KDNA_SYSTEM_WITHDRAWN_UPSTREAM");
  assert.deepEqual([withdrawn.detail.upstream_judgment_id, withdrawn.detail.downstream_judgment_id], ["j:2", "j:0"]);
  assert.equal(withdrawn.detail.downstream_status, "undeclared");
  // The plain validate shape is unchanged and carries no system key at all.
  const plain = await invoke(["validate", file]);
  assert.equal(plain.code, 0);
  assert.equal(Object.hasOwn(plain.row, "system"), false);
  assert.deepEqual(Object.keys(plain.row).sort(), ["diagnostics", "format_valid", "states", "status"], "the unchanged validate shape");
  assert.equal(plain.row.status, "accepted");
});

test("--system stays silent on legal structures and reports clean", async () => {
  const clean = await create("clean", authored(() => {}));
  const cleanResult = await invoke(["validate", clean, "--system"]);
  assert.equal(cleanResult.code, 0);
  assert.deepEqual(cleanResult.row.system, { status: "clean", warning_count: 0, warnings: [] });
  // Each legal counterpart of a warning class: an acyclic support DAG with a
  // conflict pair that shares no support edge; a withdrawn upstream whose
  // downstream is explicitly withdrawn too; a strictly ordered asset-scoped
  // declaration and a scoped one that ranks at least as many entries as its
  // scope; and a complement cycle, which carries no dependence.
  const doc = authored(payload => {
    payload.relationships = [
      relation("relationship:dag-01", "support", [["supporter", "j:0"], ["claim", "j:1"]]),
      relation("relationship:dag-12", "support", [["supporter", "j:1"], ["claim", "j:2"]]),
      relation("relationship:conflict-02", "conflict", [["side_a", "j:0"], ["side_b", "j:2"]]),
      relation("relationship:withdrawn-both", "qualify", [["qualifier", "j:1"], ["qualified", "j:2"]]),
      relation("relationship:complement-cycle-a", "complement", [["supplement", "j:0"], ["base", "j:1"]]),
      relation("relationship:complement-cycle-b", "complement", [["supplement", "j:1"], ["base", "j:0"]]),
    ];
    payload.judgments.find(judgment => judgment.id === "j:1").lifecycle =
      { status: "withdrawn", superseded_by: [], statement: "Withdrawn upstream." };
    payload.judgments.find(judgment => judgment.id === "j:2").lifecycle =
      { status: "withdrawn", superseded_by: [], statement: "Downstream withdrawn with its upstream." };
    payload.shared_declarations = [
      { id: "shared:order-strict", subject: { actor_ids: ["actor:boundary"], statement: "Strict ordering" }, applies_to: { kind: "asset" }, kind: "value_order", value: ["first", "second", "third"] },
      { id: "shared:order-covered", subject: { actor_ids: ["actor:boundary"], statement: "Covered ordering" }, applies_to: { kind: "judgments", judgment_refs: ["j:0", "j:1"] }, kind: "value_order", value: ["first", "second"] },
    ];
  });
  const file = await create("legal", doc);
  const result = await invoke(["validate", file, "--system"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.row.system, { status: "clean", warning_count: 0, warnings: [] });
});

test("--system is a validate-only flag and refuses nothing by itself", async () => {
  const file = await create("flag-scope", authored(() => {}));
  const refused = await invoke(["inspect", file, "--system"]);
  assert.equal(refused.code, 2);
  assert.equal(refused.row.code, "KDNA_ARGUMENT_INVALID");
});

test("source-pack reports the direct downstream of changed judgments and nothing else", async () => {
  // j:0 supports j:1; j:1 supports j:2 (indirect, must stay out); j:0 also
  // complements j:3 (no dependence, must stay out).
  const doc = authored(payload => {
    const fourth = JSON.parse(JSON.stringify(payload.judgments[2]));
    fourth.id = "j:3"; fourth.focus = "Fourth issue";
    fourth.core_expression = { ...fourth.core_expression, statement: "Authored answer 3" };
    fourth.method.components[0] = { ...fourth.method.components[0], id: "component:3" };
    fourth.ports[0] = { ...fourth.ports[0], name: "output:dependency:optional:3" };
    fourth.result_contract = { ...fourth.result_contract, id: "result-contract:3" };
    fourth.result = { ...fourth.result, contract_ref: "result-contract:3", value: { kind: "text", value: "Authored result 3" } };
    payload.judgments.push(fourth);
    payload.reading_order = ["j:0", "j:1", "j:2", "j:3"];
    payload.relationships = [
      relation("relationship:prop-01", "support", [["supporter", "j:0"], ["claim", "j:1"]]),
      relation("relationship:prop-12", "support", [["supporter", "j:1"], ["claim", "j:2"]]),
      relation("relationship:prop-complement", "complement", [["supplement", "j:0"], ["base", "j:3"]]),
    ];
  });
  const original = await create("prop-original", doc);
  const expected = "sha256:" + createHash("sha256").update(fs.readFileSync(original)).digest("hex");
  const opened = await invoke(["source-open", original, "--expected-a", expected, "--allow-source"]);
  assert.equal(opened.code, 0, opened.text);
  assert.equal(opened.row.status, "source_opened");
  const edits = { manifest: opened.row.edits.manifest, payload: opened.row.edits.payload };
  const changed = edits.payload.judgments.find(judgment => judgment.id === "j:0");
  changed.core_expression.statement = "Revised statement";
  changed.result.value.value = "Revised statement";
  edits.manifest.version = edits.payload.asset.asset_version = "1.0.1";
  const editFile = path.join(scratch, "edits-change.json");
  fs.writeFileSync(editFile, JSON.stringify(edits));
  const packed = await invoke(["source-pack", original, "--edits", editFile, "--expected-a", expected,
    "--output", path.join(scratch, "prop-revised.kdna"), "--allow-source"]);
  assert.equal(packed.code, 0, packed.text);
  assert.equal(packed.row.status, "saved");
  assert.deepEqual(packed.row.affected_by_change, {
    changed_judgment_ids: ["j:0"],
    relation_kinds: ["support", "qualify", "conflict"],
    direct_downstream: [
      { judgment_id: "j:1", via: [{ relation_id: "relationship:prop-01", kind: "support", role: "claim", state: "in_produced_asset" }] },
    ],
  });
  // A relation this revision removes still names its downstream, marked as
  // changed by this revision rather than present in the produced asset.
  const editsRemoved = JSON.parse(JSON.stringify(edits));
  editsRemoved.payload.relationships = editsRemoved.payload.relationships.filter(entry => entry.id !== "relationship:prop-01");
  const removedFile = path.join(scratch, "edits-removed.json");
  fs.writeFileSync(removedFile, JSON.stringify(editsRemoved));
  const packedRemoved = await invoke(["source-pack", original, "--edits", removedFile, "--expected-a", expected,
    "--output", path.join(scratch, "prop-removed.kdna"), "--allow-source"]);
  assert.equal(packedRemoved.code, 0, packedRemoved.text);
  assert.deepEqual(packedRemoved.row.affected_by_change, {
    changed_judgment_ids: ["j:0"],
    relation_kinds: ["support", "qualify", "conflict"],
    direct_downstream: [
      { judgment_id: "j:1", via: [{ relation_id: "relationship:prop-01", kind: "support", role: "claim", state: "changed_by_this_revision" }] },
    ],
  });
});
