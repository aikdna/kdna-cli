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
  assert.match(
    readme,
    /Saving, discovery, attachment, authorization, applicability, and loading are\s+separate events/,
  );
  assert.match(skill, /Do not discover, install, auto-select, or silently apply assets/);
  assert.match(skill, /active asset identity/);
});

test('published quick start does not imply unreleased workspace commands are npm latest', () => {
  const readme = read('README.md');
  const publishedInstall = readme.indexOf('npm install -g @aikdna/kdna-cli');
  const candidateBoundary = readme.indexOf('## Unreleased 0.36.0 source candidate');
  const firstWorkspaceCommand = readme.indexOf('node ./src/cli.js attach');

  assert.ok(publishedInstall >= 0, 'published install command must remain visible');
  assert.ok(
    candidateBoundary > publishedInstall,
    'candidate boundary must follow the published install',
  );
  assert.ok(
    firstWorkspaceCommand > candidateBoundary,
    'workspace commands must follow the candidate boundary',
  );
  assert.doesNotMatch(
    readme.slice(publishedInstall, candidateBoundary),
    /\bkdna (?:attach|attachments|resolve|disable|enable|switch|rollback|remove|cleanup)\b/,
  );
  assert.match(readme, /registry `latest` release is `0\.35\.1`/);
  assert.match(readme, /not the npm `latest` surface/);
  assert.match(readme, /exact candidate commit from a\s+machine-readable source receipt/i);
  assert.match(readme, /detach at that immutable commit, verify the\s+recorded HEAD/i);
  assert.match(readme, /candidate package supplied with an exact\s+SHA-256 receipt/i);
  assert.doesNotMatch(readme, /\bpull\/[0-9]+\/head\b|\bPR\s*#?[0-9]+\b/iu);
});

test('workspace narrative requires a bounded Host root and rejects home authority', () => {
  const readme = read('README.md');
  const allowlist = JSON.parse(read('release-surface/cli-command-allowlist.json'));
  const resolve = allowlist.commands.find((entry) => entry.command === 'resolve');

  assert.match(readme, /`--cwd` is also the explicit workspace root boundary/);
  assert.match(readme, /--workspace-root/);
  assert.match(readme, /home-level\s+`~\/\.kdna\/attachments\.json` fails closed/);
  assert.match(readme, /never falls back to a user-global package\s+directory/);
  assert.match(resolve.usage, /--workspace-root <boundary>/);
  assert.match(resolve.purpose, /explicit Host workspace boundary/);
});

test('scope narrative does not present phrase matching as natural-language understanding', () => {
  const readme = read('README.md');
  assert.match(readme, /negation, quotation or meta-discussion/);
  assert.match(readme, /contrastive multi-clause task/);
  assert.match(readme, /overly short or broad hint/);
  assert.match(readme, /does not claim to understand arbitrary\s+natural language/);
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
