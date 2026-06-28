#!/usr/bin/env node
/**
 * kdna — v1 Core runtime CLI.
 *
 * KDNA CLI is the runtime control plane for inspecting, validating,
 * planning, packing, unpacking, and loading local .kdna assets.
 */

const fs = require('node:fs');
const path = require('node:path');
const { error, EXIT, setQuiet, setExitCodeOnly } = require('./cmds/_common');
const { cmdDemo: cmdDemoMinimal } = require('./cmds/demo');
const { runAntiMonolithicCheck, printAndExit: printAntiMonolithic } = require('./cmds/anti-monolithic');
const { cmdWorkpack } = require('./cmds/workpack');
const { cmdLicenseInstall, cmdLicenseStatus, cmdLicenseGenerate } = require('./cmds/license');
const { cmdIdentityInit, cmdIdentityShow } = require('./cmds/identity');
const { cmdDoctor } = require('./cmds/doctor');
const { cmdTrace, cmdHistory } = require('./cmds/trace');
const { cmdCluster } = require('./cmds/cluster');
const { cmdProtect, cmdUnlock, cmdRecover } = require('./cmds/protect');
const { cmdAvailable, cmdMatch } = require('./agent');
const { cmdInstallExtended } = require('./install');
const { cmdPublish, cmdPublishCheck } = require('./publish');
const { cmdChangelog } = require('./cmds/changelog');
const { cmdExplain } = require('./cmds/explain');
const { cmdProtocol } = require('./cmds/protocol');
const { cmdTestRun, cmdTestImport } = require('./cmds/test');
const badge = require('./cmds/badge');
const domain = require('./cmds/domain');
const governance = require('./cmds/governance');
const legacy = require('./cmds/legacy');
const quality = require('./cmds/quality');
const registry = require('./cmds/registry');
const { cmdSetup } = require('./cmds/setup');
const { validateBundle } = require('./cmds/validate-bundle');
const { computeContextBudget } = require('./cmds/context-budget');
const { appendAuditEntry } = require('./cmds/audit-log');
const studio = require('./cmds/studio');
const { resolveAsset, readAssetManifest } = require('./package-store');

const resolveAssetCallback = (name) => {
  const pkg = resolveAsset(name);
  if (pkg && pkg.asset_path) {
    return {
      path: pkg.asset_path,
      version: pkg.version,
      manifest: readAssetManifest(pkg.asset_path)
    };
  }
  return null;
};

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
  console.log(`kdna v${v} — v1 Core runtime CLI
Core v1:
  inspect   <file.kdna>              Inspect a local v1 .kdna container
  validate  <file.kdna>              Validate a local v1 .kdna container
  validate  <path> --runtime         Validate and require LoadPlan readiness
  validate  <bundle.json> --bundle   Validate a kdna.bundle.json manifest
                                     (component resolution + stub; Story 3)
  plan-load <file.kdna>              Return a LoadPlan before runtime load
  load      <file.kdna>              Render agent-ready judgment context
                                     --namespace=<id> limit to one RAG namespace
  pack      <dev-source> <out>       Pack into .kdna (--force to overwrite)
  unpack    <file.kdna> <out>        Extract .kdna into an editing/debug view
  demo      <minimal|judgment> <dir>  Create a v1 demo fixture
  lint      <source-dir>             Anti-Monolithic Domain check (RFC-0013 §4)
                                     --strict: upgrade warnings to errors
                                     --json: machine-readable output
  workpack  <subcommand> <path>      Work Pack operations (init/validate/inspect/
                                     explain/plan/run/report)
Auth & Identity:
  license  install <license.json>    Install a license for a domain
  license  status [<domain>]         Show license status (all or one)
  license  generate <domain>         Generate a signed license
           --to <email> [--expires]
  identity init                      Generate Ed25519 identity keypair
  identity show                      Display identity fingerprint/paths
Diagnostics:
  doctor   [--agents] [--domains]    System health check
  trace    [--json] [--clear]        Observability trace logs
  history  [--stats] [--json]        KDNA load history (agent trace)
  history  --audit [--stats] [--json] CLI load audit log (~/.kdna/audit.jsonl)
  cluster  <path>                    Validate a cluster manifest
  protect  <file> --out <file>       Encrypt a .kdna asset with a password
           [--password <pw>|--password-stdin]
           [--entries payload.kdnab,...]
  protect  unlock <file>             Decrypt a protected .kdna
           [--password <pw>|--password-stdin]
           [--profile compact|index|full]
  protect  recover <file>            Recover a .kdna using a recovery code
           --out <file> --code-stdin
  available                            List available installed domains
  match     "<task>"                  Find the best-matching domain for a task
  install   <name|@scope/name|file>   Install a .kdna asset from local/registry
Authoring & Publishing:
  publish  <file.kdna>               Publish a .kdna asset (see also --check)
  publish  --check <path>            Quality gate check before publish
  changelog <domain> --from --to     Generate judgment changelog between versions
  explain  <domain>                  Natural-language explanation of a domain
  protocol <validate|inspect>        Validate or inspect protocol artifacts
  test     run <domain>              Run test cases against a domain
  test     import                    Import test results
Asset & Domain Operations:
  badge    <domain>                  Compute quality badge for a domain
  badge    audit                      Audit registry for stale entries
  badge    package <path>             Package a badge artifact
  domain   validate <path>            Validate a domain source directory
  domain   pack <src> <out>           Pack a domain source to .kdna
  domain   unpack <file>              Unpack a .kdna file to a source dir
  domain   inspect <path>             Inspect a domain source
  domain   card <path>                Render a domain summary card
  governance <proposal|review|...>   Human-governed self-improvement ops
  legacy   <preview|project|eval>    Legacy domain migration commands
  quality  <compare|diff|search>      Cross-version quality analysis
  registry <list|refresh>            Registry operations (registry is out of scope
                                     for Core v1; refresh is informational only)
  setup                                First-time setup wizard
  studio   <scaffold|cards|...>       Studio integration commands
Flags: --version / --help / --json / --quiet
`);
}

