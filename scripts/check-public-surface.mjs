#!/usr/bin/env node

/**
 * Scan every Git-tracked text file. Public repositories do not gain a privacy
 * exemption for tests, fixtures, archives, changelogs, or source code.
 *
 * Private-name configuration remains hash based so the guard itself does not
 * publish the names it rejects. Add the SHA-256 of a forbidden token or
 * org/name reference to public-surface.config.json.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ROOT = process.cwd();
const CONFIG_PATH = new URL('./public-surface.config.json', import.meta.url);
const SELF = 'scripts/check-public-surface.mjs';
const MAX_TEXT_BYTES = 1_000_000;

const forbiddenHashes = new Set();
if (existsSync(CONFIG_PATH)) {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    for (const hash of config.forbiddenPatternHashes || []) forbiddenHashes.add(hash);
    if (Array.isArray(config.forbiddenPatterns) && config.forbiddenPatterns.length > 0) {
      throw new Error('forbiddenPatterns is not public-safe; store only forbiddenPatternHashes');
    }
  } catch (error) {
    console.error(`public-surface.config.json invalid: ${error.message}`);
    process.exit(1);
  }
}

function digest(value) {
  return createHash('sha256').update(value.toLowerCase()).digest('hex');
}

function isForbidden(value) {
  return forbiddenHashes.has(digest(value));
}

const rules = [
  {
    name: 'private-repository-url',
    pattern: /github\.com\/aikdna\/([a-z][a-z0-9_-]+)/gi,
    check: (match) => isForbidden(`aikdna/${match[1]}`),
    hint: 'Replace the private repository reference with a public-safe generic description.',
  },
  {
    name: 'private-name-token',
    pattern:
      /@[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*|[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*|[a-z][a-z0-9_-]*/gi,
    check: (match) => isForbidden(match[0]),
    hint: 'Replace the private name with a public-safe generic example.',
  },
  {
    name: 'local-filesystem-path',
    pattern: /\/Users\/(?!<user>\/|you\/|username\/)[^/\s]+\/|\/private\/tmp\/kdna/gi,
    hint: 'Replace the machine-specific path with <workdir>, <home>, or /tmp.',
  },
  {
    name: 'full-commit-hash',
    pattern: /(?<![a-f0-9])[a-f0-9]{40}(?![a-f0-9])/gi,
    excludePathPrefixes: ['.github/workflows/'],
    excludeExactPaths: ['ecosystem-manifest.json'],
    allowMatch: (_match, context) =>
      context.file === 'tests/fixtures/core-0.18-release-evidence.json' &&
      /^\s*"git_head":\s*"[a-f0-9]{40}"\s*,?\s*$/i.test(context.line),
    hint: 'Use a short public ref or a public acceptance-note link.',
  },
  {
    name: 'internal-code-name',
    pattern: /\bM3 self-eval\b/gi,
    hint: 'Replace with "single-model self-evaluation".',
  },
];

function listTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function isExcluded(file, rule) {
  return (
    (rule.excludeExactPaths || []).includes(file) ||
    (rule.excludePathPrefixes || []).some((prefix) => file.startsWith(prefix))
  );
}

const findings = [];
let scanned = 0;
for (const file of listTrackedFiles()) {
  if (file === SELF) continue;
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }
  if (buffer.length > MAX_TEXT_BYTES || buffer.includes(0)) continue;
  scanned += 1;
  const lines = buffer.toString('utf8').split('\n');
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    for (const rule of rules) {
      if (isExcluded(file, rule)) continue;
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        if (rule.check && !rule.check(match)) continue;
        if (rule.allowMatch && rule.allowMatch(match, { file, line, lineNumber: lineNumber + 1 })) {
          continue;
        }
        findings.push({
          file,
          line: lineNumber + 1,
          rule: rule.name,
          match: match[0],
          hint: rule.hint,
        });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(
    `public-surface check failed: ${findings.length} finding(s) across ${scanned} files`,
  );
  for (const finding of findings) {
    console.error(`\n${finding.file}:${finding.line} [${finding.rule}]`);
    console.error(`  match: ${finding.match}`);
    console.error(`  ${finding.hint}`);
  }
  process.exit(1);
}

console.log(`public-surface check passed: ${scanned} tracked text files, 0 findings`);
