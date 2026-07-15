#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHIPPED_ROOTS = Object.freeze([
  'src',
  'validators',
  'templates',
  'skills',
  'schema',
  'fixtures',
]);
const SHIPPED_FILES = Object.freeze(['package.json', 'README.md', 'SECURITY.md', 'NOTICE']);
const TEXT_EXTENSIONS = new Set(['.js', '.json', '.md', '.txt', '.yml', '.yaml']);
const FORBIDDEN_FILES = new Set(['src/loader.js', 'src/runner.js', 'src/verify.js']);
const FORBIDDEN_DECLARATIONS = Object.freeze([
  ['obsolete manifest discriminator', /kdna_version/],
  ['obsolete judgment profile', /judgment-profile-v1/],
  ['obsolete bundle profile', /bundle-profile-v1/],
  ['obsolete Runtime entry-set profile', /kdna-runtime-entry-set-v1/],
  ['obsolete Capsule type', /kdna\.context\.capsule/],
  ['obsolete execution contract', /execution-contract-v1/],
  ['obsolete Runtime contract', /runtime-contract-v1/],
  ['obsolete bundle format', /kdna-bundle-v1/],
  ['obsolete capability fallback', /legacy_assumption/],
  ['duplicate loading route', /\bquality\s+load\b/],
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

function scanCurrentProtocolNames(root) {
  const candidates = [
    ...SHIPPED_ROOTS.flatMap((relative) => listFiles(root, relative)),
    ...SHIPPED_FILES.filter((relative) => fs.existsSync(path.join(root, relative))),
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

function main() {
  const root = path.resolve(__dirname, '..');
  const issues = scanCurrentProtocolNames(root);
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

module.exports = { scanCurrentProtocolNames };
