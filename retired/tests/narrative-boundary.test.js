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
  assert.match(skill, /is one approval for that attachment operation/);
  assert.match(skill, /do not\s+ask the user to repeat the same consent/);
});

test('published quick start and published workspace attachment surface remain distinct sections', () => {
  const readme = read('README.md');
  const publishedInstall = readme.indexOf('npm install -g @aikdna/kdna-cli');
  const workspaceSurface = readme.indexOf('## Workspace attachment surface');
  const firstWorkspaceCommand = readme.indexOf('node ./src/cli.js attach');

  assert.ok(publishedInstall >= 0, 'published install command must remain visible');
  assert.ok(
    workspaceSurface > publishedInstall,
    'workspace surface must follow the published install',
  );
  assert.ok(
    firstWorkspaceCommand > workspaceSurface,
    'workspace commands must follow the workspace surface',
  );
  assert.doesNotMatch(
    readme.slice(publishedInstall, workspaceSurface),
    /\bkdna (?:attach|attachments|resolve|disable|enable|switch|rollback|remove|cleanup)\b/,
  );
  assert.match(readme, /registry `latest` release is `0\.36\.1`/);
  assert.match(readme, /engineering foundation primitives/u);
  assert.match(readme, /exact candidate commit from a\s+machine-readable source receipt/i);
  assert.match(readme, /detach at that immutable commit, verify the\s+recorded HEAD/i);
  assert.match(readme, /candidate package supplied with an exact\s+SHA-256 receipt/i);
  assert.doesNotMatch(readme, /\bpull\/[0-9]+\/head\b|\bPR\s*#?[0-9]+\b/iu);
});

test('workspace narrative requires a bounded Host root and rejects home authority', () => {
  const readme = read('README.md');
  const allowlist = JSON.parse(read('release-surface/cli-command-allowlist.json'));
  const resolve = allowlist.commands.find((entry) => entry.command === 'resolve');

  assert.match(readme, /For `attach`, `--cwd` is the exact workspace being approved/);
  assert.match(readme, /direct CLI use without `--workspace-root` searches upward/);
  assert.match(readme, /--workspace-root/);
  assert.match(readme, /home-level\s+`~\/\.kdna\/attachments\.json` fails closed/);
  assert.match(readme, /never falls back to a user-global package\s+directory/);
  assert.match(resolve.usage, /--workspace-root <boundary>/);
  assert.match(resolve.usage, /--task-stdin \| --task-file <file>/);
  assert.match(resolve.purpose, /explicit Host workspace boundary/);
});

test('ordinary Host approval is human-readable and hides mechanical coordinates', () => {
  const readme = read('README.md');
  assert.match(readme, /default user-facing status shows the asset name and\s+version/);
  assert.match(readme, /purpose and boundary, Host identity, named processing destination/);
  assert.match(
    readme,
    /Digests, receipts, record IDs, and plan coordinates remain available only in\s+technical details, JSON, or audit output/,
  );
  assert.match(readme, /ordinary approval is never a hash\s+questionnaire/);
  assert.match(
    readme,
    /original natural-language instruction already binds\s+the exact file, workspace, purpose or scope, current Host, named destination/,
  );
  assert.match(readme, /Host does not\s+ask again merely to display a digest/);
  assert.match(readme, /mechanically supplies the workspace, scope mode, digests/);
});

test('source-candidate task examples prefer stdin and keep file input explicit', () => {
  const readme = read('README.md');
  const candidate = readme.slice(readme.indexOf('## Workspace attachment surface'));
  assert.match(candidate, /resolve --cwd \.\/my-project --task-stdin/);
  assert.match(candidate, /writes bounded UTF-8 task bytes to stdin/);
  assert.match(
    candidate,
    /`--task-file`\s+remains\s+available\s+only\s+when\s+the\s+user\s+already\s+has\s+an\s+explicit\s+task\s+file/,
  );
  assert.doesNotMatch(candidate, /save the current task text in a regular file/iu);
  assert.match(candidate, /--attachment-stdin/);
  assert.match(candidate, /`role`,\s+`applies_to`,\s+`does_not_apply_to`/);
  assert.match(
    candidate,
    /explicit request naming the file, workspace,\s+role, and scope is one approval/,
  );
  assert.match(candidate, /--scope-user-approved/);
  assert.match(candidate, /--consent-digest/);
  assert.match(candidate, /Approval of only “attach this KDNA to this project” does not authorize/);
  assert.match(candidate, /user_approved_routing_hint/);
  assert.match(candidate, /Runtime and payload boundaries remain authoritative/);
  assert.match(candidate, /negative hints are optional/);
  assert.match(candidate, /`matching_policy: "open_world_ask"`/);
  assert.match(candidate, /`matching_policy: "closed_world_skip"`/);
  assert.match(candidate, /no lexical match is unresolved/);
  assert.match(candidate, /explicitly approve\s+`scope_mode: "all_workspace"`/);
  assert.match(candidate, /Completely unspecified applicability is rejected/);
});

test('scope narrative does not present phrase matching as natural-language understanding', () => {
  const readme = read('README.md');
  assert.match(readme, /(?:in\s+)?negation, quotation or\s+meta-discussion/);
  assert.match(readme, /contrastive multi-clause task/);
  assert.match(readme, /overly\s+short or broad\s+hints?/);
  assert.match(
    readme,
    /(?:(?:this\s+)?resolver\s+)?does not claim\s+to\s+understand arbitrary\s+natural language/,
  );
  assert.match(readme, /ask\/applicability_unresolved/);
  assert.match(readme, /skip\/explicitly_outside_scope/);
  assert.match(readme, /receipt-bound one-task\s+selection is the safe continuation/);
});

test('protected authorization documents one bounded byte-preserving stdin contract', () => {
  const readme = read('README.md');
  assert.match(readme, /`--password-stdin` contract is bounded strict UTF-8/);
  assert.match(readme, /at most one final transport LF or CRLF/);
  assert.match(readme, /preserves every other\s+character, including leading\/trailing spaces/);
  assert.match(readme, /Empty,\s+oversized, or invalid input is rejected/);
  assert.doesNotMatch(readme, /#14[01]/u);
});

test('ask has an official receipt-bound one-task continuation without generic-load bypass', () => {
  const readme = read('README.md');
  const allowlist = JSON.parse(read('release-surface/cli-command-allowlist.json'));
  const resolve = allowlist.commands.find((entry) => entry.command === 'resolve');
  assert.match(readme, /one-task `selection_plan` binding the exact task\s+bytes/);
  assert.match(readme, /does not change stored scope/);
  assert.match(readme, /not reused for a later task/);
  assert.match(
    readme,
    /generic\s+`kdna load <file>`[\s\S]*?not\s+a\s+workspace-selection\s+continuation/u,
  );
  assert.match(readme, /an asset-ID substring never can/);
  assert.match(readme, /Authorization is\s+reported per candidate/);
  assert.match(readme, /unauthorized candidate\s+cannot prevent selection/);
  assert.match(readme, /`switch` is a policy change/);
  assert.match(readme, /Rollback restores the complete previous asset and policy metadata/);
  assert.match(readme, /--selection-task-digest/);
  assert.match(readme, /--selection-plan-digest/);
  assert.match(readme, /--selection-approved/);
  assert.match(resolve.usage, /--select-attachment <id>/);
  assert.match(resolve.purpose, /receipt-bound one-task user selection/);
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
