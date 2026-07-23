#!/usr/bin/env node
/**
 * kdna — current KDNA runtime CLI.
 *
 * KDNA CLI is the runtime control plane for inspecting, validating,
 * planning, packing, unpacking, and loading local .kdna assets.
 */

const fs = require('node:fs');
const path = require('node:path');
const { error, EXIT, rejectPasswordArgv, setQuiet, setExitCodeOnly } = require('./cmds/_common');
const { cmdDemo: cmdDemoMinimal } = require('./cmds/demo');
const {
  runAntiMonolithicCheck,
  printAndExit: printAntiMonolithic,
} = require('./cmds/anti-monolithic');
const { cmdWorkpack } = require('./cmds/workpack');
const {
  cmdLicenseActivate,
  cmdLicenseBind,
  cmdLicenseGenerate,
  cmdLicenseInstall,
  cmdLicenseShow,
  cmdLicenseStatus,
  cmdLicenseSync,
  cmdLicenseVerify,
} = require('./cmds/license');
const { cmdIdentityInit, cmdIdentityShow } = require('./cmds/identity');
const { cmdDoctor } = require('./cmds/doctor');
const { cmdTrace, cmdHistory } = require('./cmds/trace');
const { cmdCluster } = require('./cmds/cluster');
const { cmdProtect, cmdUnlock, cmdRecover } = require('./cmds/protect');
const { cmdPublish, cmdPublishCheck } = require('./publish');
const { cmdChangelog } = require('./cmds/changelog');
const { cmdExplain } = require('./cmds/explain');
const { cmdProtocol } = require('./cmds/protocol');
const { cmdTestRun, cmdTestImport } = require('./cmds/test');
const badge = require('./cmds/badge');
const domain = require('./cmds/domain');
const governance = require('./cmds/governance');
const { cmdEvalConsumption } = require('./cmds/eval-consumption');
const { cmdProject } = require('./cmds/project');
const { cmdRoute } = require('./cmds/route');
const { cmdCompose } = require('./cmds/compose');
const { cmdComposeReview } = require('./cmds/compose-review');
const { cmdAssetEvidence } = require('./cmds/asset-evidence');
const { cmdEvalAsset } = require('./cmds/eval-asset');
const { cmdPlanUse } = require('./cmds/plan-use');
const { cmdUse } = require('./cmds/use');
const legacy = require('./cmds/legacy');
const quality = require('./cmds/quality');
const {
  WorkspaceAttachmentError,
  WorkspaceCommandInputError,
  cmdAttach,
  cmdAttachments,
  cmdRemove: cmdRemoveAttachment,
  cmdResolve,
  cmdRollback,
  cmdSetState,
  cmdSwitch,
} = require('./cmds/workspace-attachments');
const { validateBundle } = require('./cmds/validate-bundle');
const { computeContextBudget } = require('./cmds/context-budget');
const { appendAuditEntry } = require('./cmds/audit-log');
const {
  shouldWatermark,
  buildWatermark,
  renderWatermarkHeader,
  newHmacKey,
} = require('./cmds/watermark');
const { scanBundleDeprecations, formatDeprecationStderr } = require('./cmds/deprecation');
const studio = require('./cmds/studio');
const { readAssetManifest } = require('./package-store');
const { loadExternalAuthorization } = require('./external-entitlement');
const {
  readBoundedFetchJson,
  remoteProjectionEndpoint,
  safeRemoteCode,
} = require('./remote-transport');

function readManifestForPath(absPath) {
  try {
    if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
      const manifestPath = path.join(absPath, 'kdna.json');
      return fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
    }
    return readAssetManifest(absPath);
  } catch {
    return null;
  }
}

/**
 * Story 13 — soft deprecation scan.
 *
 * Reads a bundle asset's `kdna.json` + `payload.kdnab`, evaluates any
 * `deprecation` blocks (top-level or per-component) against the
 * current CLI version, and prints the result to stderr. Never blocks,
 * never changes exit code. Returns the array of warnings in case the
 * caller wants to do something else with them (the validate-bundle
 * path does — it embeds them in the JSON report).
 *
 * Single-asset loads return [] (no components, no deprecation).
 */
function emitDeprecationStderr(abs) {
  try {
    const cliVersion = require('../package.json').version;
    const warnings = scanBundleDeprecations(abs, cliVersion);
    const text = formatDeprecationStderr(warnings);
    if (text) process.stderr.write(text);
    return warnings;
  } catch (_) {
    // best-effort — never block on a deprecation bug
    return [];
  }
}

// Strip stack traces from uncaught errors for clean user output
process.on('uncaughtException', (err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});

// ─── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
// `kdna help <subcmd> [...]` translates to `kdna <subcmd> [...] --help` so the
// router below routes to the real command handler. Each handler prints its own
// Usage when --help is present.
if (args[0] === 'help' && args.length > 1) {
  process.argv = [process.argv[0], process.argv[1], args[1], ...args.slice(2), '--help'];
  args.length = 0;
  for (let i = 2; i < process.argv.length; i++) args.push(process.argv[i]);
}
if (!args.length || args[0] === '--help' || args[0] === '-h') {
  showHelp();
  process.exit(0);
}
if (args[0] === '--version' || args[0] === '-v') {
  console.log(require('../package.json').version);
  process.exit(0);
}
if (args[0] === 'help' && args.length === 1) {
  showHelp();
  process.exit(0);
}

// Global flags
if (args.includes('--quiet')) setQuiet(true);
if (args.includes('--exit-code')) setExitCodeOnly(true);

function showHelp() {
  const v = require('../package.json').version;
  console.log(`kdna v${v} — KDNA runtime CLI
  attach <file.kdna> | attachments       Approve or list workspace attachments
  resolve --cwd <dir> --task-file <file> Resolve the approved workspace attachment
  disable <attachment-id> | enable <id>  Exclude or re-enable an attachment
  switch <id> <file.kdna>                Approve an explicit replacement
  rollback <id> | remove <id>            Restore history or remove only the relation
  inspect <file.kdna>                    Inspect an explicit local asset
  validate <file.kdna>                   Validate an explicit local asset
  plan-load <file.kdna>                  Return the Core LoadPlan
  load <file.kdna>                       Load only when the Core plan authorizes it
  pack <source-dir> <file.kdna> | unpack <file.kdna> <dir>
  demo <minimal|judgment> <dir>`);
}

