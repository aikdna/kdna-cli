#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cbor = require('cbor-x');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'tests', 'fixtures', 'golden-single-asset-host-contract.json');
const NORMALIZED_TIME = '<runtime-generated-iso8601>';
const FIXED_TIME = '2026-07-15T00:00:00.000Z';

function corePackageRoot() {
  const sourceRoot = process.env.KDNA_CORE_SOURCE_ROOT;
  if (sourceRoot) return path.resolve(sourceRoot);
  return path.dirname(require.resolve('@aikdna/kdna-core/package.json'));
}

function gitHead(packageRoot) {
  const repository = path.resolve(packageRoot, '..', '..');
  return require('node:child_process')
    .execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    .trim();
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function normalizedCapsule(capsule) {
  const value = globalThis.structuredClone(capsule);
  value.trace.loaded_at = NORMALIZED_TIME;
  return value;
}

function buildContract() {
  const packageRoot = corePackageRoot();
  const core = require(path.join(packageRoot, 'src'));
  const source = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'test', 'fixtures', 'golden-single-asset.json'), 'utf8'),
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-golden-generator-'));
  try {
    const sourceRoot = path.join(temp, 'source');
    const asset = path.join(temp, 'golden.kdna');
    fs.mkdirSync(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, 'mimetype'), core.MIMETYPE);
    fs.writeFileSync(path.join(sourceRoot, 'kdna.json'), JSON.stringify(source.manifest));
    fs.writeFileSync(path.join(sourceRoot, 'payload.kdnab'), cbor.encode(source.payload));
    fs.writeFileSync(
      path.join(sourceRoot, 'checksums.json'),
      JSON.stringify(core.buildChecksums(sourceRoot)),
    );
    core.pack(sourceRoot, asset);
    const capsule = normalizedCapsule(
      core.loadRuntimeCapsule(fs.readFileSync(asset), {
        profile: 'compact',
        loadedAt: FIXED_TIME,
      }),
    );
    return {
      provenance: {
        contract_id: source.contract_id,
        core_repository: 'https://github.com/aikdna/kdna',
        core_commit: gitHead(packageRoot).slice(0, 7),
        core_fixture_path: 'packages/kdna-core/test/fixtures/golden-single-asset.json',
        dynamic_field_normalization: { 'trace.loaded_at': NORMALIZED_TIME },
        normalized_capsule_sha256: sha256(JSON.stringify(capsule)),
      },
      task: 'Choose the rollout mode after required checks passed but rollback-drill evidence remains incomplete.',
      source,
      expected_compact_capsule: capsule,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--write'].includes(mode)) {
    throw new Error('usage: generate-golden-host-contract.js [--check|--write]');
  }
  const expected = `${JSON.stringify(buildContract(), null, 2)}\n`;
  if (mode === '--write') {
    fs.writeFileSync(OUTPUT, expected);
  } else if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8') !== expected) {
    throw new Error('Golden Host contract is stale. Run with --write.');
  }
  console.log(`Golden Host contract ${mode === '--write' ? 'generated' : 'verified'}.`);
}

main();
