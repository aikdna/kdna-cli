"use strict";
// The documented local host install runs `npm ci` against the committed
// development lock. npm validates that lock against the complete dependency
// graph, optional entries included, before it installs anything. A lock that
// was generated with `--omit=optional` therefore fails with EUSAGE on newer
// npm versions even though the documented command also passes
// `--omit=optional`. This gate keeps the committed lock complete.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOCK_PATH = path.join(ROOT, "release-surface", "native-offline-host", "package-lock.json");
const PACKAGE_PATH = path.join(ROOT, "release-surface", "native-offline-host", "package.json");

function lockPathFor(name, packages) {
  const direct = `node_modules/${name}`;
  if (packages[direct]) return direct;
  for (const key of Object.keys(packages)) if (key.endsWith(`/node_modules/${name}`)) return key;
  return null;
}

test("the committed offline host lock resolves every declared dependency", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  assert.equal(lock.lockfileVersion, 3);
  const packages = lock.packages;
  assert.ok(packages && Object.keys(packages).length > 1, "the lock must describe the installed tree");
  assert.deepEqual(Object.keys(packages[""]?.dependencies ?? {}).sort(), Object.keys(manifest.dependencies ?? {}).sort());

  const unresolved = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "") continue;
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const name of Object.keys(entry[field] ?? {})) {
        if (!lockPathFor(name, packages)) unresolved.push(`${key || "<root>"} -> ${field}.${name}`);
      }
    }
  }
  assert.deepEqual(unresolved, [], `the lock must resolve every dependency, including optional ones:\n${unresolved.join("\n")}`);
});

test("no committed lock entry claims an optional package is required", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || entry.optional !== true) continue;
    // An optional entry is allowed to exist so `npm ci` can validate the
    // graph, but the documented install keeps it out of the runtime tree.
    assert.equal(entry.dev, undefined);
  }
  const accelerator = lock.packages["node_modules/cbor-extract"];
  assert.ok(accelerator, "the optional native accelerator must be described by the lock");
  assert.equal(accelerator.optional, true);
});
