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

// Strip stack traces from uncaught errors for clean user output
process.on('uncaughtException', (err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});

const V2_UNSUPPORTED_MSG =
  'Unsupported legacy/registry container. KDNA v1 Core CLI supports local v1 packaged .kdna assets. Re-export with kdna-studio-cli@0.6.0 or create with kdna demo/pack.';

// ─── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
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
  plan-load <file.kdna>              Return a LoadPlan before runtime load
  load      <file.kdna>              Render agent-ready judgment context
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
  history  [--stats] [--json]        KDNA load history
  cluster  <path>                    Validate a cluster manifest
  protect  <file> --password <pw>    Encrypt a .kdna asset with a password
  protect  unlock <file> --password  Decrypt and re-pack an encrypted .kdna
  protect  recover <file> --code <rc> Recover a .kdna using a recovery code
  available                            List available installed domains
  match     "<task>"                  Find the best-matching domain for a task
  install   <name|@scope/name|file>   Install a .kdna asset from local/registry
Flags: --version / --help / --json / --quiet
`);
}

const cmd = args[0];

switch (cmd) {
 
  case 'validate': {
    try {
    const v1Target = args.filter((a) => !a.startsWith('--'))[1];
    if (!v1Target) error('Usage: kdna validate <file.kdna> [--runtime] [--entitlement-status <status>]', EXIT.INPUT_ERROR);
    const {
      isV1SourceDir,
      detectContainerFormat,
      validate,
    } = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(v1Target);
    if (!fs.existsSync(abs)) error(`File not found: ${v1Target}`, EXIT.INPUT_ERROR);
    const containerFmt = detectContainerFormat(abs);
    if (containerFmt === 'v2') error(V2_UNSUPPORTED_MSG, EXIT.INPUT_ERROR);
    if (!isV1SourceDir(abs) && containerFmt !== 'v1') {
      error(`Not a KDNA v1 container: ${v1Target}`, EXIT.INPUT_ERROR);
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
        'Usage: kdna plan-load <path> [--json] [--has-password] [--entitlement-status <status>]',
        EXIT.INPUT_ERROR,
      );
    const core = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(v1Target);
    const containerFmt = core.detectContainerFormat(abs);
    if (containerFmt === 'v2') error(V2_UNSUPPORTED_MSG, EXIT.INPUT_ERROR);
    if (!(core.isV1SourceDir(abs) || containerFmt === 'v1')) {
      error('plan-load requires a KDNA Core v1 source dir or .kdna container', EXIT.INPUT_ERROR);
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
    const plan = core.planLoad(v1Target, {
      hasPassword: args.includes('--has-password'),
      entitlement: entitlementStatus ? { status: entitlementStatus } : undefined,
    });
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
    if (containerFmt === 'v2') error(V2_UNSUPPORTED_MSG, EXIT.INPUT_ERROR);
    if (containerFmt !== 'v1') error(`Not a KDNA v1 container: ${v1Target}`, EXIT.INPUT_ERROR);
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
      detectContainerFormat,
      inspect,
    } = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(target);
    if (!fs.existsSync(abs)) error(`File not found: ${target}`, EXIT.INPUT_ERROR);
    const containerFmt = detectContainerFormat(abs);
    if (containerFmt === 'v2') error(V2_UNSUPPORTED_MSG, EXIT.INPUT_ERROR);
    if (!isV1SourceDir(abs) && containerFmt !== 'v1') {
      error(`Not a KDNA v1 container: ${target}`, EXIT.INPUT_ERROR);
    }
    const out = inspect(target);
    console.log(JSON.stringify(out, null, 2));
    return;
    } catch (e) { process.stderr.write('Error: ' + e.message + '\n'); process.exit(1); }
  }
// eslint-disable-next-line no-fallthrough
  case 'load': {
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target) error('Usage: kdna load <file.kdna> [--profile=<index|compact|scenario|full>] [--as=<json|prompt>] [--password=<value>]', EXIT.INPUT_ERROR);
    const core = require('@aikdna/kdna-core');
    const abs = require('node:path').resolve(target);
    if (!fs.existsSync(abs)) error(`File not found: ${target}`, EXIT.INPUT_ERROR);
    const getFlag = (name) => {
      const eq = args.find((a) => a.startsWith(name + '='));
      if (eq) return eq.split('=')[1];
      const idx = args.indexOf(name);
      return idx >= 0 ? args[idx + 1] : null;
    };
    const profile = getFlag('--profile') || 'compact';
    const as = getFlag('--as') || 'json';
    const passwordRaw = getFlag('--password');
    const password = typeof passwordRaw === 'string' && passwordRaw.length > 0 ? passwordRaw : undefined;
    if (args.includes('--has-password')) {
      process.stderr.write('Warning: --has-password is a plan-load diagnostic. Use --password=<value> for actual decryption.\n');
    }
    try {
      const entitlementStatusIndex = args.indexOf('--entitlement-status');
      const entitlementStatus = entitlementStatusIndex >= 0 ? args[entitlementStatusIndex + 1] : null;
      const r = core.loadAuthorized(target, {
        profile,
        as,
        password,
        hasPassword: !!password || args.includes('--has-password'),
        entitlement: entitlementStatus ? { status: entitlementStatus } : undefined,
      });
      if (as === 'prompt') {
        process.stdout.write(r.text + '\n');
      } else {
        console.log(JSON.stringify(r, null, 2));
      }
      return;
    } catch (e) {
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
  default:
    error(`Unknown command: ${cmd}\nRun: kdna help`);
}
