const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLI = path.resolve(__dirname, "..", "src", "cli.js");
const EVAL_PATH = path.resolve(__dirname, "..", "..", "kdna", "packages", "kdna-eval");

function ensureEvalAvailable() {
  try {
    require(EVAL_PATH);
    return;
  } catch (e) {
    if (e.code === "MODULE_NOT_FOUND" || e.message.includes("Cannot find module")) {
      throw new Error(
        `@aikdna/kdna-eval not found at ${EVAL_PATH}. ` +
          "Ensure it is installed: cd open/kdna && npm install"
      );
    }
  }
}

// Patch require to resolve @aikdna/kdna-eval from the monorepo path.
// The test sets KDNA_EVAL_PATH env var which eval-consumption.js checks.
// We run the CLI as a subprocess with the module path exposed.

function runCli(args, opts = {}) {
  const env = {
    ...process.env,
    NODE_PATH: [EVAL_PATH, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    ...(opts.env || {}),
  };
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd || process.cwd(),
    env,
    timeout: 30_000,
  });
}

test("eval-consumption --help shows usage", () => {
  ensureEvalAvailable();
  const r = runCli(["eval-consumption", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /--policy/);
  assert.match(r.stderr, /--gates/);
  assert.match(r.stderr, /--mode/);
  assert.match(r.stderr, /--budget/);
  assert.match(r.stderr, /--as=/);
});

test("eval-consumption with no args shows usage error", () => {
  ensureEvalAvailable();
  const r = runCli(["eval-consumption"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test("eval-consumption --as=json outputs valid JSON", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  try {
    const r = runCli(["eval-consumption", "test-asset", "--as=json"], { cwd: tmp });
    assert.equal(r.status, 0, `command failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.kdna_eval_consumption, "0.1.0");
    assert.equal(out.asset.path, "test-asset");
    assert.ok(Array.isArray(out.run.modes));
    assert.ok(Array.isArray(out.run.gates));
    assert.ok(out.run.timestamp);
    assert.ok(typeof out.results === "object");
    assert.ok(typeof out.verdict === "object");
    assert.equal(typeof out.verdict.overall, "string");
    assert.ok(typeof out.budget === "object");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval-consumption --as=markdown outputs human-readable report", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  try {
    const r = runCli(["eval-consumption", "test-asset", "--as=markdown"], { cwd: tmp });
    assert.equal(r.status, 0, `command failed: ${r.stderr}`);
    assert.match(r.stdout, /# KDNA Eval-Consumption Report/);
    assert.match(r.stdout, /## Asset/);
    assert.match(r.stdout, /## Run/);
    assert.match(r.stdout, /## Mode:/);
    assert.match(r.stdout, /\| Gate \| Pass \| Score \| Errors \|/);
    assert.match(r.stdout, /## Verdict/);
    assert.match(r.stdout, /## Budget/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval-consumption with custom gates uses only those gates", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  try {
    const r = runCli(
      ["eval-consumption", "test-asset", "--as=json", "--gates=route,cost"],
      { cwd: tmp }
    );
    assert.equal(r.status, 0, `command failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.run.gates, ["route", "cost"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval-consumption with custom modes uses only those modes", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  try {
    const r = runCli(
      ["eval-consumption", "test-asset", "--as=json", "--mode=repair,holdout"],
      { cwd: tmp }
    );
    assert.equal(r.status, 0, `command failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.run.modes, ["repair", "holdout"]);
    assert.equal(Object.keys(out.results).length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval-consumption with --out writes to file", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  const outFile = path.join(tmp, "report.json");
  try {
    const r = runCli(
      ["eval-consumption", "test-asset", "--as=json", `--out=${outFile}`],
      { cwd: tmp }
    );
    assert.equal(r.status, 0, `command failed: ${r.stderr}`);
    assert.ok(fs.existsSync(outFile));
    const content = JSON.parse(fs.readFileSync(outFile, "utf8"));
    assert.equal(content.kdna_eval_consumption, "0.1.0");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval-consumption with --policy loads policy file", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  const policyFile = path.join(tmp, "policy.json");
  try {
    fs.writeFileSync(
      policyFile,
      JSON.stringify({ id: "test-policy", version: "1.0", domains: [] }) + "\n"
    );
    const r = runCli(
      ["eval-consumption", "test-asset", "--as=json", `--policy=${policyFile}`],
      { cwd: tmp }
    );
    assert.equal(r.status, 0, `command failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.asset.version, "1.0");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval-consumption --budget uses correct profile", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  try {
    const r = runCli(
      ["eval-consumption", "test-asset", "--as=json", "--budget=code-review"],
      { cwd: tmp }
    );
    assert.equal(r.status, 0, `command failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.budget.profile, "code-review");
    assert.equal(out.budget.limits.maxChars, 3500);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval-consumption JSON output has stable schema", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  try {
    const r = runCli(["eval-consumption", "test-asset", "--as=json"], { cwd: tmp });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);

    const requiredTop = ["kdna_eval_consumption", "asset", "run", "results", "verdict", "budget"];
    for (const key of requiredTop) {
      assert.ok(key in out, `expected top-level key "${key}"`);
    }

    const requiredRun = ["timestamp", "modes", "gates"];
    for (const key of requiredRun) {
      assert.ok(key in out.run, `expected run.${key}`);
    }

    const requiredVerdict = ["overall", "blocked_gates", "failed_gates", "regression_flags"];
    for (const key of requiredVerdict) {
      assert.ok(key in out.verdict, `expected verdict.${key}`);
    }

    const requiredBudget = ["profile", "limits", "consumed", "over_budget"];
    for (const key of requiredBudget) {
      assert.ok(key in out.budget, `expected budget.${key}`);
    }

    const requiredConsumed = ["tokens", "chars", "assets"];
    for (const key of requiredConsumed) {
      assert.ok(key in out.budget.consumed, `expected consumed.${key}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("regression_flags is present in JSON verdict", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  try {
    const r = runCli(["eval-consumption", "test-asset", "--as=json"], { cwd: tmp });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok("regression_flags" in out.verdict, "verdict should have regression_flags");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("regression_flags is an array", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  try {
    const r = runCli(["eval-consumption", "test-asset", "--as=json"], { cwd: tmp });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.verdict.regression_flags), "regression_flags should be an array");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("all 6 gates are function gates (no pass: null)", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  const policyFile = path.join(tmp, "policy.json");
  fs.writeFileSync(
    policyFile,
    JSON.stringify({
      review: { operation: "review", loadProfile: "compact", domains: [{ id: "test-domain", weight: 1 }] },
    }) + "\n"
  );
  try {
    const r = runCli(["eval-consumption", "test-asset", "--as=json", "--policy", policyFile], { cwd: tmp });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    const allGates = [];
    for (const [mode, data] of Object.entries(out.results)) {
      for (const g of data.gates) {
        allGates.push(g);
      }
    }
    const blockedGates = allGates.filter((g) => g.pass === null);
    // Only route gate may be null when no policy; with policy, no gates should be blocked.
    assert.equal(
      blockedGates.length,
      0,
      `Found blocked gates: ${blockedGates.map((g) => g.gate).join(", ")}`
    );
    const expectedGates = [
      "route",
      "cost",
      "compose",
      "promotion",
      "projection",
      "quality",
    ];
    const actualGates = [...new Set(allGates.map((g) => g.gate))];
    assert.deepEqual(actualGates.sort(), expectedGates.sort());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("eval-consumption with --fixtures includes fixtures_loaded", () => {
  ensureEvalAvailable();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-eval-cons-"));
  const fixturesDir = path.join(tmp, "fixtures");
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixturesDir, "test-fixture.json"),
    JSON.stringify({ id: "f1", task: "review", text: "hello" }) + "\n"
  );
  try {
    const r = runCli(
      ["eval-consumption", "test-asset", "--as=json", "--fixtures", fixturesDir],
      { cwd: tmp }
    );
    assert.equal(r.status, 0, `failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.run.fixtures_loaded);
    assert.ok(Array.isArray(out.run.fixture_ids));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
