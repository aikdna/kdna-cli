#!/usr/bin/env node
/**
 * kdna — The runtime control plane for domain judgment.
 *
 * KDNA CLI is the runtime control plane for loading, validating,
 * composing, testing, and governing domain judgment for AI agents.
 */

const { error, EXIT, setQuiet, setExitCodeOnly } = require('./cmds/_common');
const {
  cmdValidate,
  cmdPack,
  cmdPackEncrypt,
  cmdUnpack,
  cmdUnpackEncrypt,
  cmdInspect,
  cmdCard,
} = require('./cmds/domain');
const { cmdList, cmdRegistry } = require('./cmds/registry');
const {
  cmdCompare,
  cmdDiff,
  cmdSearch,
  cmdAvailable,
  cmdMatch,
  cmdSelect,
  cmdLoad,
  cmdPostvalidate,
  cmdRoute,
} = require('./cmds/quality');
const { cmdCluster } = require('./cmds/cluster');
const { cmdIdentity } = require('./cmds/identity');
const { cmdSetup } = require('./cmds/setup');
const { cmdDoctor } = require('./cmds/doctor');
const { cmdTrace, cmdHistory } = require('./cmds/trace');
const {
  cmdLicenseGenerate,
  cmdLicenseVerify,
  cmdLicenseBind,
  cmdLicenseShow,
  cmdLicenseInstall,
} = require('./cmds/license');
const { cmdPreview, cmdProject, cmdEval, cmdExport, cmdDemo } = require('./cmds/legacy');
const {
  cmdStudioScaffold,
  cmdCardsValidate,
  cmdLockVerify,
  cmdStudioCompile,
  cmdStudioReadiness,
} = require('./cmds/studio');
const { cmdTestRun, cmdTestImport } = require('./cmds/test');
const { cmdChangelog } = require('./cmds/changelog');
const {
  cmdProposalCreate,
  cmdProposalValidate,
  cmdReview,
  cmdLockCard,
  cmdEvolution,
  cmdRegression,
} = require('./cmds/governance');
const { cmdBadgeCompute, cmdRegistryAudit, cmdPackage } = require('./cmds/badge');

// ─── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (!args.length || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
  showHelp();
  process.exit(0);
}

// Global flags
if (args.includes('--quiet')) setQuiet(true);
if (args.includes('--exit-code')) setExitCodeOnly(true);

