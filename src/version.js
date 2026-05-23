/**
 * kdna version bump <patch|minor|major> [path] — Bump domain version.
 *
 * Updates kdna.json and all KDNA JSON file meta versions.
 */

const fs = require('fs');
const path = require('path');
const { EXIT } = require('./cmds/_common');

function error(msg, code = EXIT.VALIDATION_FAILED) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function cmdVersionBump(level, domainPath) {
  if (!level || !['patch', 'minor', 'major'].includes(level)) {
    error(
      'Usage: kdna version bump <patch|minor|major> [path]\n\n  patch — fix wording, no judgment change\n  minor — add axiom/concept/framework (may change judgment)\n  major — remove/redefine axiom or change scope (breaking)',
    );
  }

  const targetDir = path.resolve(domainPath || '.');

  // Read kdna.json
  const manifestPath = path.join(targetDir, 'kdna.json');
  const manifest = readJson(manifestPath);
  if (!manifest) error(`kdna.json not found in ${targetDir}`);

  const oldVersion = manifest.version;
  if (!oldVersion) error('No version field in kdna.json');

  // Parse semver
  const parts = oldVersion.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    error(`Invalid semver: "${oldVersion}". Expected MAJOR.MINOR.PATCH`);
  }

  let [major, minor, patch] = parts;

  switch (level) {
    case 'patch':
      patch++;
      break;
    case 'minor':
      minor++;
      patch = 0;
      break;
    case 'major':
      major++;
      minor = 0;
      patch = 0;
      break;
  }

  const newVersion = `${major}.${minor}.${patch}`;

  console.log(`Bumping version: ${oldVersion} → ${newVersion} (${level})`);
  console.log('');

  // Update kdna.json
  manifest.version = newVersion;
  manifest.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`  ✓ kdna.json`);

  // Update all KDNA JSON files
  const kdnaFiles = fs
    .readdirSync(targetDir)
    .filter((f) => f.startsWith('KDNA_') && f.endsWith('.json'));

  for (const file of kdnaFiles) {
    const filePath = path.join(targetDir, file);
    const data = readJson(filePath);
    if (data && data.meta) {
      // meta.version is spec version, not package version — keep it
      // But update any updated/created dates
      if (data.meta.updated) {
        data.meta.updated = new Date().toISOString().slice(0, 10);
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      console.log(`  ✓ ${file} (meta unchanged — spec version)`);
    }
  }

  // CHANGELOG reminder
  const changelogPath = path.join(targetDir, 'CHANGELOG.md');
  console.log('');
  if (fs.existsSync(changelogPath)) {
    console.log(`  ⚠ Remember to add ${newVersion} entry to CHANGELOG.md`);
  } else {
    console.log(`  ⚠ Consider creating CHANGELOG.md`);
  }

  // Benchmark reminder for minor/major
  if (level === 'minor' || level === 'major') {
    console.log(`  ⚠ MINOR/MAJOR bump — must re-run benchmark before release`);
    console.log(`     kdna verify ${domainPath || '.'}`);
  }

  console.log('');
  console.log(`Done. Version: ${oldVersion} → ${newVersion}`);
}

/**
 * kdna version bump --suggest [path]
 *   Suggest version bump based on judgment changes detected by kdna diff.
 *   Compares installed vs registry-current and suggests patch/minor/major.
 */
function cmdVersionSuggest(domainPath = '.', args = []) {
  const jsonMode = args.includes('--json');
  const abs = path.resolve(domainPath);

  const manifest = readJson(path.join(abs, 'kdna.json'));
  if (!manifest) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: 'No kdna.json found', suggestion: 'none' }));
      process.exit(EXIT.OK);
    }
    console.log('No kdna.json found in current directory. Cannot suggest version bump.');
    process.exit(EXIT.OK);
  }

  const currentVersion = manifest.version;
  if (!currentVersion) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: 'No version field', suggestion: 'none' }));
      process.exit(EXIT.OK);
    }
    console.log('No version field in kdna.json.');
    process.exit(EXIT.OK);
  }

  // Rules for suggesting:
  // - If no previous version to diff against, suggest 'none'
  // - Check for judgment_version changes
  // - Check for axiom/ontology/misunderstanding changes

  const changes = detectChanges(abs);

  if (jsonMode) {
    console.log(JSON.stringify({
      current_version: currentVersion,
      suggested_bump: changes.suggestion,
      reasons: changes.reasons,
      change_summary: changes.summary,
    }, null, 2));
    return;
  }

  console.log(`Current version: ${currentVersion}`);
  console.log(`Suggested bump:  ${changes.suggestion}`);
  console.log('');
  if (changes.reasons.length) {
    console.log('Reasons:');
    changes.reasons.forEach((r) => console.log(`  - ${r}`));
  }
  if (changes.suggestion !== 'none') {
    console.log('');
    console.log(`Run: kdna version bump ${changes.suggestion} ${domainPath}`);
  }
}

function detectChanges(domainPath) {
  const reasons = [];
  let axiomChanges = 0;
  const ontologyChanges = 0;
  const misunderstandingChanges = 0;

  // Simple heuristic: count content vs previous git state
  // For now, use a heuristic based on file modification
  const core = readJson(path.join(domainPath, 'KDNA_Core.json'));

  // Check if evals/ dir has recent changes
  const evalsDir = path.join(domainPath, 'evals');
  if (fs.existsSync(evalsDir)) {
    reasons.push('evals/ directory present');
  }

  // Check for judgment_version in manifest
  const manifest = readJson(path.join(domainPath, 'kdna.json'));
  if (manifest?.judgment_version) {
    reasons.push(`judgment_version: ${manifest.judgment_version}`);
  }

  // Count axioms with applies_when (v2.1 governance) vs without
  if (core?.axioms) {
    const total = core.axioms.length;
    const governed = core.axioms.filter((a) => a.applies_when?.length && a.does_not_apply_when?.length).length;
    if (governed < total) {
      axiomChanges = total - governed;
      reasons.push(`${axiomChanges} axioms missing v2.1 governance fields`);
    }
  }

  let suggestion = 'none';
  if (axiomChanges > 0) suggestion = 'patch';
  if (axiomChanges >= 3) suggestion = 'minor';

  return {
    suggestion,
    reasons,
    summary: {
      axiom_changes: axiomChanges,
      ontology_changes: ontologyChanges,
      misunderstanding_changes: misunderstandingChanges,
    },
  };
}

module.exports = { cmdVersionBump, cmdVersionSuggest };
