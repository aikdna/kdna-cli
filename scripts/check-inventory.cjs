#!/usr/bin/env node
'use strict';
/*
 * Permanent repository-inventory gate.
 *
 * Why it exists: a broad .gitignore pattern can hide a file that must travel
 * with the repository, so the file is invisible to `git status` and to any
 * review that counts status lines. That already happened in this repository:
 * `*.tgz` hid a 118 KB retired byte-preservation archive, so `git status -uall`
 * reported 703 lines where the tree held 704 files, and a 442-line review of
 * the dirty set could not see it. 227 retired paths were declared to remain
 * under `retired/`, but only 236 of the 237 files were actually commit-able.
 *
 * What it does: compares the inventory the repository DECLARES
 * (release-surface/inventory.json) with the inventory git can actually see.
 * Any entry that is declared to be in the repository but is not tracked, any
 * present-but-untracked or present-but-ignored path outside the declared
 * allowance, and any drift in the declared in-repository file count, is red.
 *
 * Inputs come from git itself. There is deliberately no flag that accepts a
 * caller-supplied inventory, so a stub that prints success cannot satisfy it.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Hard-coded invariants. These are NOT read from the manifest, so emptying or
// weakening the manifest cannot switch the rule off.
const REQUIRED_MUST_TRACK = Object.freeze(['vendor/*.tgz', 'retired/**/*.tgz']);

function git(root, args) {
  const out = execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return out.split('\n').filter((line) => line !== '');
}

// Minimal gitignore-style matcher, explicit about its own semantics:
//   `**` crosses `/`; `*` and `?` do not cross `/`;
//   a pattern containing no `/` matches the basename at any depth.
function globToRegExp(pattern) {
  const anchored = pattern.includes('/');
  const segments = pattern.split('/');
  const parts = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    if (segment === '**') {
      // `**` spans path separators: zero or more whole segments, or the whole
      // remainder when it is the final segment.
      parts.push(last ? '.*' : '(?:[^/]+/)*');
      continue;
    }
    let out = '';
    for (const c of segment) {
      if (c === '*') out += '[^/]*';
      else if (c === '?') out += '[^/]';
      else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    parts.push(last ? out : `${out}/`);
  }
  const body = parts.join('');
  return new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
}

const REGEXP_CACHE = new Map();
function matchesAny(file, patterns) {
  for (const pattern of patterns) {
    let re = REGEXP_CACHE.get(pattern);
    if (!re) {
      re = globToRegExp(pattern);
      REGEXP_CACHE.set(pattern, re);
    }
    if (re.test(file)) return pattern;
  }
  return null;
}

function loadManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const arrays = ['must_track_globs', 'allowed_untracked_globs', 'allowed_ignored_globs'];
  for (const key of arrays) {
    if (!Array.isArray(manifest[key])) {
      throw new Error(`inventory manifest: ${key} must be an array`);
    }
  }
  if (!Number.isInteger(manifest.tracked_count) || manifest.tracked_count < 0) {
    throw new Error('inventory manifest: tracked_count must be a non-negative integer');
  }
  return manifest;
}

