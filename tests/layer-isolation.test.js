/**
 * layer-isolation.test.js — Layer isolation regression test
 * (roadmap-2026.md §13.1).
 *
 * Per the design contract in roadmap-2026.md §13.1 and
 * OPEN/kdna/SPEC.md §250: "CLI and Core are explicitly forbidden
 * from emitting `recommended`, `officially_approved`, `high_quality`
 * or any similar content-trust claim. This is a hard rule, not a
 * convention."
 *
 * Each layer (access / license / entitlement / digest / signature /
 * trust) answers one question and MUST NOT cross boundaries. The
 * CLI is not in the trust layer — it cannot assert that an asset is
 * "good" or "officially approved." That is the runtime / user /
 * registry's job, not the CLI's.
 *
 * This test is a bug-class guard. It catches future regressions
 * where a new feature is added that emits a content-trust claim
 * about an asset. The guard has three parts:
 *
 *   1. SOURCE STRUCTURE — scan src/ for string literals that
 *      contain forbidden content-trust claim tokens. Catches direct
 *      emissions at code review time.
 *
 *   2. BEHAVIORAL OUTPUT — run representative CLI commands on the
 *      minimal fixture and check that the runtime output does
 *      not contain content-trust claim phrases. Catches indirect
 *      emissions (via variable interpolation, e.g. a badge level
 *      interpolated into a status string).
 *
 *   3. ALLOWLIST STALENESS — every allowlist entry must point to a
 *      line that still contains a forbidden token. If the line
 *      moves or the token is removed, the entry must be updated.
 *
 * Known legitimate uses (e.g. `recommendedVersionBump` for semver
 * calculation, `--trusted` for signature verification) are NOT
 * content-trust claims about an asset — they are about tool usage.
 * These are explicitly allowlisted below. Each entry is documented
 * with the file, line, and reason.
 *
 * Run: node --test tests/layer-isolation.test.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const CLI_BIN = path.join(REPO_ROOT, 'src', 'cli.js');
const FIXTURE = path.join(REPO_ROOT, 'fixtures', 'minimal');

// Per roadmap-2026.md §13.1 design contract.
//
// 'trusted' is intentionally EXCLUDED from this list. The current
// code uses 'trusted' in three legitimate-or-design-debate places:
//   1. `--trusted` flag for signature verification (install.js)
//   2. `trustedPubkeys` / "trusted allow-list" in capsule-verify.js
//   3. Evidence summaries must not claim an asset is trusted or approved.
//      Structural observations are allowed, but content trust remains a
//      consumer decision outside the CLI.
const FORBIDDEN_TOKENS = [
  'recommended',
  'officially_approved',
  'high_quality',
  'endorsed',
  'authoritative',
  'certified',
];

// Pattern that triggers a finding: a forbidden token surrounded by
// word boundaries. Matches the token in any context (string literal,
// identifier, comment) — context filtering happens in the per-test
// rules.
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN_TOKENS.join('|')})\\b`);

// Each allowlist entry documents a known legitimate use of a
// forbidden token. Format: { file, line, reason }.
// - file: relative to REPO_ROOT
// - line: 1-indexed line number in file
// - reason: why this occurrence is NOT a content-trust claim
const ALLOWLIST = [
  // secret-store.js — docstring about recommended way to use keychain
  {
    file: 'src/secret-store.js',
    line: 8,
    reason:
      'docstring: "This is the recommended [way]..." — tool-usage recommendation, not a content-trust claim',
  },
  // diff.js — shared semver calculation and output field
  {
    file: 'src/diff.js',
    line: 31,
    reason: 'shared `recommendedVersionBump` helper import — semver calculation',
  },
  {
    file: 'src/diff.js',
    line: 377,
    reason: 'shared `recommendedVersionBump` helper call — semver calculation',
  },
  {
    file: 'src/diff.js',
    line: 395,
    reason:
      'output field: `recommended_version_bump: <semver>` — semver tool recommendation, not a content-trust claim',
  },
  // judgment-diff.js — shared semver calculation
  {
    file: 'src/judgment-diff.js',
    line: 49,
    reason: 'shared `recommendedVersionBump` function — semver calculation',
  },
  {
    file: 'src/judgment-diff.js',
    line: 90,
    reason: 'shared `recommendedVersionBump` export — semver calculation',
  },
  // cmds/demo.js — tool-usage recommendation
  {
    file: 'src/cmds/demo.js',
    line: 27,
    reason: 'tool-usage message: "(recommended first-run)" — which demo to run first',
  },
  // cmds/changelog.js — shared semver calculation and output
  {
    file: 'src/cmds/changelog.js',
    line: 16,
    reason: 'shared `recommendedVersionBump` helper import — semver calculation',
  },
  {
    file: 'src/cmds/changelog.js',
    line: 138,
    reason: 'internal var from `recommendedVersionBump` — semver calculation',
  },
  {
    file: 'src/cmds/changelog.js',
    line: 156,
    reason: 'output field: `recommended_version_bump: <semver>` — semver tool recommendation',
  },
  {
    file: 'src/cmds/changelog.js',
    line: 203,
    reason:
      'output: "Recommended version bump: `<semver>`" — semver tool recommendation, not a content-trust claim',
  },
  // cmds/anti-monolithic.js — function comment about process exit code
  {
    file: 'src/cmds/anti-monolithic.js',
    line: 159,
    reason: 'function comment: "Returns the recommended process [exit code]"',
  },
];

// ─── helpers ──────────────────────────────────────────────────────────

function walkJsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

function isPureCommentLine(line) {
  // Pure single-line comment, or inside a /* ... */ block continuation
  // (we do not track block state, so this is a conservative
  // approximation: a line that is entirely whitespace + a // or *
  // prefix is treated as a comment).
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

