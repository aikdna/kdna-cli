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

const run = (args, options = {}) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", ...options });

function createAsset() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-multi-"));
  const output = path.join(dir, "team-update.kdna");
  const created = run(["create", authored, "--output", output, "--allow-create"]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  return { dir, output };
}

function selectedIds(stdout) {
  const result = JSON.parse(stdout.trim().split("\n").pop());
  return result.envelope?.content?.selected?.judgment_ids;
}

test("repeated --judgment-id reads several judgments in one catalog-ordered selection", () => {
  const { output } = createAsset();
  const result = run([
    "read", output, "--mode", "exact_selection",
    "--judgment-id", "update:evidence", "--judgment-id", "update:order",
    "--allow-read", "--view", "raw",
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ids = selectedIds(result.stdout);
  assert.ok(ids.includes("update:order") && ids.includes("update:evidence"), JSON.stringify(ids));
});

test("a comma-separated --judgment-id list is the same selection", () => {
  const { output } = createAsset();
  const repeated = run([
    "read", output, "--mode", "exact_selection",
    "--judgment-id", "update:order", "--judgment-id", "update:evidence", "--allow-read", "--view", "raw",
  ]);
  const comma = run([
    "read", output, "--mode", "exact_selection",
    "--judgment-id", "update:evidence,update:order", "--allow-read", "--view", "raw",
  ]);
  assert.equal(comma.status, 0, comma.stdout + comma.stderr);
  assert.deepEqual(selectedIds(comma.stdout), selectedIds(repeated.stdout));
});

test("an unknown id among several is refused by name with the catalog", () => {
  const { output } = createAsset();
  const result = run([
    "read", output, "--mode", "exact_selection",
    "--judgment-id", "update:order,update:nope", "--allow-read",
  ]);
  assert.equal(result.status, 1);
  const refusal = JSON.parse(result.stdout.trim());
  assert.equal(refusal.code, "KDNA_JUDGMENT_ID_UNKNOWN");
  assert.deepEqual(refusal.unknown_judgment_ids, ["update:nope"]);
  assert.ok(refusal.catalog_judgment_ids.includes("update:order"));
});

test("duplicate ids and multi-id outside exact_selection stay refused", () => {
  const { output } = createAsset();
  const duplicate = run(["read", output, "--mode", "exact_selection", "--judgment-id", "update:order,update:order", "--allow-read"]);
  assert.equal(duplicate.status, 2);
  const catalog = run(["read", output, "--mode", "catalog", "--judgment-id", "update:order,update:evidence", "--allow-read"]);
  assert.equal(catalog.status, 2);
});

test("a single --judgment-id keeps requiring the explicit asset id and version", () => {
  const { output } = createAsset();
  const result = run(["read", output, "--mode", "exact_selection", "--judgment-id", "update:order", "--allow-read"]);
  assert.notEqual(result.status, 0);
});