const cmd = args[0];

function runWorkspaceCommand(command, commandArgs) {
  try {
    command(commandArgs);
  } catch (commandError) {
    if (
      commandError instanceof WorkspaceAttachmentError ||
      commandError instanceof WorkspaceCommandInputError
    ) {
      error(commandError.message, EXIT.INPUT_ERROR);
    }
    error('Workspace attachment operation failed safely.', EXIT.PROVIDER_ERROR);
  }
}

switch (cmd) {
  case 'attach': {
    runWorkspaceCommand(cmdAttach, args.slice(1));
    break;
  }
  case 'attachments': {
    runWorkspaceCommand(cmdAttachments, args.slice(1));
    break;
  }
  case 'resolve': {
    runWorkspaceCommand(cmdResolve, args.slice(1));
    break;
  }
  case 'disable': {
    runWorkspaceCommand((commandArgs) => cmdSetState(commandArgs, 'disabled'), args.slice(1));
    break;
  }
  case 'enable': {
    runWorkspaceCommand((commandArgs) => cmdSetState(commandArgs, 'enabled'), args.slice(1));
    break;
  }
  case 'switch': {
    runWorkspaceCommand(cmdSwitch, args.slice(1));
    break;
  }
  case 'rollback': {
    runWorkspaceCommand(cmdRollback, args.slice(1));
    break;
  }
  case 'remove': {
    runWorkspaceCommand(cmdRemoveAttachment, args.slice(1));
    break;
  }
  case 'validate': {
    try {
      // --bundle mode: validate a kdna.bundle.json manifest (RFC #148 Story 3)
      if (args.includes('--bundle')) {
        const bundleTarget = args.filter((a) => !a.startsWith('--'))[1];
        if (!bundleTarget)
          error('Usage: kdna validate <bundle.json> --bundle [--verbose]', EXIT.INPUT_ERROR);
        const result = validateBundle(bundleTarget, { verbose: args.includes('--verbose') });
        // Always emit JSON output so callers can parse the result regardless of outcome.
        // Fatal errors (file not found, invalid JSON) are represented inside the result.
        if (result.fatal) delete result.fatal;
        console.log(JSON.stringify(result, null, 2));
        // Story 13 — soft deprecation scan (stderr, non-blocking). The
        // warnings are already inside result.deprecation_warnings; this
        // is just the human-readable one-liner for terminal users.
        if (result.deprecation_warnings && result.deprecation_warnings.stderr_text) {
          process.stderr.write(result.deprecation_warnings.stderr_text);
        }
        process.exit(result.bundle_valid ? 0 : 1);
      }
      const assetTarget = args.filter((a) => !a.startsWith('--'))[1];
      if (!assetTarget)
        error(
          'Usage: kdna validate <file.kdna> [--runtime] [--entitlement-status <status>]',
          EXIT.INPUT_ERROR,
        );
      const { isKdnaSourceDir, detectContainerFormat, validate } = require('@aikdna/kdna-core');
      const abs = require('node:path').resolve(assetTarget);
      if (!fs.existsSync(abs)) error(`File not found: ${assetTarget}`, EXIT.INPUT_ERROR);
      const containerFmt = detectContainerFormat(abs);
      const isKdna = isKdnaSourceDir(abs) || containerFmt === 'kdna';
      if (!isKdna) {
        error(`Not a KDNA container or source directory: ${assetTarget}`, EXIT.INPUT_ERROR);
      }
      const runtimeMode = args.includes('--runtime');
      const result = validate(assetTarget);
      if (runtimeMode) {
        if (!fs.statSync(abs).isFile() || containerFmt !== 'kdna') {
          error(
            'kdna validate --runtime requires a packaged .kdna asset file. Source directories are authoring inputs only.',
            EXIT.INPUT_ERROR,
          );
        }
        const entitlementStatusIndex = args.indexOf('--entitlement-status');
        const entitlementStatus =
          entitlementStatusIndex >= 0 ? args[entitlementStatusIndex + 1] : null;
        const allowedEntitlementStatuses = new Set([
          'active',
          'expired',
          'revoked',
          'offline_grace',
        ]);
        if (entitlementStatusIndex >= 0 && !allowedEntitlementStatuses.has(entitlementStatus)) {
          error(
            'Invalid --entitlement-status. Use active, expired, revoked, or offline_grace.',
            EXIT.INPUT_ERROR,
          );
        }
        const core = require('@aikdna/kdna-core');
        if (typeof core.planLoad !== 'function') {
          error(
            'kdna validate --runtime requires @aikdna/kdna-core with the LoadPlan API. Update @aikdna/kdna-core before enabling runtime authorization diagnostics.',
            EXIT.PROVIDER_ERROR,
          );
        }
        result.runtime_load_plan = core.planLoad(assetTarget, {
          hasPassword: args.includes('--has-password'),
          entitlement: entitlementStatus ? { status: entitlementStatus } : undefined,
        });
      }
      console.log(JSON.stringify(result, null, 2));
      if (!result.overall_valid) process.exit(1);
      if (
        runtimeMode &&
        result.runtime_load_plan &&
        result.runtime_load_plan.can_load_now !== true
      ) {
        process.exit(result.runtime_load_plan.state === 'invalid' ? 1 : 3);
      }
      process.exit(0);
    } catch (e) {
      process.stderr.write('Error: ' + e.message + '\n');
      process.exit(1);
    }
  }
  // eslint-disable-next-line no-fallthrough
  case 'plan-load': {
    try {
      const assetTarget = args.filter((a) => !a.startsWith('--'))[1];
      if (!assetTarget)
        error(
          'Usage: kdna plan-load <path> [--json] [--has-password] [--entitlement-status <status>]',
          EXIT.INPUT_ERROR,
        );
      const core = require('@aikdna/kdna-core');
      const planTarget = assetTarget;
      const abs = require('node:path').resolve(planTarget);
      const containerFmt = core.detectContainerFormat(abs);
      const isKdna = fs.existsSync(abs) && fs.statSync(abs).isFile() && containerFmt === 'kdna';
      if (!isKdna) {
        error('plan-load requires an explicit packaged .kdna asset file', EXIT.INPUT_ERROR);
      }
      // Story 13 — soft deprecation scan (bundle manifest-level +
      // per-component). Non-blocking. Always emitted before the plan
      // JSON so a `kdna plan-load <bundle> | jq` consumer still sees
      // the warnings on its own stderr.
      emitDeprecationStderr(abs);
      if (typeof core.planLoad !== 'function') {
        error(
          'kdna plan-load requires @aikdna/kdna-core with the LoadPlan API. Update @aikdna/kdna-core before enabling runtime authorization diagnostics.',
          EXIT.PROVIDER_ERROR,
        );
      }
      const entitlementStatusIndex = args.indexOf('--entitlement-status');
      const entitlementStatus =
        entitlementStatusIndex >= 0 ? args[entitlementStatusIndex + 1] : null;
      const allowedEntitlementStatuses = new Set(['active', 'expired', 'revoked', 'offline_grace']);
      if (entitlementStatusIndex >= 0 && !allowedEntitlementStatuses.has(entitlementStatus)) {
        error(
          'Invalid --entitlement-status. Use active, expired, revoked, or offline_grace.',
          EXIT.INPUT_ERROR,
        );
      }
      rejectPasswordArgv(args);
      const planManifest = readManifestForPath(abs);
      let externalSession = null;
      try {
        externalSession = loadExternalAuthorization(abs, planManifest || {});
        const plan = core.planLoad(planTarget, {
          hasPassword: args.includes('--has-password'),
          entitlement:
            externalSession?.entitlement ||
            (entitlementStatus ? { status: entitlementStatus } : undefined),
        });

        // Context budget reporting (Story 8) — non-blocking, best-effort.
        // If the Bundle manifest declares context_budget.max_tokens, compute
        // a per-component token cost estimate and attach it to the plan output.
        if (plan.resolved_dependencies && plan.resolved_dependencies.length > 0) {
          try {
            const manifestPath = require('node:path').join(abs, 'kdna.json');
            if (fs.existsSync(manifestPath)) {
              const bundleManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              const budgetDecl =
                bundleManifest.context_budget ||
                (bundleManifest.context_budget_strategy
                  ? { max_tokens: null, strategy: bundleManifest.context_budget_strategy }
                  : null);
              if (budgetDecl && budgetDecl.max_tokens) {
                plan.context_budget_report = computeContextBudget(
                  budgetDecl,
                  plan.resolved_dependencies,
                );
                // If strategy is 'error' and over budget, escalate plan state.
                if (
                  plan.context_budget_report.over_budget &&
                  plan.context_budget_report.strategy === 'error'
                ) {
                  plan.state = 'invalid';
                  plan.can_load_now = false;
                  plan.required_action = 'reduce_bundle_components';
                  if (!plan.issues) plan.issues = [];
                  plan.issues.push({
                    code: 'KDNA_CONTEXT_BUDGET_EXCEEDED',
                    severity: 'blocking',
                    message:
                      `Bundle context budget exceeded: estimated ${plan.context_budget_report.total_estimated_tokens} tokens ` +
                      `exceeds declared maximum of ${plan.context_budget_report.declared_max_tokens} tokens. ` +
                      `Strategy is "error" — loading blocked.`,
                  });
                } else if (
                  plan.context_budget_report.over_budget &&
                  plan.context_budget_report.strategy === 'warn'
                ) {
                  process.stderr.write(
                    `Warning: Bundle context budget exceeded: estimated ` +
                      `${plan.context_budget_report.total_estimated_tokens} tokens ` +
                      `exceeds declared maximum of ${plan.context_budget_report.declared_max_tokens} tokens.\n`,
                  );
                }
              }
            }
          } catch (_) {
            // context_budget is optional — never fail plan-load because of it
          }
        }

        // LoadPlan is a closed public contract shared with Core and Swift.
        // Watermark data belongs to the observed load result, not to the plan;
        // adding an undeclared field here would make CLI output schema-invalid.

        console.log(JSON.stringify(plan, null, 2));
        process.exitCode = plan.state === 'invalid' ? 1 : plan.can_load_now === true ? 0 : 3;
        return;
      } finally {
        externalSession?.dispose();
      }
    } catch (e) {
      process.stderr.write('Error: ' + e.message + '\n');
      process.exit(1);
    }
  }
  // eslint-disable-next-line no-fallthrough
  case 'pack': {
    try {
      const assetTarget = args.filter((a) => !a.startsWith('--'))[1];
      if (!assetTarget) error('Usage: kdna pack <source-dir> <output.kdna>', EXIT.INPUT_ERROR);
      const { isKdnaSourceDir, pack: packDir } = require('@aikdna/kdna-core');
      const abs = require('node:path').resolve(assetTarget);
      if (!isKdnaSourceDir(abs)) {
        error(`Not a KDNA source directory: ${assetTarget}`, EXIT.INPUT_ERROR);
      }

      // Warn if checksums are stale (source modified since last pack)
      const checksumsPath = path.resolve(abs, 'checksums.json');
      if (fs.existsSync(checksumsPath)) {
        try {
          const { buildChecksums } = require('@aikdna/kdna-core');
          const manifestPath = path.resolve(abs, 'kdna.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const fresh = buildChecksums(abs);
          const stored = JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
          if (JSON.stringify(fresh) !== JSON.stringify(stored)) {
            process.stderr.write(
              'Warning: checksums.json is stale (source files changed). Rebuilding during pack.\n',
            );
          }
        } catch {
          /* checksums check is best-effort */
        }
      }
      const out = args.filter((a) => !a.startsWith('--'))[2];
      if (!out) error('Usage: kdna pack <source-dir> <output.kdna>', EXIT.INPUT_ERROR);
      if (fs.existsSync(out)) {
        if (args.includes('--force')) {
          fs.unlinkSync(out);
        } else {
          error(`Output file already exists: ${out}\nUse --force to overwrite.`, EXIT.INPUT_ERROR);
        }
      }
      // Warn if checksums.json is stale (source files modified since last pack)
      const csp = require('node:path').resolve(abs, 'checksums.json');
      if (fs.existsSync(csp)) {
        try {
          const mf = JSON.parse(
            fs.readFileSync(require('node:path').resolve(abs, 'kdna.json'), 'utf8'),
          );
          const fresh = require('@aikdna/kdna-core').buildChecksums(abs, mf);
          const stored = JSON.parse(fs.readFileSync(csp, 'utf8'));
          if (JSON.stringify(fresh) !== JSON.stringify(stored)) {
            process.stderr.write(
              'Warning: checksums.json is stale (source files changed). Rebuilding during pack.\n',
            );
          }
        } catch {
          /* checksums check is best-effort */
        }
      }
      const r = packDir(assetTarget, out);
      process.stdout.write(
        `Packed: ${r.outputPath}\nEntries: ${r.entries.length} (${r.entries.join(', ')})\n`,
      );
      return;
    } catch (e) {
      process.stderr.write('Error: ' + e.message + '\n');
      process.exit(1);
    }
  }
  // eslint-disable-next-line no-fallthrough
  case 'unpack': {
    try {
      const assetTarget = args.filter((a) => !a.startsWith('--'))[1];
      if (!assetTarget) error('Usage: kdna unpack <input.kdna> <output-dir>', EXIT.INPUT_ERROR);
      const { detectContainerFormat, unpack } = require('@aikdna/kdna-core');
      const abs = require('node:path').resolve(assetTarget);
      if (!fs.existsSync(abs)) error(`File not found: ${assetTarget}`, EXIT.INPUT_ERROR);
      const containerFmt = detectContainerFormat(abs);
      if (containerFmt !== 'kdna') {
        error(`Not a valid KDNA container: ${assetTarget}`, EXIT.INPUT_ERROR);
      }
      const out = args.filter((a) => !a.startsWith('--'))[2];
      if (!out) error('Usage: kdna unpack <input.kdna> <output-dir>', EXIT.INPUT_ERROR);
      const r = unpack(assetTarget, out);
      process.stdout.write(
        `Unpacked: ${r.outputDir}\nEntries: ${r.entries.length} (${r.entries.join(', ')})\n`,
      );
      return;
    } catch (e) {
      process.stderr.write('Error: ' + e.message + '\n');
      process.exit(1);
    }
  }
  // eslint-disable-next-line no-fallthrough
  case 'inspect': {
    try {
      const target = args.filter((a) => !a.startsWith('--'))[1];
      if (!target) error('Usage: kdna inspect <path> [--json] [--locale zh-CN]');
      const { isKdnaSourceDir, detectContainerFormat, inspect } = require('@aikdna/kdna-core');
      const abs = require('node:path').resolve(target);
      if (!fs.existsSync(abs)) error(`File not found: ${target}`, EXIT.INPUT_ERROR);
      const containerFmt = detectContainerFormat(abs);
      const isKdna = isKdnaSourceDir(abs) || containerFmt === 'kdna';
      if (!isKdna) {
        error(`Not a valid KDNA container or source directory: ${target}`, EXIT.INPUT_ERROR);
      }
      const out = inspect(abs);
      console.log(JSON.stringify(out, null, 2));
      return;
    } catch (e) {
      process.stderr.write('Error: ' + e.message + '\n');
      process.exit(1);
    }
  }
  // eslint-disable-next-line no-fallthrough
  case 'load': {
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target)
      error(
        'Usage: kdna load <file.kdna> [--profile=<index|compact|scenario|full>] [--as=<json|prompt|raw>] [--namespace=<component-id>] [--password-stdin] [--audit]',
        EXIT.INPUT_ERROR,
      );
    const core = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(target);
    if (!fs.existsSync(abs)) error(`File not found: ${target}`, EXIT.INPUT_ERROR);
    const isKdna = fs.statSync(abs).isFile() && core.detectContainerFormat(abs) === 'kdna';
    if (!isKdna) {
      error(
        'kdna load requires a packaged .kdna asset file. Source directories are authoring inputs only.',
        EXIT.INPUT_ERROR,
      );
    }
    // Story 13 — soft deprecation scan. Non-blocking.
    emitDeprecationStderr(abs);
    const getFlag = (name) => {
      const eq = args.find((a) => a.startsWith(name + '='));
      if (eq) return eq.split('=')[1];
      const idx = args.indexOf(name);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const profile = getFlag('--profile') || 'compact';
    const as = getFlag('--as') || 'json';
    // An explicit-file load is one-shot by default and must not create
    // ~/.kdna state. Users who want a local, content-neutral receipt can opt
    // in for this invocation with --audit.
    const auditRequested = args.includes('--audit');
    // --namespace <id>: filter load output to a single RAG namespace (Story 11).
    // Only the component whose rag_namespace contains <id> is returned.
    // Useful for querying one component of a Bundle without loading all content.
    const namespaceFilter = getFlag('--namespace') || null;
    rejectPasswordArgv(args);
    const useStdin = args.includes('--password-stdin');
    let password;
    if (useStdin) {
      // Bug fix: refuse up front on a TTY rather than calling
      // `fs.readFileSync(0)` and hanging indefinitely waiting for input
      // the user never sends.
      if (process.stdin.isTTY) {
        error(
          '--password-stdin requires the password to be piped in on stdin.\n' +
            'Example:  printf \'%s\' "$KDNA_PASSWORD" | kdna load <file.kdna> --password-stdin',
          EXIT.INPUT_ERROR,
        );
      }
      const stdinPw = fs.readFileSync(0, 'utf8').trim();
      password = stdinPw.length > 0 ? stdinPw : undefined;
    }
    if (args.includes('--has-password')) {
      error(
        '--has-password is a plan-load diagnostic only; it does not decrypt. Use `kdna plan-load --has-password` for dry-runs. For `kdna load`, pipe the real password with --password-stdin.',
        EXIT.INPUT_ERROR,
      );
    }

    // Read asset_id + version for audit log (best-effort)
    let auditAssetId = null;
    let auditAssetUid = null;
    let auditVersion = null;
    let auditAccessMode = null;
    try {
      const m = readManifestForPath(abs);
      if (m) {
        auditAssetId = m.asset_id || null;
        auditAssetUid = m.asset_uid || null;
        auditVersion = m.version || null;
        auditAccessMode = m.access || null;
      }
    } catch (e) {
      // Non-fatal: audit log metadata extraction is best-effort.
      // A malformed kdna.json means the audit entry will have null
      // asset_id/version/access_mode, but the load still proceeds.
      if (process.env.KDNA_DEBUG) {
        process.stderr.write(`audit metadata read failed: ${e.message}
`);
      }
    }

    // Story 16+18+CRITICAL-2: detect access: "remote" before the
    // loadAuthorized path. For remote assets the kdna-core load
    // path returns state: "needs_runtime" (can_load_now: false);
    // we route to the configured kdna-remote-server instead.
    const remoteServer = getFlag('--remote-server') || process.env.KDNA_REMOTE_SERVER || null;
    if (isAccessRemote(abs)) {
      if (auditRequested) {
        error(
          '--audit currently supports local Runtime loads only; remote loads do not write a local receipt.',
          EXIT.INPUT_ERROR,
        );
      }
      runRemoteLoad({ abs, remoteServer, getFlag, args }).catch((e) => {
        process.stderr.write(`Error: ${e.message || e}\n`);
        process.exit(EXIT.VALIDATION_FAILED);
      });
      return;
    } else if (remoteServer !== null) {
      process.stderr.write(
        'Note: --remote-server is ignored for non-remote assets.\n' +
          'The flag only applies to assets declared access: "remote" in kdna.json.\n',
      );
    }

    const loadStart = Date.now();
    let externalSession = null;
    try {
      const entitlementStatusIndex = args.indexOf('--entitlement-status');
      const entitlementStatus =
        entitlementStatusIndex >= 0 ? args[entitlementStatusIndex + 1] : null;
      const loadManifest = readManifestForPath(abs) || {};
      externalSession = loadExternalAuthorization(abs, loadManifest);
      const r = core.loadAuthorized(abs, {
        profile,
        as,
        password,
        hasPassword: !!password || args.includes('--has-password'),
        entitlement:
          externalSession?.entitlement ||
          (entitlementStatus ? { status: entitlementStatus } : undefined),
        decryptEntry: externalSession?.decryptEntry,
      });
      if (auditRequested) {
        appendAuditEntry({
          asset_id: auditAssetId,
          version: auditVersion,
          profile,
          as,
          access_mode: auditAccessMode,
          result: 'success',
          error_code: null,
          duration_ms: Date.now() - loadStart,
        });
      }

      // --namespace filter (Story 11): if requested, reduce output to a
      // single component's content from resolved_dependencies.
      // Story 21: if the access mode is `licensed` or `remote`, the
      // watermark is attached to the load result BEFORE the
      // namespace filter so it applies regardless of whether the
      // consumer asked for the full content or a single namespace.
      if (auditAccessMode && shouldWatermark(auditAccessMode)) {
        try {
          const wm = buildWatermark({
            access: auditAccessMode,
            // Prefer asset_uid (the URN — globally unique). Fall
            // back to asset_id (which may be a human-readable name
            // like "kdna:test:foo"). This is the same fallback
            // the plan-load uses for the watermark_policy.
            assetUid: auditAssetUid || auditAssetId || 'urn:unknown',
          });
          if (wm) {
            r.watermark = wm;
          }
        } catch (_) {
          // watermark generation is optional — never fail load because of it
        }
      }

      if (namespaceFilter) {
        if (!r || !r.resolved_dependencies || r.resolved_dependencies.length === 0) {
          process.stderr.write(
            `Warning: --namespace="${namespaceFilter}" has no effect on single-asset loads ` +
              `(no resolved_dependencies). Load a Bundle to use namespace filtering.\n`,
          );
        } else {
          const match = r.resolved_dependencies.find(
            (d) => d.rag_namespace && d.rag_namespace.includes(namespaceFilter),
          );
          if (!match) {
            process.stderr.write(
              `Warning: namespace "${namespaceFilter}" not found in resolved_dependencies. ` +
                `Available: ${r.resolved_dependencies.map((d) => d.rag_namespace).join(', ')}\n`,
            );
          } else {
            // Return only the matched component's content
            const filtered = {
              ...r,
              rag_namespace_filter: namespaceFilter,
              resolved_dependencies: [match],
              content: match.content,
            };
            if (as === 'prompt') {
              process.stdout.write(
                `[NAMESPACE: ${match.rag_namespace}]\n` +
                  (match.content ? JSON.stringify(match.content, null, 2) : '(no content)') +
                  '\n',
              );
            } else {
              console.log(JSON.stringify(filtered, null, 2));
            }
            return;
          }
        }
      }

      if (as === 'prompt') {
        // Story 21: prepend the watermark header so the consumer
        // is expected to include it in the prompt they send to
        // the model. The header is one line, machine-parseable,
        // and content-neutral.
        const wmHeader = r.watermark ? renderWatermarkHeader(r.watermark) + '\n' : '';
        process.stdout.write(wmHeader + r.text + '\n');
      } else {
        console.log(JSON.stringify(r, null, 2));
      }
      return;
    } catch (e) {
      if (auditRequested) {
        appendAuditEntry({
          asset_id: auditAssetId,
          version: auditVersion,
          profile,
          as,
          access_mode: auditAccessMode,
          result: 'error',
          error_code: e.code || null,
          duration_ms: Date.now() - loadStart,
        });
      }
      if (e.code === 'KDNA_DECRYPT_FAILED') {
        process.stderr.write('Error: decryption failed. Check your password.\n');
        process.exit(EXIT.JUDGMENT_QUALITY_FAILED);
      }
      if (e.code === 'KDNA_AUTH_PASSWORD_REQUIRED' || e.code === 'requires_decryption') {
        process.stderr.write(
          'Error: payload requires a password. Pipe it with --password-stdin.\n',
        );
        process.exit(EXIT.JUDGMENT_QUALITY_FAILED);
      }
      if (e.code === 'KDNA_AUTH_ACCOUNT_REQUIRED' || e.code === 'KDNA_AUTH_ORG_REQUIRED') {
        process.stderr.write(
          'Error: this asset needs an approved account/device entitlement. ' +
            'Run kdna license activate <asset-name> --server <url>.\n',
        );
        process.exit(EXIT.JUDGMENT_QUALITY_FAILED);
      }
      if (e.code === 'KDNA_AUTH_REMOTE_RUNTIME_REQUIRED') {
        // Defensive: the access check above should have caught
        // this case, but if it slips through (e.g. if the access
        // check is wrong), at least give a clear error rather
        // than a generic "LoadPlan denied loading".
        process.stderr.write(
          'Error: this asset is access: "remote" and requires a kdna-remote-server.\n' +
            'Pass --remote-server <url> or set KDNA_REMOTE_SERVER=<url>.\n',
        );
        process.exit(EXIT.JUDGMENT_QUALITY_FAILED);
      }
      process.stderr.write('Error: ' + e.message + '\n');
      process.exit(EXIT.VALIDATION_FAILED);
    } finally {
      externalSession?.dispose();
    }
  }
  // eslint-disable-next-line no-fallthrough
  case 'lint': {
    try {
      const lintTarget = args.filter((a) => !a.startsWith('--'))[1];
      if (!lintTarget) error('Usage: kdna lint <source-dir> [--strict] [--json]', EXIT.INPUT_ERROR);
      const abs = require('node:path').resolve(lintTarget);
      if (!fs.existsSync(abs)) error(`Directory not found: ${lintTarget}`, EXIT.INPUT_ERROR);
      if (!fs.statSync(abs).isDirectory())
        error(`Not a directory: ${lintTarget}`, EXIT.INPUT_ERROR);
      const result = runAntiMonolithicCheck(abs, { strict: args.includes('--strict') });
      const code = printAntiMonolithic(result, { json: args.includes('--json') });
      process.exit(code);
    } catch (e) {
      process.stderr.write('Error: ' + e.message + '\n');
      process.exit(1);
    }
  }
  // eslint-disable-next-line no-fallthrough
  case 'workpack': {
    cmdWorkpack(args);
    break;
  }

  case 'demo': {
    cmdDemoMinimal(args.slice(1));
    break;
  }

  case 'license': {
    // Wave 5: wire license subcommands (G8)
    const sub = args[1];
    if (sub === 'install') {
      cmdLicenseInstall(args.slice(2));
      break;
    }
    if (sub === 'status') {
      cmdLicenseStatus(args.slice(2));
      break;
    }
    if (sub === 'generate') {
      cmdLicenseGenerate(args.slice(2));
      break;
    }
    if (sub === 'activate') {
      cmdLicenseActivate(args.slice(2)).catch((e) => {
        process.stderr.write(`Error: ${e.message || e}\n`);
        process.exit(EXIT.TRUST_FAILED);
      });
      break;
    }
    if (sub === 'sync') {
      cmdLicenseSync(args.slice(2)).catch((e) => {
        process.stderr.write(`Error: ${e.message || e}\n`);
        process.exit(EXIT.TRUST_FAILED);
      });
      break;
    }
    if (sub === 'verify') {
      cmdLicenseVerify(args.slice(2));
      break;
    }
    if (sub === 'bind') {
      cmdLicenseBind(args.slice(2));
      break;
    }
    if (sub === 'show') {
      cmdLicenseShow(args.slice(2));
      break;
    }
    error(
      `Usage: kdna license <install|status|generate|activate|sync|verify|bind|show> [...]`,
      EXIT.INPUT_ERROR,
    );
  }
  // eslint-disable-next-line no-fallthrough
  case 'identity': {
    const sub = args[1];
    if (sub === 'init') {
      cmdIdentityInit();
      break;
    }
    if (sub === 'show') {
      cmdIdentityShow(args.includes('--json'));
      break;
    }
    error(
      `Usage: kdna identity <init|show>\n` +
        `  kdna identity init\n` +
        `  kdna identity show [--json]`,
      EXIT.INPUT_ERROR,
    );
  }
  // eslint-disable-next-line no-fallthrough
  case 'doctor': {
    cmdDoctor(args.slice(1));
    break;
  }

  case 'publish': {
    const sub = args[1];
    if (sub === '--check' || sub === 'check') {
      cmdPublishCheck(args[2], args.slice(3));
      break;
    }
    cmdPublish(args[1], args.slice(2));
    break;
  }
  case 'changelog': {
    cmdChangelog(args.slice(1));
    break;
  }
  case 'explain': {
    cmdExplain(args.slice(1));
    break;
  }
  case 'protocol': {
    cmdProtocol(args.slice(1));
    break;
  }
  case 'test': {
    const sub = args[1];
    if (sub === 'import') {
      cmdTestImport(args.slice(2));
      break;
    }
    cmdTestRun(args.slice(1));
    break;
  }
  case 'badge': {
    const sub = args[1];
    if (sub === 'audit') {
      badge.cmdRegistryAudit(args.slice(2));
      break;
    }
    if (sub === 'package') {
      badge.cmdPackage(args[2], args.slice(3));
      break;
    }
    badge.cmdBadgeCompute(args[1], args.slice(2));
    break;
  }
  case 'domain': {
    const sub = args[1];
    if (sub === 'pack') {
      domain.cmdPack(args[2], args[3]);
      break;
    }
    if (sub === 'unpack') {
      domain.cmdUnpack(args.slice(2));
      break;
    }
    if (sub === 'inspect') {
      domain.cmdInspect(args.slice(2));
      break;
    }
    if (sub === 'validate') {
      const json = args.includes('--json');
      domain.cmdValidate(args[2], !args.includes('--no-schema'), json);
      break;
    }
    if (sub === 'card') {
      domain.cmdCard(args.slice(2));
      break;
    }
    error('Usage: kdna domain <validate|pack|unpack|inspect|card> [args]');
    break;
  }

  case 'governance': {
    const sub = args[1];
    if (sub === 'proposal') {
      if (args[2] === 'create') {
        governance.cmdProposalCreate(args.slice(3));
        break;
      }
      if (args[2] === 'validate') {
        governance.cmdProposalValidate(args.slice(3));
        break;
      }
    }
    if (sub === 'review') {
      governance.cmdReview(args.slice(2));
      break;
    }
    if (sub === 'lock') {
      governance.cmdLockCard(args.slice(2));
      break;
    }
    if (sub === 'evolution') {
      governance.cmdEvolution(args.slice(2));
      break;
    }
    if (sub === 'regression') {
      governance.cmdRegression(args.slice(2));
      break;
    }
    error('Usage: kdna governance <proposal|review|lock|evolution|regression>');
    break;
  }

  case 'legacy': {
    const sub = args[1];
    if (sub === 'preview') {
      legacy.cmdPreview();
      break;
    }
    if (sub === 'project') {
      legacy.cmdProject(args.slice(2));
      break;
    }
    if (sub === 'eval') {
      legacy.cmdEval(args.slice(2));
      break;
    }
    if (sub === 'select') {
      legacy.cmdSelect(args.slice(2));
      break;
    }
    if (sub === 'export') {
      legacy.cmdExport(args.slice(2));
      break;
    }
    if (sub === 'demo') {
      legacy.cmdDemo(args.slice(2));
      break;
    }
    error('Usage: kdna legacy <preview|project|eval|select|export|demo>');
    break;
  }

  case 'quality': {
    const sub = args[1];
    if (sub === 'compare') {
      error(
        'kdna quality compare is outside the current Preview. ' +
          'Asset-level behavioral evaluation belongs to a named evaluator, not the Runtime CLI.',
        EXIT.INPUT_ERROR,
      );
    }
    if (sub === 'diff') {
      quality.cmdDiff(args.slice(2));
      break;
    }
    if (sub === 'search') {
      quality.cmdSearch(args.slice(2));
      break;
    }
    if (sub === 'available') {
      quality.cmdAvailable(args.slice(2));
      break;
    }
    if (sub === 'match') {
      quality.cmdMatch(args.slice(2));
      break;
    }
    if (sub === 'select') {
      quality.cmdSelect(args.slice(2));
      break;
    }
    if (sub === 'postvalidate') {
      quality.cmdPostvalidate(args.slice(2));
      break;
    }
    error('Usage: kdna quality <diff|search|available|match|select|postvalidate>');
    break;
  }

  case 'studio': {
    const sub = args[1];
    if (sub === 'scaffold') {
      studio.cmdStudioScaffold(args[2], args.slice(3));
      break;
    }
    if (sub === 'cards') {
      if (args[2] === 'validate') {
        studio.cmdCardsValidate(args[3], args.slice(4));
        break;
      }
    }
    if (sub === 'lock') {
      if (args[2] === 'verify') {
        studio.cmdLockVerify(args[3], args.slice(4));
        break;
      }
    }
    if (sub === 'compile') {
      studio.cmdStudioCompile(args[2], args.slice(3));
      break;
    }
    if (sub === 'readiness') {
      studio.cmdStudioReadiness(args.slice(2));
      break;
    }
    error('Usage: kdna studio <scaffold|cards|lock|compile|readiness>');
    break;
  }

  case 'trace': {
    cmdTrace(args.slice(1));
    break;
  }

  case 'history': {
    cmdHistory(args.slice(1));
    break;
  }

  case 'cluster': {
    cmdCluster(args.slice(1));
    break;
  }

  case 'protect': {
    // Subcommands: protect/unlock prefer --password-stdin; recover combines
    // --code-stdin with a new password from an approved non-argv source.
    const sub = args[1];
    if (sub === 'unlock') {
      cmdUnlock(args.slice(2));
      break;
    }
    if (sub === 'recover') {
      cmdRecover(args.slice(2));
      break;
    }
    // Default: protect itself
    cmdProtect(args.slice(1));
    break;
  }

  case 'capsule-verify': {
    const capsuleFile = args.slice(1).find((a) => !a.startsWith('--')) || '';
    if (!capsuleFile)
      error(
        'Usage: kdna capsule-verify <capsule.json> [--asset <file.kdna>] [--json]',
        EXIT.INPUT_ERROR,
      );
    const getFlag = (name) => {
      const eq = args.find((a) => a.startsWith(name + '='));
      if (eq) return eq.split('=')[1];
      const idx = args.indexOf(name);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const assetPath = getFlag('--asset') || null;
    if (getFlag('--key')) {
      error('Asset signatures are outside the current Preview contract.', EXIT.INPUT_ERROR);
    }
    const { verifyCapsule } = require('./capsule-verify');
    const result = verifyCapsule(capsuleFile, { assetPath });
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.valid) {
        console.log('Capsule verification PASSED');
        if (result.warnings.length) {
          for (const w of result.warnings) console.log('  WARN:', w);
        }
      } else {
        console.log('Capsule verification FAILED');
        for (const e of result.errors) console.log('  ERROR:', e);
        for (const w of result.warnings) console.log('  WARN:', w);
      }
    }
    process.exit(result.valid ? 0 : 1);
    break;
  }
  case 'version': {
    console.log(require('../package.json').version);
    break;
  }
  case 'plan-use': {
    cmdPlanUse(args.slice(1));
    break;
  }
  case 'use': {
    cmdUse(args.slice(1));
    break;
  }
  case 'eval': {
    const sub = args[1];
    if (sub === 'asset') {
      Promise.resolve(cmdEvalAsset(args.slice(2))).catch((e) => {
        error(`Asset Assay failed: ${e.message}`, EXIT.VALIDATION_FAILED);
      });
    } else if (sub === 'cluster') {
      const { cmdEvalCluster } = require('./cmds/eval-cluster');
      cmdEvalCluster(args.slice(2));
    } else {
      error(
        'Usage: kdna eval <asset|cluster> <path> [options]\n' +
          '  kdna eval asset <asset.kdna> --fixtures <dir>\n' +
          '  kdna eval cluster <kdna.cluster.json> --fixtures <dir>  (Phase 6)',
        EXIT.INPUT_ERROR,
      );
    }
    break;
  }
  case 'eval-consumption': {
    cmdEvalConsumption(args.slice(1));
    break;
  }
  case 'project': {
    cmdProject(args.slice(1));
    break;
  }
  case 'route': {
    cmdRoute(args.slice(1));
    break;
  }
  case 'compose': {
    cmdCompose(args.slice(1));
    break;
  }
  case 'compose-review-workbook':
  case 'validate-compose-decisions':
  case 'apply-reviewed-compose-decisions': {
    cmdComposeReview(args);
    break;
  }
  case 'asset-evidence': {
    cmdAssetEvidence(args.slice(1));
    break;
  }
  default:
    error(`Unknown command: ${cmd}\nRun: kdna help`);
}

