'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.js');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-host-consent-'));
}

function runHostConsent(args, options = {}) {
  return spawnSync(process.execPath, [CLI, 'host-consent', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input: options.input,
    env: {
      ...process.env,
      KDNA_MCP_HOST_PROCESSING_CONSENT_FILE: options.consentPath,
    },
  });
}

const VALID_DRAFT = {
  host_id: 'test-host-1',
  workspace_root: '/tmp',
  asset_id: 'kdna:studio:fixture_asset',
  asset_version: '0.1.0',
  asset_digest: 'sha256:' + 'a'.repeat(64),
  attachment_id: 'att_' + 'b'.repeat(24),
  role: 'fixture-role',
  applies_to: ['review'],
  does_not_apply_to: ['code'],
  scope_digest: 'sha256:' + 'c'.repeat(64),
  processor: 'fixture-provider',
  capsule_profile: 'compact',
};

test('host-consent --status reports absent when no consent exists', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  const result = runHostConsent(['--status'], { consentPath });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.present, false);
  assert.equal(parsed.consent_digest, null);
});

test('host-consent --revoke removes an existing consent', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  fs.writeFileSync(consentPath, '{"document_type":"placeholder"}', { mode: 0o600 });
  const result = runHostConsent(['--revoke'], { consentPath });
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(consentPath), false);
});

test('host-consent fails closed without an interactive terminal', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  fs.writeFileSync(path.join(temporary, 'draft.json'), JSON.stringify(VALID_DRAFT), { mode: 0o600 });
  const result = runHostConsent(['--input-file', path.join(temporary, 'draft.json')], {
    consentPath,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /interactive Allow\/Decline confirmation/);
  assert.equal(fs.existsSync(consentPath), false);
});

test('host-consent --status reports a valid consent with exact fields', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  const document = {
    document_type: 'kdna.mcp.host-processing-consent',
    schema_version: '0.1.0',
    nonce: 'c'.repeat(32),
    host_id: 'test-host-1',
    workspace_root_digest: 'sha256:' + 'd'.repeat(64),
    asset_digest: 'sha256:' + 'a'.repeat(64),
    use_boundary: {
      kind: 'workspace_attachment',
      attachment_id: 'att_' + 'b'.repeat(24),
      scope_digest: 'sha256:' + 'c'.repeat(64),
    },
    processing_boundary: { kind: 'named_remote', processor: 'fixture-provider' },
    capsule_profile: 'compact',
    approval_source: 'user_explicit_natural_language',
    approved: true,
  };
  fs.writeFileSync(consentPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  const result = runHostConsent(['--status'], { consentPath });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.present, true);
  assert.equal(parsed.host_id, 'test-host-1');
  assert.equal(parsed.processor, 'fixture-provider');
  assert.match(parsed.consent_digest, /^sha256:[0-9a-f]{64}$/u);
});

test('host-consent rejects a symlink or world-readable consent file', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  fs.writeFileSync(consentPath, '{}', { mode: 0o644 });
  const result = runHostConsent(['--status'], { consentPath });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private regular file/);
  fs.unlinkSync(consentPath);
  fs.symlinkSync('/etc/hosts', consentPath);
  const symlinkResult = runHostConsent(['--status'], { consentPath });
  assert.notEqual(symlinkResult.status, 0);
});

test('host-consent declines drafts with unknown fields or invalid coordinates', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  const hostileDrafts = [
    { ...VALID_DRAFT, injected: 'field' },
    { ...VALID_DRAFT, asset_digest: 'not-a-digest' },
    { ...VALID_DRAFT, attachment_id: 'wrong' },
    { ...VALID_DRAFT, scope_digest: 'bad' },
    { ...VALID_DRAFT, processor: '' },
    { ...VALID_DRAFT, host_id: '' },
  ];
  for (const draft of hostileDrafts) {
    fs.writeFileSync(path.join(temporary, 'draft.json'), JSON.stringify(draft), { mode: 0o600 });
    const result = runHostConsent(['--input-file', path.join(temporary, 'draft.json')], {
      consentPath,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /draft_invalid|unknown fields|requires/);
    assert.equal(fs.existsSync(consentPath), false);
  }
});

test('host-consent --from-workspace requires host and processor', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  const result = runHostConsent(['--from-workspace', '--cwd', temporary], {
    consentPath,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --host/);
});

test('host-consent --from-workspace fails closed without a workspace record', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace);
  const result = runHostConsent(
    [
      '--from-workspace',
      '--cwd',
      workspace,
      '--host',
      'test-host-1',
      '--processor',
      'fixture-provider',
    ],
    { consentPath },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /No KDNA workspace attachment record was found from the current directory/,
  );
  assert.equal(fs.existsSync(consentPath), false);
});

test('host-consent --from-workspace requires exactly one enabled attachment', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(path.join(workspace, '.kdna', 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.kdna', 'attachments.json'),
    JSON.stringify({
      document_type: 'kdna.workspace-attachments',
      schema_version: '0.3.0',
      workspace: { root_marker: '.kdna/attachments.json' },
      attachments: [],
    }),
    { mode: 0o600 },
  );
  const result = runHostConsent(
    [
      '--from-workspace',
      '--cwd',
      workspace,
      '--host',
      'test-host-1',
      '--processor',
      'fixture-provider',
    ],
    { consentPath },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires exactly one enabled workspace attachment/);
  assert.equal(fs.existsSync(consentPath), false);
});

test('host-consent --from-workspace derives a draft from the enabled attachment', () => {
  const temporary = temporaryDirectory();
  const consentPath = path.join(temporary, 'consent.json');
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(path.join(workspace, '.kdna', 'assets'), { recursive: true });
  const digest = 'sha256:' + 'a'.repeat(64);
  fs.writeFileSync(
    path.join(workspace, '.kdna', 'assets', 'sha256-' + 'a'.repeat(64) + '.kdna'),
    Buffer.from('fixture'),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(workspace, '.kdna', 'attachments.json'),
    JSON.stringify({
      document_type: 'kdna.workspace-attachments',
      schema_version: '0.3.0',
      workspace: { root_marker: '.kdna/attachments.json' },
      attachments: [
        {
          attachment_id: 'att_' + 'b'.repeat(24),
          state: 'enabled',
          role: 'review-triage',
          asset: {
            id: 'kdna:studio:fixture_asset',
            version: '0.1.0',
            digest,
            snapshot: 'assets/sha256-' + 'a'.repeat(64) + '.kdna',
          },
          scope: {
            kind: 'workspace',
            application: 'task_hints',
            matching_policy: 'open_world_ask',
            authority: 'user_approved_routing_hint',
            approval_source: 'user_explicit',
            applies_to: ['review'],
            does_not_apply_to: ['code'],
          },
          resolution_policy: 'load_when_clear_ask_when_ambiguous',
          update_policy: 'explicit_switch_only',
          approved_at: new Date().toISOString(),
          history: [],
        },
      ],
    }),
    { mode: 0o600 },
  );
  const result = runHostConsent(
    [
      '--from-workspace',
      '--cwd',
      workspace,
      '--host',
      'test-host-1',
      '--processor',
      'fixture-provider',
    ],
    { consentPath },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /interactive Allow\/Decline confirmation/,
    'draft derivation must succeed and reach the interactive confirmation step',
  );
  assert.equal(fs.existsSync(consentPath), false);
});


