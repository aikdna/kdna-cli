'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const CONSENT_DOCUMENT_SCHEMA = '0.1.0';
const MAX_CONSENT_BYTES = 64 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

class HostConsentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256Digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function consentPathFromEnvironment() {
  const configured = process.env.KDNA_MCP_HOST_PROCESSING_CONSENT_FILE;
  if (configured !== undefined) {
    if (
      typeof configured !== 'string' ||
      configured.length === 0 ||
      configured.length > 4096 ||
      !path.isAbsolute(configured) ||
      path.resolve(configured) !== configured
    ) {
      throw new HostConsentError(
        'host_consent_coordinate_invalid',
        'KDNA_MCP_HOST_PROCESSING_CONSENT_FILE must name one absolute regular-file path.',
      );
    }
    return configured;
  }
  return path.join(os.homedir(), '.kdna', 'host-processing-consent.json');
}

function ensurePrivateParent(target) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new HostConsentError(
      'host_consent_parent_insecure',
      'The Host processing consent parent directory must be private and symlink-free.',
    );
  }
}

function atomicWritePrivate(target, bytes) {
  ensurePrivateParent(target);
  const nonce = crypto.randomBytes(8).toString('hex');
  const temporary = path.join(
    path.dirname(target),
    `.host-processing-consent.tmp-${nonce}`,
  );
  const backup = path.join(
    path.dirname(target),
    `.host-processing-consent.backup-${nonce}`,
  );
  let movedExisting = false;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    fs.fsyncSync(fs.openSync(temporary, 'r'));
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedExisting = true;
    }
    fs.renameSync(temporary, target);
    fs.fsyncSync(fs.openSync(target, 'r'));
    if (movedExisting) fs.unlinkSync(backup);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      if (movedExisting && fs.existsSync(backup)) {
        fs.renameSync(backup, target);
      }
    } catch {
      // Preserve the original error; recovery is best-effort.
    }
    throw error;
  }
}

function readConsent(target) {
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > MAX_CONSENT_BYTES ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new HostConsentError(
      'host_consent_invalid',
      'The Host processing consent file must be one private regular file.',
    );
  }
  const bytes = fs.readFileSync(target);
  try {
    return {
      document: JSON.parse(bytes.toString('utf8')),
      digest: sha256Digest(bytes),
    };
  } catch {
    throw new HostConsentError(
      'host_consent_invalid',
      'The Host processing consent document is not valid JSON.',
    );
  } finally {
    bytes.fill(0);
  }
}

function validBoundedString(value, maxLength) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.includes('\0')
  );
}

function normalizeDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HostConsentError(
      'host_consent_draft_invalid',
      'Host consent requires a structured draft object.',
    );
  }
  const allowed = new Set([
    'host_id',
    'workspace_root',
    'asset_id',
    'asset_version',
    'asset_digest',
    'attachment_id',
    'role',
    'applies_to',
    'does_not_apply_to',
    'scope_digest',
    'processor',
    'capsule_profile',
  ]);
  const keys = Object.keys(input).sort();
  if (keys.some((key) => !allowed.has(key))) {
    throw new HostConsentError(
      'host_consent_draft_invalid',
      'The Host consent draft contains unknown fields.',
    );
  }
  const hostId = input.host_id;
  if (!validBoundedString(hostId, 256)) {
    throw new HostConsentError(
      'host_consent_draft_invalid',
      'The Host consent draft requires a bounded host_id.',
    );
  }
  const workspaceRoot = input.workspace_root;
  if (
    !validBoundedString(workspaceRoot, 4096) ||
    !path.isAbsolute(workspaceRoot)
  ) {
    throw new HostConsentError(
      'host_consent_draft_invalid',
      'The Host consent draft requires one absolute workspace root.',
    );
  }
  const assetId = input.asset_id;
  const assetVersion = input.asset_version;
  const assetDigest = input.asset_digest;
  if (
    !validBoundedString(assetId, 512) ||
    !validBoundedString(assetVersion, 128) ||
    !DIGEST_PATTERN.test(assetDigest)
  ) {
    throw new HostConsentError(
      'host_consent_draft_invalid',
      'The Host consent draft requires asset id, version, and sha256 digest.',
    );
  }
  const attachmentId = input.attachment_id;
  const role = input.role;
  const appliesTo = input.applies_to;
  const doesNotApplyTo = input.does_not_apply_to;
  const scopeDigest = input.scope_digest;
  if (
    !/^att_[0-9a-f]{24}$/u.test(attachmentId) ||
    !validBoundedString(role, 512) ||
    !Array.isArray(appliesTo) ||
    appliesTo.length === 0 ||
    appliesTo.some((entry) => !validBoundedString(entry, 256)) ||
    !Array.isArray(doesNotApplyTo) ||
    doesNotApplyTo.some((entry) => !validBoundedString(entry, 256)) ||
    !DIGEST_PATTERN.test(scopeDigest)
  ) {
    throw new HostConsentError(
      'host_consent_draft_invalid',
      'The Host consent draft requires attachment_id, role, applies_to, does_not_apply_to, and the workspace scope_digest.',
    );
  }
  const processor = input.processor;
  if (!validBoundedString(processor, 256)) {
    throw new HostConsentError(
      'host_consent_draft_invalid',
      'The Host consent draft requires one named remote processor.',
    );
  }
  const profile = input.capsule_profile || 'compact';
  if (profile !== 'compact' && profile !== 'full') {
    throw new HostConsentError(
      'host_consent_draft_invalid',
      'The capsule profile must be compact or full.',
    );
  }
  const resolvedWorkspace = fs.realpathSync(workspaceRoot);
  return {
    host_id: hostId,
    workspace_root_digest: sha256Digest(resolvedWorkspace),
    workspace_root_display: workspaceRoot,
    asset_id: assetId,
    asset_version: assetVersion,
    asset_digest: assetDigest,
    attachment_id: attachmentId,
    role,
    applies_to: [...appliesTo],
    does_not_apply_to: [...doesNotApplyTo],
    scope_digest: scopeDigest,
    processor,
    capsule_profile: profile,
  };
}