function showHelp() {
  const v = require('../package.json').version;
  console.log(`kdna v${v} — The runtime control plane for domain judgment

Usage: kdna <command> [options]

Domain Authoring:
  init <name>                      Scaffold a new domain from template
  validate <path>                  Validate domain structure
  validate --schema <path>         Schema-only validation
  pack <path>                      Pack into .kdna container
  pack <path> --encrypt --license <file>   Pack encrypted .kdnae container
  unpack <file>                    Unpack .kdna container
  unpack <file> --license <file>   Unpack encrypted .kdnae container
  inspect <path>                   Inspect domain or .kdna file
  inspect <path> --locale zh-CN     Inspect with localized governance data
  card <path> [--locale zh-CN]      Display KDNA Card (governance metadata)
  publish <path>                   Pack + sign + publish
  publish --check <path>           Quality gate check only
  version bump <level> [path]      Bump domain version
  version bump --suggest [path]     Suggest version bump level

Studio Integration (Phase 1):
  studio scaffold <name>           Create Studio project + card templates
  cards validate <project.json>    Validate Judgment Cards structure
  lock verify <project.json>       Verify Human Lock status
  studio compile <project.json>    Compile locked cards into KDNA domain
  studio readiness <project.json>  Generate domain readiness card

Agent Runtime:
  route "<task>" [--json] [--discover]  5-Gate 7-State routing decision
  available [--json]               List installed domains with v2.1 fields
  match "<task>" [--json]          Signal matching — find relevant domains
  select --input "..." [--json]    Selection policy — decide which domains to load
  load <name> [--as=prompt|json|raw]  Emit domain in agent-ready format
  load <name> --profile=index|compact|scenario|full  Load profiles (Phase 2)
  postvalidate <name> --output <file>  Post-generation judgment check

Testing & Verification:
  verify <name>                    3-layer: structure + trust + judgment
  verify <name> --i18n               I18N verification: locales, overlays, card completeness
  verify <name> --governance         Governance verification: risk_level, KDNA_CARD, provenance
  verify <name> --judgment --run-tests  Judgment validation with eval cases
  compare <name> --input "..."     With/without KDNA reasoning diff
  compare <name> --input "..." --report-md     Markdown report format
  compare <name> --input "..." --report-json   JSON report with scoring
  diff <name>@<v1> <name>@<v2>     Judgment-level diff between versions
  test run <name> --input <file>   Record test result against domain
  test import <run> --as-eval      Convert test result to eval card
  changelog <name> --from --to     Generate judgment changelog

Cluster Composition:
  cluster lint <path>              Validate cluster manifest
  cluster match <path> --input ".." Match input to cluster domains
  cluster compose <path> --input   Compose context with source attribution
  cluster conflicts <path> --input Detect inter-domain conflicts
  cluster graph <path>             Output domain relationship graph (DOT/JSON)

Governance & Release (Phase 6):
  proposal create --from-test <run> --domain <path>  Create improvement proposal
  proposal validate <proposal.json>   Validate proposal structure
  review accept <proposal> --by --reason   Accept improvement proposal
  review reject <proposal> --by --reason   Reject improvement proposal
  lock card <id> --by --reason        Record human lock on a card
  evolution add-proposal <file>        Add proposal to evolution record
  evolution add-lock <file>            Add lock to evolution record
  evolution report <domain>            Show domain evolution history
  regression <old> <new> --evals <dir>  Detect judgment regression

Quality & Distribution (Phase 7):
  badge compute <domain>              Compute quality badge (draft/tested/trusted)
  registry audit --scope <@scope>     Audit registry scope health
  package <domain> --format=kdna      Package domain as distributable asset

Registry & Distribution:
  install <name>                   Install domain from registry
  remove <name>                    Uninstall a domain
  update <name>                    Update installed domain
  info <name>                      Show domain metadata and trust status
  list [--available]               List installed or available domains
  search <keyword>                 Search registry
  registry refresh                 Refresh registry cache

Identity & Signing:
  identity init                    Generate Ed25519 signing key
  identity show                    Display public key and buyer ID
  identity export [--out]          Backup private key (encrypted)
  identity import <file>           Restore identity from backup

Setup:
  setup                            One-command setup: CLI + skill + data root

Trace & Diagnostics:
  doctor [--agents] [--domains] [--json]   System health check
  trace [--json] [--since 7d] [--export <file>]  Agent judgment trace
  history [--stats] [--domain <name>] [--agent <name>]  Recent usage

License & Authorization:
  license generate <domain> --to <email>   Generate signed license
  license install <license.json>           Register license for auto-decrypt
  license verify <license.json>            Verify license signature
  license bind <license.json>              Bind license to this machine
  license show <license.json>              Display license details

Flags:
  --json                           Structured JSON output (machine-readable)
  --quiet                          Suppress non-error output

Exit Codes:
  0 OK  1 VALIDATION_FAILED  2 INPUT_ERROR  3 TRUST_FAILED
  4 JUDGMENT_QUALITY_FAILED  5 REGISTRY_ERROR  6 PROVIDER_ERROR
  7 POLICY_VIOLATION  8 HUMAN_LOCK_REQUIRED
`);
}

const cmd = args[0];

