#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PACKAGED_ROOTS = Object.freeze([
  'src',
  'validators',
  'templates',
  'skills',
  'schema',
  'fixtures',
]);
const PACKAGED_FILES = Object.freeze(['package.json', 'README.md', 'SECURITY.md', 'NOTICE']);
const REPOSITORY_ROOTS = Object.freeze([...PACKAGED_ROOTS, 'scripts', 'tests', '.github']);
const REPOSITORY_FILES = Object.freeze([...PACKAGED_FILES]);
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.md', '.txt', '.yml', '.yaml']);
const FORBIDDEN_FILES = new Set(['src/loader.js', 'src/runner.js', 'src/verify.js']);

function joinedPattern(...parts) {
  return new RegExp(parts.join(''));
}

function joinedInsensitivePattern(...parts) {
  return new RegExp(parts.join(''), 'i');
}

const KDNA_OWNED_CONCEPT =
  '(?:kdna|core|registry|index(?:es)?|records?|fixtures?|bundle|capsule|runtime|manifest|profile|grant|proof|envelope|container|format|protocol)';

const FORBIDDEN_DECLARATIONS = Object.freeze([
  ['obsolete manifest discriminator', joinedPattern('kdna', '_version')],
  ['obsolete judgment profile', joinedPattern('judgment', '-profile-', 'v1')],
  ['obsolete bundle profile', joinedPattern('bundle', '-profile-', 'v1')],
  ['obsolete Runtime entry-set profile', joinedPattern('kdna-runtime', '-entry-set-', 'v1')],
  ['obsolete Capsule type', joinedPattern('kdna', '\\.context\\.', 'capsule')],
  ['obsolete execution contract', joinedPattern('execution', '-contract-', 'v1')],
  ['obsolete Runtime contract', joinedPattern('runtime', '-contract-', 'v1')],
  ['obsolete bundle format', joinedPattern('kdna-bundle', '-v1')],
  ['obsolete remote projection route', joinedPattern('/', 'v1', '/project')],
  ['obsolete capability fallback', joinedPattern('legacy', '_assumption')],
  ['duplicate loading route', /\bquality\s+load\b/],
  [
    'generation suffix on a KDNA-owned name',
    joinedInsensitivePattern('\\bkdna[a-z0-9_.:-]*[-_.]', 'v', '[0-9]+(?![0-9.])'),
  ],
  [
    'generation label after a KDNA-owned concept',
    joinedInsensitivePattern(`\\b${KDNA_OWNED_CONCEPT}\\s+`, 'v', '[0-9]+(?![0-9.])'),
  ],
  [
    'generation label before a KDNA-owned concept',
    joinedInsensitivePattern('\\b', 'v', `[0-9]+\\s+${KDNA_OWNED_CONCEPT}\\b`),
  ],
  [
    'generation encoded in an implementation identifier',
    joinedPattern(
      '\\b(?:is|has|use|load|validate|inspect|format|protocol|profile|registry|index)',
      'V',
      '[0-9]+\\b',
    ),
  ],
]);

function listFiles(root, relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function isTextFile(relative) {
  if (['NOTICE', 'mimetype'].includes(path.basename(relative))) return true;
  return TEXT_EXTENSIONS.has(path.extname(relative));
}

function scanPaths(root, roots, topLevelFiles) {
  const candidates = [
    ...roots.flatMap((relative) => listFiles(root, relative)),
    ...topLevelFiles.filter((relative) => fs.existsSync(path.join(root, relative))),
  ];
  const files = [...new Set(candidates)].sort();
  const issues = [];

  for (const relative of files) {
    if (FORBIDDEN_FILES.has(relative)) {
      issues.push({ file: relative, line: null, rule: 'obsolete shipped implementation' });
    }
    if (!isTextFile(relative)) continue;
    const lines = fs.readFileSync(path.join(root, relative), 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      for (const [rule, pattern] of FORBIDDEN_DECLARATIONS) {
        if (pattern.test(lines[index])) {
          issues.push({ file: relative, line: index + 1, rule });
        }
      }
    }
  }
  return issues;
}

function scanCurrentProtocolNames(root) {
  return scanPaths(root, REPOSITORY_ROOTS, REPOSITORY_FILES);
}

function scanPackedArtifact(root) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-protocol-pack-'));
  try {
    const tarballName = execFileSync(
      'npm',
      ['pack', '--silent', '--ignore-scripts', '--pack-destination', temporary],
      { cwd: root, encoding: 'utf8' },
    ).trim();
    const tarball = path.join(temporary, tarballName.split(/\r?\n/).at(-1));
    execFileSync('tar', ['-xzf', tarball, '-C', temporary]);
    const packageRoot = path.join(temporary, 'package');
    return scanPaths(packageRoot, PACKAGED_ROOTS, PACKAGED_FILES).map((issue) => ({
      ...issue,
      file: `npm-pack/${issue.file}`,
    }));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const root = path.resolve(__dirname, '..');
  const issues = [...scanCurrentProtocolNames(root), ...scanPackedArtifact(root)];
  if (issues.length > 0) {
    for (const issue of issues) {
      const location = issue.line === null ? issue.file : `${issue.file}:${issue.line}`;
      console.error(`${location}: ${issue.rule}`);
    }
    throw new Error(`current protocol naming gate found ${issues.length} issue(s)`);
  }
  console.log('Current protocol naming gate passed');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { scanCurrentProtocolNames, scanPackedArtifact };
