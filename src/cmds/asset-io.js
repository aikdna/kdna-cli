'use strict';

const fs = require('node:fs');
const path = require('node:path');

const core = require('@aikdna/kdna-core');
const { appendAuditEntry } = require('./audit-log');
const {
  EXIT,
  error,
  parseCommandArgs,
  rejectPasswordArgv,
  resolvePassword,
} = require('../foundation-common');
const { loadExternalAuthorization } = require('../runtime-entitlement');
const {
  readBoundedFetchJson,
  remoteProjectionEndpoint,
  safeRemoteCode,
} = require('../runtime-remote-transport');
const { snapshotAssetFile } = require('../snapshot-asset');
const {
  cmdRuntimeLoad,
  cmdRuntimePlanLoad,
  isRuntimeHostRequest,
  isRuntimePlanRequest,
} = require('../runtime-host-command');

const ENTITLEMENT_STATUSES = new Set(['active', 'expired', 'revoked', 'offline_grace']);
const LOAD_PROFILES = new Set(['index', 'compact', 'scenario', 'full']);
const OUTPUT_FORMATS = new Set(['json', 'prompt', 'raw']);

function requireOneTarget(parsed, usage) {
  if (parsed.positional.length !== 1) error(usage, EXIT.INPUT_ERROR);
  return parsed.positional[0];
}

function requireExisting(target) {
  const absolute = path.resolve(target);
  if (!fs.existsSync(absolute)) error(`File not found: ${target}`, EXIT.INPUT_ERROR);
  return absolute;
}

function requirePackagedAsset(target) {
  const absolute = requireExisting(target);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || core.detectContainerFormat(absolute) !== 'kdna') {
    error('An explicit regular packaged .kdna file is required.', EXIT.INPUT_ERROR);
  }
  return absolute;
}

function entitlementStatus(parsed) {
  const status = parsed.value('--entitlement-status');
  if (status !== null && !ENTITLEMENT_STATUSES.has(status)) {
    error(
      'Invalid --entitlement-status. Use active, expired, revoked, or offline_grace.',
      EXIT.INPUT_ERROR,
    );
  }
  return status;
}

function readManifest(absolute) {
  return core.inspectKDNASync(snapshotAssetFile(absolute), { verify: false }).manifest;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function cmdValidate(args) {
  const parsed = parseCommandArgs(args, {
    booleans: ['--runtime', '--has-password', '--json'],
    values: ['--entitlement-status'],
  });
  const target = requireOneTarget(
    parsed,
    'Usage: kdna validate <file.kdna|source-dir> [--runtime] [--has-password] [--entitlement-status <status>]',
  );
  const absolute = requireExisting(target);
  const packaged =
    fs.lstatSync(absolute).isFile() && core.detectContainerFormat(absolute) === 'kdna';
  if (!packaged && !core.isKdnaSourceDir(absolute)) {
    error('Target is not a KDNA container or source directory.', EXIT.INPUT_ERROR);
  }

  const result = core.validate(absolute);
  if (parsed.has('--runtime')) {
    if (!packaged) {
      error('Runtime validation requires a packaged .kdna file.', EXIT.INPUT_ERROR);
    }
    const status = entitlementStatus(parsed);
    result.runtime_load_plan = core.planLoad(absolute, {
      hasPassword: parsed.has('--has-password'),
      entitlement: status ? { status } : undefined,
    });
  }
  printJson(result);
  if (!result.overall_valid) process.exitCode = EXIT.VALIDATION_FAILED;
  if (result.runtime_load_plan && result.runtime_load_plan.can_load_now !== true) {
    process.exitCode =
      result.runtime_load_plan.state === 'invalid' ? EXIT.VALIDATION_FAILED : EXIT.TRUST_FAILED;
  }
}

function cmdPlanLoad(args) {
  if (isRuntimePlanRequest(args)) return cmdRuntimePlanLoad(args);
  rejectPasswordArgv(args);
  const parsed = parseCommandArgs(args, {
    booleans: ['--has-password', '--json'],
    values: ['--entitlement-status'],
  });
  const absolute = requirePackagedAsset(
    requireOneTarget(
      parsed,
      'Usage: kdna plan-load <file.kdna> [--json] [--has-password] [--entitlement-status <status>]',
    ),
  );
  const status = entitlementStatus(parsed);
  const manifest = readManifest(absolute);
  let session = null;
  try {
    session = loadExternalAuthorization(absolute, manifest || {});
    const plan = core.planLoad(absolute, {
      hasPassword: parsed.has('--has-password'),
      entitlement: session?.entitlement || (status ? { status } : undefined),
    });
    printJson(plan);
    process.exitCode =
      plan.state === 'invalid'
        ? EXIT.VALIDATION_FAILED
        : plan.can_load_now === true
          ? EXIT.OK
          : EXIT.TRUST_FAILED;
  } finally {
    session?.dispose();
  }
}

function cmdPack(args) {
  const parsed = parseCommandArgs(args, { booleans: ['--force'] });
  if (parsed.positional.length !== 2) {
    error('Usage: kdna pack <source-dir> <output.kdna> [--force]', EXIT.INPUT_ERROR);
  }
  const [source, output] = parsed.positional;
  const absoluteSource = requireExisting(source);
  if (!core.isKdnaSourceDir(absoluteSource)) {
    error('Source is not a KDNA source directory.', EXIT.INPUT_ERROR);
  }
  const absoluteOutput = path.resolve(output);
  if (fs.existsSync(absoluteOutput)) {
    if (!parsed.has('--force')) {
      error('Output already exists. Use --force to replace that exact file.', EXIT.INPUT_ERROR);
    }
    const stat = fs.lstatSync(absoluteOutput);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      error('--force may replace only an existing regular file.', EXIT.INPUT_ERROR);
    }
    fs.unlinkSync(absoluteOutput);
  }
  const result = core.pack(absoluteSource, absoluteOutput);
  process.stdout.write(
    `Packed: ${result.outputPath}\nEntries: ${result.entries.length} (${result.entries.join(', ')})\n`,
  );
}