switch (cmd) {
  case 'validate': {
    const schemaFlag = args.includes('--schema');
    const jsonFlag = args.includes('--json');
    const target = args.filter((a, i) => i > 0 && a !== '--schema' && a !== '--json')[0];
    if (!target) error('Usage: kdna validate <path>');
    cmdValidate(target, schemaFlag, jsonFlag);
    break;
  }
  case 'pack': {
    let output = null;
    let target = null;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--output' || args[i] === '-o') {
        output = args[i + 1];
        i++;
      } else if (!target) {
        target = args[i];
      }
    }
    if (!target) error('Usage: kdna pack <path>');
    if (args.includes('--encrypt')) {
      cmdPackEncrypt(target, args);
    } else {
      cmdPack(target, output);
    }
    break;
  }
  case 'unpack': {
    const target = args[1];
    if (!target) error('Usage: kdna unpack <file.kdna|file.kdnae>');
    if (target.endsWith('.kdnae')) {
      cmdUnpackEncrypt(target, args);
    } else {
      cmdUnpack(target, args.includes('--force'));
    }
    break;
  }
  case 'preview': {
    cmdPreview();
    break;
  }
  case 'install': {
    let domainId = null;
    let fromGit = null;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--from-git') {
        fromGit = args[i + 1];
        i++;
      } else if (!domainId) {
        domainId = args[i];
      }
    }
    if (!domainId) error('Usage: kdna install <domain-id|github:user/repo|./folder>');

    const { cmdInstallExtended } = require('./install');
    if (fromGit) {
      // Legacy --from-git: treat as github: URL
      const url = fromGit.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
      cmdInstallExtended(`github:${url}`, args);
    } else {
      cmdInstallExtended(domainId, args);
    }
    break;
  }
  case 'registry': {
    cmdRegistry(args[1]);
    break;
  }
  case 'remove': {
    const { cmdRemove } = require('./install');
    const target = args[1];
    if (!target) error('Usage: kdna remove <domain>');
    cmdRemove(target);
    break;
  }
  case 'info': {
    const { cmdInfo } = require('./install');
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target) error('Usage: kdna info <domain>');
    cmdInfo(target, args.includes('--json'));
    break;
  }
  case 'update': {
    const { cmdUpdate, cmdUpdateAll } = require('./install');
    if (args.includes('--all')) {
      cmdUpdateAll();
    } else {
      const target = args[1];
      if (!target) error('Usage: kdna update <domain>');
      cmdUpdate(target);
    }
    break;
  }
  case 'inspect': {
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target) error('Usage: kdna inspect <path> [--json] [--locale zh-CN]');
    const localeIdx = args.indexOf('--locale');
    const locale = localeIdx >= 0 ? args[localeIdx + 1] : null;
    cmdInspect(target, args.includes('--json'), locale);
    break;
  }
  case 'card': {
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target) error('Usage: kdna card <path> [--json] [--locale zh-CN]');
    const localeIdx = args.indexOf('--locale');
    const locale = localeIdx >= 0 ? args[localeIdx + 1] : null;
    cmdCard(target, args.includes('--json'), locale);
    break;
  }
  case 'verify': {
    const { cmdVerify } = require('./verify');
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target) {
      error(
        'Usage:\n' +
          '  kdna verify <name>             Run all three layers (structure / trust / judgment)\n' +
          '  kdna verify <name> --structure  Files + schema only\n' +
          '  kdna verify <name> --trust      Signature + scope + Ed25519 only\n' +
          '  kdna verify <name> --judgment   v2.1 governance fields + eval cases only',
      );
    }
    cmdVerify(target, args);
    break;
  }
  case 'compare': {
    cmdCompare(args);
    break;
  }
  case 'diff': {
    cmdDiff(args);
    break;
  }
  case 'search': {
    cmdSearch(args);
    break;
  }
  case 'available': {
    cmdAvailable(args);
    break;
  }
  case 'match': {
    cmdMatch(args);
    break;
  }
  case 'load': {
    cmdLoad(args);
    break;
  }
  case 'select': {
    cmdSelect(args);
    break;
  }
  case 'route': {
    cmdRoute(args);
    break;
  }
  case 'postvalidate': {
    cmdPostvalidate(args);
    break;
  }
  case 'test': {
    const sub = args[1];
    if (sub === 'run') {
      cmdTestRun(['test', ...args.slice(2)]);
    } else if (sub === 'import') {
      cmdTestImport(['test', ...args.slice(2)]);
    } else {
      error(
        'Usage:\n' +
          '  kdna test run <domain> --input <file> [--save <dir>]\n' +
          '  kdna test import <run-file> --as-eval --out <file>',
        EXIT.INPUT_ERROR,
      );
    }
    break;
  }
  case 'changelog': {
    cmdChangelog(args);
    break;
  }
  case 'proposal': {
    const sub = args[1];
    if (sub === 'create') {
      cmdProposalCreate(args);
    } else if (sub === 'validate') {
      cmdProposalValidate(args);
    } else {
      error(
        'Usage: kdna proposal create --from-test <run.json> --domain <path>\n       kdna proposal validate <proposal.json>',
        EXIT.INPUT_ERROR,
      );
    }
    break;
  }
  case 'review': {
    cmdReview(args);
    break;
  }
  case 'lock': {
    const sub = args[1];
    if (sub === 'verify') {
      const target = args.filter((a) => !a.startsWith('--'))[2];
      if (!target) error('Usage: kdna lock verify <studio.project.json>');
      cmdLockVerify(target, args);
    } else if (sub === 'card') {
      cmdLockCard(args);
    } else {
      error(
        'Usage:\n' +
          '  kdna lock verify <studio.project.json>     Verify human lock status\n' +
          '  kdna lock card <card-id> --by <name> --reason "..."   Lock a judgment card',
        EXIT.INPUT_ERROR,
      );
    }
    break;
  }
  case 'evolution': {
    cmdEvolution(args);
    break;
  }
  case 'regression': {
    cmdRegression(args);
    break;
  }
  case 'badge': {
    const sub = args[1];
    if (sub === 'compute') {
      const target = args.filter((a) => !a.startsWith('--'))[2];
      if (!target) error('Usage: kdna badge compute <domain>');
      cmdBadgeCompute(target, args);
    } else {
      error('Usage: kdna badge compute <domain>', EXIT.INPUT_ERROR);
    }
    break;
  }
  case 'audit': {
    cmdRegistryAudit(args);
    break;
  }
  case 'package': {
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target) error('Usage: kdna package <domain> --format=kdna');
    cmdPackage(target, args);
    break;
  }
  // Legacy (removed) commands
  case 'project': {
    cmdProject();
    break;
  }
  case 'eval': {
    cmdEval();
    break;
  }
  case 'export': {
    cmdExport();
    break;
  }
  case 'demo': {
    cmdDemo();
    break;
  }
  case 'list': {
    const localeIdx = args.indexOf('--locale');
    const locale = localeIdx >= 0 ? args[localeIdx + 1] : null;
    cmdList(args.includes('--available'), args.includes('--json'), locale);
    break;
  }
  case 'setup': {
    cmdSetup();
    break;
  }
  case 'cluster': {
    cmdCluster(args);
    break;
  }
  case 'doctor': {
    cmdDoctor(args);
    break;
  }
  case 'trace': {
    cmdTrace(args);
    break;
  }
  case 'history': {
    cmdHistory(args);
    break;
  }
  case 'license': {
    const sub = args[1];
    const rest = args.slice(2);
    if (sub === 'generate') {
      cmdLicenseGenerate(rest);
    } else if (sub === 'verify') {
      cmdLicenseVerify(rest);
    } else if (sub === 'bind') {
      cmdLicenseBind(rest);
    } else if (sub === 'show') {
      cmdLicenseShow(rest);
    } else if (sub === 'install') {
      cmdLicenseInstall(rest);
    } else {
      error(
        'Usage:\n' +
          '  kdna license generate <domain> --to <email> [--expires <date>]\n' +
          '  kdna license install <license.json>\n' +
          '  kdna license verify <license.json>\n' +
          '  kdna license bind <license.json>\n' +
          '  kdna license show <license.json>',
        EXIT.INPUT_ERROR,
      );
    }
    break;
  }
  case 'identity': {
    cmdIdentity(args);
    break;
  }
  case 'init': {
    const { cmdInit } = require('./init');
    cmdInit(args[1]);
    break;
  }
  case 'publish': {
    if (args.includes('--check')) {
      const { cmdPublishCheck } = require('./publish');
      const idx = args.indexOf('--check');
      const target = args[idx + 1] || args.filter((a) => !a.startsWith('--'))[1] || '.';
      if (!target || target.startsWith('--')) error('Usage: kdna publish --check <path>');
      cmdPublishCheck(target, args);
    } else {
      const { cmdPublish } = require('./publish');
      const target = args.filter((a) => !a.startsWith('--'))[1];
      if (!target) {
        error(
          'Usage:\n' +
            '  kdna publish <path>                      Pack + sign, output patch JSON\n' +
            '  kdna publish <path> --release-tag <tag> --repo <owner/name>\n' +
            '                                           ...also upload to GitHub Release\n' +
            '  kdna publish --check <path>              Quality gate only',
        );
      }
      cmdPublish(target, args);
    }
    break;
  }
  case 'version': {
    const { cmdVersionBump, cmdVersionSuggest } = require('./version');
    const sub = args[1];
    if (sub === 'bump') {
      if (args.includes('--suggest')) {
        const target = args.filter((a) => !a.startsWith('--'))[3] || '.';
        cmdVersionSuggest(target, args);
      } else {
        const level = args[2];
        const target = args[3] || '.';
        if (!level || !['patch', 'minor', 'major'].includes(level)) {
          error('Usage: kdna version bump <patch|minor|major> [path]');
        }
        cmdVersionBump(level, target);
      }
    } else {
      console.log(`kdna v${require('../package.json').version}`);
      console.log('');
      console.log('Usage: kdna version bump <patch|minor|major> [path]');
      console.log('       kdna version bump --suggest [path]');
    }
    break;
  }
  case 'cards': {
    const sub = args[1];
    if (sub === 'validate') {
      const target = args.filter((a) => !a.startsWith('--'))[2];
      if (!target) error('Usage: kdna cards validate <studio.project.json>');
      cmdCardsValidate(target, args);
    } else {
      error('Usage: kdna cards validate <studio.project.json>', EXIT.INPUT_ERROR);
    }
    break;
  }
  case 'studio': {
    const sub = args[1];
    if (sub === 'scaffold') {
      const target = args.filter((a) => !a.startsWith('--'))[2];
      if (!target) error('Usage: kdna studio scaffold <name> [--type=cluster] [--minimal]');
      cmdStudioScaffold(target, args);
    } else if (sub === 'compile') {
      const target = args.filter((a) => !a.startsWith('--'))[2];
      if (!target) error('Usage: kdna studio compile <studio.project.json> [--out <dir>]');
      cmdStudioCompile(target, args);
    } else if (sub === 'readiness') {
      const target = args.filter((a) => !a.startsWith('--'))[2];
      if (!target) error('Usage: kdna studio readiness <studio.project.json>');
      cmdStudioReadiness(target, args);
    } else {
      error(
        'Usage:\n' +
          '  kdna studio scaffold <name> [--type=cluster] [--minimal]\n' +
          '  kdna studio compile <studio.project.json> [--out <dir>]\n' +
          '  kdna studio readiness <studio.project.json>',
        EXIT.INPUT_ERROR,
      );
    }
    break;
  }
  default:
    error(`Unknown command: ${cmd}\nRun: kdna help`);
}
