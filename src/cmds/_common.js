const fs = require('fs');
const { loadRegistry: loadCanonicalRegistry } = require('../registry');
const { USER_KDNA_DIR, INSTALL_DIR } = require('../paths');

// ─── Global flags ──────────────────────────────────────────────────────

let _quiet = false;
let _exitCodeOnly = false;
const _originalLog = console.log;
const _originalError = console.error;
const _originalWarn = console.warn;

function setQuiet(val) {
  _quiet = val;
  if (val) {
    console.log = () => {};
  } else {
    console.log = _originalLog;
  }
}

function isQuiet() { return _quiet; }

function setExitCodeOnly(val) {
  _exitCodeOnly = val;
  if (val) {
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
  } else {
    console.log = _originalLog;
    console.warn = _originalWarn;
    console.error = _originalError;
  }
}

function isExitCodeOnly() { return _exitCodeOnly; }

function log(...args) {
  if (!_quiet && !_exitCodeOnly) _originalLog(...args);
}

function warn(...args) {
  if (!_exitCodeOnly) _originalWarn(...args);
}

function usage() {
  console.log(`kdna — KDNA domain cognition asset tool

Usage:

  --- Domain authors ---
  kdna init <name>              Scaffold a new KDNA domain from template
  kdna dev validate <path>      Validate a dev source directory
  kdna dev pack <path>          Build a dev source directory into .kdna
  kdna dev unpack <path>        Unpack .kdna into a dev source directory
  kdna dev inspect <path>       Inspect a dev source directory
  kdna dev card <path>          Display KDNA Card from a dev source directory
  kdna inspect <file.kdna>      Inspect a .kdna asset
  kdna publish <path>           Pack + sign a dev source directory
  kdna publish <path> --release-tag <tag> --repo <o/r>   ...also upload to GitHub
  kdna publish --check <path>   Run quality gate only (no pack/upload)
  kdna version bump <patch|minor|major> [path]   Bump domain version
  kdna cluster lint <path>      Validate a cluster manifest

  --- Domain consumers ---
  kdna install <name>           Install official domain: @aikdna/<name>
  kdna install @scope/name      Install any scoped domain
  kdna install @aikdna/animation    Install a cluster (installs all sub-domains)
  kdna install ./file.kdna      Install from a local .kdna file
  kdna remove <name>            Uninstall a domain
  kdna update <name>            Update an installed domain
  kdna update --all             Update all installed domains
  kdna info <name>              Show version, signature, governance, risks
  kdna list                     List installed domains
  kdna list --available         List available domains from registry
  kdna search <keyword>         Search registry by name/keywords/insight
  kdna registry refresh         Refresh the canonical registry cache

  --- Quality + judgment ---
  kdna verify <name|file.kdna>  Quality check: structure + trust + judgment
  kdna compare <name|file.kdna> --input "<text>"   With/without KDNA reasoning diff
  kdna diff <name>@<v1> <name>@<v2>      Judgment-level diff between versions

  --- Agent-facing (called by the kdna-loader skill) ---
  kdna available [--json]                List installed domains + v2.1 fields
  kdna match "<task>" [--json]           Hint signals (dropped + weak overlap)
  kdna load <name|file.kdna> [--as=prompt|json|raw]   Emit asset in agent-ready format

  --- Identity ---
  kdna identity init            Generate Ed25519 identity key pair
  kdna identity show            Display public key and buyer ID
  kdna identity export [--out]  Backup private key (passphrase-encrypted)
  kdna identity import <file>   Restore identity from backup

  --- Other ---
  kdna setup                    One-command setup: CLI + skill + data root
  kdna doctor [--agents] [--domains] [--json]   System health check
  kdna trace [--json] [--since 7d] [--export <file>]  Agent judgment trace
  kdna history [--stats] [--domain <name>] [--agent <name>]  Recent usage
  kdna version                  Show kdna CLI version
  kdna help                     Show this help

Examples:
  kdna install writing
  kdna verify @aikdna/writing
  kdna available
  kdna init my_domain
  kdna publish ./my_domain --release-tag v0.1.0 --repo yourname/kdna-my_domain`);
}

// Exit codes — semantic exit codes for all KDNA CLI commands
const EXIT = {
  OK: 0,
  VALIDATION_FAILED: 1,
  INPUT_ERROR: 2,
  TRUST_FAILED: 3,
  JUDGMENT_QUALITY_FAILED: 4,
  REGISTRY_ERROR: 5,
  PROVIDER_ERROR: 6,
  POLICY_VIOLATION: 7,
  HUMAN_LOCK_REQUIRED: 8,
};

function error(msg, code = EXIT.VALIDATION_FAILED) {
  if (!_exitCodeOnly) _originalError(`Error: ${msg}`);
  process.exit(code);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function selfCheckText(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.question === 'string') return item.question;
  return '';
}

function isYesNoSelfCheck(item) {
  const raw = selfCheckText(item).trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower.endsWith('?') ||
    raw.endsWith('？') ||
    raw.endsWith('吗') ||
    raw.includes('是否') ||
    /^(have|has|can|does|do|is|are|did|was|were|should|will|would|could|might|can not|cannot|能不能|会不会|有没有|要不要|是不是)/.test(lower)
  );
}

function loadRegistry() {
  return loadCanonicalRegistry({ allowNetwork: true });
}

module.exports = {
  EXIT,
  USER_KDNA_DIR,
  INSTALL_DIR,
  usage,
  error,
  log,
  warn,
  setQuiet,
  isQuiet,
  setExitCodeOnly,
  isExitCodeOnly,
  readJson,
  writeJson,
  selfCheckText,
  isYesNoSelfCheck,
  loadRegistry,
};
