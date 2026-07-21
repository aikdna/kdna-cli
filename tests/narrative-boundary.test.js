'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('current CLI narrative remains file-first and user-authorized', () => {
  const readme = read('README.md');
  const skill = read('skills/kdna-loader/SKILL.md');

  assert.match(readme, /one explicit file/i);
  assert.match(readme, /Saving, discovery, attachment, authorization, applicability, and loading are\s+separate events/);
  assert.match(skill, /Do not discover, install, auto-select, or silently apply assets/);
  assert.match(skill, /active asset identity/);
});

test('default authoring rubric does not require output uplift', () => {
  const rubric = read('templates/standard-domain/evals/scoring.json');
  const template = read('templates/standard-domain/README.md');

  assert.doesNotMatch(rubric, /minimum_threshold_for_kdna_value/i);
  assert.doesNotMatch(rubric, /no-KDNA baseline/i);
  assert.doesNotMatch(rubric, /must improve average score/i);
  assert.match(rubric, /owner- or reviewer-scoped/i);
  assert.match(rubric, /carrier superiority/i);
  assert.match(template, /govern or influence/i);
});
