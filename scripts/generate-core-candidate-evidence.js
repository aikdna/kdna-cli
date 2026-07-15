#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CORE_CANDIDATE_EVIDENCE_PATH,
  CORE_CANDIDATE_PACKAGE,
  CORE_CANDIDATE_VERSION,
  readPinnedCoreCommit,
} = require('./core-candidate');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, CORE_CANDIDATE_EVIDENCE_PATH);
const FILES = [
  'src/runtime-contract.js',
  'src/runtime-capsule.js',
  'schema/runtime-capsule.schema.json',
  'schema/consumption-plan.schema.json',
  'schema/agent-host-capabilities.schema.json',
  'schema/agent-host-request.schema.json',
  'schema/agent-host-receipt.schema.json',
  'schema/judgment-trace.schema.json',
  'schema/digest-evidence.schema.json',
  'test/fixtures/golden-single-asset.json',
  'test/fixtures/golden-single-asset-payload.kdnab',
];

function digest(algorithm, value, encoding = 'hex') {
  return crypto.createHash(algorithm).update(value).digest(encoding);
}

function packOnce(packageRoot) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-core-candidate-pack-'));
  try {
    const metadata = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', temp], {
        cwd: packageRoot,
        encoding: 'utf8',
      }),
    )[0];
    const bytes = fs.readFileSync(path.join(temp, metadata.filename));
    return {
      filename: metadata.filename,
      size: bytes.length,
      entry_count: metadata.entryCount,
      sha1: digest('sha1', bytes),
      sha512: `sha512-${digest('sha512', bytes, 'base64')}`,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function buildEvidence() {
  const packageRoot = process.env.KDNA_CORE_SOURCE_ROOT;
  if (!packageRoot) throw new Error('KDNA_CORE_SOURCE_ROOT is required for candidate evidence.');
  const absolute = path.resolve(packageRoot);
  const repository = path.resolve(absolute, '..', '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(absolute, 'package.json'), 'utf8'));
  const head = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const status = execFileSync('git', ['-C', repository, 'status', '--porcelain=v1'], {
    encoding: 'utf8',
  }).trim();
  if (status !== '')
    throw new Error('Core source worktree must be clean before candidate packing.');
  if (packageJson.name !== CORE_CANDIDATE_PACKAGE) {
    throw new Error(`Core candidate package must be ${CORE_CANDIDATE_PACKAGE}.`);
  }
  if (packageJson.version !== CORE_CANDIDATE_VERSION) {
    throw new Error(`Core candidate version must be ${CORE_CANDIDATE_VERSION}.`);
  }
  if (head !== readPinnedCoreCommit(ROOT)) {
    throw new Error('Core candidate source does not match the exact CI commit pin.');
  }
  const first = packOnce(absolute);
  const second = packOnce(absolute);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error('Core candidate package is not reproducible across two npm pack runs.');
  }
  return {
    evidence_kind: 'candidate_source_pack',
    package: packageJson.name,
    version: packageJson.version,
    git_head: head,
    source_worktree_clean: true,
    pack: {
      status: 'candidate_source_pack_not_registry_artifact',
      npm_client: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
      ...first,
      reproducible_runs: 2,
    },
    registry_artifact: null,
    files: Object.fromEntries(
      FILES.map((file) => [file, digest('sha256', fs.readFileSync(path.join(absolute, file)))]),
    ),
  };
}

function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--write'].includes(mode)) {
    throw new Error('usage: generate-core-candidate-evidence.js [--check|--write]');
  }
  const expected = `${JSON.stringify(buildEvidence(), null, 2)}\n`;
  if (mode === '--write') {
    fs.writeFileSync(OUTPUT, expected);
  } else if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8') !== expected) {
    throw new Error('Core candidate evidence is stale. Run with --write.');
  }
  console.log(`Core candidate evidence ${mode === '--write' ? 'generated' : 'verified'}.`);
}

main();
