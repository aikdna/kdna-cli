#!/usr/bin/env node
/**
 * kdna — The runtime control plane for domain judgment.
 *
 * KDNA CLI is the runtime control plane for loading, validating,
 * composing, testing, and governing domain judgment for AI agents.
 */

const { error, EXIT, setQuiet, setExitCodeOnly } = require('./cmds/_common');
const { cmdValidate, cmdPack, cmdUnpack, cmdInspect, cmdCard } = require('./cmds/domain');
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
  cmdLicenseStatus,
  cmdLicenseActivate,
  cmdLicenseSync,
} = require('./cmds/license');
const { cmdProtect, cmdUnlock, cmdRecover } = require('./cmds/protect');
const { cmdPreview, cmdProject, cmdEval, cmdExport, cmdDemo } = require('./cmds/legacy');
const { cmdDemo: cmdDemoMinimal } = require('./cmds/demo');
const { cmdCardsValidate, cmdLockVerify } = require('./cmds/studio');
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
const { cmdBadgeCompute, cmdRegistryAudit } = require('./cmds/badge');
const { cmdExplain } = require('./cmds/explain');
const { cmdWorkpack } = require('./cmds/workpack');
const { cmdProtocol } = require('./cmds/protocol');

// ─── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help' || args[0] === '-h') {
  showHelp();
  process.exit(0);
}
if (args[0] === 'help') {
  const sub = args[1];
  if (sub === 'advanced' || sub === 'legacy') {
    sub === 'advanced' ? showHelpAdvanced() : showHelpLegacy();
  } else {
    showHelp();
  }
  process.exit(0);
}

// Global flags
if (args.includes('--quiet')) setQuiet(true);
if (args.includes('--exit-code')) setExitCodeOnly(true);

function showHelp() {
  const v = require('../package.json').version;
  console.log(`kdna v${v} — Runtime control plane for KDNA Core v1

Start here:
  kdna demo minimal <dir>           Create a minimal KDNA Core v1 demo

Core v1:
  inspect  <path>                   Inspect v1 source dir or .kdna container
  validate <path>                   Validate v1 source dir or .kdna container
  pack     <src> <out>              Deterministic pack into .kdna container
  unpack   <in>  <out>              Extract .kdna container

More:
  kdna help advanced                Agent runtime, setup, loading, comparison
  kdna help legacy                  Pre-v1 compatibility commands

Flags:
  --json                            Structured JSON output
  --quiet                           Suppress non-error output
`);
}

function showHelpAdvanced() {
  const v = require('../package.json').version;
  console.log(`kdna v${v} — Advanced commands

Core v1:
  inspect  <path>                   Inspect v1 source dir or .kdna container
  validate <path>                   Validate v1 source dir or .kdna container
  pack     <src> <out>              Deterministic pack into .kdna container
  unpack   <in>  <out>              Extract .kdna container
  demo     minimal <dir> [--force]  Create a minimal v1 fixture

Setup:
  setup                             One-command setup: CLI + skill + data root
  doctor [--agents] [--domains] [--json]  System health check

Agent Runtime:
  load   <name|file> [--as=prompt|json|raw]  Emit asset in agent-ready form
  load   <name|file> --profile=index|compact|scenario|full  Load profiles
  verify <name|file> [--structure|--trust|--judgment]  3-layer verification
  compare <name|file> --input "..."       With/without KDNA reasoning diff

Authoring (beta):
  Studio authoring: npm install -g @aikdna/kdna-studio-cli

Flags:
  --json                            Structured JSON output
  --quiet                           Suppress non-error output

More:
  kdna help legacy                  Legacy / experimental commands
`);
}

function showHelpLegacy() {
  const v = require('../package').version;
  console.log(`kdna v${v} — Legacy / experimental commands

Not part of the current KDNA Core v1 first-run path. Preserved for
backward compatibility. These commands may change or be removed.

Registry (legacy — kdna-registry is a legacy experiment):
  install <name>                    Install domain from legacy registry
  remove <name>                     Uninstall a domain
  update <name>                     Update installed domain
  info <name>                       Show domain metadata
  list [--available]                List installed or available domains
  search <keyword>                  Search legacy registry
  registry refresh                  Refresh legacy registry cache

Legacy dev source utilities:
  dev validate <path>               Validate a dev source directory
  dev pack <path>                   Build a dev-only .kdna bundle
  dev unpack <file>                 Unpack .kdna into a dev source directory
  dev inspect <path>                Inspect a dev source directory

Legacy operations:
  badge compute <domain>            Compute quality badge (pre-v1)
  registry audit --scope <@scope>   Audit registry scope health
  license <subcommand> ...          License management
  protect / unlock / recover        Protected assets (RFC-0009)
  publish <file.kdna>               Publish to legacy registry
  identity <subcommand> ...         Ed25519 signing key management
  cluster <subcommand> ...          Cluster composition
  workpack <subcommand> ...         Work Pack (experimental)
  governance / proposal / review / evolution / regression
  trace / history / route / match / select / postvalidate
  test run / test import / changelog / diff / compare
  explain / card / version bump

Flags:
  --json                            Structured JSON output
  --quiet                           Suppress non-error output
`);
}
const cmd = args[0];

