const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLI = path.resolve(__dirname, "..", "src", "cli.js");
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "v1-minimal");
const PACKED_FIXTURE = path.join(os.tmpdir(), `kdna-project-${process.pid}.kdna`);

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 30_000,
  });
}

function packedFixture() {
  if (fs.existsSync(PACKED_FIXTURE)) return PACKED_FIXTURE;
  const result = runCli(["pack", FIXTURE, PACKED_FIXTURE]);
  assert.equal(result.status, 0, `fixture pack failed: ${result.stderr}`);
  return PACKED_FIXTURE;
}

test("project --help shows usage", () => {
  const r = runCli(["project", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
  assert.match(r.stderr, /--shape/);
  assert.match(r.stderr, /answer-pattern/);
});

test("project with no args shows usage error", () => {
  const r = runCli(["project"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test("project with a valid fixture path succeeds", () => {
  const r = runCli(["project", FIXTURE, "--as=json"]);
  assert.equal(r.status, 0, `project failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kdna_project, "0.1.0");
  assert.ok(out.trace_id);
  assert.ok(out.timestamp);
});

test("project --shape=answer-pattern outputs structured answer", () => {
  const r = runCli(["project", packedFixture(), "--shape=answer-pattern", "--as=json"]);
  assert.equal(r.status, 0, `project failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.shape, "answer-pattern");
  assert.ok(typeof out.answer === "string");
  assert.ok(Array.isArray(out.reasoning));
  assert.ok(Array.isArray(out.sources));
  assert.ok(typeof out.confidence === "string");
  assert.ok(Array.isArray(out.alternatives));
  assert.equal(out._loaded_from_payload, true);
  assert.ok(out.answer.trim().length > 0);
  assert.doesNotMatch(out.answer, /\[object Object\]/);
  assert.match(out.answer, /Domain Cognition|Axioms|KDNA/i);
});

test("project source directories use the explicit manifest-only fallback", () => {
  const r = runCli(["project", FIXTURE, "--shape=answer-pattern", "--as=json"]);
  assert.equal(r.status, 0, `project failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out._loaded_from_payload, false);
  assert.equal(out.confidence, "low");
});

test("project --shape=answer-pattern as prompt includes all sections", () => {
  const r = runCli(["project", FIXTURE, "--shape=answer-pattern", "--as=prompt"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /# kdna project/);
  assert.match(r.stdout, /## Answer/);
  assert.match(r.stdout, /## Reasoning/);
  assert.match(r.stdout, /## Sources/);
  assert.match(r.stdout, /## Confidence/);
  assert.match(r.stdout, /## Alternatives/);
});

test("project --shape=compact outputs minimal summary", () => {
  const r = runCli(["project", FIXTURE, "--shape=compact", "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.shape, "compact");
  assert.equal(out.mode, "compact");
  assert.ok(typeof out.summary === "string");
});

test("project --shape=scenario outputs scenario projection", () => {
  const r = runCli(["project", FIXTURE, "--shape=scenario", "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.shape, "scenario");
  assert.equal(out.mode, "scenario");
  assert.ok(out.projection);
});

test("project --shape=full outputs full metadata", () => {
  const r = runCli(["project", FIXTURE, "--shape=full", "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.shape, "full");
  assert.equal(out.mode, "full");
  assert.ok(out.asset);
  assert.ok(out.meta);
  assert.equal(out.meta.type, "directory");
});

test("project default shape is answer-pattern", () => {
  const r = runCli(["project", FIXTURE, "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.shape, "answer-pattern");
});

test("project with non-existent path still produces output", () => {
  const r = runCli(["project", "/nonexistent/path", "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.kdna_project);
  assert.ok(out.meta || out.answer || out.summary);
});

test("project --task customizes task field", () => {
  const r = runCli(["project", FIXTURE, "--as=json", "--task=decide"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.task, "decide");
});

test("project JSON output has consistent trace_id", () => {
  const r = runCli(["project", FIXTURE, "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.match(out.trace_id, /^[0-9a-f]{32}$/);
});

test("project prompt output is human-readable", () => {
  const r = runCli(["project", FIXTURE, "--as=prompt"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /# kdna project/);
  assert.ok(
    !r.stdout.trim().startsWith("{"),
    "prompt output should not start with {"
  );
});

test("project with --context passes context", () => {
  const r = runCli([
    "project",
    FIXTURE,
    "--as=json",
    '--context={"domain":"test","priority":1}',
  ]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  if (out.context) {
    assert.equal(out.context.domain, "test");
    assert.equal(out.context.priority, 1);
  }
});

test("project answer-pattern includes _loaded_from_payload field", () => {
  const r = runCli(["project", FIXTURE, "--shape=answer-pattern", "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(
    "_loaded_from_payload" in out,
    "answer-pattern should include _loaded_from_payload field"
  );
});

test("project manifest-only fallback has confidence low", () => {
  const r = runCli(["project", "/nonexistent/path", "--shape=answer-pattern", "--as=json"]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.confidence, "low");
});
