#!/usr/bin/env node
'use strict';
// Golden generator for the full-print field-level acceptance.
//
// It installs the published @aikdna/kdna-cli@0.40.1 from the registry, creates
// the retained-expansion fixture asset with that exact CLI, runs its `--view
// full` exact-selection read, normalizes only the volatile fields listed below
// and writes tests/fixtures/view-full-golden.json. The companion test runs the
// current CLI on the same (deterministic) asset and compares field for field.
//
// Normalization is deliberately narrow and explicit. Only these values differ
// between two genuine runs of the SAME build on the SAME asset bytes:
//   1. identifier values: <prefix>:<uuid> for the retained handle, receipt,
//      operation, capture, snapshot, CLI request and local host epoch, plus
//      `process:<pid>`;
//   2. timestamps: the numeric fields issued_at, expires_at and disclosed_at;
//   3. digests computed over volatile input, at exactly these paths:
//      envelope.verification.{intent_digest,request_digest},
//      envelope.verification.origin.*, envelope.verification.origin_verification.*,
//      envelope.verification.signature_policy_check.origin_receipt_digest,
//      envelope.receipt.{request_id,decision_id,receipt_id,snapshot_id,disclosed_at,host_epoch},
//      envelope.content.expansion_handles[i].{issuing_request_digest,origin.*}.
// Everything else — every content field, every contract coordinate, every
// stable digest — must match exactly.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const GOLDEN_CLI_VERSION = '0.40.1';
const FIXTURE = 'tests/fixtures/graph-expand-session.authored.json';
const SELECTION = Object.freeze({ mode: 'exact_selection', asset_id: 'asset:bytes', asset_version: '1.0.0', judgment_ids: ['j:0'] });
const COMMAND = 'kdna read <asset.kdna> --mode exact_selection --asset-id asset:bytes --asset-version 1.0.0 --judgment-id j:0 --allow-read --view full';
const ID_PATTERNS = [
  [/^retained-handle:[0-9a-f-]{36}$/u, 'retained-handle:<id>'],
  [/^retained-receipt:[0-9a-f-]{36}$/u, 'retained-receipt:<id>'],
  [/^retained:[0-9a-f-]{36}$/u, 'retained:<id>'],
  [/^capture:[0-9a-f-]{36}$/u, 'capture:<id>'],
  [/^section-snapshot:[0-9a-f-]{36}$/u, 'section-snapshot:<id>'],
  [/^cli:[0-9a-f-]{36}$/u, 'cli:<id>'],
  [/^decision:cli:[0-9a-f-]{36}$/u, 'decision:cli:<id>'],
  [/^process:\d+$/u, 'process:<pid>'],
];
const VOLATILE_TIME_KEYS = new Set(['issued_at', 'expires_at', 'disclosed_at']);
const VOLATILE_DIGEST_PATHS = [
  /^\/envelope\/verification\/(intent_digest|request_digest)$/u,
  /^\/envelope\/verification\/origin(?:\/.*)?$/u,
  /^\/envelope\/verification\/origin_verification(?:\/.*)?$/u,
  /^\/envelope\/verification\/signature_policy_check\/origin_receipt_digest$/u,
  /^\/envelope\/receipt\/(request_id|decision_id|receipt_id|snapshot_id|disclosed_at|host_epoch)$/u,
  /^\/envelope\/content\/expansion_handles\/\d+\/(issuing_request_digest|origin(?:\/.*)?)$/u,
];
function normalize(value, path = '') {
  if (typeof value === 'string') {
    for (const [pattern, replacement] of ID_PATTERNS) if (pattern.test(value)) return replacement;
    if (/^sha256:[0-9a-f]{64}$/u.test(value) && VOLATILE_DIGEST_PATHS.some((pattern) => pattern.test(path)))
      return 'sha256:<volatile>';
    return value;
  }
  if (typeof value === 'number' && VOLATILE_TIME_KEYS.has(path.slice(path.lastIndexOf('/') + 1))) return 0;
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, path + '/' + index));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, path + '/' + key)]));
  return value;
}
function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-full-golden-'));
  try {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'kdna-full-golden-host', version: '1.0.0', private: true }, null, 2) + '\n');
    execFileSync('npm', ['install', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', '@aikdna/kdna-cli@' + GOLDEN_CLI_VERSION], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });
    const cliRoot = path.join(work, 'node_modules/@aikdna/kdna-cli');
    const installed = JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8'));
    if (installed.version !== GOLDEN_CLI_VERSION) throw new Error('golden CLI version differs: ' + installed.version);
    const dist = JSON.parse(
      execFileSync('npm', ['view', '@aikdna/kdna-cli@' + GOLDEN_CLI_VERSION, 'dist', '--json', '--registry=https://registry.npmjs.org'], { encoding: 'utf8' }),
    );
    const { run } = require(path.join(cliRoot, 'src/public-cli.js'));
    const asset = path.join(work, 'golden-asset.kdna');
    const sink = () => { const lines = []; return { lines, write(text) { lines.push(String(text)); return true; } }; };
    return (async () => {
      const created = sink();
      const code = await run(['create', path.join(root, FIXTURE), '--output', asset, '--allow-create'], created);
      if (code !== 0) throw new Error('golden create failed: ' + created.lines.join(''));
      const saved = JSON.parse(created.lines.join(''));
      const read = sink();
      const readCode = await run(['read', asset, '--mode', SELECTION.mode, '--asset-id', SELECTION.asset_id, '--asset-version', SELECTION.asset_version, '--judgment-id', SELECTION.judgment_ids[0], '--allow-read', '--view', 'full'], read);
      if (readCode !== 0) throw new Error('golden read failed: ' + read.lines.join(''));
      const answer = JSON.parse(read.lines.join(''));
      const golden = {
        provenance: {
          cli: { name: '@aikdna/kdna-cli', version: GOLDEN_CLI_VERSION, registry_integrity: dist.integrity, registry_shasum: dist.shasum },
          fixture: FIXTURE,
          asset: { sha256: saved.output.sha256, bytes: saved.output.bytes },
          selection: SELECTION,
          command: COMMAND,
          note: 'Produced by this script from the registry install of the named CLI version; volatile fields are replaced per the normalization list in this script.',
        },
        output: normalize(answer),
      };
      fs.writeFileSync(path.join(root, 'tests/fixtures/view-full-golden.json'), JSON.stringify(golden, null, 2) + '\n');
      console.log('golden written from @aikdna/kdna-cli@' + GOLDEN_CLI_VERSION + '; asset sha256 ' + saved.output.sha256);
    })();
  } finally {
    // The temporary host is intentionally left for inspection on failure only.
    process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
  }
}
if (require.main === module) main().catch((error) => { console.error('golden generation failed: ' + error.message); process.exitCode = 1; });
module.exports = { normalize, GOLDEN_CLI_VERSION, SELECTION, COMMAND, FIXTURE };