switch (cmd) {
  case 'dev': {
    const sub = args[1];
    if (sub === 'validate') {
      const schemaFlag = args.includes('--schema');
      const jsonFlag = args.includes('--json');
      const antiMonolithicFlag = args.includes('--anti-monolithic');
      const strictFlag = args.includes('--strict');
      const target = args.filter(
        (a, i) =>
          i > 1 &&
          a !== '--schema' &&
          a !== '--json' &&
          a !== '--anti-monolithic' &&
          a !== '--strict',
      )[0];
      if (!target)
        error(
          'Usage: kdna dev validate <source-dir> [--schema] [--json] [--anti-monolithic] [--strict]',
        );
      if (antiMonolithicFlag) {
        const { cmdValidateAntiMonolithic } = require('./cmds/domain');
        cmdValidateAntiMonolithic(target, { json: jsonFlag, strict: strictFlag });
      } else {
        cmdValidate(target, schemaFlag, jsonFlag);
      }
      break;
    }
    if (sub === 'pack') {
      let output = null;
      let target = null;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--output' || args[i] === '--out' || args[i] === '-o') {
          output = args[i + 1];
          i++;
        } else if (args[i].startsWith('-')) {
          error(`Unknown option for kdna dev pack: ${args[i]}`, EXIT.INPUT_ERROR);
        } else if (!target) {
          target = args[i];
        }
      }
      if (!target) error('Usage: kdna dev pack <source-dir>');
      cmdPack(target, output);
      break;
    }
    if (sub === 'scaffold') {
      const { cmdInit } = require('./init');
      cmdInit(args[2], { devScaffold: true });
      break;
    }
    if (sub === 'unpack') {
      const target = args[2];
      if (!target) error('Usage: kdna dev unpack <file.kdna>');
      if (!target.endsWith('.kdna')) error('Not a .kdna asset.', EXIT.INPUT_ERROR);
      cmdUnpack(target, args.includes('--force'));
      break;
    }
    if (sub === 'inspect') {
      const target = args.filter((a, i) => i > 1 && !a.startsWith('--'))[0];
      if (!target) error('Usage: kdna dev inspect <source-dir> [--json] [--locale zh-CN]');
      const localeIdx = args.indexOf('--locale');
      const locale = localeIdx >= 0 ? args[localeIdx + 1] : null;
      cmdInspect(target, args.includes('--json'), locale, { allowDirectory: true });
      break;
    }
    if (sub === 'card') {
      const target = args.filter((a, i) => i > 1 && !a.startsWith('--'))[0];
      if (!target) error('Usage: kdna dev card <source-dir> [--json] [--locale zh-CN]');
      const localeIdx = args.indexOf('--locale');
      const locale = localeIdx >= 0 ? args[localeIdx + 1] : null;
      cmdCard(target, args.includes('--json'), locale, { allowDirectory: true });
      break;
    }
    error('Usage: kdna dev <validate|pack|unpack|inspect|card> ...', EXIT.INPUT_ERROR);
    break;
  }
  case 'validate': {
    const v1Target = args.filter((a) => !a.startsWith('--'))[1];
    if (v1Target) {
      const v1 = require('./v1-cli');
      const abs = require('node:path').resolve(v1Target);
      if (v1.isV1SourceDir(abs) || v1.detectContainerFormat(abs) === 'v1') {
        const result = v1.validate(v1Target);
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.overall_valid ? 0 : 1);
      }
    }
    error(
      'Directory validation is a dev-only operation. Use: kdna dev validate <source-dir>',
      EXIT.INPUT_ERROR,
    );
    break;
  }
  case 'pack': {
    const v1Target = args.filter((a) => !a.startsWith('--'))[1];
    if (v1Target) {
      const v1 = require('./v1-cli');
      const abs = require('node:path').resolve(v1Target);
      if (v1.isV1SourceDir(abs)) {
        const out = args.filter((a) => !a.startsWith('--'))[2];
        if (!out) {
          process.stderr.write('Usage: kdna pack <source-dir> <output.kdna>\n');
          process.exit(2);
        }
        const r = v1.pack(v1Target, out);
        process.stdout.write(
          `Packed: ${r.outputPath}\nEntries: ${r.entries.length} (${r.entries.join(', ')})\n`,
        );
        return;
      }
    }
    error(
      'Directory packaging is a dev-only operation. Use: kdna dev pack <source-dir>',
      EXIT.INPUT_ERROR,
    );
    break;
  }
  case 'unpack': {
    const v1Target = args.filter((a) => !a.startsWith('--'))[1];
    if (v1Target) {
      const v1 = require('./v1-cli');
      const abs = require('node:path').resolve(v1Target);
      if (v1.detectContainerFormat(abs) === 'v1') {
        const out = args.filter((a) => !a.startsWith('--'))[2];
        if (!out) {
          process.stderr.write('Usage: kdna unpack <input.kdna> <output-dir>\n');
          process.exit(2);
        }
        const r = v1.unpack(v1Target, out);
        process.stdout.write(
          `Unpacked: ${r.outputDir}\nEntries: ${r.entries.length} (${r.entries.join(', ')})\n`,
        );
        return;
      }
    }
    error(
      'Unpacking exposes internal files and is dev-only. Use: kdna dev unpack <file.kdna>',
      EXIT.INPUT_ERROR,
    );
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
    if (!domainId) error('Usage: kdna install <domain-id|file.kdna> [--trusted]');

    const { cmdInstallExtended } = require('./install');
    if (fromGit) {
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
    const v1 = require('./v1-cli');
    const abs = require('node:path').resolve(target);
    if (v1.isV1SourceDir(abs) || v1.detectContainerFormat(abs) === 'v1') {
      const out = v1.inspect(target);
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    const localeIdx = args.indexOf('--locale');
    const locale = localeIdx >= 0 ? args[localeIdx + 1] : null;
    cmdInspect(target, args.includes('--json'), locale);
    break;
  }
  case 'card': {
    const target = args.filter((a) => !a.startsWith('--'))[1];
    if (!target) error('Usage: kdna card <file.kdna> [--json] [--locale zh-CN]');
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
          '  kdna verify <name|file.kdna>             Run all three layers (structure / trust / judgment)\n' +
          '  kdna verify <name|file.kdna> --structure  Files + schema only\n' +
          '  kdna verify <name|file.kdna> --trust      Signature + scope + Ed25519 only\n' +
          '  kdna verify <name|file.kdna> --judgment   v2.1 governance fields + eval cases only',
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
    error(
      'Directory packaging is a dev-only operation. Use: kdna dev pack <source-dir>',
      EXIT.INPUT_ERROR,
    );
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
    if (args[1] === 'minimal') {
      cmdDemoMinimal(args.slice(1));
    } else {
      cmdDemo();
    }
    break;
  }
  case 'explain': {
    cmdExplain(args);
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
  case 'workpack': {
    cmdWorkpack(args);
    break;
  }
  case 'protocol': {
    cmdProtocol(args);
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
    } else if (sub === 'status') {
      cmdLicenseStatus(rest);
    } else if (sub === 'activate') {
      cmdLicenseActivate(rest).catch((e) => error(e.message, EXIT.TRUST_FAILED));
    } else if (sub === 'sync') {
      cmdLicenseSync(rest).catch((e) => error(e.message, EXIT.TRUST_FAILED));
    } else {
      error(
        'Usage:\n' +
          '  kdna license generate <domain> --to <email> [--expires <date>]\n' +
          '  kdna license install <license.json>\n' +
          '  kdna license activate <domain> --key <license-key> --server <url>\n' +
          '  kdna license sync [domain] [--server <url>]\n' +
          '  kdna license verify <license.json>\n' +
          '  kdna license bind <license.json>\n' +
          '  kdna license show <license.json>\n' +
          '  kdna license status [domain] [--json]',
        EXIT.INPUT_ERROR,
      );
    }
    break;
  }
  case 'protect': {
    const rest = args.slice(1);
    cmdProtect(rest);
    break;
  }
  case 'unlock': {
    const rest = args.slice(1);
    cmdUnlock(rest);
    break;
  }
  case 'recover': {
    const rest = args.slice(1);
    cmdRecover(rest);
    break;
  }
  case 'identity': {
    cmdIdentity(args);
    break;
  }
  case 'init': {
    const { cmdInit } = require('./init');
    cmdInit(args[1], { deprecatedAlias: true });
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
            '  kdna publish <file.kdna>                 Publish existing asset, output patch JSON\n' +
            '  kdna publish <file.kdna> --release-tag <tag> --repo <owner/name>\n' +
            '                                           ...also upload to GitHub Release\n' +
            '  kdna publish --check <path>              Dev source readiness check only',
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
    error(
      'kdna studio has been removed from the runtime CLI.\n' +
        'Trusted KDNA authoring belongs to the standalone Studio CLI:\n' +
        '  npm install -g @aikdna/kdna-studio-cli\n' +
        '  kdna-studio create <project>\n' +
        '  kdna-studio export <project> --out <file.kdna> --sign',
      EXIT.INPUT_ERROR,
    );
    break;
  }
  default:
    error(`Unknown command: ${cmd}\nRun: kdna help`);
}
