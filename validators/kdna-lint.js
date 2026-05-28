#!/usr/bin/env node
/**
 * kdna-lint — Structural and content validation for KDNA domains.
 *
 * Uses @aikdna/kdna-core lintDomain for pure validation logic,
 * handles file I/O here.
 */

const fs = require('fs');
const path = require('path');
const { lintDomain } = require('@aikdna/kdna-core');

const KDNA_DOMAIN_FILES = new Set([
  'KDNA_Core.json',
  'KDNA_Patterns.json',
  'KDNA_Scenarios.json',
  'KDNA_Cases.json',
  'KDNA_Reasoning.json',
  'KDNA_Evolution.json',
]);

const domainDir = process.argv[2];
if (!domainDir || domainDir === '--help' || domainDir === '-h') {
  console.log(`kdna-lint — Structural and content validation for KDNA domains.

Usage: kdna-lint <domain-folder>

Runs lint checks on KDNA_*.json files for structure, content, and consistency.

Options:
  -h, --help    Show this help message`);
  process.exit(domainDir ? 0 : 2);
}

if (!fs.existsSync(domainDir) || !fs.statSync(domainDir).isDirectory()) {
  console.error(`Not a directory: ${domainDir}`);
  process.exit(2);
}

// Read only canonical domain content files. Governance metadata such as
// KDNA_CARD.json is part of the package, but not one of the 6 KDNA JSON files.
const files = fs.readdirSync(domainDir).filter((f) => KDNA_DOMAIN_FILES.has(f));
const dataMap = {};
for (const f of files) {
  try {
    dataMap[f] = JSON.parse(fs.readFileSync(path.join(domainDir, f), 'utf8'));
  } catch {
    // lintDomain will report missing required files; skip unparseable here
  }
}

const result = lintDomain(dataMap);

function validateManifest(manifest) {
  const errors = [];
  const warnings = [];
  const required = [
    'format',
    'format_version',
    'spec_version',
    'name',
    'version',
    'judgment_version',
    'description',
    'author',
    'license',
    'status',
    'quality_badge',
    'access',
    'languages',
    'default_language',
  ];

  if (manifest.kdna_spec) errors.push('kdna_spec is not allowed. Use spec_version.');
  if (manifest.language)
    errors.push('language is not allowed. Use default_language and languages.');
  for (const field of required) {
    if (!(field in manifest) || manifest[field] === undefined || manifest[field] === '') {
      errors.push(`missing required field "${field}"`);
    }
  }
  if (manifest.format && manifest.format !== 'kdna') {
    errors.push(`format: invalid value "${manifest.format}". Expected "kdna".`);
  }
  if (manifest.format_version && manifest.format_version !== '1.0') {
    errors.push(`format_version: invalid value "${manifest.format_version}". Expected "1.0".`);
  }
  if (manifest.spec_version && manifest.spec_version !== '1.0-rc') {
    warnings.push(
      `spec_version: non-standard value "${manifest.spec_version}". Expected "1.0-rc".`,
    );
  }
  return { errors, warnings };
}

// Also validate kdna.json manifest if present and validateManifest is available
let manifestPath;
try {
  manifestPath = path.join(domainDir, 'kdna.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const mResult = validateManifest(manifest);
    for (const e of mResult.errors) result.errors.push(`kdna.json: ${e}`);
    for (const w of mResult.warnings) result.warnings.push(`kdna.json: ${w}`);
  }
} catch (e) {
  if (e.code !== 'ENOENT') {
    result.errors.push(`kdna.json: failed to parse — ${e.message}`);
  }
}

if (result.warnings.length) {
  console.log('Warnings:');
  result.warnings.forEach((w) => console.log(`  - ${w}`));
}
if (result.errors.length) {
  console.error('Errors:');
  result.errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}
console.log(`✓ KDNA domain valid: ${domainDir}`);
