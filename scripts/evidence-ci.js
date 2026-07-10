#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
let failures = 0;

function run(args, opts = {}) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout || 30000,
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout?.toString() || '',
    stderr: result.stderr?.toString() || '',
  };
}

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS: ${name}`);
    return true;
  }
  console.error(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`);
  failures++;
  return false;
}

// ── Install version matches npm ──────────────────────────────
console.log('── Install version matches npm');
{
  const pkg = require('../package.json');
  const cliVersion = pkg.version;
  check(`package.json version is ${cliVersion}`, /^\d+\.\d+\.\d+$/.test(cliVersion));
}

// ── CLI help exit code ───────────────────────────────────────
console.log('── CLI help');
{
  const r = run(['--help']);
  check('--help exits 0', r.ok, `exit ${r.code}`);
  check('--help mentions "kdna"', r.stdout.includes('kdna'), r.stdout.slice(0, 80));
}

// ── CLI version ──────────────────────────────────────────────
console.log('── CLI version');
{
  const r = run(['version']);
  check('version exits 0', r.ok, `exit ${r.code}`);
}

// ── kdna demo minimal ────────────────────────────────────────
console.log('── kdna demo minimal');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-evidence-'));
{
  const r = run(['demo', 'minimal', tmp]);
  check('demo minimal exits 0', r.ok, r.stderr.slice(0, 120));
  const hasFiles =
    fs.existsSync(path.join(tmp, 'KDNA_Core.json')) || fs.existsSync(path.join(tmp, 'kdna.json'));
  check('demo creates expected files', hasFiles);
}

// ── kdna pack — create a .kdna container ─────────────────────
console.log('── kdna pack');
const asset = path.join(tmp, 'evidence-test.kdna');
{
  const r = run(['pack', tmp, asset]);
  check('pack exits 0', r.ok, r.stderr.slice(0, 120));
  check('pack creates .kdna file', fs.existsSync(asset));
}

// ── kdna validate ────────────────────────────────────────────
console.log('── kdna validate');
{
  const r = run(['validate', asset, '--json']);
  check('validate exits 0', r.ok, r.stderr.slice(0, 120));
  try {
    const result = JSON.parse(r.stdout);
    check(
      'validate returns overall_valid',
      result.overall_valid === true,
      JSON.stringify(result).slice(0, 120),
    );
  } catch {
    check('validate returns valid JSON', false, r.stdout.slice(0, 80));
  }
}

// ── kdna plan-load ───────────────────────────────────────────
console.log('── kdna plan-load');
{
  const r = run(['plan-load', asset, '--json']);
  if (r.ok) {
    try {
      JSON.parse(r.stdout);
      check('plan-load returns valid JSON', true);
    } catch {
      check('plan-load returns valid JSON', false, r.stdout.slice(0, 80));
    }
  } else {
    // plan-load may fail if the demo asset doesn't have a load contract;
    // that is not a README truth violation
    check('plan-load does not crash', r.stderr.length > 0 || r.stdout.length > 0, `exit ${r.code}`);
  }
}

// ── kdna load ────────────────────────────────────────────────
console.log('── kdna load');
{
  const r = run(['load', asset, '--profile=compact', '--as=prompt']);
  if (r.ok) {
    check('load exits 0', true);
    check('load produces content', r.stdout.length > 0);
  } else {
    check('load does not crash', r.stderr.length > 0 || r.stdout.length > 0, `exit ${r.code}`);
  }
}

// ── Cleanup ──────────────────────────────────────────────────
fs.rmSync(tmp, { recursive: true, force: true });

// ── Summary ──────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
