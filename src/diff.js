/**
 * kdna diff <name>@<ver1> <name>@<ver2> — Judgment-level diff between versions.
 *
 * Downloads two .kdna dev packages from the registry, extracts to temp dirs,
 * compares axioms / misunderstandings / banned_terms / stances / boundary,
 * and surfaces what would change for an agent loading the new version.
 *
 * Not a structural file diff — a judgment diff:
 *   - Added/removed/changed axioms with their applies_when boundaries
 *   - Added/removed/changed misunderstandings
 *   - Added/removed banned terms
 *   - judgment_version bump (if declared)
 *
 * Usage:
 *   kdna diff @aikdna/writing@0.7.1 @aikdna/writing@0.7.2
 *   kdna diff @aikdna/writing                              # latest vs installed
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { RegistryResolver } = require('./registry');
const { EXIT } = require('./cmds/_common');
const { getInstalled, readContainer } = require('./package-store');

const TMP_DIR = '/tmp';

function error(msg, code = EXIT.VALIDATION_FAILED) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// ─── Parse "<name>@<ver>" ──────────────────────────────────────────────

function parseNameVersion(input) {
  // accept @scope/name@version OR @scope/name OR bare@ver OR bare
  const atSplit = input.split('@');
  if (input.startsWith('@')) {
    // @scope/name OR @scope/name@version
    if (atSplit.length === 2) return { full: input, version: null };
    if (atSplit.length === 3) return { full: '@' + atSplit[1], version: atSplit[2] };
  } else {
    if (atSplit.length === 1) return { full: input, version: null };
    if (atSplit.length === 2) return { full: atSplit[0], version: atSplit[1] };
  }
  return null;
}

// ─── Download specific version ────────────────────────────────────────

function downloadVersion(entry, version, destDir) {
  const assetUrl = entry.asset_url;
  // assetUrl is for the registry-current version. For older versions
  // we infer the URL pattern from the registry-current URL.
  if (entry.version === version) {
    return downloadAndExtract(assetUrl, destDir);
  }

  // Infer pattern: replace v<current> in the URL with v<requested>
  const inferredUrl = assetUrl
    .replace(`/v${entry.version}/`, `/v${version}/`)
    .replace(`-${entry.version}.kdna`, `-${version}.kdna`);

  return downloadAndExtract(inferredUrl, destDir);
}

function downloadAndExtract(url, destDir) {
  const tmpFile = `${destDir}.kdna.tmp`;
  try {
    execFileSync('curl', ['-fsSL', '--retry', '2', '-o', tmpFile, url], {
      timeout: 60000,
      stdio: 'pipe',
    });
  } catch (e) {
    error(
      `Failed to download ${url}: ${e.stderr?.toString().trim() || e.message}`,
      EXIT.PROVIDER_ERROR,
    );
  }

  fs.mkdirSync(destDir, { recursive: true });
  try {
    execSync(`unzip -q -o "${tmpFile}" -d "${destDir}"`, { stdio: 'pipe' });
  } catch {
    const script = `import zipfile
zf = zipfile.ZipFile(${JSON.stringify(tmpFile)}, 'r')
zf.extractall(${JSON.stringify(destDir)})`;
    execSync(`python3 -c ${JSON.stringify(script)}`, { stdio: 'pipe' });
  }
  fs.unlinkSync(tmpFile);
  return destDir;
}

// ─── Extract judgment artifacts ────────────────────────────────────────

function loadJudgment(domainDir) {
  const core = readJson(path.join(domainDir, 'KDNA_Core.json')) || {};
  const pat = readJson(path.join(domainDir, 'KDNA_Patterns.json')) || {};
  const manifest = readJson(path.join(domainDir, 'kdna.json')) || {};

  return {
    version: manifest.version || '?',
    judgment_version: manifest.judgment_version || null,
    axioms: Object.fromEntries((core.axioms || []).map((a) => [a.id, a])),
    ontology: Object.fromEntries((core.ontology || []).map((o) => [o.id, o])),
    stances: (core.stances || [])
      .map((s) => (typeof s === 'string' ? s : s.stance))
      .filter(Boolean),
    misunderstandings: Object.fromEntries((pat.misunderstandings || []).map((m) => [m.id, m])),
    banned_terms: Object.fromEntries((pat.terminology?.banned_terms || []).map((t) => [t.term, t])),
  };
}

// ─── Set diff helpers ─────────────────────────────────────────────────

function diffMaps(label, oldMap, newMap, render, jsonMode = false) {
  const oldIds = new Set(Object.keys(oldMap));
  const newIds = new Set(Object.keys(newMap));
  const added = [...newIds].filter((id) => !oldIds.has(id));
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  const both = [...newIds].filter((id) => oldIds.has(id));
  const changed = both.filter((id) => JSON.stringify(oldMap[id]) !== JSON.stringify(newMap[id]));

  // Collect boundary-level diffs for JSON output
  const changedDetails = changed.map((id) => {
    const a = oldMap[id],
      b = newMap[id];
    const boundaryChanges = {};
    for (const field of ['applies_when', 'does_not_apply_when', 'failure_risk', 'confidence']) {
      const before = a[field] ?? null;
      const after = b[field] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        boundaryChanges[field] = { before, after };
      }
    }
    return { id, before: a, after: b, boundary_changes: boundaryChanges };
  });

  const out = { label, added, removed, changed, changedDetails };

  if (jsonMode) return out;

  console.log('');
  console.log('─'.repeat(64));
  console.log(`  ${label.toUpperCase()}`);
  console.log(`  added:${added.length}  removed:${removed.length}  changed:${changed.length}`);
  console.log('─'.repeat(64));

  for (const id of added) {
    console.log(`  + ${id}`);
    if (render) console.log(`    "${render(newMap[id])}"`);
  }
  for (const id of removed) {
    console.log(`  - ${id}`);
    if (render) console.log(`    (was) "${render(oldMap[id])}"`);
  }
  for (const id of changed) {
    console.log(`  ~ ${id}`);
    if (render) {
      console.log(`    was: "${render(oldMap[id])}"`);
      console.log(`    now: "${render(newMap[id])}"`);
    }
    // Surface key diffs in v2.1 boundary fields
    const a = oldMap[id],
      b = newMap[id];
    for (const field of ['applies_when', 'does_not_apply_when', 'failure_risk', 'confidence']) {
      const before = JSON.stringify(a[field] ?? null);
      const after = JSON.stringify(b[field] ?? null);
      if (before !== after) {
        console.log(`    [${field}] ${before} → ${after}`);
      }
    }
  }

  return out;
}

function diffStanceList(oldList, newList, jsonMode = false) {
  const oldSet = new Set(oldList);
  const newSet = new Set(newList);
  const added = newList.filter((s) => !oldSet.has(s));
  const removed = oldList.filter((s) => !newSet.has(s));
  const out = { added, removed };
  if (jsonMode) return out;
  console.log('');
  console.log('─'.repeat(64));
  console.log(`  STANCES   added:${added.length}  removed:${removed.length}`);
  console.log('─'.repeat(64));
  for (const s of added) console.log(`  + "${s}"`);
  for (const s of removed) console.log(`  - "${s}"`);
  return out;
}

// ─── Main ──────────────────────────────────────────────────────────────

async function cmdDiff(a, b, args = []) {
  const jsonMode = args.includes('--json');

  if (!a) error('Usage: kdna diff <name>@<v1> <name>@<v2>  or  kdna diff <name>', EXIT.INPUT_ERROR);

  const aParsed = parseNameVersion(a);
  const bParsed = b ? parseNameVersion(b) : null;
  if (!aParsed) error(`Cannot parse "${a}"`, EXIT.INPUT_ERROR);

  const resolver = new RegistryResolver({ allowNetwork: true });
  let entryA;
  try {
    ({ entry: entryA } = resolver.resolve(aParsed.full));
  } catch (e) {
    error(e.message, EXIT.REGISTRY_ERROR);
  }

  // Determine targets
  let oldVersion, newVersion, oldEntry, newEntry;
  if (bParsed) {
    let entryB;
    try {
      ({ entry: entryB } = resolver.resolve(bParsed.full));
    } catch (e) {
      error(e.message, EXIT.REGISTRY_ERROR);
    }
    if (aParsed.full !== bParsed.full)
      error('Comparing across different domains is not supported.', EXIT.INPUT_ERROR);
    oldVersion = aParsed.version || entryA.version;
    newVersion = bParsed.version || entryB.version;
    oldEntry = entryA;
    newEntry = entryB;
  } else {
    // single-arg form: installed vs registry-current
    const installed = getInstalled(aParsed.full);
    if (!installed) {
      error(`${aParsed.full} not installed. Run: kdna install ${aParsed.full}`, EXIT.INPUT_ERROR);
    }
    const localManifest = readContainer(installed.asset_path).manifest || {};
    oldVersion = localManifest?.version || '?';
    newVersion = entryA.version;
    oldEntry = entryA;
    newEntry = entryA;
    if (oldVersion === newVersion) {
      if (jsonMode) {
        console.log(
          JSON.stringify({ error: `${aParsed.full}@${oldVersion}: only one version found.` }),
        );
        process.exit(EXIT.OK);
      }
      console.log(
        `${aParsed.full}@${oldVersion}: only one version found.\n` +
          `To compare across versions, specify two: kdna diff ${aParsed.full}@${oldVersion} ${aParsed.full}@<other>`,
      );
      return;
    }
  }

  if (!jsonMode) {
    console.log('═'.repeat(64));
    console.log(`  kdna diff  ${aParsed.full}`);
    console.log(`  ${oldVersion}  →  ${newVersion}`);
    console.log('═'.repeat(64));
  }

  // Download both versions to temp dirs
  const tmpOld = path.join(TMP_DIR, `kdna-diff-${Date.now()}-old`);
  const tmpNew = path.join(TMP_DIR, `kdna-diff-${Date.now()}-new`);

  if (!jsonMode) console.log('Downloading old version...');
  downloadVersion(oldEntry, oldVersion, tmpOld);
  if (!jsonMode) console.log('Downloading new version...');
  downloadVersion(newEntry, newVersion, tmpNew);

  const oldJ = loadJudgment(tmpOld);
  const newJ = loadJudgment(tmpNew);

  if (!jsonMode) {
    console.log('');
    console.log(
      '  judgment_version: ' +
        (oldJ.judgment_version || '(not declared)') +
        '  →  ' +
        (newJ.judgment_version || '(not declared)'),
    );
  }

  const axiomsDiff = diffMaps(
    'axioms',
    oldJ.axioms,
    newJ.axioms,
    (a) => a.one_sentence || a.id,
    jsonMode,
  );
  diffMaps('ontology', oldJ.ontology, newJ.ontology, (o) => o.one_sentence || o.id, jsonMode);
  const misunderstandingsDiff = diffMaps(
    'misunderstandings',
    oldJ.misunderstandings,
    newJ.misunderstandings,
    (m) => m.wrong || m.id,
    jsonMode,
  );
  const bannedDiff = diffMaps(
    'banned_terms',
    oldJ.banned_terms,
    newJ.banned_terms,
    (t) => t.term || '',
    jsonMode,
  );
  const stancesDiff = diffStanceList(oldJ.stances, newJ.stances, jsonMode);

  // Cleanup
  try {
    fs.rmSync(tmpOld, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpNew, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // Derive structured JSON fields
  const changedAxioms = axiomsDiff.changedDetails.map((d) => ({
    id: d.id,
    changes: d.boundary_changes,
  }));

  const changedBoundaries = axiomsDiff.changedDetails
    .filter((d) => Object.keys(d.boundary_changes).length > 0)
    .map((d) => ({
      axiom_id: d.id,
      boundary_changes: d.boundary_changes,
    }));

  const newMisunderstandings = misunderstandingsDiff.added;
  const deprecatedSelfChecks = []; // self_checks are not part of diffMaps; would need separate tracking

  const riskModelChanges = axiomsDiff.changedDetails
    .filter((d) => d.boundary_changes.failure_risk)
    .map((d) => ({
      axiom_id: d.id,
      before: d.boundary_changes.failure_risk.before,
      after: d.boundary_changes.failure_risk.after,
    }));

  const affectedScenarios = axiomsDiff.changedDetails
    .filter((d) => d.boundary_changes.applies_when || d.boundary_changes.does_not_apply_when)
    .map((d) => ({
      axiom_id: d.id,
      applies_when: d.boundary_changes.applies_when || null,
      does_not_apply_when: d.boundary_changes.does_not_apply_when || null,
    }));

  // Determine recommended version bump
  const hasRemoved = axiomsDiff.removed.length > 0 || misunderstandingsDiff.removed.length > 0;
  const hasAdded = axiomsDiff.added.length > 0 || misunderstandingsDiff.added.length > 0;
  const hasChanged = axiomsDiff.changed.length > 0 || bannedDiff.changed.length > 0;
  let recommendedVersionBump = 'none';
  if (hasRemoved) recommendedVersionBump = 'major';
  else if (hasAdded || hasChanged) recommendedVersionBump = 'minor';
  else if (stancesDiff.added.length > 0 || stancesDiff.removed.length > 0)
    recommendedVersionBump = 'patch';

  if (jsonMode) {
    const result = {
      domain: aParsed.full,
      old_version: oldVersion,
      new_version: newVersion,
      judgment_version: {
        before: oldJ.judgment_version || null,
        after: newJ.judgment_version || null,
      },
      changed_axioms: changedAxioms,
      changed_boundaries: changedBoundaries,
      new_misunderstandings: newMisunderstandings,
      deprecated_self_checks: deprecatedSelfChecks,
      risk_model_changes: riskModelChanges,
      affected_scenarios: affectedScenarios,
      recommended_version_bump: recommendedVersionBump,
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    console.log('═'.repeat(64));
    const drift = Object.keys(newJ.axioms).length - Object.keys(oldJ.axioms).length;
    const note = drift !== 0 ? ` (axiom count drift: ${drift > 0 ? '+' : ''}${drift})` : '';
    console.log(`  Judgment surface change: ${oldVersion} → ${newVersion}${note}`);
    console.log(
      `  Agent loading the new version may classify, diagnose, or recommend differently.`,
    );
    console.log('═'.repeat(64));
  }
}

module.exports = { cmdDiff, loadJudgment, parseNameVersion };
