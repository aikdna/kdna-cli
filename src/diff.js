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
const os = require('os');
const path = require('path');
const { RegistryResolver } = require('./registry');
const { EXIT } = require('./cmds/_common');
const { assertInstalledIntegrity, getInstalled, readContainer } = require('./package-store');
const { downloadAndExtractKdna } = require('./safe-archive');
const {
  judgmentChanges,
  jsonChanges,
  listChanges,
  mapChanges,
  recommendedVersionBump,
} = require('./judgment-diff');

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

function downloadVersion(entry, version, destDir, options = {}) {
  const { expectedName = entry?.name, ...downloadOptions } = options;
  if (!entry || entry.version !== version) {
    throw new Error(
      `registry version mismatch: requested ${version}, resolved ${entry?.version || 'none'}`,
    );
  }
  if (typeof expectedName !== 'string' || entry.name !== expectedName) {
    throw new Error(
      `registry identity mismatch: requested ${expectedName || 'none'}, resolved ${entry.name || 'none'}`,
    );
  }
  if (typeof entry.asset_url !== 'string' || entry.asset_url.length === 0) {
    throw new Error(`registry entry ${entry.name || 'unknown'}@${version} has no asset_url`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(entry.asset_digest || '')) {
    throw new Error(
      `registry entry ${entry.name || 'unknown'}@${version} has no canonical asset_digest`,
    );
  }
  const assetUrl = entry.asset_url;
  return downloadAndExtractKdna(assetUrl, destDir, {
    ...downloadOptions,
    expected: {
      name: expectedName,
      version,
      assetDigest: entry.asset_digest,
    },
  });
}

// ─── Extract judgment artifacts ────────────────────────────────────────

function loadJudgment(domainDir) {
  let core;
  let pat;
  let manifest;
  if (fs.existsSync(domainDir) && fs.statSync(domainDir).isFile()) {
    const container = readContainer(domainDir);
    core = container.core || {};
    pat = container.patterns || {};
    manifest = container.manifest || {};
  } else {
    core = readJson(path.join(domainDir, 'KDNA_Core.json')) || {};
    pat = readJson(path.join(domainDir, 'KDNA_Patterns.json')) || {};
    manifest = readJson(path.join(domainDir, 'kdna.json')) || {};
  }

  const misunderstandings = Array.isArray(pat)
    ? []
    : Array.isArray(pat.misunderstandings)
      ? pat.misunderstandings
      : [];
  const bannedTerms = Array.isArray(pat) ? [] : pat.terminology?.banned_terms || [];

  return {
    version: manifest.version || '?',
    judgment_version: manifest.judgment_version || null,
    axioms: Object.fromEntries((core.axioms || []).map((a) => [a.id, a])),
    ontology: Object.fromEntries((core.ontology || []).map((o) => [o.id, o])),
    stances: (core.stances || [])
      .map((s) => (typeof s === 'string' ? s : s.stance))
      .filter(Boolean),
    misunderstandings: Object.fromEntries(misunderstandings.map((m) => [m.id, m])),
    banned_terms: Object.fromEntries(bannedTerms.map((t) => [t.term, t])),
  };
}

// ─── Set diff helpers ─────────────────────────────────────────────────

function diffMaps(label, oldMap, newMap, render, jsonMode = false, facts = null) {
  const out = { label, ...(facts || mapChanges(oldMap, newMap)) };
  const { added, removed, changed } = out;

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
    // Surface key diffs in optional authoring boundary fields
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

function diffStanceList(oldList, newList, jsonMode = false, facts = null) {
  const out = facts || listChanges(oldList, newList);
  const { added, removed } = out;
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
  if (b && !bParsed) error(`Cannot parse "${b}"`, EXIT.INPUT_ERROR);

  const resolver = new RegistryResolver({ allowNetwork: true });
  let resolvedA;
  let entryA;
  try {
    resolvedA = resolver.resolve(a);
    entryA = resolvedA.entry;
  } catch (e) {
    error(e.message, EXIT.REGISTRY_ERROR);
  }
  const canonicalName = resolvedA.parsed.full;

  // Determine targets
  let oldVersion, newVersion, oldEntry, newEntry;
  let oldJ = null;
  if (bParsed) {
    let resolvedB;
    try {
      resolvedB = resolver.resolve(b);
    } catch (e) {
      error(e.message, EXIT.REGISTRY_ERROR);
    }
    if (canonicalName !== resolvedB.parsed.full)
      error('Comparing across different domains is not supported.', EXIT.INPUT_ERROR);
    oldVersion = resolvedA.parsed.version || entryA.version;
    newVersion = resolvedB.parsed.version || resolvedB.entry.version;
    oldEntry = entryA;
    newEntry = resolvedB.entry;
  } else {
    // single-arg form: installed vs registry-current
    const installed = getInstalled(canonicalName);
    if (!installed) {
      error(`${canonicalName} not installed. Run: kdna install ${canonicalName}`, EXIT.INPUT_ERROR);
    }
    try {
      assertInstalledIntegrity(installed, `${canonicalName}@${installed.version}`);
      oldJ = loadJudgment(installed.asset_path);
    } catch (integrityError) {
      error(integrityError.message, EXIT.VALIDATION_FAILED);
    }
    oldVersion = installed.version;
    newVersion = entryA.version;
    newEntry = entryA;
    if (oldVersion === newVersion) {
      if (jsonMode) {
        console.log(
          JSON.stringify({ error: `${canonicalName}@${oldVersion}: only one version found.` }),
        );
        process.exit(EXIT.OK);
      }
      console.log(
        `${canonicalName}@${oldVersion}: only one version found.\n` +
          `To compare across versions, specify two: kdna diff ${canonicalName}@${oldVersion} ${canonicalName}@<other>`,
      );
      return;
    }
  }

  if (!jsonMode) {
    console.log('═'.repeat(64));
    console.log(`  kdna diff  ${canonicalName}`);
    console.log(`  ${oldVersion}  →  ${newVersion}`);
    console.log('═'.repeat(64));
  }

  // Download both versions to temp dirs
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-diff-'));
  const tmpOld = path.join(tempRoot, 'old');
  const tmpNew = path.join(tempRoot, 'new');
  let newJ;
  let fetching = `${canonicalName}@${oldVersion}`;
  try {
    if (oldEntry) {
      if (!jsonMode) console.log('Downloading old version...');
      downloadVersion(oldEntry, oldVersion, tmpOld, {
        expectedName: canonicalName,
        onVerifiedArchive(archivePath) {
          oldJ = loadJudgment(archivePath);
        },
      });
    }
    fetching = `${canonicalName}@${newVersion}`;
    if (!jsonMode) console.log('Downloading new version...');
    downloadVersion(newEntry, newVersion, tmpNew, {
      expectedName: canonicalName,
      onVerifiedArchive(archivePath) {
        newJ = loadJudgment(archivePath);
      },
    });
  } catch (downloadError) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    error(`Failed to download ${fetching}: ${downloadError.message}`, EXIT.PROVIDER_ERROR);
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });

  if (!jsonMode) {
    console.log('');
    console.log(
      '  judgment_version: ' +
        (oldJ.judgment_version || '(not declared)') +
        '  →  ' +
        (newJ.judgment_version || '(not declared)'),
    );
  }

  const changes = judgmentChanges(oldJ, newJ);
  const axiomsDiff = diffMaps(
    'axioms',
    oldJ.axioms,
    newJ.axioms,
    (a) => a.one_sentence || a.id,
    jsonMode,
    changes.axioms,
  );
  diffMaps(
    'ontology',
    oldJ.ontology,
    newJ.ontology,
    (o) => o.one_sentence || o.concept || o.id,
    jsonMode,
    changes.ontology,
  );
  const misunderstandingsDiff = diffMaps(
    'misunderstandings',
    oldJ.misunderstandings,
    newJ.misunderstandings,
    (m) => m.wrong || m.id,
    jsonMode,
    changes.misunderstandings,
  );
  diffMaps(
    'banned_terms',
    oldJ.banned_terms,
    newJ.banned_terms,
    (t) => t.term || '',
    jsonMode,
    changes.banned_terms,
  );
  diffStanceList(oldJ.stances, newJ.stances, jsonMode, changes.stances);

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

  const versionBump = recommendedVersionBump(changes);

  if (jsonMode) {
    const result = {
      domain: canonicalName,
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
      changes: jsonChanges(changes),
      recommended_version_bump: versionBump,
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

module.exports = { cmdDiff, downloadVersion, loadJudgment, parseNameVersion };
