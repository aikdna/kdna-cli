"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const target = process.env.KDNA_CLI_TARGET_ROOT || path.resolve(__dirname, "..");
const pkg = require(path.join(target, "package.json"));
const bin = path.join(target, pkg.bin.kdna);

test("read help separates whole_asset delivery, model input and the envelope budget", () => {
  const result = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const phrase of [
    "whole_asset returns the Core asset closure",
    "may defer judgment bodies behind handles",
    "default body view can list the catalog with zero judgment bodies",
    "one session request with multiple judgment_ids",
    "--budget counts the complete final JCS read envelope",
    "Keep this disclosure budget separate from the",
    "model context budget",
  ]) {
    assert.ok(result.stdout.includes(phrase), phrase);
  }
});
