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
const authored = path.join(target, "examples", "team-update", "author.json");

const run = (args, options = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", ...options });
const last = (stdout) => JSON.parse(stdout.trim().split("\n").pop());

// One plain asset, one protected copy and one revised asset are shared by the cases.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-protect-cli-"));
const plain = path.join(dir, "plain.kdna");
const protectedAsset = path.join(dir, "protected.kdna");
const revised = path.join(dir, "revised.kdna");
const passwordFile = path.join(dir, "password.txt");
const wrongFile = path.join(dir, "wrong.txt");
fs.writeFileSync(passwordFile, "correct horse battery staple\n");
fs.writeFileSync(wrongFile, "not the password");

test("setup: create a plain asset and protect it with a password file", () => {
  const created = run(["create", authored, "--output", plain, "--allow-create"]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const protectedRun = run(["protect", plain, "--output", protectedAsset, "--password-file", passwordFile]);
  assert.equal(protectedRun.status, 0, protectedRun.stdout + protectedRun.stderr);
  const result = last(protectedRun.stdout);
  assert.equal(result.status, "saved");
  assert.deepEqual(result.protection.encrypted_entries, ["payload.kdnab"]);
  assert.equal(result.action_authorized, false);
  assert.ok(!protectedRun.stdout.includes("correct horse"), "the password never reaches the output");
});

test("protect never replaces a file, needs a password source and refuses argv passwords", () => {
  const again = run(["protect", plain, "--output", protectedAsset, "--password-file", passwordFile]);
  assert.equal(again.status, 1);
  assert.equal(last(again.stdout).code, "KDNA_OUTPUT_EXISTS");
  assert.equal(run(["protect", plain, "--output", path.join(dir, "n.kdna")]).status, 2);
  assert.equal(run(["protect", plain, "--output", path.join(dir, "n.kdna"), "--password", "secret"]).status, 2);
  assert.equal(run(["protect", plain, "--output", path.join(dir, "n.kdna"), "--password-fd", "3", "--password-file", passwordFile]).status, 2);
  assert.equal(run(["protect", plain, "--output", path.join(dir, "n.kdna"), "--password-fd", "1"]).status, 2);
  assert.equal(run(["protect", protectedAsset, "--output", path.join(dir, "again.kdna"), "--password-file", passwordFile]).status, 1);
});

test("a protected asset is refused by name without a password and with a wrong one", () => {
  const none = run(["inspect", protectedAsset]);
  assert.equal(none.status, 1);
  assert.equal(last(none.stdout).code, "KDNA_PASSWORD_REQUIRED");
  const wrong = run(["inspect", protectedAsset, "--password-file", wrongFile]);
  assert.equal(wrong.status, 1);
  assert.equal(last(wrong.stdout).code, "PROTECTION_AUTHENTICATION_FAILED");
  assert.ok(!wrong.stdout.includes("not the password"));
  const empty = path.join(dir, "empty.txt");
  fs.writeFileSync(empty, "\n");
  assert.equal(last(run(["inspect", protectedAsset, "--password-file", empty]).stdout).code, "KDNA_PASSWORD_INVALID");
});

test("inspect and validate unlock a protected asset to the same identity as the plain one", () => {
  const plainView = last(run(["inspect", plain]).stdout);
  const unlocked = run(["inspect", protectedAsset, "--password-file", passwordFile]);
  assert.equal(unlocked.status, 0, unlocked.stdout);
  const view = last(unlocked.stdout);
  assert.deepEqual(view.asset, plainView.asset);
  assert.equal(view.judgment_count, plainView.judgment_count);
  assert.equal(view.protection.status, "unlocked");
  assert.equal(run(["validate", protectedAsset, "--system", "--password-file", passwordFile]).status, 0);
});

test("the password also comes from an inherited descriptor", () => {
  const fd = fs.openSync(passwordFile, "r");
  const result = spawnSync(process.execPath, [bin, "inspect", protectedAsset, "--password-fd", "3"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", fd] });
  fs.closeSync(fd);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(last(result.stdout).status, "accepted");
});

test("read of a protected asset returns the same judgments as the plain asset", () => {
  const ids = ["update:order", "update:evidence"];
  const args = (file, extra) => ["read", file, "--mode", "exact_selection", ...ids.flatMap((id) => ["--judgment-id", id]), "--allow-read", "--view", "raw", ...extra];
  const open = run(args(protectedAsset, ["--password-file", passwordFile]));
  assert.equal(open.status, 0, open.stdout + open.stderr);
  const plainRead = last(run(args(plain, [])).stdout);
  const protectedRead = last(open.stdout);
  assert.deepEqual(protectedRead.envelope.content.selected.judgment_ids, plainRead.envelope.content.selected.judgment_ids);
  const refusal = run(["read", protectedAsset, "--mode", "catalog", "--allow-read"]);
  assert.equal(refusal.status, 1);
  assert.equal(last(refusal.stdout).code, "KDNA_PASSWORD_REQUIRED");
});

test("--compact keeps the answer's judgments and is much smaller than the default body", () => {
  const base = ["read", plain, "--mode", "exact_selection", "--judgment-id", "update:order", "--judgment-id", "update:evidence", "--allow-read"];
  const normal = run(base);
  const compact = run([...base, "--compact"]);
  assert.equal(compact.status, 0, compact.stdout + compact.stderr);
  assert.ok(compact.stdout.length < normal.stdout.length / 2, compact.stdout.length + " vs " + normal.stdout.length);
  assert.ok(compact.stdout.includes("update:order") && compact.stdout.includes("update:evidence"));
  assert.equal(run([...base, "--compact", "--view", "full"]).status, 2);
});

test("--format human renders inspect, validate and read as text and rejects other formats", () => {
  const inspected = run(["inspect", plain, "--format", "human"]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.ok(!inspected.stdout.trimStart().startsWith("{"));
  assert.ok(inspected.stdout.includes("asset:team-update-format"));
  const validated = run(["validate", plain, "--system", "--format", "human"]);
  assert.equal(validated.status, 0, validated.stderr);
  assert.ok(!validated.stdout.trimStart().startsWith("{"));
  const read = run(["read", plain, "--mode", "exact_selection", "--judgment-id", "update:order,update:evidence", "--allow-read", "--format", "human"]);
  assert.equal(read.status, 0, read.stderr);
  assert.ok(read.stdout.includes("update:order"));
  assert.equal(run(["inspect", plain, "--format", "yaml"]).status, 2);
});

test("diff compares assets, including a protected one, as JSON and as text", () => {
  const input = JSON.parse(fs.readFileSync(authored, "utf8"));
  const judgment = input.payload.judgments.find((entry) => entry.id === "update:order");
  judgment.core_expression.statement = judgment.core_expression.statement + " Keep it under five lines.";
  const file = path.join(dir, "revised.json");
  fs.writeFileSync(file, JSON.stringify(input));
  assert.equal(run(["create", file, "--output", revised, "--allow-create"]).status, 0);
  const identical = run(["diff", plain, plain]);
  assert.equal(identical.status, 0, identical.stdout + identical.stderr);
  assert.equal(last(identical.stdout).identical, true);
  const changed = run(["diff", plain, revised]);
  assert.equal(changed.status, 0, changed.stdout + changed.stderr);
  const result = last(changed.stdout);
  assert.equal(result.identical, false);
  assert.ok(result.judgments.changed.some((entry) => entry.id === "update:order"), JSON.stringify(result.judgments));
  const viaProtected = last(run(["diff", protectedAsset, revised, "--password-file", passwordFile]).stdout);
  assert.ok(viaProtected.judgments.changed.some((entry) => entry.id === "update:order"));
  const human = run(["diff", plain, revised, "--format", "human"]);
  assert.equal(human.status, 0);
  assert.ok(human.stdout.includes("update:order"));
  assert.equal(run(["diff", plain]).status, 2);
  assert.equal(run(["inspect", plain, revised]).status, 2);
  assert.equal(last(run(["diff", protectedAsset, revised]).stdout).code, "KDNA_PASSWORD_REQUIRED");
});
