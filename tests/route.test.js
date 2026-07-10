const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLI = path.resolve(__dirname, "..", "src", "cli.js");
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "v1-minimal");
const EVAL_PATH = path.resolve(__dirname, "..", "..", "kdna", "packages", "kdna-eval");

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

function makePoliciesFile(dir) {
  const p = path.join(dir, "policy.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      review: {
        operation: "review",
        loadProfile: "compact",
        domains: [
          { id: "atomspeak-core", weight: 1 },
          { id: "content-review", weight: 0.5 },
        ],
      },
    }) + "\n"
  );
  return p;
}

test("kdna route --help shows usage", () => {
  const r = runCli(["route", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /--policy/);
  assert.match(r.stderr, /--as=/);
});

test("kdna route with no args shows usage error", () => {
  const r = runCli(["route"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test("kdna route with fixture --as=json outputs trace", () => {
  const r = runCli(["route", FIXTURE, "--as=json"]);
  assert.equal(r.status, 0, `route failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kdna_trace, "1.0.0");
  assert.ok(out.trace_id);
  assert.ok(out.timestamp);
  assert.equal(out.operation, "review");
  assert.ok(out.decision);
  assert.ok(out.decision.primary);
  assert.ok(out.decision.budget_profile);
});

test("kdna route --as=trace includes validation", () => {
  const r = runCli(["route", FIXTURE, "--as=trace"]);
  assert.equal(r.status, 0, `route failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(out._validation);
  assert.equal(typeof out._validation.valid, "boolean");
  assert.ok(Array.isArray(out._validation.errors));
});

test("kdna route --as=prompt produces human-readable output", () => {
  const r = runCli(["route", FIXTURE, "--as=prompt"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /# kdna route/);
  assert.match(r.stdout, /## Primary/);
  assert.match(r.stdout, /## Cost/);
});

test("kdna route with --policy uses specified policy", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-route-"));
  const policyFile = makePoliciesFile(tmp);
  try {
    const r = runCli(["route", FIXTURE, "--as=json", "--policy", policyFile]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision.primary.domain_id, "atomspeak-core");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("kdna route --budget uses correct profile", () => {
  const r = runCli(["route", FIXTURE, "--as=json", "--budget=code-review"]);
  assert.equal(r.status, 0, `route failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision.budget_profile, "code-review");
});

test("kdna route --trace writes trace file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-route-"));
  const traceFile = path.join(tmp, "trace.json");
  try {
    const r = runCli(["route", FIXTURE, "--as=json", "--trace", traceFile]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    assert.ok(fs.existsSync(traceFile));
    const content = JSON.parse(fs.readFileSync(traceFile, "utf8"));
    assert.equal(content.kdna_trace, "1.0.0");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("kdna route with non-existent path gives clear error", () => {
  const r = runCli(["route", "/nonexistent/path", "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision.primary.domain_id, null);
});

test("kdna route trace_id is 32-char hex", () => {
  const r = runCli(["route", FIXTURE, "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.trace_id, /^[0-9a-f]{32}$/);
});

test("kdna route cost fields are present", () => {
  const r = runCli(["route", FIXTURE, "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok("cost" in out);
  assert.ok("tokens_consumed" in out.cost);
  assert.ok("chars_consumed" in out.cost);
  assert.ok("assets_loaded" in out.cost);
  assert.ok("over_budget" in out.cost);
});

test("kdna route provenance fields are present", () => {
  const r = runCli(["route", FIXTURE, "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.provenance);
  assert.ok("policy_input_hash" in out.provenance);
  assert.ok("consumer_index_version" in out.provenance);
});

test("kdna route with --route-card applies card preferences", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-route-"));
  const policyFile = makePoliciesFile(tmp);
  const cardFile = path.join(tmp, "card.json");
  fs.writeFileSync(
    cardFile,
    JSON.stringify({
      route_card: "0.1.0",
      domain_id: "card-domain",
      role: "primary",
    }) + "\n"
  );
  try {
    const r = runCli([
      "route",
      FIXTURE,
      "--as=json",
      "--policy",
      policyFile,
      "--route-card",
      cardFile,
    ]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision.primary.domain_id, "atomspeak-core");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("kdna route with invalid --route-card fails cleanly", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-route-"));
  const cardFile = path.join(tmp, "card.json");
  fs.writeFileSync(
    cardFile,
    JSON.stringify({ route_card: "0.1.0", role: "primary" }) + "\n"
  );
  try {
    const r = runCli(["route", FIXTURE, "--as=json", "--route-card", cardFile]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Invalid route card|domain_id/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("kdna route with --consumer-index includes consumer_index_version in provenance", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-route-"));
  const policyFile = makePoliciesFile(tmp);
  const ciFile = path.join(tmp, "ci.json");
  fs.writeFileSync(
    ciFile,
    JSON.stringify({
      consumer_index: "0.1.0",
      entries: [{ domain_id: "atomspeak-core", status: "trusted_runtime", enabled: true }],
    }) + "\n"
  );
  try {
    const r = runCli([
      "route",
      FIXTURE,
      "--as=json",
      "--policy",
      policyFile,
      "--consumer-index",
      ciFile,
    ]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.provenance.consumer_index_version, "0.1.0");
    assert.ok(out.provenance.consumer_index_path);
    assert.equal(out.decision.confidence, "high");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("kdna route with consumer index marks untrusted domain as low confidence", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kdna-route-"));
  const policyFile = makePoliciesFile(tmp);
  const ciFile = path.join(tmp, "ci.json");
  fs.writeFileSync(
    ciFile,
    JSON.stringify({
      consumer_index: "0.1.0",
      entries: [{ domain_id: "atomspeak-core", status: "draft_generated", enabled: false }],
    }) + "\n"
  );
  try {
    const r = runCli([
      "route",
      FIXTURE,
      "--as=json",
      "--policy",
      policyFile,
      "--consumer-index",
      ciFile,
    ]);
    assert.equal(r.status, 0, `route failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision.confidence, "low");
    assert.match(out.decision.abstain_reason, /not trusted/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
