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
const {
  BINDING_PATH,
  STRICT_PACKAGE_INSTALL_EQUIVALENCE,
  assertPackageTarInstallEquivalent,
  readTarFileEntriesFromBytes,
  resolveTrustedNpmInvocation,
  verifyCandidateBinding,
} = require('./runtime-candidate-binding');
const {
  assertCoreSourceAuthorityUnchanged,
  coreSourcePackArguments,
  inspectCoreSourceAuthority,
  materializeCoreCommitPackage,
} = require('./core-source-authority');

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

function runTrustedNpm(invocation, args, options = {}) {
  return execFileSync(invocation.command, [...invocation.prefixArgs, ...args], options);
}

function packOnce(packageRoot, invocation) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-core-candidate-pack-'));
  try {
    const metadata = JSON.parse(
      runTrustedNpm(invocation, coreSourcePackArguments(temp), {
        cwd: packageRoot,
        encoding: 'utf8',
      }),
    )[0];
    const bytes = fs.readFileSync(path.join(temp, metadata.filename));
    return {
      bytes,
      facts: {
        filename: metadata.filename,
        size: bytes.length,
        entry_count: metadata.entryCount,
        sha1: digest('sha1', bytes),
        sha512: `sha512-${digest('sha512', bytes, 'base64')}`,
      },
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function sourceFacts() {
  const packageRoot = process.env.KDNA_CORE_SOURCE_ROOT;
  if (!packageRoot) throw new Error('KDNA_CORE_SOURCE_ROOT is required for candidate evidence.');
  const authority = inspectCoreSourceAuthority(
    path.resolve(packageRoot),
    readPinnedCoreCommit(ROOT),
  );
  const { packageJson, head } = authority;
  if (packageJson.name !== CORE_CANDIDATE_PACKAGE) {
    throw new Error(`Core candidate package must be ${CORE_CANDIDATE_PACKAGE}.`);
  }
  if (packageJson.version !== CORE_CANDIDATE_VERSION) {
    throw new Error(`Core candidate version must be ${CORE_CANDIDATE_VERSION}.`);
  }
  return {
    authority,
    packageRoot: authority.packageRoot,
    packageJson,
    head,
    files: Object.fromEntries(
      FILES.map((file) => [
        file,
        digest('sha256', fs.readFileSync(path.join(authority.packageRoot, file))),
      ]),
    ),
  };
}

function boundPackArtifact() {
  const binding = JSON.parse(fs.readFileSync(path.join(ROOT, BINDING_PATH), 'utf8'));
  const entry = binding.packages?.find(({ name }) => name === CORE_CANDIDATE_PACKAGE);
  if (!entry) throw new Error('Core candidate binding is missing.');
  const expectedArtifact = path.posix.join(
    'tests',
    'fixtures',
    'runtime-candidates',
    `kdna-core-${CORE_CANDIDATE_VERSION}.tgz`,
  );
  if (entry.artifact !== expectedArtifact) {
    throw new Error('Core candidate binding artifact path is not canonical.');
  }
  const artifact = path.join(ROOT, ...entry.artifact.split('/'));
  const bytes = fs.readFileSync(artifact);
  return {
    bytes,
    evidence: {
      status: 'candidate_source_pack_not_registry_artifact',
      npm_client: '11.17.0',
      filename: `${CORE_CANDIDATE_PACKAGE.slice(1).replace('/', '-')}-${CORE_CANDIDATE_VERSION}.tgz`,
      size: bytes.length,
      entry_count: readTarFileEntriesFromBytes(bytes, 'bound Core candidate artifact').length,
      sha1: digest('sha1', bytes),
      sha512: `sha512-${digest('sha512', bytes, 'base64')}`,
      reproducible_runs: 2,
      source_equivalence: STRICT_PACKAGE_INSTALL_EQUIVALENCE,
    },
  };
}

function boundPackEvidence() {
  return boundPackArtifact().evidence;
}

function expectedEvidence(source, pack) {
  return {
    evidence_kind: 'candidate_source_pack',
    package: source.packageJson.name,
    version: source.packageJson.version,
    git_head: source.head,
    source_worktree_clean: true,
    pack,
    registry_artifact: null,
    files: source.files,
  };
}

function assertSourceFactsUnchanged(before, after) {
  const snapshot = ({ packageRoot, packageJson, head, files }) => ({
    packageRoot,
    packageJson,
    head,
    files,
  });
  if (JSON.stringify(snapshot(before)) !== JSON.stringify(snapshot(after))) {
    throw new Error('Core candidate source changed during npm pack.');
  }
}

function buildEvidence() {
  const source = sourceFacts();
  const invocation = resolveTrustedNpmInvocation(ROOT);
  const isolated = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-core-commit-package-')),
  );
  try {
    const npmClient = runTrustedNpm(invocation, ['--version'], { encoding: 'utf8' }).trim();
    if (npmClient !== '11.17.0') throw new Error('Core candidate pack requires npm 11.17.0.');
    materializeCoreCommitPackage(source.authority, isolated);
    const first = packOnce(isolated, invocation);
    const second = packOnce(isolated, invocation);
    const after = sourceFacts();
    assertCoreSourceAuthorityUnchanged(source.authority, after.authority);
    assertSourceFactsUnchanged(source, after);
    if (
      !first.bytes.equals(second.bytes) ||
      JSON.stringify(first.facts) !== JSON.stringify(second.facts)
    ) {
      throw new Error('Core candidate package is not reproducible across two npm pack runs.');
    }
    const bound = boundPackArtifact();
    if (first.facts.filename !== bound.evidence.filename) {
      throw new Error('Core candidate source pack filename does not match the bound artifact.');
    }
    const comparison = assertPackageTarInstallEquivalent(bound.bytes, first.bytes, {
      referenceLabel: 'bound Core candidate artifact',
      candidateLabel: 'exact Core source pack',
    });
    if (
      comparison.entry_count !== first.facts.entry_count ||
      comparison.entry_count !== bound.evidence.entry_count
    ) {
      throw new Error('Core candidate package entry count does not match npm pack metadata.');
    }
    return expectedEvidence(source, bound.evidence);
  } finally {
    invocation.dispose();
    fs.rmSync(isolated, { recursive: true, force: true });
  }
}

function checkedEvidence() {
  return expectedEvidence(sourceFacts(), boundPackEvidence());
}

function verifyEvidence() {
  const expected = `${JSON.stringify(checkedEvidence(), null, 2)}\n`;
  if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8') !== expected) {
    throw new Error('Core candidate evidence is stale. Run with --write.');
  }
  verifyCandidateBinding(ROOT);
}

function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--write'].includes(mode)) {
    throw new Error('usage: generate-core-candidate-evidence.js [--check|--write]');
  }
  if (mode === '--write') {
    fs.writeFileSync(OUTPUT, `${JSON.stringify(buildEvidence(), null, 2)}\n`);
    verifyEvidence();
  } else {
    verifyEvidence();
  }
  console.log(`Core candidate evidence ${mode === '--write' ? 'generated' : 'verified'}.`);
}

if (require.main === module) main();

module.exports = {
  assertSourceFactsUnchanged,
  buildEvidence,
  checkedEvidence,
  verifyEvidence,
};
