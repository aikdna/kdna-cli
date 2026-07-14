/**
 * kdna changelog <domain> --from <v1> --to <v2>
 *   Generate a judgment changelog between two versions.
 *
 * Reuses the diff engine from src/diff.js to compute changes,
 * then renders a human-readable markdown changelog.
 */

const fs = require('fs');
const path = require('path');
const { error, EXIT } = require('./_common');
const { loadJudgment } = require('../diff');
const { RegistryResolver } = require('../registry');

const TMP_DIR = '/tmp';

function downloadVersion(entry, version, destDir) {
  const { execFileSync } = require('child_process');
  const tmpFile = `${destDir}.kdna.tmp`;
  try {
    execFileSync('curl', ['-fsSL', '--retry', '2', '-o', tmpFile, entry.asset_url], {
      timeout: 60000,
      stdio: 'pipe',
    });
  } catch (e) {
    const stderr = e.stderr?.toString().trim() || e.message;
    error(`Failed to download: ${stderr}`, EXIT.PROVIDER_ERROR);
  }
  fs.mkdirSync(destDir, { recursive: true });
  try {
    try {
      execFileSync('unzip', ['-q', '-o', tmpFile, '-d', destDir], { stdio: 'pipe' });
    } catch {
      const script = `import zipfile\nzf = zipfile.ZipFile(${JSON.stringify(tmpFile)}, 'r')\nzf.extractall(${JSON.stringify(destDir)})`;
      execFileSync('python3', ['-c', script], { stdio: 'pipe' });
    }
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
  return destDir;
}

function cmdChangelog(args = []) {
  const jsonMode = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const domainInput = positional[1];
  const fromIdx = args.indexOf('--from');
  const toIdx = args.indexOf('--to');
  const fromVersion = fromIdx >= 0 ? args[fromIdx + 1] : null;
  const toVersion = toIdx >= 0 ? args[toIdx + 1] : null;

  if (!domainInput || !fromVersion || !toVersion) {
    error(
      'Usage:\n' +
        '  kdna changelog <domain> --from <version> --to <version> [--json]\n' +
        '\n' +
        'Generates a judgment changelog between two domain versions.\n' +
        'Versions are fetched from the registry.',
      EXIT.INPUT_ERROR,
    );
  }

  // Resolve domain from registry
  let parsed;
  try {
    const { parseName } = require('../registry');
    parsed = parseName(domainInput);
  } catch {
    error(`Invalid domain name: ${domainInput}`, EXIT.INPUT_ERROR);
  }
  if (!parsed) error(`Cannot parse "${domainInput}"`, EXIT.INPUT_ERROR);

  const resolver = new RegistryResolver({ allowNetwork: true });
  let entry;
  try {
    ({ entry } = resolver.resolve(parsed.reference || parsed.full));
  } catch (e) {
    error(e.message, EXIT.REGISTRY_ERROR);
  }

  // Download both versions
  const tmpOld = path.join(TMP_DIR, `kdna-changelog-${Date.now()}-old`);
  const tmpNew = path.join(TMP_DIR, `kdna-changelog-${Date.now()}-new`);

  if (!jsonMode) console.log(`Fetching ${parsed.full}@${fromVersion}...`);
  downloadVersion(entry, fromVersion, tmpOld);
  if (!jsonMode) console.log(`Fetching ${parsed.full}@${toVersion}...`);
  downloadVersion(entry, toVersion, tmpNew);

  const oldJ = loadJudgment(tmpOld);
  const newJ = loadJudgment(tmpNew);

  // Diff maps
  const axioms = diffSummary(oldJ.axioms || {}, newJ.axioms || {}, 'one_sentence');
  const ontology = diffSummary(oldJ.ontology || {}, newJ.ontology || {}, 'concept');
  const misunderstandings = diffSummary(
    oldJ.misunderstandings || {},
    newJ.misunderstandings || {},
    'wrong',
  );
  const bannedTerms = diffList(
    Object.keys(oldJ.banned_terms || {}),
    Object.keys(newJ.banned_terms || {}),
  );
  const stances = diffList(oldJ.stances || [], newJ.stances || []);

  // Version bump suggestion
  const hasRemoved =
    Object.values(axioms).some((a) => a.status === 'removed') ||
    Object.values(misunderstandings).some((m) => m.status === 'removed');
  const hasAdded =
    Object.values(axioms).some((a) => a.status === 'added') ||
    Object.values(misunderstandings).some((m) => m.status === 'added');
  const hasChanged =
    Object.values(axioms).some((a) => a.status === 'changed') ||
    Object.values(misunderstandings).some((m) => m.status === 'changed');
  let recommendedBump = 'none';
  if (hasRemoved) recommendedBump = 'major';
  else if (hasAdded || hasChanged) recommendedBump = 'minor';
  else if (stances.added.length || stances.removed.length) recommendedBump = 'patch';

  // Cleanup
  try {
    fs.rmSync(tmpOld, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }
  try {
    fs.rmSync(tmpNew, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }

  // Output
  const changelog = {
    domain: parsed.full,
    from: fromVersion,
    to: toVersion,
    judgment_version: {
      before: oldJ.judgment_version || null,
      after: newJ.judgment_version || null,
    },
    changes: {
      axioms,
      ontology,
      misunderstandings,
      banned_terms: bannedTerms,
      stances,
    },
    recommended_version_bump: recommendedBump,
  };

  if (jsonMode) {
    console.log(JSON.stringify(changelog, null, 2));
    return;
  }

  // Human-readable markdown
  console.log(`# ${parsed.full} changelog`);
  console.log(`## ${fromVersion} → ${toVersion}`);
  console.log('');
  if (oldJ.judgment_version || newJ.judgment_version) {
    console.log(
      `Judgment version: ${oldJ.judgment_version || '(none)'} → ${newJ.judgment_version || '(none)'}`,
    );
    console.log('');
  }

  renderSection('Axioms', axioms);
  renderSection('Ontology', ontology);
  renderSection('Misunderstandings', misunderstandings);
  if (bannedTerms.added.length || bannedTerms.removed.length) {
    console.log('### Banned Terms');
    for (const t of bannedTerms.added) console.log(`- **Added:** "${t}"`);
    for (const t of bannedTerms.removed) console.log(`- **Removed:** "${t}"`);
    console.log('');
  }
  if (stances.added.length || stances.removed.length) {
    console.log('### Stances');
    for (const s of stances.added) console.log(`- **Added:** "${s}"`);
    for (const s of stances.removed) console.log(`- **Removed:** "${s}"`);
    console.log('');
  }

  const changeCount = Object.values(changelog.changes).reduce((sum, v) => {
    if (Array.isArray(v)) return sum + (v.added?.length || 0) + (v.removed?.length || 0);
    return sum + Object.values(v || {}).filter((x) => x.status !== 'unchanged').length;
  }, 0);

  console.log(`---`);
  if (changeCount === 0) {
    console.log(`No judgment changes detected.`);
  } else {
    console.log(`**Recommended version bump: \`${recommendedBump}\`**`);
  }
}

function diffSummary(oldMap, newMap, labelField) {
  const result = {};
  const oldIds = new Set(Object.keys(oldMap));
  const newIds = new Set(Object.keys(newMap));

  for (const id of newIds) {
    if (!oldIds.has(id)) {
      const item = newMap[id];
      result[id] = { status: 'added', label: item[labelField] || id };
    }
  }
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      const item = oldMap[id];
      result[id] = { status: 'removed', label: item[labelField] || id };
    } else {
      const oldItem = oldMap[id];
      const newItem = newMap[id];
      if (JSON.stringify(oldItem) !== JSON.stringify(newItem)) {
        result[id] = { status: 'changed', label: newItem[labelField] || id };
      } else {
        result[id] = { status: 'unchanged', label: newItem[labelField] || id };
      }
    }
  }
  return result;
}

function diffList(oldList, newList) {
  const oldSet = new Set(oldList);
  const newSet = new Set(newList);
  return {
    added: newList.filter((s) => !oldSet.has(s)),
    removed: oldList.filter((s) => !newSet.has(s)),
  };
}

function renderSection(title, items) {
  const added = Object.entries(items).filter(([, v]) => v.status === 'added');
  const removed = Object.entries(items).filter(([, v]) => v.status === 'removed');
  const changed = Object.entries(items).filter(([, v]) => v.status === 'changed');

  if (!added.length && !removed.length && !changed.length) return;

  console.log(`### ${title}`);
  for (const [, v] of added) console.log(`- **Added:** ${v.label}`);
  for (const [, v] of removed) console.log(`- **Removed:** ${v.label}`);
  for (const [, v] of changed) console.log(`- **Changed:** ${v.label}`);
  console.log('');
}

module.exports = { cmdChangelog };