function confirmInteractive(summary) {
  let ttyInput;
  try {
    ttyInput = fs.openSync('/dev/tty', 'r');
  } catch {
    throw new HostConsentError(
      'host_consent_confirmation_unavailable',
      'Host processing consent requires an interactive Allow/Decline confirmation; no terminal is available.',
    );
  }
  const ttyStream = fs.createReadStream(null, { fd: ttyInput });
  ttyStream.on('error', () => {
    try {
      fs.closeSync(ttyInput);
    } catch {
      // Terminal already closed.
    }
  });
  const rl = readline.createInterface({
    input: ttyStream,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(
      [
        'KDNA Host processing consent',
        '',
        `  Asset        : ${summary.asset_id}@${summary.asset_version}`,
        `  Purpose      : ${summary.role}`,
        `  Used for     : ${summary.applies_to.join(', ') || '(everything in the workspace)'}`,
        `  Not for      : ${summary.does_not_apply_to.join(', ') || '(nothing excluded)'}`,
        `  Workspace    : ${summary.workspace_root_display}`,
        `  Host         : ${summary.host_id}`,
        `  Processor    : ${summary.processor} (named remote; the asset judgment may be processed by this provider under its retention policy)`,
        `  Projection   : ${summary.capsule_profile} Runtime Capsule (minimal judgment projection)`,
        '',
        'Allow this processing consent? [y/N] ',
      ].join('\n'),
      (answer) => {
        rl.close();
        try {
          fs.closeSync(ttyInput);
        } catch {
          // Terminal already closed.
        }
        resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
      },
    );
  });
}

function buildConsentDocument(draft) {
  return {
    document_type: 'kdna.mcp.host-processing-consent',
    schema_version: CONSENT_DOCUMENT_SCHEMA,
    nonce: crypto.randomBytes(16).toString('hex'),
    host_id: draft.host_id,
    workspace_root_digest: draft.workspace_root_digest,
    asset_digest: draft.asset_digest,
    use_boundary: {
      kind: 'workspace_attachment',
      attachment_id: draft.attachment_id,
      scope_digest: draft.scope_digest,
    },
    processing_boundary: {
      kind: 'named_remote',
      processor: draft.processor,
    },
    capsule_profile: draft.capsule_profile,
    approval_source: 'user_explicit_natural_language',
    approved: true,
  };
}

function valueOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new HostConsentError(
      'host_consent_usage_invalid',
      `${name} requires one value.`,
    );
  }
  return value;
}

function workspaceDraft(args) {
  const cwd = valueOption(args, '--cwd') || process.cwd();
  const hostId = valueOption(args, '--host');
  const processor = valueOption(args, '--processor');
  const profile = valueOption(args, '--profile') || 'compact';
  if (!hostId || !processor) {
    throw new HostConsentError(
      'host_consent_usage_invalid',
      '--from-workspace requires --host <host-id> and --processor <named-remote-provider>.',
    );
  }
  const workspaceAttachments = require('../workspace-attachments');
  const listing = workspaceAttachments.listWorkspaceAttachments(cwd);
  if (!listing.record) {
    throw new HostConsentError(
      'host_consent_workspace_missing',
      'No KDNA workspace attachment record was found from the current directory.',
    );
  }
  const enabled = (listing.record.attachments || []).filter(
    (attachment) => attachment && attachment.state === 'enabled',
  );
  if (enabled.length !== 1) {
    throw new HostConsentError(
      'host_consent_attachment_ambiguous',
      'Host processing consent requires exactly one enabled workspace attachment; found '
        + `${enabled.length}.`,
    );
  }
  const attachment = enabled[0];
  const asset = attachment.asset || {};
  const scope = attachment.scope || {};
  const scopeDigest = workspaceAttachments.sha256(
    Buffer.from(JSON.stringify(scope), 'utf8'),
  );
  return {
    host_id: hostId,
    workspace_root: listing.workspace_root,
    asset_id: asset.id,
    asset_version: asset.version,
    asset_digest: asset.digest,
    attachment_id: attachment.attachment_id,
    role: attachment.role,
    applies_to: Array.isArray(scope.applies_to) ? scope.applies_to : [],
    does_not_apply_to: Array.isArray(scope.does_not_apply_to)
      ? scope.does_not_apply_to
      : [],
    scope_digest: scopeDigest,
    processor,
    capsule_profile: profile,
  };
}