function cmdUnpack(args) {
  const parsed = parseCommandArgs(args);
  if (parsed.positional.length !== 2) {
    error('Usage: kdna unpack <file.kdna> <empty-output-dir>', EXIT.INPUT_ERROR);
  }
  const absolute = requirePackagedAsset(parsed.positional[0]);
  const output = path.resolve(parsed.positional[1]);
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(output).length !== 0) {
      error('Unpack output must be a new or empty regular directory.', EXIT.INPUT_ERROR);
    }
  }
  const result = core.unpack(absolute, output);
  process.stdout.write(
    `Unpacked: ${result.outputDir}\nEntries: ${result.entries.length} (${result.entries.join(', ')})\n`,
  );
}

function cmdInspect(args) {
  const parsed = parseCommandArgs(args, { booleans: ['--json'] });
  const target = requireOneTarget(parsed, 'Usage: kdna inspect <file.kdna|source-dir>');
  const absolute = requireExisting(target);
  const packaged =
    fs.lstatSync(absolute).isFile() && core.detectContainerFormat(absolute) === 'kdna';
  if (!packaged && !core.isKdnaSourceDir(absolute)) {
    error('Target is not a KDNA container or source directory.', EXIT.INPUT_ERROR);
  }
  printJson(core.inspect(absolute));
}