function scanFileForForbiddenTokens(filePath) {
  const rel = path.relative(REPO_ROOT, filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const findings = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    if (!line.trim()) continue;
    if (isPureCommentLine(line)) continue;

    const match = line.match(FORBIDDEN_RE);
    if (!match) continue;

    // Check allowlist
    const allowlisted = ALLOWLIST.some((a) => a.file === rel && a.line === lineNum);
    if (allowlisted) continue;

    findings.push({
      file: rel,
      line: lineNum,
      token: match[1],
      text: line.trim().slice(0, 140),
    });
  }
  return findings;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Walk a parsed JSON value and return all string leaves that match the
// forbidden-token regex. Used to detect content-trust claims emitted
// as JSON field values (e.g. `{ "is_recommended": true }`).
function collectForbiddenStringValues(obj, out = []) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'string') {
    if (FORBIDDEN_RE.test(obj)) out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) collectForbiddenStringValues(v, out);
    return out;
  }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) collectForbiddenStringValues(v, out);
  }
  return out;
}

// ─── test 1: source structure ─────────────────────────────────────────

test('layer-isolation: no content-trust claim tokens in CLI source (per roadmap §13.1)', () => {
  const files = walkJsFiles(SRC_DIR);
  const findings = [];
  for (const f of files) {
    findings.push(...scanFileForForbiddenTokens(f));
  }
  if (findings.length > 0) {
    const msg = findings.map((f) => `  ${f.file}:${f.line}  [${f.token}]  ${f.text}`).join('\n');
    assert.fail(
      `Found content-trust claim tokens in CLI source (per design contract, ` +
        `roadmap-2026.md §13.1). Either remove the claim or add an entry to ` +
        `ALLOWLIST in tests/layer-isolation.test.js with a justification.\n` +
        `Findings:\n${msg}`,
    );
  }
});

// ─── test 2: behavioral output ────────────────────────────────────────

const BEHAVIORAL_COMMANDS = [
  ['inspect', FIXTURE],
  ['validate', FIXTURE, '--json'],
  ['plan-load', FIXTURE, '--json'],
  ['load', FIXTURE, '--profile=compact', '--as=json'],
  ['version'],
  ['doctor'],
];

for (const args of BEHAVIORAL_COMMANDS) {
  const label = `kdna ${args.join(' ')}`;
  test(`layer-isolation: ${label} does not emit content-trust claim strings`, () => {
    const r = runCli(args);
    const out = (r.stdout || '') + (r.stderr || '');

    // If the command is JSON, parse it and check string leaves.
    if (args.includes('--json') || args[0] === 'inspect') {
      try {
        const parsed = JSON.parse(r.stdout);
        const values = collectForbiddenStringValues(parsed);
        assert.deepStrictEqual(
          values,
          [],
          `${label} JSON output contains content-trust claim string value(s): ${JSON.stringify(values)}`,
        );
      } catch {
        // Not JSON — fall through to raw-text check.
      }
    }

    // Raw text check: a forbidden token as a standalone word in the
    // output is a finding. The token may appear in legitimate help
    // text (e.g. "recommended" inside parentheses), but those are
    // guard-railed by the source scan test above, not this one.
    const matches = out.match(FORBIDDEN_RE);
    assert.strictEqual(
      matches,
      null,
      `${label} stdout/stderr contains content-trust claim token(s): ${JSON.stringify(matches)}`,
    );
  });
}

// ─── test 3: allowlist staleness ──────────────────────────────────────

// Stale-entry check uses a case-insensitive substring match instead
// of the strict word-boundary regex used by the source scan. Reason:
// many allowlist entries point to identifiers / field names that
// embed the forbidden token as a prefix (e.g. `recommendedVersionBump`,
// `recommended_version_bump`, `Recommended version bump`). The
// substring check catches the embedded form too, so the staleness
// guard correctly fails when the entire line is rewritten and no
// longer mentions the token.
function lineMentionsAnyForbiddenToken(line) {
  const lower = line.toLowerCase();
  return FORBIDDEN_TOKENS.some((t) => lower.includes(t.toLowerCase()));
}

test('layer-isolation: every ALLOWLIST entry still matches a forbidden token on its line', () => {
  const files = walkJsFiles(SRC_DIR);
  const fileMap = new Map();
  for (const f of files) {
    fileMap.set(path.relative(REPO_ROOT, f), f);
  }
  const stale = [];
  for (const entry of ALLOWLIST) {
    const f = fileMap.get(entry.file);
    if (!f) {
      stale.push({ ...entry, why: 'file no longer exists in src/' });
      continue;
    }
    const content = fs.readFileSync(f, 'utf8');
    const lines = content.split('\n');
    const line = lines[entry.line - 1] || '';
    if (!lineMentionsAnyForbiddenToken(line)) {
      stale.push({
        ...entry,
        why: `line no longer mentions any forbidden token (text: ${JSON.stringify(line.trim().slice(0, 80))})`,
      });
    }
  }
  if (stale.length > 0) {
    const msg = stale.map((s) => `  ${s.file}:${s.line}  ${s.why}`).join('\n');
    assert.fail(
      `Stale ALLOWLIST entries — the underlying code changed. ` +
        `Either remove the entry or update its line number / file.\n${msg}`,
    );
  }
});

test('layer-isolation: badge command reports evidence facts, not a quality or trust verdict', () => {
  const source = fs.readFileSync(path.join(SRC_DIR, 'cmds', 'badge.js'), 'utf8');
  assert.doesNotMatch(source, /quality_badge\s*:/);
  assert.doesNotMatch(source, /badge\s*=\s*['"]trusted['"]/);
  assert.match(source, /evidence_status/);
});
