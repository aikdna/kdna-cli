'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CORE_CANDIDATE_PACKAGE = '@aikdna/kdna-core';
const CORE_CANDIDATE_VERSION = '0.20.0';
const CORE_CANDIDATE_EVIDENCE_PATH = path.join(
  'tests',
  'fixtures',
  'core-0.20-candidate-evidence.json',
);
const CORE_CANDIDATE_WORKFLOW_PATH = path.join('.github', 'workflows', 'ci.yml');

function readPinnedCoreCommit(root) {
  const workflow = fs.readFileSync(path.join(root, CORE_CANDIDATE_WORKFLOW_PATH), 'utf8');
  const refs = [
    ...workflow.matchAll(/repository:\s*aikdna\/kdna\s*\r?\n\s*ref:\s*([a-f0-9]{40})(?:\s|$)/gi),
  ].map((match) => match[1].toLowerCase());
  const distinct = [...new Set(refs)];
  if (refs.length === 0 || distinct.length !== 1) {
    throw new Error('CI must pin every Core candidate checkout to one full commit.');
  }
  return distinct[0];
}

module.exports = {
  CORE_CANDIDATE_EVIDENCE_PATH,
  CORE_CANDIDATE_PACKAGE,
  CORE_CANDIDATE_VERSION,
  CORE_CANDIDATE_WORKFLOW_PATH,
  readPinnedCoreCommit,
};