const cmd = args[0];

switch (cmd) {
 
  case 'validate': {
    try {
    // --bundle mode: validate a kdna.bundle.json manifest (RFC #148 Story 3)
    if (args.includes('--bundle')) {
      const bundleTarget = args.filter((a) => !a.startsWith('--'))[1];
      if (!bundleTarget) error('Usage: kdna validate <bundle.json> --bundle [--verbose]', EXIT.INPUT_ERROR);
      const result = validateBundle(bundleTarget, { verbose: args.includes('--verbose') });
      // Always emit JSON output so callers can parse the result regardless of outcome.
      // Fatal errors (file not found, invalid JSON) are represented inside the result.
      if (result.fatal) delete result.fatal;
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.bundle_valid ? 0 : 1);
    }
    const v1Target = args.filter((a) => !a.startsWith('--'))[1];
    if (!v1Target) error('Usage: kdna validate <file.kdna> [--runtime] [--entitlement-status <status>]', EXIT.INPUT_ERROR);
    const {
      isV1SourceDir,
      isV2SourceDir,
      detectContainerFormat,
      validate,
    } = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(v1Target);
    if (!fs.existsSync(abs)) error(`File not found: ${v1Target}`, EXIT.INPUT_ERROR);
    const containerFmt = detectContainerFormat(abs);
    const isV1 = isV1SourceDir(abs) || containerFmt === 'v1';
    const isV2 = (isV2SourceDir && isV2SourceDir(abs)) || containerFmt === 'v2';
    if (!isV1 && !isV2) {
      error(`Not a KDNA container or source directory: ${v1Target}`, EXIT.INPUT_ERROR);
    }
    if (isV1) {
      process.stderr.write('Warning: KDNA v1 format is deprecated and will reach end-of-life in 9-12 months. Please migrate to KDNA v2.\n');
    }
    const runtimeMode = args.includes('--runtime');
    const result = validate(v1Target);
    if (runtimeMode) {
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
          'kdna validate --runtime requires @aikdna/kdna-core with the LoadPlan v1 API. Update @aikdna/kdna-core before enabling runtime authorization diagnostics.',
          EXIT.PROVIDER_ERROR,
        );
      }
      result.runtime_load_plan = core.planLoad(v1Target, {
        hasPassword: args.includes('--has-password'),
        entitlement: entitlementStatus ? { status: entitlementStatus } : undefined,
        resolveAsset: resolveAssetCallback,
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
    } catch (e) { process.stderr.write('Error: ' + e.message + '\n'); process.exit(1); }
  }
// eslint-disable-next-line no-fallthrough
  case 'plan-load': {
    try {
    const v1Target = args.filter((a) => !a.startsWith('--'))[1];
    if (!v1Target)
      error(
        'Usage: kdna plan-load <path> [--json] [--has-password | --password <value>] [--entitlement-status <status>]',
        EXIT.INPUT_ERROR,
      );
    const core = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(v1Target);
    const containerFmt = core.detectContainerFormat(abs);
    const isV1 = core.isV1SourceDir(abs) || containerFmt === 'v1';
    const isV2 = (core.isV2SourceDir && core.isV2SourceDir(abs)) || containerFmt === 'v2';
    if (!isV1 && !isV2) {
      error('plan-load requires a KDNA Core source dir or .kdna container', EXIT.INPUT_ERROR);
    }
    if (isV1) {
      process.stderr.write('Warning: KDNA v1 format is deprecated and will reach end-of-life in 9-12 months. Please migrate to KDNA v2.\n');
    }
    if (typeof core.planLoad !== 'function') {
      error(
        'kdna plan-load requires @aikdna/kdna-core with the LoadPlan v1 API. Update @aikdna/kdna-core before enabling runtime authorization diagnostics.',
        EXIT.PROVIDER_ERROR,
      );
    }
    const entitlementStatusIndex = args.indexOf('--entitlement-status');
    const entitlementStatus = entitlementStatusIndex >= 0 ? args[entitlementStatusIndex + 1] : null;
    const allowedEntitlementStatuses = new Set(['active', 'expired', 'revoked', 'offline_grace']);
    if (entitlementStatusIndex >= 0 && !allowedEntitlementStatuses.has(entitlementStatus)) {
      error(
        'Invalid --entitlement-status. Use active, expired, revoked, or offline_grace.',
        EXIT.INPUT_ERROR,
      );
    }
    // --password <value> is the credential-presence signal for plan-load.
    // The LoadPlan does NOT verify the password (only `kdna load` does that),
    // but presence of --password makes has_password_input: true and lets
    // downstream callers skip the "enter_password" step.
    const planLoadPwIdx = args.indexOf('--password');
    const planLoadPassword =
      planLoadPwIdx >= 0 && args[planLoadPwIdx + 1] && !args[planLoadPwIdx + 1].startsWith('--')
        ? args[planLoadPwIdx + 1]
        : null;
    const plan = core.planLoad(v1Target, {
      hasPassword: !!planLoadPassword || args.includes('--has-password'),
      password: planLoadPassword || undefined,
      entitlement: entitlementStatus ? { status: entitlementStatus } : undefined,
      resolveAsset: resolveAssetCallback,
    });

    // Context budget reporting (Story 8) — non-blocking, best-effort.
    // If the Bundle manifest declares context_budget.max_tokens, compute
    // a per-component token cost estimate and attach it to the plan output.
    if (
      plan.resolved_dependencies &&
      plan.resolved_dependencies.length > 0
    ) {
      try {
        const manifestPath = require('node:path').join(abs, 'kdna.json');
        if (fs.existsSync(manifestPath)) {
          const bundleManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const budgetDecl = bundleManifest.context_budget ||
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

    console.log(JSON.stringify(plan, null, 2));
    process.exit(plan.state === 'invalid' ? 1 : plan.can_load_now === true ? 0 : 3);
    } catch (e) { process.stderr.write('Error: ' + e.message + '\n'); process.exit(1); }
  }
// eslint-disable-next-line no-fallthrough
  case 'pack': {
    try {
    const v1Target = args.filter((a) => !a.startsWith('--'))[1];
    if (!v1Target) error('Usage: kdna pack <source-dir> <output.kdna>', EXIT.INPUT_ERROR);
    const {
      isV1SourceDir,
      pack: packDir,
    } = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(v1Target);
    if (!isV1SourceDir(abs)) {
      error(`Not a KDNA v1 source directory: ${v1Target}`, EXIT.INPUT_ERROR);
    }

    // Warn if checksums are stale (source modified since last pack)
    const checksumsPath = path.resolve(abs, 'checksums.json');
    if (fs.existsSync(checksumsPath)) {
      try {
        const { buildChecksumsV1 } = require('@aikdna/kdna-core');
        const manifestPath = path.resolve(abs, 'kdna.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const fresh = buildChecksumsV1(abs, manifest);
        const stored = JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
        if (JSON.stringify(fresh) !== JSON.stringify(stored)) {
          process.stderr.write('Warning: checksums.json is stale (source files changed). Rebuilding during pack.\n');
        }
      } catch { /* checksums check is best-effort */ }
    }
    const out = args.filter((a) => !a.startsWith('--'))[2];
    if (!out) error('Usage: kdna pack <source-dir> <output.kdna>', EXIT.INPUT_ERROR);
    if (fs.existsSync(out)) {
      if (args.includes('--force')) {
        fs.unlinkSync(out);
      } else {
        error(
          `Output file already exists: ${out}\nUse --force to overwrite.`,
          EXIT.INPUT_ERROR,
        );
      }
    }
    // Warn if checksums.json is stale (source files modified since last pack)
    const csp = require('node:path').resolve(abs, 'checksums.json');
    if (fs.existsSync(csp)) {
      try {
        const mf = JSON.parse(fs.readFileSync(require('node:path').resolve(abs, 'kdna.json'), 'utf8'));
        const fresh = require('@aikdna/kdna-core').buildChecksumsV1(abs, mf);
        const stored = JSON.parse(fs.readFileSync(csp, 'utf8'));
        if (JSON.stringify(fresh) !== JSON.stringify(stored)) {
          process.stderr.write('Warning: checksums.json is stale (source files changed). Rebuilding during pack.\n');
        }
      } catch { /* checksums check is best-effort */ }
    }
    const r = packDir(v1Target, out);
    process.stdout.write(
      `Packed: ${r.outputPath}\nEntries: ${r.entries.length} (${r.entries.join(', ')})\n`,
    );
    return;
    } catch (e) { process.stderr.write('Error: ' + e.message + '\n'); process.exit(1); }
  }
// eslint-disable-next-line no-fallthrough
  case 'unpack': {
    try {
    const v1Target = args.filter((a) => !a.startsWith('--'))[1];
    if (!v1Target) error('Usage: kdna unpack <input.kdna> <output-dir>', EXIT.INPUT_ERROR);
    const {
      detectContainerFormat,
      unpack,
    } = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(v1Target);
    if (!fs.existsSync(abs)) error(`File not found: ${v1Target}`, EXIT.INPUT_ERROR);
    const containerFmt = detectContainerFormat(abs);
    if (containerFmt !== 'v1' && containerFmt !== 'v2') {
      error(`Not a valid KDNA container: ${v1Target}`, EXIT.INPUT_ERROR);
    }
    if (containerFmt === 'v1') {
      process.stderr.write('Warning: KDNA v1 format is deprecated and will reach end-of-life in 9-12 months. Please migrate to KDNA v2.\n');
    }
    const out = args.filter((a) => !a.startsWith('--'))[2];
    if (!out) error('Usage: kdna unpack <input.kdna> <output-dir>', EXIT.INPUT_ERROR);
    const r = unpack(v1Target, out);
    process.stdout.write(
      `Unpacked: ${r.outputDir}\nEntries: ${r.entries.length} (${r.entries.join(', ')})\n`,
    );
    return;
    } catch (e) { process.stderr.write('Error: ' + e.message + '\n'); process.exit(1); }
  }
// eslint-disable-next-line no-fallthrough
  case 'inspect': {
    try {
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target) error('Usage: kdna inspect <path> [--json] [--locale zh-CN]');
    const {
      isV1SourceDir,
      isV2SourceDir,
      detectContainerFormat,
      inspect,
    } = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(target);
    if (!fs.existsSync(abs)) error(`File not found: ${target}`, EXIT.INPUT_ERROR);
    const containerFmt = detectContainerFormat(abs);
    const isV1 = isV1SourceDir(abs) || containerFmt === 'v1';
    const isV2 = (isV2SourceDir && isV2SourceDir(abs)) || containerFmt === 'v2';
    if (!isV1 && !isV2) {
      error(`Not a valid KDNA container or source directory: ${target}`, EXIT.INPUT_ERROR);
    }
    if (isV1) {
      process.stderr.write('Warning: KDNA v1 format is deprecated and will reach end-of-life in 9-12 months. Please migrate to KDNA v2.\n');
    }
    const out = inspect(target);
    console.log(JSON.stringify(out, null, 2));
    return;
    } catch (e) { process.stderr.write('Error: ' + e.message + '\n'); process.exit(1); }
  }
// eslint-disable-next-line no-fallthrough
  case 'load': {
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target) error('Usage: kdna load <file.kdna> [--profile=<index|compact|scenario|full>] [--as=<json|prompt|raw>] [--namespace=<component-id>] [--password=<value>|--password-stdin]', EXIT.INPUT_ERROR);
    const core = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(target);
    if (!fs.existsSync(abs)) error(`File not found: ${target}`, EXIT.INPUT_ERROR);
    const isV1 = core.isV1SourceDir(abs) || core.detectContainerFormat(abs) === 'v1';
    if (isV1) {
      process.stderr.write('Warning: KDNA v1 format is deprecated and will reach end-of-life in 9-12 months. Please migrate to KDNA v2.\n');
    }
    const getFlag = (name) => {
      const eq = args.find((a) => a.startsWith(name + '='));
      if (eq) return eq.split('=')[1];
      const idx = args.indexOf(name);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const profile = getFlag('--profile') || 'compact';
    const as = getFlag('--as') || 'json';
    // --namespace <id>: filter load output to a single RAG namespace (Story 11).
    // Only the component whose rag_namespace contains <id> is returned.
    // Useful for querying one component of a Bundle without loading all content.
    const namespaceFilter = getFlag('--namespace') || null;
    // BUG-16 (2026-06-27): kdna load previously only accepted
    // --password=<value>, forcing users to either type the password
    // inline (shell history risk) or pipe nothing. Match the protect
    // and plan-load paths: --password-stdin reads from stdin; if both
    // are present, --password-stdin wins (explicit intent).
    const useStdin = args.includes('--password-stdin');
    let password;
    if (useStdin) {
      // Bug fix: refuse up front on a TTY rather than calling
      // `fs.readFileSync(0)` and hanging indefinitely waiting for input
      // the user never sends.
      if (process.stdin.isTTY) {
        error(
          '--password-stdin requires the password to be piped in on stdin.\n' +
          'Example:  echo "$KDNA_PASSWORD" | kdna load <file.kdna> --password-stdin\n' +
          'If you are running interactively, omit --password-stdin and you will be prompted.',
          EXIT.INPUT_ERROR,
        );
      }
      const stdinPw = fs.readFileSync(0, 'utf8').trim();
      password = stdinPw.length > 0 ? stdinPw : undefined;
    } else {
      const passwordRaw = getFlag('--password');
      password = typeof passwordRaw === 'string' && passwordRaw.length > 0 ? passwordRaw : undefined;
    }
    if (args.includes('--has-password')) {
      process.stderr.write('Warning: --has-password is a plan-load diagnostic. Use --password=<value> for actual decryption.\n');
    }

    // Read asset_id + version for audit log (best-effort)
    let auditAssetId = null;
    let auditVersion = null;
    let auditAccessMode = null;
    try {
      const manifestPath = require('node:path').join(abs, 'kdna.json');
      if (fs.existsSync(manifestPath)) {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        auditAssetId = m.asset_id || null;
        auditVersion = m.version || null;
        auditAccessMode = m.access || null;
      }
    } catch (_) {}

    const loadStart = Date.now();
    try {
      const entitlementStatusIndex = args.indexOf('--entitlement-status');
      const entitlementStatus = entitlementStatusIndex >= 0 ? args[entitlementStatusIndex + 1] : null;
      const r = core.loadAuthorized(target, {
        profile,
        as,
        password,
        hasPassword: !!password || args.includes('--has-password'),
        entitlement: entitlementStatus ? { status: entitlementStatus } : undefined,
        resolveAsset: resolveAssetCallback,
      });
      appendAuditEntry({
        asset_path: abs,
        asset_id: auditAssetId,
        version: auditVersion,
        profile,
        as,
        access_mode: auditAccessMode,
        result: 'success',
        error_code: null,
        duration_ms: Date.now() - loadStart,
      });

      // --namespace filter (Story 11): if requested, reduce output to a
      // single component's content from resolved_dependencies.
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
                (match.content ? JSON.stringify(match.content, null, 2) : '(no content)') + '\n',
              );
            } else {
              console.log(JSON.stringify(filtered, null, 2));
            }
            return;
          }
        }
      }

      if (as === 'prompt') {
        process.stdout.write(r.text + '\n');
      } else {
        console.log(JSON.stringify(r, null, 2));
      }
      return;
    } catch (e) {
      appendAuditEntry({
        asset_path: abs,
        asset_id: auditAssetId,
        version: auditVersion,
        profile,
        as,
        access_mode: auditAccessMode,
        result: 'error',
        error_code: e.code || null,
        duration_ms: Date.now() - loadStart,
      });
      if (e.code === 'KDNA_DECRYPT_FAILED') {
        process.stderr.write('Error: decryption failed. Check your password.\n');
        process.exit(EXIT.JUDGMENT_QUALITY_FAILED);
      }
      if (e.code === 'KDNA_AUTH_PASSWORD_REQUIRED' || e.code === 'requires_decryption') {
        process.stderr.write('Error: payload requires a password. Use --password=<value>.\n');
        process.exit(EXIT.JUDGMENT_QUALITY_FAILED);
      }
      process.stderr.write('Error: ' + e.message + '\n');
      process.exit(EXIT.VALIDATION_FAILED);
    }
  }
