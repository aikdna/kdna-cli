#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validatePackReport } = require('./release-evidence');

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

function packOnce(destination) {
  const reportText = run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    destination,
  ]);
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-pack-policy-'));
  try {
    const firstDir = path.join(temp, 'first');
    const secondDir = path.join(temp, 'second');
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    const first = packOnce(firstDir);
    const second = packOnce(secondDir);
    if (!first.tarball.equals(second.tarball)) {
      throw new Error('two clean npm pack runs produced different bytes');
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const commit = run('git', ['rev-parse', 'HEAD']).trim();
    const evidence = validatePackReport({
      reportText: first.reportText,
      tarball: first.tarball,
      pkg,
      source: { ref: `refs/tags/${pkg.version}`, commit },
    });
    return evidence.artifact;
  } finally {
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
