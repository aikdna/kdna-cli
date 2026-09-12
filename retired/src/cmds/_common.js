const fs = require('fs');
const { loadRegistry: loadCanonicalRegistry } = require('../registry');
const { USER_KDNA_DIR, INSTALL_DIR } = require('../paths');
const {
  MAX_SECRET_BYTES,
  SecretInputError,
  decodeSecretBytes,
  readSecretStdin,
} = require('../secret-input');

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

function isQuiet() {
  return _quiet;
}

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

function isExitCodeOnly() {
  return _exitCodeOnly;
}

function log(...args) {
  if (!_quiet && !_exitCodeOnly) _originalLog(...args);
}

function warn(...args) {
  if (!_exitCodeOnly) _originalWarn(...args);
}

function usage() {
  console.log(`kdna — KDNA .kdna file tool

Usage:

  --- Current KDNA Core path ---
  kdna inspect <file.kdna>      Inspect a local .kdna asset
  kdna validate <file.kdna>     Validate a local .kdna asset
  kdna plan-load <file.kdna>    Produce the required LoadPlan
  kdna load <file.kdna> [--as=prompt|json|raw]   Load only when LoadPlan allows it

  --- Dev source utilities (creator/debug path) ---
  kdna validate <path>          Validate a .kdna asset or dev source directory
  kdna pack <source-dir> <out>  Pack a dev source directory into .kdna
  kdna unpack <file.kdna> <dir> Unpack .kdna into a dev source directory
  kdna inspect <path>           Inspect a .kdna asset or dev source directory
  kdna domain card <path>       Display KDNA Card from a dev source directory
  kdna version bump <patch|minor|major> [path]   Bump domain version
  kdna cluster lint <path>      Validate a cluster manifest

  --- Agent-facing (called by the kdna-loader skill) ---
  kdna available [--json]       List locally available assets (discovery
                                metadata only; no content is loaded)
  kdna match "<task>" [--json]  Hint signals for local assets

  --- Other ---
  kdna setup                    One-command setup: CLI + skill + data root
  kdna doctor [--agents] [--domains] [--json]   System health check
  kdna version                  Show kdna CLI version
  kdna help                     Show this help
  kdna help legacy              Show legacy / experimental commands

Examples:
  kdna validate example.kdna
  kdna plan-load example.kdna
  kdna load example.kdna --profile=compact --as=prompt`);
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

// The HTTPS-only download guard lives in src/https-download.js so that
// src/registry.js can use it without a require cycle through this module.
const { assertHttpsDownloadUrl } = require('../https-download');

function isYesNoSelfCheck(item) {
  const raw = selfCheckText(item).trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower.endsWith('?') ||
    raw.endsWith('？') ||
    raw.endsWith('吗') ||
    raw.includes('是否') ||
    /^(have|has|can|does|do|is|are|did|was|were|should|will|would|could|might|can not|cannot|能不能|会不会|有没有|要不要|是不是)/.test(
      lower,
    )
  );
}

function loadRegistry() {
  return loadCanonicalRegistry({ allowNetwork: true });
}

/**
 * Prompt for a password interactively without echoing to the terminal.
 * Reads from stdin pipe if non-interactive.
 */
function promptPassword(question) {
  const tty = require('tty');

  // Non-interactive: read from stdin pipe
  if (!tty.isatty(process.stdin.fd)) {
    try {
      return readSecretStdin({ label: 'Password' });
    } catch (readError) {
      const message =
        readError instanceof SecretInputError
          ? readError.message
          : 'Password input could not be read.';
      error(message, EXIT.INPUT_ERROR);
    }
  }

  process.stdout.write(question);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;

  if (stdin.setRawMode) {
    stdin.setRawMode(true);
  }
  stdin.resume();

  const secretBytes = Buffer.alloc(MAX_SECRET_BYTES);
  const readBuffer = Buffer.alloc(1);
  let length = 0;
  let decodedPassword;
  let failureMessage = null;
  try {
    while (true) {
      const count = fs.readSync(stdin.fd, readBuffer, 0, 1);
      if (count === 0) break;
      const ch = readBuffer[0];
      if (ch === 0x0d || ch === 0x0a) {
        process.stdout.write('\n');
        break;
      }
      if (ch === 0x03) {
        // Ctrl+C
        if (stdin.setRawMode) stdin.setRawMode(!!wasRaw);
        stdin.pause();
        secretBytes.fill(0);
        readBuffer.fill(0);
        process.exit(130);
      }
      if (ch === 0x7f) {
        // Backspace removes one complete UTF-8 code point.
        if (length > 0) {
          let start = length - 1;
          while (start > 0 && (secretBytes[start] & 0xc0) === 0x80) start -= 1;
          secretBytes.fill(0, start, length);
          length = start;
          process.stdout.write('\b \b');
        }
        continue;
      }
      if (length >= MAX_SECRET_BYTES) {
        throw new SecretInputError(
          'secret_input_too_large',
          'Password input exceeds the size limit.',
        );
      }
      secretBytes[length] = ch;
      length += 1;
    }
    decodedPassword = decodeSecretBytes(Buffer.from(secretBytes.subarray(0, length)), {
      label: 'Password',
      stripTransportLineEnding: false,
    });
  } catch (readError) {
    failureMessage =
      readError instanceof SecretInputError
        ? readError.message
        : 'Password input could not be read.';
  } finally {
    secretBytes.fill(0);
    readBuffer.fill(0);
    if (stdin.setRawMode) stdin.setRawMode(!!wasRaw);
    stdin.pause();
  }
  if (failureMessage !== null) error(failureMessage, EXIT.INPUT_ERROR);
  return decodedPassword;
}

function rejectPasswordArgv(args) {
  if (args.includes('--password') || args.some((arg) => arg.startsWith('--password='))) {
    error(
      '--password is not supported because it exposes secrets in process arguments. ' +
        'Use --password-stdin or the secure interactive prompt.',
      EXIT.INPUT_ERROR,
    );
  }
}

// Resolve a password from stdin or an interactive prompt.
//
// Bug (#60): prior version of protect.js had this same block
// duplicated verbatim in cmdProtect and cmdUnlock. The fix extracts it
// to a single helper so the two code paths can never drift.
//
// Sources (in priority order):
//   1. --password-stdin (with TTY-hang guard, refuses up front on a TTY)
//   2. promptPassword() interactive fallback
//
// Throws via the project's `error` helper (process.exit on the
// configured EXIT code) if stdin fails or no password is obtainable.
function resolvePassword(args, { prompt = 'Password: ' } = {}) {
  rejectPasswordArgv(args);
  if (args.includes('--password-stdin')) {
    if (process.stdin.isTTY) {
      error(
        '--password-stdin requires the password to be piped in on stdin.\n' +
          'Example:  printf \'%s\' "$KDNA_PASSWORD" | kdna protect <file> --password-stdin\n' +
          'If you are running interactively, omit --password-stdin and you will be prompted.',
        EXIT.INPUT_ERROR,
      );
    }
    try {
      return readSecretStdin({ label: 'Password' });
    } catch (readError) {
      const message =
        readError instanceof SecretInputError
          ? readError.message
          : 'Password input could not be read.';
      error(message, EXIT.INPUT_ERROR);
    }
  }
  return promptPassword(prompt);
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
  assertHttpsDownloadUrl,
  loadRegistry,
  rejectPasswordArgv,
  promptPassword,
  resolvePassword,
};
