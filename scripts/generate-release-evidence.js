#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validatePackReport } = require('./release-evidence');
const { resolveTrustedNpmInvocation } = require('./runtime-candidate-binding');
const {
  assertTrustedIndexIsOrdinary,
  materializeTrustedCommit,
  runTrustedGit,
} = require('./trusted-git');

const root = path.resolve(__dirname, '..');

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    ...options,
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} exited ${String(result.status)}: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

function treeStatus() {
  return runTrustedGit(root, ['status', '--porcelain', '--untracked-files=all']).trim();
}

function createCanonicalReleaseTemp(baseDirectory = os.tmpdir()) {
  return fs.realpathSync(fs.mkdtempSync(path.join(baseDirectory, 'kdna-cli-release-pack-')));
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
  let reports;
  try {
    reports = JSON.parse(reportText);
  } catch {
    fail('npm pack output was not valid JSON');
  }
  if (!Array.isArray(reports) || reports.length !== 1 || !reports[0].filename) {
    fail('npm pack did not report exactly one filename');
  }
  return {
    reportText,
    tarballPath: path.join(destination, reports[0].filename),
  };
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  const artifactIndex = process.argv.indexOf('--artifact');
  if (
    outIndex < 0 ||
    artifactIndex < 0 ||
    !process.argv[outIndex + 1] ||
    !process.argv[artifactIndex + 1] ||
    process.argv.length !== 6
  ) {
    fail(
      'usage: generate-release-evidence.js --out <evidence-outside-repository> --artifact <tarball-outside-repository>',
    );
  }
  const output = path.resolve(process.argv[outIndex + 1]);
  const artifact = path.resolve(process.argv[artifactIndex + 1]);
  for (const [label, destination] of [
    ['release evidence', output],
    ['release artifact', artifact],
  ]) {
    const relative = path.relative(root, destination);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      fail(`${label} output must be outside the repository`);
    }
  }
  if (output === artifact) fail('release evidence and artifact paths must differ');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(artifact), { recursive: true });

  assertTrustedIndexIsOrdinary(root);
  if (treeStatus()) fail('worktree must be clean before packing');
  const source = {
    ref: process.env.GITHUB_REF,
    commit: runTrustedGit(root, ['rev-parse', 'HEAD']).trim(),
  };
  if (process.env.GITHUB_SHA !== source.commit) fail('GITHUB_SHA must equal the packed commit');
  const temp = createCanonicalReleaseTemp();
  const npm = resolveTrustedNpmInvocation(root);
  let complete = false;
  try {
    const packageRoot = path.join(temp, 'source');
    const firstDir = path.join(temp, 'first');
    const secondDir = path.join(temp, 'second');
    fs.mkdirSync(packageRoot);
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    materializeTrustedCommit(root, source.commit, packageRoot);
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const tagCommit = runTrustedGit(root, ['rev-parse', `${pkg.version}^{commit}`]).trim();
    if (tagCommit !== source.commit)
      fail('the package version tag must resolve to the packed commit');
    const first = packOnce(packageRoot, firstDir, npm);
    const second = packOnce(packageRoot, secondDir, npm);
    const firstTarball = fs.readFileSync(first.tarballPath);
    const secondTarball = fs.readFileSync(second.tarballPath);
    if (!firstTarball.equals(secondTarball)) {
      fail('two clean npm pack runs produced different bytes');
    }
    const evidence = validatePackReport({
      reportText: first.reportText,
      tarball: firstTarball,
      pkg,
      source,
    });
    fs.copyFileSync(first.tarballPath, artifact, fs.constants.COPYFILE_EXCL);
    if (!fs.readFileSync(artifact).equals(firstTarball)) {
      fail('retained release artifact differs from the verified tarball');
    }
    fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    assertTrustedIndexIsOrdinary(root);
    if (treeStatus()) fail('packing changed the repository');
    complete = true;
  } finally {
    npm.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
    if (!complete) {
      fs.rmSync(output, { force: true });
      fs.rmSync(artifact, { force: true });
    }
  }
  console.log(`Release evidence written to ${output}; verified artifact retained at ${artifact}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Release evidence rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createCanonicalReleaseTemp };
