#!/usr/bin/env node
// kdna-cli prerelease-candidate release preflight (this repository's own; DESIGN02/03 Δ2 under FROZEN,
// repository-gate scope per DESIGN05 Option S).
//
// Scope: the kdna-cli repository's OWN preflight for the rc publish candidate (DESIGN02/03 Δ2,
// FROZEN N2(b), N3, N4). Domain-separated from the kdna repository's frozen prerelease preflight:
// it imports nothing from it and does not copy its naming authority table. Pure local/offline;
// the install smoke is the separate C2 step.
//
// Frozen hard requirements (CLI prep design v0.3):
//   N3. Naming coverage = candidate-domain subset (tarball member names + package.json fields),
//       implemented from the naming-integrity rules; the scope sentence below must be emitted.
//   N4. Repository gates (build/check/test) run as part of this preflight, raw output recorded.
//
// Usage:
//   node scripts/check-release-prerelease-readiness.mjs \
//     --label=cli --candidate=<candidate.json> --naming-bind=<source-coordinate-string> \
//     [--dist-tag=<tag>] [--out=<report.json>]
//
// Candidate file format: kdna.prerelease-candidate/1 (same family as the r2.7 pair).
// Exit codes: 0 all checks passed; 1 overall failure (first failing check code recorded); 64 usage error.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const ROOT = path.resolve(SCRIPT_DIR, '..');
const TAR = '/usr/bin/tar';
const NPM = process.env.KDNA_PRERELEASE_NPM || 'npm';