function renderRemotePrompt(projection, task, assetId) {
  const lines = [
    `# kdna-remote projection (${task})`,
    `# asset: ${projection.asset_id || assetId || '?'}@${projection.asset_version || '?'}`,
    `# trace: ${projection.trace_id || '(none)'}`,
    '',
  ];
  const fields = [
    ['highest_question', 'Highest question'],
    ['diagnosis_focus', 'Diagnosis focus'],
    ['constraints', 'Constraints'],
    ['self_check', 'Self-check'],
    ['failure_modes', 'Failure modes'],
  ];
  const body = projection.task_projection || {};
  for (const [field, title] of fields) {
    const value = body[field];
    if (typeof value === 'string' && value.length > 0) {
      lines.push(`## ${title}`, value, '');
    } else if (Array.isArray(value) && value.length > 0) {
      lines.push(`## ${title}`, ...value.map((item) => `- ${item}`), '');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function loadRemote({ manifest, parsed, outputFormat }) {
  if (outputFormat === 'raw') {
    error('Remote projection supports only json or prompt output.', EXIT.INPUT_ERROR);
  }
  const configuredServer =
    parsed.value('--remote-server') || process.env.KDNA_REMOTE_SERVER || null;
  if (!configuredServer) {
    error('This remote asset requires --remote-server or KDNA_REMOTE_SERVER.', EXIT.TRUST_FAILED);
  }

  let url;
  try {
    url = remoteProjectionEndpoint(configuredServer);
  } catch {
    error('--remote-server must be canonical HTTPS or exact loopback HTTP.', EXIT.INPUT_ERROR);
  }

  const task = parsed.value('--task', 'review');
  const context = parsed.value('--context', '');
  const mode = parsed.value('--mode', 'judge');
  const assetId = manifest.asset_uid || manifest.asset_id || null;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kdna_id: assetId, task, context, mode }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    error('Remote projection request failed [REMOTE_TRANSPORT_FAILED].', EXIT.PROVIDER_ERROR);
  }

  if (!response.ok) {
    let code = 'REMOTE_REQUEST_REJECTED';
    try {
      const body = await readBoundedFetchJson(response);
      code = safeRemoteCode(body?.error?.code);
    } catch {
      // A malformed response never crosses the transport boundary.
    }
    error(`Remote projection rejected [${code}] (HTTP ${response.status}).`, EXIT.PROVIDER_ERROR);
  }

  let projection;
  try {
    projection = await readBoundedFetchJson(response);
  } catch {
    error('Remote projection returned an invalid response.', EXIT.PROVIDER_ERROR);
  }
  if (outputFormat === 'prompt') {
    process.stdout.write(renderRemotePrompt(projection, task, assetId));
  } else {
    printJson({
      request: { kdna_id: assetId, task, context, mode },
      response: projection,
    });
  }
}

async function cmdLoad(args) {
  if (isRuntimeHostRequest(args)) return cmdRuntimeLoad(args);
  rejectPasswordArgv(args);
  const parsed = parseCommandArgs(args, {
    booleans: ['--password-stdin', '--audit', '--has-password'],
    values: [
      '--profile',
      '--as',
      '--entitlement-status',
      '--remote-server',
      '--task',
      '--context',
      '--mode',
    ],
  });
  const absolute = requirePackagedAsset(
    requireOneTarget(
      parsed,
      'Usage: kdna load <file.kdna> [--profile <profile>] [--as <format>] [--password-stdin] [--audit]',
    ),
  );
  if (parsed.has('--has-password')) {
    error(
      '--has-password is a plan-load diagnostic only. Load requires --password-stdin.',
      EXIT.INPUT_ERROR,
    );
  }
  const profile = parsed.value('--profile', 'compact');
  const outputFormat = parsed.value('--as', 'json');
  if (!LOAD_PROFILES.has(profile)) error('Invalid load profile.', EXIT.INPUT_ERROR);
  if (!OUTPUT_FORMATS.has(outputFormat)) error('Invalid output format.', EXIT.INPUT_ERROR);
  const status = entitlementStatus(parsed);
  const manifest = readManifest(absolute) || {};

  if (manifest.access === 'remote') {
    if (parsed.has('--audit')) {
      error('Remote loads do not write local audit receipts.', EXIT.INPUT_ERROR);
    }
    await loadRemote({ manifest, parsed, outputFormat });
    return;
  }
  if (parsed.value('--remote-server') !== null) {
    error('--remote-server applies only to remote assets.', EXIT.INPUT_ERROR);
  }

  const password = resolvePassword(args);
  const startedAt = Date.now();
  let session = null;
  try {
    session = loadExternalAuthorization(absolute, manifest);
    const result = core.loadAuthorized(absolute, {
      profile,
      as: outputFormat,
      password,
      hasPassword: Boolean(password),
      entitlement: session?.entitlement || (status ? { status } : undefined),
      decryptEntry: session?.decryptEntry,
    });
    if (parsed.has('--audit')) {
      appendAuditEntry({
        asset_id: manifest.asset_id,
        version: manifest.version,
        profile,
        as: outputFormat,
        access_mode: manifest.access,
        result: 'success',
        duration_ms: Date.now() - startedAt,
      });
    }
    if (outputFormat === 'prompt') {
      process.stdout.write(`${result.text}\n`);
    } else {
      printJson(result);
    }
  } catch (loadError) {
    if (parsed.has('--audit')) {
      appendAuditEntry({
        asset_id: manifest.asset_id,
        version: manifest.version,
        profile,
        as: outputFormat,
        access_mode: manifest.access,
        result: 'error',
        error_code: loadError.code || null,
        duration_ms: Date.now() - startedAt,
      });
    }
    throw loadError;
  } finally {
    session?.dispose();
  }
}

module.exports = {
  cmdInspect,
  cmdLoad,
  cmdPack,
  cmdPlanLoad,
  cmdUnpack,
  cmdValidate,
};