/**
 * Read the kdna.json manifest and return its `access` field, or
 * null. Used to short-circuit remote assets before the
 * loadAuthorized path throws KDNA_AUTH_REMOTE_RUNTIME_REQUIRED.
 */
function readAccessField(abs) {
  try {
    const m = readManifestForPath(abs);
    return m.access || null;
  } catch (_) {
    return null;
  }
}

function isAccessRemote(abs) {
  return readAccessField(abs) === 'remote';
}

/**
 * Story 16+18+CRITICAL-2: client integration for access: "remote"
 * assets. Posts a projection request to the configured
 * kdna-remote-server and prints the result.
 *
 * The remote-server URL is taken from:
 *   1. --remote-server <url> flag
 *   2. KDNA_REMOTE_SERVER environment variable
 * If neither is set, we fail with a clear error.
 */
function resolveRemoteProjectionUrl(remoteServer) {
  return remoteProjectionEndpoint(remoteServer);
}

async function runRemoteLoad(opts) {
  const { abs, remoteServer, getFlag, args } = opts;
  const task = getFlag('--task') || 'review';
  const context = getFlag('--context') || '';
  const mode = getFlag('--mode') || 'judge';
  const as = getFlag('--as') || 'json';

  if (!remoteServer) {
    process.stderr.write(
      'Error: this asset is access: "remote" and requires a kdna-remote-server.\n' +
        'Pass --remote-server <url> or set KDNA_REMOTE_SERVER=<url>.\n' +
        'Get a projection server at https://github.com/aikdna/kdna-remote-server\n',
    );
    process.exit(EXIT.JUDGMENT_QUALITY_FAILED);
  }

  // Read the asset_uid from kdna.json. The remote server uses
  // kdna_id for the projection request; matching it to the
  // asset_uid is the natural choice.
  let assetUid = null;
  try {
    const m = readManifestForPath(abs);
    assetUid = m.asset_uid || m.asset_id || null;
  } catch (_) {
    // fall through
  }

  // Build the projection request body. Matches the
  // kdna-remote-server /project contract (see
  // @aikdna/kdna-remote-server README §HTTP API).
  const reqBody = JSON.stringify({
    kdna_id: assetUid,
    task,
    context,
    mode,
  });

  // Compute the projection endpoint without accepting obsolete route
  // aliases. A caller may provide only a server base URL or the exact
  // current /project endpoint.
  let url;
  try {
    url = resolveRemoteProjectionUrl(remoteServer);
  } catch (_) {
    process.stderr.write(
      'Error: --remote-server must be a canonical HTTPS origin or exact /project endpoint.\n' +
        'HTTP is allowed only for the exact 127.0.0.1 or [::1] loopback host.\n',
    );
    process.exit(EXIT.INPUT_ERROR);
    return;
  }

  let response;
  try {
    // Defer to the next tick so the case-block's caller (the
    // main switch) has a chance to return synchronously. This
    // keeps the event loop alive and lets the fetch actually
    // dispatch.
    await new Promise((resolve) => setImmediate(resolve));
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reqBody,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      let code = 'REMOTE_REQUEST_REJECTED';
      try {
        const body = await readBoundedFetchJson(response);
        code = safeRemoteCode(body?.error?.code);
      } catch {
        // A malformed error response is still a rejection. Its body never
        // crosses the user-facing error boundary.
      }
      process.stderr.write(
        `Error: remote projection rejected [${code}] (HTTP ${response.status}). ` +
          'No projection was loaded.\n',
      );
      process.exit(EXIT.PROVIDER_ERROR);
    }

    const projection = await readBoundedFetchJson(response);
    // CRITICAL-2 (2026-06-29): hand off to the formatter and
    // explicit-exit helper. The async IIFE that called us
    // doesn't await; the explicit process.exit() inside the
    // helper keeps node from closing in-flight fetch handles
    // before stdout has fully flushed.
    finishRemoteLoad(projection, url, assetUid, task, context, mode, as);
  } catch {
    process.stderr.write(
      'Error: remote projection request failed [REMOTE_TRANSPORT_FAILED]. ' +
        'No projection was loaded.\n',
    );
    process.exit(EXIT.PROVIDER_ERROR);
  }
}