const checks = [];
const failures = [];
function record(id, ok, detail) {
  checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail: detail ?? null });
  if (!ok) failures.push({ id, detail: detail ?? null });
}
function fail(id, detail) {
  record(id, false, detail);
  finish(1);
}
function finish(code) {
  const report = {
    format: 'kdna.prerelease-readiness-report/1',
    script: { path: SCRIPT_PATH, sha256: sha256File(SCRIPT_PATH) },
    naming_scope: '命名门槛覆盖候选域子集（tarball 成员名＋package.json 字段，按命名完整性规则文本实现）；大仓权威表未复制、未运行；非整仓、非 tarball 字节之外',
    checks,
    failures,
    finished_at: new Date().toISOString(),
    exit_code: code,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (OUT_PATH) fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  process.exit(code);
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function parseArgs(argv) {
  const out = {};
  const known = new Set(['label', 'candidate', 'naming-bind', 'dist-tag', 'out']);
  for (const item of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/u.exec(item);
    if (!m) fail('ARGUMENT_INVALID', { argument: item });
    if (!known.has(m[1])) fail('ARGUMENT_INVALID', { argument: item, reason: 'unknown flag' });
    out[m[1]] = m[2] ?? true;
  }
  return out;
}
function runFile(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ?? null };
}
function readTarballJson(tgz, innerPath) {
  const result = runFile(TAR, ['-xOzf', tgz, innerPath]);
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}
function listTarball(tgz) {
  const result = runFile(TAR, ['-tzf', tgz]);
  if (result.status !== 0) return null;
  return result.stdout.split('\n').filter(Boolean);
}

// N3: candidate-domain naming subset. Generation-style `V`+integer tokens (incl. `-vN` suffix
// forms) are forbidden; natural numeric semver coordinates are allowed. Applied to tarball member
// paths and package.json name/version/bin. This is a subset check implemented from the rule text
// (the kdna repository's authority table is neither copied nor invoked).
const NAMING_FORBIDDEN = /(^|[^A-Za-z0-9])[vV]\d+([^0-9]|$)/u;
function namingHits(strings) {
  const hits = [];
  for (const s of strings) {
    if (typeof s === 'string' && NAMING_FORBIDDEN.test(s)) hits.push(s);
  }
  return hits;
}

let OUT_PATH = null;
const args = parseArgs(process.argv.slice(2));
if (!args.label || !args.candidate || args['naming-bind'] === undefined) {
  console.error('USAGE: check-release-prerelease-readiness.mjs --label=<label> --candidate=<file> --naming-bind=<source-coordinate> [--dist-tag=<tag>] [--out=<file>]');
  process.exit(64);
}
if (args['naming-bind'] === true || String(args['naming-bind']).trim() === '') {
  fail('NAMING_BIND_MISSING', '--naming-bind is required and must be non-empty (frozen requirement: naming step never skipped)');
}
OUT_PATH = typeof args.out === 'string' ? args.out : null;

// --- Candidate file ---------------------------------------------------------
const candidatePath = path.resolve(args.candidate);
if (!fs.existsSync(candidatePath)) fail('CANDIDATE_FILE_MISSING', candidatePath);
let candidate;
try {
  candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
} catch (error) {
  fail('CANDIDATE_FILE_INVALID', { error: String(error.message) });
}
if (candidate.format !== 'kdna.prerelease-candidate/1' || !Array.isArray(candidate.members) || candidate.members.length === 0) {
  fail('CANDIDATE_FILE_INVALID', candidatePath);
}
record('candidate_file', true, { path: candidatePath, sha256: sha256File(candidatePath), label: candidate.label ?? null });
if (candidate.label && args.label !== candidate.label) fail('CANDIDATE_LABEL_MISMATCH', { expected: args.label, candidate: candidate.label });

// --- Channel policy (prerelease only; non-latest dist-tag required) ---------
const distTag = typeof args['dist-tag'] === 'string' ? args['dist-tag'] : candidate.dist_tag;
if (typeof distTag !== 'string' || distTag.trim() === '') fail('DIST_TAG_MISSING', 'a non-latest dist-tag must be stated in advance');
if (distTag === 'latest') fail('DIST_TAG_LATEST_FORBIDDEN', distTag);
if (/^v?\d+\.\d+\.\d+/u.test(distTag)) fail('DIST_TAG_SEMVER_SHAPE_FORBIDDEN', distTag);
if (candidate.dist_tag && args['dist-tag'] && args['dist-tag'] !== candidate.dist_tag) fail('DIST_TAG_MISMATCH', { argument: args['dist-tag'], candidate: candidate.dist_tag });
record('channel_policy', true, { dist_tag: distTag, channel: 'prerelease' });

// --- Hooked package binding (single package at repository root) -------------
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const hooked = candidate.members.find(m => m.name === pkgJson.name);
if (!hooked) fail('HOOKED_PACKAGE_NOT_IN_CANDIDATE', { package: pkgJson.name });
if (hooked.version !== pkgJson.version) fail('HOOKED_PACKAGE_VERSION_MISMATCH', { package_json: pkgJson.version, candidate: hooked.version });
if (!String(hooked.version).includes('-')) fail('CHANNEL_VERSION_NOT_PRERELEASE', hooked.version);
record('hooked_package_binding', true, { package: pkgJson.name, version: pkgJson.version });

// --- Member identity, packed package.json audit, member list ----------------
const forbiddenMember = /(^|\/)(\.env|\.git|node_modules)(\/|$)|(^|\/)(id_rsa|\.npmrc)$|_authToken|BEGIN [A-Z ]*PRIVATE KEY/u;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
for (const member of candidate.members) {
  if (typeof member.tgz !== 'string' || !fs.existsSync(member.tgz)) fail('MEMBER_TARBALL_MISSING', member.name);
  const actual = sha256File(member.tgz);
  if (member.sha256 && actual !== member.sha256) fail('MEMBER_SHA_MISMATCH', { name: member.name, expected: member.sha256, actual });
  const inside = readTarballJson(member.tgz, 'package/package.json');
  if (!inside) fail('MEMBER_TARBALL_NOT_PACKAGE', member.name);
  if (member.name && inside.name !== member.name) fail('MEMBER_NAME_MISMATCH', { file: inside.name, declared: member.name });
  if (member.version && inside.version !== member.version) fail('MEMBER_VERSION_MISMATCH', { file: inside.version, declared: member.version });
  if (!String(inside.version).includes('-')) fail('CHANNEL_VERSION_NOT_PRERELEASE', { member: inside.name, version: inside.version });
  // Head-on re-verification of the historical publish blocker: the packed manifest must not be private.
  if (inside.private === true) fail('PACKED_PRIVATE_PRESENT', { member: inside.name });
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dep, spec] of Object.entries(inside[field] ?? {})) {
      if (typeof spec === 'string' && (spec.startsWith('file:') || spec.startsWith('link:') || spec.startsWith('workspace:') || path.isAbsolute(spec))) {
        fail('DEP_FILE_SPECIFIER_FORBIDDEN', { in: inside.name, dep, spec });
      }
      if (typeof spec === 'string' && !EXACT_VERSION.test(spec)) {
        fail('DEP_SPEC_NOT_EXACT', { in: inside.name, dep, spec });
      }
    }
  }
  record('member', true, { name: inside.name, version: inside.version, sha256: actual, tgz: member.tgz, dependencies: inside.dependencies ?? null });
}
for (const member of candidate.members) {
  const list = listTarball(member.tgz);
  if (!list) fail('MEMBER_LIST_FAILED', member.name);
  for (const entry of list) if (forbiddenMember.test(entry)) fail('FORBIDDEN_MEMBER', { tgz: member.name, entry });
  if (member.member_count && list.length !== member.member_count) fail('MEMBER_COUNT_MISMATCH', { name: member.name, expected: member.member_count, actual: list.length });
  const hasLicense = list.some(entry => /(^|\/)LICENSE(\.|$)/u.test(entry)) || /Apache|MIT|BSD|ISC/u.test(String(readTarballJson(member.tgz, 'package/package.json')?.license ?? ''));
  if (!hasLicense) fail('LICENSE_MISSING', member.name);
  // N3: candidate-domain naming subset over member paths + package.json fields.
  const hits = namingHits([...list, inside_name_version(member)]);
  if (hits.length) fail('NAMING_SUBSET_HIT', { tgz: member.name, hits });
  record('naming_subset_member', true, { tgz: member.name, member_count: list.length });
}
function inside_name_version(member) {
  const inside = readTarballJson(member.tgz, 'package/package.json');
  if (!inside) return '';
  const binValues = inside.bin && typeof inside.bin === 'object' ? Object.values(inside.bin) : [inside.bin];
  return [inside.name, inside.version, ...binValues.filter(v => typeof v === 'string')].join(' ');
}
for (const pin of candidate.peer_pins ?? []) {
  const holder = candidate.members.find(m => m.name === pin.package && m.tgz);
  const target = candidate.members.find(m => m.name === pin.peer && m.tgz);
  if (!holder || !target) fail('PEER_PIN_TARGET_MISSING', pin);
  const holderJson = readTarballJson(holder.tgz, 'package/package.json');
  const actualPin = holderJson?.peerDependencies?.[pin.peer];
  if (actualPin !== pin.version || target.version !== pin.version) {
    fail('PEER_PIN_MISMATCH', { package: pin.package, peer: pin.peer, expected: pin.version, actual: actualPin, sibling: target.version });
  }
  record('peer_pin', true, { package: pin.package, peer: pin.peer, version: pin.version });
}