// eslint-disable-next-line no-fallthrough
  case 'lint': {
    try {
    const lintTarget = args.filter((a) => !a.startsWith('--'))[1];
    if (!lintTarget) error('Usage: kdna lint <source-dir> [--strict] [--json]', EXIT.INPUT_ERROR);
    const abs = require('node:path').resolve(lintTarget);
    if (!fs.existsSync(abs)) error(`Directory not found: ${lintTarget}`, EXIT.INPUT_ERROR);
    if (!fs.statSync(abs).isDirectory()) error(`Not a directory: ${lintTarget}`, EXIT.INPUT_ERROR);
    const result = runAntiMonolithicCheck(abs, { strict: args.includes('--strict') });
    const code = printAntiMonolithic(result, { json: args.includes('--json') });
    process.exit(code);
    } catch (e) { process.stderr.write('Error: ' + e.message + '\n'); process.exit(1); }
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
    if (sub === 'install') { cmdLicenseInstall(args.slice(2)); break; }
    if (sub === 'status') { cmdLicenseStatus(args.slice(2)); break; }
    if (sub === 'generate') { cmdLicenseGenerate(args.slice(2)); break; }
    error(`Usage: kdna license <install|status|generate> [...]`, EXIT.INPUT_ERROR);
  }
// eslint-disable-next-line no-fallthrough
  case 'identity': {
    const sub = args[1];
    if (sub === 'init') { cmdIdentityInit(args.slice(2)); break; }
    if (sub === 'show') { cmdIdentityShow(args.slice(2)); break; }
    error(`Usage: kdna identity <init|show>`, EXIT.INPUT_ERROR);
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
    if (sub === 'import') { cmdTestImport(args.slice(2)); break; }
    cmdTestRun(args.slice(1));
    break;
  }
  case 'badge': {
    const sub = args[1];
    if (sub === 'audit') { badge.cmdRegistryAudit(args.slice(2)); break; }
    if (sub === 'package') { badge.cmdPackage(args[2], args.slice(3)); break; }
    badge.cmdBadgeCompute(args[1], args.slice(2));
    break;
  }
  case 'domain': {
    const sub = args[1];
    if (sub === 'pack') { domain.cmdPack(args[2], args[3]); break; }
    if (sub === 'unpack') { domain.cmdUnpack(args.slice(2)); break; }
    if (sub === 'inspect') { domain.cmdInspect(args.slice(2)); break; }
    if (sub === 'validate') {
      const json = args.includes('--json');
      domain.cmdValidate(args[2], !args.includes('--no-schema'), json);
      break;
    }
    if (sub === 'card') { domain.cmdCard(args.slice(2)); break; }
    error('Usage: kdna domain <validate|pack|unpack|inspect|card> [args]');
    break;
  }
 
  case 'governance': {
    const sub = args[1];
    if (sub === 'proposal') {
      if (args[2] === 'create') { governance.cmdProposalCreate(args.slice(3)); break; }
      if (args[2] === 'validate') { governance.cmdProposalValidate(args.slice(3)); break; }
    }
    if (sub === 'review') { governance.cmdReview(args.slice(2)); break; }
    if (sub === 'lock') { governance.cmdLockCard(args.slice(2)); break; }
    if (sub === 'evolution') { governance.cmdEvolution(args.slice(2)); break; }
    if (sub === 'regression') { governance.cmdRegression(args.slice(2)); break; }
    error('Usage: kdna governance <proposal|review|lock|evolution|regression>');
    break;
  }
 
  case 'legacy': {
    const sub = args[1];
    if (sub === 'preview') { legacy.cmdPreview(); break; }
    if (sub === 'project') { legacy.cmdProject(args.slice(2)); break; }
    if (sub === 'eval') { legacy.cmdEval(args.slice(2)); break; }
    if (sub === 'select') { legacy.cmdSelect(args.slice(2)); break; }
    if (sub === 'export') { legacy.cmdExport(args.slice(2)); break; }
    if (sub === 'demo') { legacy.cmdDemo(args.slice(2)); break; }
    error('Usage: kdna legacy <preview|project|eval|select|export|demo>');
    break;
  }
 
  case 'quality': {
    const sub = args[1];
    if (sub === 'compare') { quality.cmdCompare(args.slice(2)); break; }
    if (sub === 'diff') { quality.cmdDiff(args.slice(2)); break; }
    if (sub === 'search') { quality.cmdSearch(args.slice(2)); break; }
    if (sub === 'available') { quality.cmdAvailable(args.slice(2)); break; }
    if (sub === 'match') { quality.cmdMatch(args.slice(2)); break; }
    if (sub === 'select') { quality.cmdSelect(args.slice(2)); break; }
    if (sub === 'load') { quality.cmdLoad(args.slice(2)); break; }
    if (sub === 'postvalidate') { quality.cmdPostvalidate(args.slice(2)); break; }
    error('Usage: kdna quality <compare|diff|search|available|match|select|load|postvalidate>');
    break;
  }
 
  case 'registry': {
    const sub = args[1];
    if (sub === 'refresh') { registry.cmdRegistry('refresh'); break; }
    if (sub === 'list' || sub === undefined) {
      registry.cmdList(sub === 'list', args.includes('--json'));
      break;
    }
    error('Usage: kdna registry <list|refresh> [--json]');
    break;
  }
 
  case 'setup': {
    cmdSetup();
    break;
  }
  case 'studio': {
    const sub = args[1];
    if (sub === 'scaffold') { studio.cmdStudioScaffold(args[2], args.slice(3)); break; }
    if (sub === 'cards') {
      if (args[2] === 'validate') { studio.cmdCardsValidate(args[3], args.slice(4)); break; }
    }
    if (sub === 'lock') {
      if (args[2] === 'verify') { studio.cmdLockVerify(args[3], args.slice(4)); break; }
    }
    if (sub === 'compile') { studio.cmdStudioCompile(args[2], args.slice(3)); break; }
    if (sub === 'readiness') { studio.cmdStudioReadiness(args.slice(2)); break; }
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
    // Subcommands: protect <file> --password <pw>, unlock <file> --password <pw>,
    // recover <file> --out <file> --code <code|stdin>
    const sub = args[1];
    if (sub === 'unlock') { cmdUnlock(args.slice(2)); break; }
    if (sub === 'recover') { cmdRecover(args.slice(2)); break; }
    // Default: protect itself
    cmdProtect(args.slice(1));
    break;
  }
 
  case 'available': {
    cmdAvailable(args.slice(1));
    break;
  }
 
  case 'match': {
    const taskText = args.slice(1).find((a) => !a.startsWith('--')) || '';
    cmdMatch(taskText, args.slice(1));
    break;
  }
 
  case 'install': {
    // args.slice(1) is the array of args. cmdInstallExtended takes
    // (input, args) where input is the source string and args is the
    // remaining flag array. Pass the first non-flag arg as input.
    const installArgs = args.slice(1);
    const installInput = installArgs.find((a) => !a.startsWith('--')) || '';
    cmdInstallExtended(installInput, installArgs);
    break;
  }
  case 'version': {
    console.log(require('../package.json').version);
    break;
  }
  default:
    error(`Unknown command: ${cmd}\nRun: kdna help`);
}