function checkInventory({ root, manifestPath }) {
  const manifest = loadManifest(manifestPath);
  const failures = [];

  // (1) the declared in-repository file count must equal reality.
  const tracked = git(root, ['ls-files']);
  const trackedSet = new Set(tracked);
  if (tracked.length !== manifest.tracked_count) {
    failures.push(
      `declared tracked_count=${manifest.tracked_count} but git tracks ${tracked.length} files` +
        ' (re-pin release-surface/inventory.json in the same change that adds or removes files)',
    );
  }

  // (2) the manifest may add required globs but never drop a hard invariant.
  for (const required of REQUIRED_MUST_TRACK) {
    if (!manifest.must_track_globs.includes(required)) {
      failures.push(`manifest no longer declares the required in-repository glob ${required}`);
    }
  }

  // (3) everything the manifest says must be in the repository must be TRACKED.
  //     A file hidden by a broad ignore pattern shows up here and nowhere else.
  // NOTE: `git ls-files --cached` and `--others --ignored` do not combine:
  // passing `--ignored` suppresses the cached list. The on-disk set is
  // `--cached --others` (untracked-and-ignored files are "others" without
  // `--exclude-standard`), which is exactly tracked + present-but-unignored +
  // present-but-ignored.
  const present = [...new Set(git(root, ['ls-files', '--cached', '--others']))];
  const mustTrackHits = [];
  for (const file of present) {
    const pattern = matchesAny(file, manifest.must_track_globs);
    if (!pattern) continue;
    mustTrackHits.push(file);
    if (!trackedSet.has(file)) {
      failures.push(
        `"${file}" matches declared must-track glob "${pattern}" but is NOT tracked` +
          ' (ignored or untracked paths are invisible in `git status --short`)',
      );
    }
  }

  // (4) present-but-untracked paths must be explicitly allowed.
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  for (const file of untracked) {
    if (!matchesAny(file, manifest.allowed_untracked_globs)) {
      failures.push(`"${file}" is present and untracked but is not declared in allowed_untracked_globs`);
    }
  }

  // (5) present-but-ignored paths must be explicitly allowed. This is the rule
  //     that makes the ignore surface a reviewed declaration rather than an
  //     accident of the pattern list.
  const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard']);
  for (const file of ignored) {
    if (!matchesAny(file, manifest.allowed_ignored_globs)) {
      failures.push(`"${file}" is present and ignored but is not declared in allowed_ignored_globs`);
    }
  }

  return {
    failures,
    counts: {
      tracked: tracked.length,
      untracked: untracked.length,
      ignored: ignored.length,
      present: present.length,
      must_track_present: mustTrackHits.length,
    },
    manifest,
  };
}

function main(argv) {
  let root = path.resolve(__dirname, '..');
  let manifestPath = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' && i + 1 < argv.length) {
      root = path.resolve(argv[++i]);
    } else if (arg === '--manifest' && i + 1 < argv.length) {
      manifestPath = path.resolve(argv[++i]);
    } else {
      // Unknown options are refused: there is no "trust me" input path.
      console.error(`check-inventory: unknown argument ${arg}`);
      console.error('usage: check-inventory.cjs [--root <dir>] [--manifest <file>]');
      return 2;
    }
  }
  if (manifestPath === null) manifestPath = path.join(root, 'release-surface', 'inventory.json');

  let result;
  try {
    result = checkInventory({ root, manifestPath });
  } catch (error) {
    console.error(`check-inventory: ${error.message}`);
    return 1;
  }

  const { counts, failures } = result;
  if (failures.length > 0) {
    for (const failure of failures) console.error(`INVENTORY FAIL: ${failure}`);
    return 1;
  }
  console.log('Repository inventory MATCH: declared and git-visible sets agree; no hidden in-repository bytes.');
  console.log(
    `  tracked=${counts.tracked} (declared ${result.manifest.tracked_count}) | must-track present=${counts.must_track_present} all tracked` +
      ` | untracked=${counts.untracked} all declared | ignored=${counts.ignored} all declared`,
  );
  return 0;
}

// Entry guard: compared through realpath so an invocation through a symlink
// still runs the gate (and can never exit 0 silently, which is the failure
// mode this guard exists to prevent).
if (require.main === module) {
  let invoked;
  try {
    invoked = fs.realpathSync(process.argv[1]);
  } catch {
    invoked = null;
  }
  let self;
  try {
    self = fs.realpathSync(__filename);
  } catch {
    self = null;
  }
  if (!invoked || !self || invoked !== self) {
    console.error('KDNA_INVENTORY_ENTRY_GUARD_FAILED: refusing to run under an unresolved entry path');
    process.exit(2);
  }
  process.exit(main(process.argv.slice(2)));
}

module.exports = { checkInventory, globToRegExp, matchesAny, REQUIRED_MUST_TRACK };
