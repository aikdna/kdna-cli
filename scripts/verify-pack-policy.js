#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createCanonicalReleaseTemp } = require('./generate-release-evidence');
const { validatePackReport } = require('./release-evidence');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');
const {
  assertTrustedIndexIsOrdinary,
  materializeTrustedCommit,
  runTrustedGit,
} = require('./trusted-git');

const root = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    ...options,
  });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} exited ${String(result.status)}: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

function packOnce(packageRoot, destination, npm) {
  const reportText = run(
    npm.command,
    [
      ...npm.prefixArgs,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      destination,
      '--registry=https://registry.npmjs.org/',
      '--@aikdna:registry=https://registry.npmjs.org/',
    ],
    { cwd: packageRoot },
  );
  const reports = JSON.parse(reportText);
  if (!Array.isArray(reports) || reports.length !== 1 || !reports[0].filename) {
    throw new Error('npm pack did not report exactly one artifact');
  }
  return {
    reportText,
    tarball: fs.readFileSync(path.join(destination, reports[0].filename)),
  };
}

function verifyReproduciblePack() {
  const temp = createCanonicalReleaseTemp();
  const npm = resolveTrustedNpmInvocation(root);
  try {
    assertTrustedIndexIsOrdinary(root);
    const status = runTrustedGit(root, ['status', '--porcelain', '--untracked-files=all']).trim();
    if (status) throw new Error('worktree must be clean before pack policy verification');
    const commit = runTrustedGit(root, ['rev-parse', 'HEAD']).trim();
    const packageRoot = path.join(temp, 'source');
    const firstDir = path.join(temp, 'first');
    const secondDir = path.join(temp, 'second');
    fs.mkdirSync(packageRoot);
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    materializeTrustedCommit(root, commit, packageRoot);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const tagCommit = runTrustedGit(root, ['rev-parse', `${pkg.version}^{commit}`]).trim();
    if (tagCommit !== commit) throw new Error('package version tag must match HEAD');
    const first = packOnce(packageRoot, firstDir, npm);
    const second = packOnce(packageRoot, secondDir, npm);
    if (!first.tarball.equals(second.tarball)) {
      throw new Error('two clean npm pack runs produced different bytes');
    }
    const evidence = validatePackReport({
      reportText: first.reportText,
      tarball: first.tarball,
      pkg,
      source: { ref: `refs/tags/${pkg.version}`, commit },
    });
    return evidence.artifact;
  } finally {
    npm.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const artifact = verifyReproduciblePack();
    console.log(
      `Pack policy passed: ${artifact.filename} ${artifact.file_count} files ${artifact.integrity}`,
    );
  } catch (error) {
    console.error(`Pack policy rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyReproduciblePack };
