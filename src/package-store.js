const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PATHS = require('./paths');
const { nameFromAssetId, parseName } = require('./registry');
const core = require('@aikdna/kdna-core');

if (typeof core.createKdnaAssetReader !== 'function') {
  throw new Error('@aikdna/kdna-core >=0.5.0 is required for direct .kdna asset loading');
}

const assetReader = core.createKdnaAssetReader();

const INDEX_VERSION = 2;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// ─── Two-tier store helpers (Story 2) ──────────────────────────────────
//
// `tier` is one of:
//   - 'global' — the user-global root at ~/.kdna/packages/ + index.json
//   - 'project' — the project-local root at ./.kdna/packages/ + index.json
//
// All index read/write operations take an explicit tier. The public
// `getInstalled` / `listInstalled` / `removeInstalled` functions
// implement the "project wins on conflict" merge over both tiers.

function indexPathFor(tier) {
  return tier === 'project' ? PATHS.projectIndex : PATHS.packageIndex;
}

function packagesDirFor(tier) {
  return tier === 'project' ? PATHS.projectPackages : PATHS.packages;
}

function readIndexFor(tier) {
  const data = readJsonFile(indexPathFor(tier));
  if (data?.packages && typeof data.packages === 'object') return data;
  return { version: INDEX_VERSION, packages: {} };
}

function writeIndexFor(tier, index) {
  index.version = INDEX_VERSION;
  writeJsonFile(indexPathFor(tier), index);
}

function assetDirFor(tier, scope, ident, version) {
  return path.join(packagesDirFor(tier), scope, ident, version || 'unknown');
}

function readIndex() {
  // Backward-compat alias. Reads the global index. New code should
  // pass an explicit tier to readIndexFor().
  return readIndexFor('global');
}

function writeIndex(index) {
  // Backward-compat alias. Writes the global index.
  writeIndexFor('global', index);
}

// `assetDir(scope, ident, version)` was the original (global-only)
// helper. It has been replaced by `assetDirFor(tier, scope, ident,
// version)`. Kept documented here for historical reference; the
// function is no longer exported — callers should use
// `assetDirFor` directly with an explicit tier.

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assetDigest(filePath) {
  return `sha256:${sha256File(filePath)}`;
}

function contentDigest(kdnaPath) {
  return assetReader.contentDigestSync(assetReader.openSync(kdnaPath));
}

function assetFileName(ident, version) {
  return `${ident}-${version || 'unknown'}.kdna`;
}

function readContainerJson(kdnaPath, fileName, options = {}) {
  const asset = assetReader.openSync(kdnaPath);
  return assetReader.readJsonSync(asset, fileName, options);
}

function readContainerDataMap(kdnaPath, options = {}) {
  const asset = assetReader.openSync(kdnaPath);
  const dataMap = readDataMapCompatSync(asset, options);
  if (asset.entries.has('kdna.json')) {
    dataMap['kdna.json'] = assetReader.readJsonSync(asset, 'kdna.json', options);
  }
  return dataMap;
}

function readContainerEntry(kdnaPath, fileName) {
  const asset = assetReader.openSync(kdnaPath);
  return assetReader.readEntrySync(asset, fileName);
}

function listContainerEntries(kdnaPath) {
  const asset = assetReader.openSync(kdnaPath);
  return assetReader.listEntriesSync(asset);
}

function readContainer(kdnaPath, options = {}) {
  const asset = assetReader.openSync(kdnaPath);
  const dataMap = readDataMapCompatSync(asset, options);
  return {
    manifest: dataMap['kdna.json'] || {},
    core: dataMap['KDNA_Core.json'] || {},
    patterns: dataMap['KDNA_Patterns.json'] || {},
    scenarios: dataMap['KDNA_Scenarios.json'] || null,
    cases: dataMap['KDNA_Cases.json'] || null,
    reasoning: dataMap['KDNA_Reasoning.json'] || null,
    evolution: dataMap['KDNA_Evolution.json'] || null,
    files: assetReader.listEntriesSync(asset),
  };
}

function readDataMapCompatSync(asset, options = {}) {
  try {
    return assetReader.readDataMapSync(asset, options);
  } catch (e) {
    if (asset.entries.has('payload.kdnab')) {
      try {
        const payload = JSON.parse(
          assetReader.readEntrySync(asset, 'payload.kdnab').toString('utf8'),
        );
        if (payload && typeof payload === 'object') {
          const judgment = payload.judgment || payload;
          return {
            ...(judgment.core ? { 'KDNA_Core.json': judgment.core } : {}),
            ...(judgment.patterns ? { 'KDNA_Patterns.json': judgment.patterns } : {}),
            ...(judgment.scenarios ? { 'KDNA_Scenarios.json': judgment.scenarios } : {}),
            ...(judgment.cases ? { 'KDNA_Cases.json': judgment.cases } : {}),
            ...(judgment.reasoning ? { 'KDNA_Reasoning.json': judgment.reasoning } : {}),
            ...(judgment.evolution ? { 'KDNA_Evolution.json': judgment.evolution } : {}),
          };
        }
      } catch {
        /* Preserve the original reader error below. */
      }
    }
    if (!String(e?.message || '').includes('missing payload.kdnab')) {
      throw e;
    }
  }

  const dataMap = {};
  for (const entry of [
    'KDNA_Core.json',
    'KDNA_Patterns.json',
    'KDNA_Scenarios.json',
    'KDNA_Cases.json',
    'KDNA_Reasoning.json',
    'KDNA_Evolution.json',
  ]) {
    if (asset.entries.has(entry)) {
      dataMap[entry] = assetReader.readJsonSync(asset, entry, options);
    }
  }
  return dataMap;
}