/**
 * Print the projection result and exit. Pulled out so the
 * async runner can call it at the end of its try block.
 */
function finishRemoteLoad(projection, url, assetUid, task, context, mode, as) {
  if (as === 'prompt') {
    // Render the projection as a readable prompt. Include the
    // task_projection fields as bullet points; the consumer
    // typically forwards this to a model.
    const lines = [];
    lines.push(`# kdna-remote projection (${task})`);
    lines.push(
      `# asset: ${projection.asset_id || assetUid || '?'}@${projection.asset_version || '?'}`,
    );
    lines.push(`# trace: ${projection.trace_id || '(none)'}`);
    lines.push(`# server: ${url}`);
    lines.push('');
    const tp = projection.task_projection || {};
    if (tp.highest_question) {
      lines.push('## Highest question');
      lines.push(tp.highest_question);
      lines.push('');
    }
    if (Array.isArray(tp.diagnosis_focus) && tp.diagnosis_focus.length > 0) {
      lines.push('## Diagnosis focus');
      for (const a of tp.diagnosis_focus) lines.push('- ' + a);
      lines.push('');
    }
    if (Array.isArray(tp.constraints) && tp.constraints.length > 0) {
      lines.push('## Constraints');
      for (const a of tp.constraints) lines.push('- ' + a);
      lines.push('');
    }
    if (Array.isArray(tp.self_check) && tp.self_check.length > 0) {
      lines.push('## Self-check');
      for (const a of tp.self_check) lines.push('- ' + a);
      lines.push('');
    }
    if (Array.isArray(tp.failure_modes) && tp.failure_modes.length > 0) {
      lines.push('## Failure modes');
      for (const a of tp.failure_modes) lines.push('- ' + a);
      lines.push('');
    }
    process.stdout.write(lines.join('\n'));
  } else {
    // JSON output: include the request metadata alongside the
    // projection response so the consumer can audit.
    console.log(
      JSON.stringify(
        {
          remote_server: url,
          request: { kdna_id: assetUid, task, context, mode },
          response: projection,
        },
        null,
        2,
      ),
    );
  }
  // CRITICAL-2 (2026-06-29): explicit exit. Without this, the
  // node process may close the in-flight fetch handles before
  // stdout has fully flushed (observed in spawnSync tests).
  process.exit(EXIT.OK);
}