function statusOf(consent) {
  if (!consent) {
    return {
      document_type: 'kdna.cli.host-processing-consent-status',
      schema_version: '0.1.0',
      present: false,
      consent_digest: null,
      host_id: null,
      asset_digest: null,
      processor: null,
      capsule_profile: null,
      approval_source: null,
      approved_at: null,
      revoked: false,
    };
  }
  const { document, digest } = consent;
  return {
    document_type: 'kdna.cli.host-processing-consent-status',
    schema_version: '0.1.0',
    present: true,
    consent_digest: digest,
    host_id: document.host_id,
    asset_digest: document.asset_digest,
    processor: document.processing_boundary?.processor || null,
    capsule_profile: document.capsule_profile || null,
    approval_source: document.approval_source || null,
    approved_at: document.approved_at || null,
    revoked: document.revoked_at !== null,
  };
}

async function cmdHostConsent(args) {
  const target = consentPathFromEnvironment();
  const revoke = args.includes('--revoke');
  const json = args.includes('--json');
  const statusOnly = args.includes('--status');
  const fromWorkspace = args.includes('--from-workspace');
  if (revoke && statusOnly) {
    throw new HostConsentError(
      'host_consent_usage_invalid',
      '--revoke and --status are mutually exclusive.',
    );
  }
  if (fromWorkspace && (revoke || statusOnly)) {
    throw new HostConsentError(
      'host_consent_usage_invalid',
      '--from-workspace cannot be combined with --revoke or --status.',
    );
  }
  if (revoke) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          operation: 'revoke',
          document_type: 'kdna.cli.host-processing-consent-status',
          present: false,
          revoked: true,
        }, null, 2)}\n`,
      );
    } else {
      process.stdout.write('KDNA Host processing consent revoked.\n');
    }
    return;
  }
  if (statusOnly) {
    const consent = fs.existsSync(target)
      ? readConsent(target)
      : null;
    process.stdout.write(`${JSON.stringify(statusOf(consent), null, 2)}\n`);
    return;
  }
  let draft;
  if (fromWorkspace) {
    draft = normalizeDraft(workspaceDraft(args));
  } else {    let rawDraft = null;
    const inputFile = valueOption(args, '--input-file');
    if (inputFile !== null) {
      const stat = fs.lstatSync(inputFile);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      ) {
        throw new HostConsentError(
          'host_consent_draft_invalid',
          'The Host consent draft file must be one private regular file.',
        );
      }
      rawDraft = fs.readFileSync(inputFile, 'utf8').trim();
    } else {
      rawDraft = fs.readFileSync(0, 'utf8').trim();
    }
    try {
      draft = normalizeDraft(rawDraft ? JSON.parse(rawDraft) : null);
    } catch (error) {
      if (error instanceof HostConsentError) throw error;
      throw new HostConsentError(
        'host_consent_draft_invalid',
        'The Host consent draft must be strict JSON.',
      );
    }
    if (draft === null) {
      throw new HostConsentError(
        'host_consent_draft_required',
        'Usage: kdna host-consent [--json] [--status] [--revoke] [--from-workspace --cwd <dir> --host <host-id> --processor <named-remote-provider> | --input-file <private-draft.json>]',
      );
    }
  }
  const displaySummary = {
    ...draft,
    workspace_root_display: draft.workspace_root,
  };
  const allowed = await confirmInteractive(displaySummary);
  if (!allowed) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          operation: 'decline',
          approved: false,
          consent_digest: null,
        }, null, 2)}\n`,
      );
    } else {
      process.stdout.write('KDNA Host processing consent declined.\n');
    }
    return;
  }
  const document = buildConsentDocument(draft);
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  atomicWritePrivate(target, bytes);
  const { digest } = readConsent(target);
  bytes.fill(0);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        operation: 'approve',
        document_type: 'kdna.cli.host-processing-consent-status',
        present: true,
        approved: true,
        consent_digest: digest,
        consent_path: target,
      }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `KDNA Host processing consent approved and written to ${target}\n`,
    );
  }
}

module.exports = {
  HostConsentError,
  cmdHostConsent,
  readConsent,
  statusOf,
};
