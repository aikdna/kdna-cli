/**
 * kdna changelog <domain> --from <from-version> --to <to-version>
 *   Generate a judgment changelog between two versions.
 *
 * Reuses the diff engine from src/diff.js to compute changes,
 * then renders a human-readable markdown changelog.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { error, EXIT } = require('./_common');
const { loadJudgment } = require('../diff');
const { RegistryResolver } = require('../registry');
const { downloadAndExtractKdna } = require('../safe-archive');
const { describeDownloadFailure } = require('../https-download');
const { judgmentChanges, recommendedVersionBump } = require('../judgment-diff');

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
  return downloadAndExtractKdna(entry.asset_url, destDir, {
    ...downloadOptions,
    expected: {
      name: expectedName,
      version,
      assetDigest: entry.asset_digest,
    },
  });
}

function cmdChangelog(args = []) {
  const jsonMode = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const domainInput = positional[0];
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
  let oldEntry;
  let newEntry;
  try {
    ({ entry: oldEntry } = resolver.resolve(`${parsed.full}@${fromVersion}`));
    ({ entry: newEntry } = resolver.resolve(`${parsed.full}@${toVersion}`));
  } catch (e) {
    error(e.message, EXIT.REGISTRY_ERROR);
  }

  // Download both versions
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-changelog-'));
  const tmpOld = path.join(tempRoot, 'old');
  const tmpNew = path.join(tempRoot, 'new');
  let oldJ;
  let newJ;
  let fetching = `${parsed.full}@${fromVersion}`;
  try {
    if (!jsonMode) console.log(`Fetching ${fetching}...`);
    downloadVersion(oldEntry, fromVersion, tmpOld, {
      expectedName: parsed.full,
      onVerifiedArchive(archivePath) {
        oldJ = loadJudgment(archivePath);
      },
    });
    fetching = `${parsed.full}@${toVersion}`;
    if (!jsonMode) console.log(`Fetching ${fetching}...`);
    downloadVersion(newEntry, toVersion, tmpNew, {
      expectedName: parsed.full,
      onVerifiedArchive(archivePath) {
        newJ = loadJudgment(archivePath);
      },
    });
  } catch (downloadError) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    // Sterile error: asset coordinates + a stable download category (+ curl
    // exit code). Never the URL, URL parts, local paths, or server bytes.
    error(
      `Failed to download ${fetching}: ${describeDownloadFailure(downloadError)}`,
      EXIT.PROVIDER_ERROR,
    );
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });

  const changes = judgmentChanges(oldJ, newJ);
  const axioms = diffSummary(
    oldJ.axioms || {},
    newJ.axioms || {},
    ['one_sentence'],
    changes.axioms,
  );
  const ontology = diffSummary(
    oldJ.ontology || {},
    newJ.ontology || {},
    ['one_sentence', 'concept'],
    changes.ontology,
  );
  const misunderstandings = diffSummary(
    oldJ.misunderstandings || {},
    newJ.misunderstandings || {},
    ['wrong'],
    changes.misunderstandings,
  );
  const bannedTerms = listJsonChanges(changes.banned_terms);
  const stances = listJsonChanges(changes.stances);
  const recommendedBump = recommendedVersionBump(changes);

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
  if (bannedTerms.added.length || bannedTerms.removed.length || bannedTerms.changed.length) {
    console.log('### Banned Terms');
    for (const t of bannedTerms.added) console.log(`- **Added:** "${t}"`);
    for (const t of bannedTerms.removed) console.log(`- **Removed:** "${t}"`);
    for (const t of bannedTerms.changed) console.log(`- **Changed:** "${t}"`);
    console.log('');
  }
  if (stances.added.length || stances.removed.length) {
    console.log('### Stances');
    for (const s of stances.added) console.log(`- **Added:** "${s}"`);
    for (const s of stances.removed) console.log(`- **Removed:** "${s}"`);
    console.log('');
  }

  const changeCount =
    countSummaryChanges(axioms) +
    countSummaryChanges(ontology) +
    countSummaryChanges(misunderstandings) +
    countListChanges(bannedTerms) +
    countListChanges(stances);

  console.log(`---`);
  if (changeCount === 0) {
    console.log(`No judgment changes detected.`);
  } else {
    console.log(`**Recommended version bump: \`${recommendedBump}\`**`);
  }
}

function itemLabel(item, labelFields, fallback) {
  for (const field of labelFields) {
    if (item?.[field]) return item[field];
  }
  return fallback;
}

function diffSummary(oldMap, newMap, labelFields, facts) {
  const result = {};
  const oldIds = new Set(Object.keys(oldMap));
  const newIds = new Set(Object.keys(newMap));
  const addedIds = new Set(facts.added);
  const removedIds = new Set(facts.removed);
  const changedIds = new Set(facts.changed);

  for (const id of newIds) {
    if (addedIds.has(id)) {
      const item = newMap[id];
      result[id] = { status: 'added', label: itemLabel(item, labelFields, id) };
    }
  }
  for (const id of oldIds) {
    if (removedIds.has(id)) {
      const item = oldMap[id];
      result[id] = { status: 'removed', label: itemLabel(item, labelFields, id) };
    } else {
      const newItem = newMap[id];
      if (changedIds.has(id)) {
        result[id] = { status: 'changed', label: itemLabel(newItem, labelFields, id) };
      } else {
        result[id] = { status: 'unchanged', label: itemLabel(newItem, labelFields, id) };
      }
    }
  }
  return result;
}

function listJsonChanges(facts) {
  return {
    added: facts.added,
    removed: facts.removed,
    changed: facts.changed,
  };
}

function countSummaryChanges(summary) {
  return Object.values(summary || {}).filter((entry) => entry.status !== 'unchanged').length;
}

function countListChanges(changes) {
  return (
    (changes?.added?.length || 0) +
    (changes?.removed?.length || 0) +
    (changes?.changed?.length || 0)
  );
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

module.exports = { cmdChangelog, downloadVersion };