// --- Naming gate bind + runtime coordinates ---------------------------------
const headRun = runFile('/usr/bin/git', ['-C', ROOT, 'rev-parse', 'HEAD']);
const runtimeGitHead = headRun.status === 0 ? headRun.stdout.trim() : null;
const statusRun = runFile('/usr/bin/git', ['-C', ROOT, 'status', '--porcelain']);
let runtimePorcelain = null;
if (statusRun.status === 0) {
  const lines = statusRun.stdout.split('\n').filter(Boolean);
  runtimePorcelain = { total: lines.length, untracked: lines.filter(line => line.startsWith('??')).length };
}
record('naming_gate', true, {
  naming_bind: String(args['naming-bind']),
  note: 'candidate-domain subset (tarball member names + package.json fields); rule text, not the kdna authority table',
  runtime_git_head: runtimeGitHead,
  runtime_porcelain: runtimePorcelain,
});

// --- Repository gates (N4; scope per DESIGN05 Option S; raw output recorded) -
const npmVersion = runFile(NPM, ['--version']).stdout.trim();
const scopedTestFiles = ['tests/cli-slice.test.js', 'tests/surface-gate.test.js', 'tests/prerelease-readiness.test.js'];
const gateCommands = [
  { command: `${NPM} run build`, bin: NPM, argv: ['run', 'build'] },
  { command: `${NPM} run check`, bin: NPM, argv: ['run', 'check'] },
  { command: `${process.execPath} --test ${scopedTestFiles.join(' ')}`, bin: process.execPath, argv: ['--test', ...scopedTestFiles] },
];
const gateEnv = { ...process.env };
// Measured: with NODE_TEST_CONTEXT set, `node --test <files>` exits 0 even when tests
// fail (silent masking). Spawned gates must see a clean test context.
delete gateEnv.NODE_TEST_CONTEXT;
const gateRuns = [];
for (const { command, bin, argv } of gateCommands) {
  const run = runFile(bin, argv, { cwd: ROOT, env: gateEnv });
  gateRuns.push({ command, exit: run.status, stdout_tail: String(run.stdout).slice(-600), stderr_tail: String(run.stderr).slice(-600) });
  if (run.status !== 0) fail('REPO_GATES_FAILED', { command, exit: run.status, stderr_tail: String(run.stderr).slice(-400) });
}
record('repo_gates', true, { npm: NPM, npm_version: npmVersion, node: process.execPath, node_version: process.version, env_scrubbed: ['NODE_TEST_CONTEXT'], runs: gateRuns });

finish(0);
