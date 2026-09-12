'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateReleaseEvidence } = require('./release-evidence');
const { validateReleaseContext } = require('./release-policy');
const { assertTrustedIndexIsOrdinary, runTrustedGit } = require('./trusted-git');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateCurrentReleaseBinding({ evidence: rawEvidence, pkg, changelog, env, git }) {
  const evidence = validateReleaseEvidence(rawEvidence);
  const context = validateReleaseContext({ pkg, changelog, env, git });
  assert(evidence.package.name === context.name, 'release evidence name is stale');
  assert(evidence.package.version === context.version, 'release evidence version is stale');
  assert(evidence.source.ref === context.ref, 'release evidence ref is stale');
  assert(evidence.source.commit === context.commit, 'release evidence commit is stale');
  return evidence;
}

function readCurrentReleaseBinding({ root, evidence, env = process.env }) {
  assertTrustedIndexIsOrdinary(root);
  function git(args) {
    return runTrustedGit(root, args).trim();
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const tag = pkg.version;
  return validateCurrentReleaseBinding({
    evidence,
    pkg,
    changelog,
    env,
    git: {
      status: git(['status', '--porcelain', '--untracked-files=all']),
      head: git(['rev-parse', 'HEAD']),
      tagCommit: git(['rev-parse', `${tag}^{commit}`]),
    },
  });
}

module.exports = { readCurrentReleaseBinding, validateCurrentReleaseBinding };