function verifyAsset(kdnaPath, options = {}) {
  const asset = assetReader.openSync(kdnaPath);
  return assetReader.verifySync(asset, options);
}

function getInstalled(input) {
  const parsed = parseName(input);
  if (!parsed) return null;
  // Project-local wins on conflict (roadmap-2026.md §5.1 Story 2).
  // Check project index first, then global.
  const projectIndex = readIndexFor('project');
  const projectEntry = projectIndex.packages[parsed.full];
  if (projectEntry?.asset_path && fs.existsSync(projectEntry.asset_path)) {
    return { ...projectEntry, parsed, tier: 'project' };
  }
  const globalIndex = readIndexFor('global');
  const globalEntry = globalIndex.packages[parsed.full];
  if (globalEntry?.asset_path && fs.existsSync(globalEntry.asset_path)) {
    return { ...globalEntry, parsed, tier: 'global' };
  }
  return null;
}

function listInstalled() {
  // Merge: project entries override global entries on name conflict.
  // Each entry gets a `tier` field ('project' | 'global') so callers
  // can show the user where each package lives.
  const projectIndex = readIndexFor('project');
  const globalIndex = readIndexFor('global');
  const merged = new Map();
  // Global first so the project map can override.
  for (const [full, entry] of Object.entries(globalIndex.packages)) {
    if (entry?.asset_path && fs.existsSync(entry.asset_path)) {
      merged.set(full, { full, ...entry, tier: 'global' });
    }
  }
  for (const [full, entry] of Object.entries(projectIndex.packages)) {
    if (entry?.asset_path && fs.existsSync(entry.asset_path)) {
      merged.set(full, { full, ...entry, tier: 'project' });
    }
  }
  return [...merged.values()].sort((a, b) => a.full.localeCompare(b.full));
}

function readAssetManifest(assetPath) {
  return readContainerJson(assetPath, 'kdna.json') || {};
}

function installNameFromManifest(manifest) {
  return manifest.name || nameFromAssetId(manifest.asset_id) || null;
}

function receiptPathForAsset(assetPath) {
  return path.join(path.dirname(assetPath), 'receipt.json');
}

function installAsset({ sourcePath, name, version, source = {}, local = false }) {
  const parsed = parseName(name);
  if (!parsed) throw new Error(`Invalid scoped domain name: ${name}`);
  const finalVersion = version || 'unknown';
  const tier = local ? 'project' : 'global';
  const destDir = assetDirFor(tier, parsed.scope, parsed.ident, finalVersion);
  const dest = path.join(destDir, assetFileName(parsed.ident, finalVersion));
  ensureDir(destDir);
  fs.copyFileSync(sourcePath, dest);

  const manifest = readAssetManifest(dest);
  const installedAt = new Date().toISOString();
  const computedAssetDigest = assetDigest(dest);
  const computedContentDigest = contentDigest(dest);
  const receiptPath = receiptPathForAsset(dest);
  const receipt = {
    version: 1,
    name: parsed.full,
    tier,
    asset_path: dest,
    asset_digest: computedAssetDigest,
    content_digest: computedContentDigest,
    package_version: finalVersion,
    judgment_version: manifest.judgment_version || null,
    access: manifest.access || 'public',
    signature: manifest.signature || null,
    installed_at: installedAt,
    source,
  };
  writeJsonFile(receiptPath, receipt);

  const index = readIndexFor(tier);
  index.packages[parsed.full] = {
    name: parsed.full,
    version: finalVersion,
    tier,
    asset_path: dest,
    receipt_path: receiptPath,
    asset_digest: computedAssetDigest,
    content_digest: computedContentDigest,
    judgment_version: manifest.judgment_version || null,
    access: manifest.access || 'public',
    signature: manifest.signature || null,
    installed_at: installedAt,
    source,
  };
  writeIndexFor(tier, index);
  return index.packages[parsed.full];
}

function resolveAsset(input) {
  const expanded = input.replace(/^~/, process.env.HOME || '');
  const looksLikeFile =
    input.endsWith('.kdna') &&
    (input.startsWith('./') ||
      input.startsWith('/') ||
      input.startsWith('~/') ||
      fs.existsSync(expanded));
  if (looksLikeFile) {
    const abs = path.resolve(expanded);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const manifest = readAssetManifest(abs);
    const full = installNameFromManifest(manifest);
    const parsed = full ? parseName(full) : null;
    return {
      name: full || path.basename(abs, '.kdna'),
      parsed,
      asset_path: abs,
      receipt_path: null,
      version: manifest.version || null,
      judgment_version: manifest.judgment_version || null,
      access: manifest.access || 'public',
      asset_digest: assetDigest(abs),
      content_digest: contentDigest(abs),
      source: { type: 'local-file', path: abs },
      local_file: true,
    };
  }
  return getInstalled(input);
}

function removeInstalled(input) {
  const parsed = parseName(input);
  if (!parsed) return false;
  // Project wins on conflict — try project first, fall back to global.
  for (const tier of ['project', 'global']) {
    const index = readIndexFor(tier);
    const entry = index.packages[parsed.full];
    if (entry) {
      delete index.packages[parsed.full];
      writeIndexFor(tier, index);
      if (entry.asset_path) {
        const versionDir = path.dirname(entry.asset_path);
        fs.rmSync(versionDir, { recursive: true, force: true });
      }
      return true;
    }
  }
  return false;
}

module.exports = {
  readIndex,
  writeIndex,
  sha256File,
  assetDigest,
  contentDigest,
  readContainer,
  readContainerDataMap,
  readContainerEntry,
  readContainerJson,
  readAssetManifest,
  listContainerEntries,
  verifyAsset,
  getInstalled,
  listInstalled,
  installAsset,
  resolveAsset,
  removeInstalled,
};
