const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PATHS = require('./paths');
const { parseName } = require('./registry');
const core = require('@aikdna/kdna-core');

if (typeof core.createKdnaAssetReader !== 'function') {
  throw new Error('@aikdna/kdna-core >=0.5.0 is required for direct .kdna asset loading');
}

const assetReader = core.createKdnaAssetReader();

const V1_ENTRIES = [
  'KDNA_Core.json',
  'KDNA_Patterns.json',
  'KDNA_Scenarios.json',
  'KDNA_Cases.json',
  'KDNA_Reasoning.json',
  'KDNA_Evolution.json',
];

function validateContainerV2(asset, assetPath) {
  const hasPayload = asset.entries.has('payload.kdnab');
  if (hasPayload) return; // v2, OK
  const hasV1 = V1_ENTRIES.some((e) => asset.entries.has(e));
  if (!hasV1) return; // neither v1 nor v2, probably empty — let caller decide
  const found = V1_ENTRIES.filter((e) => asset.entries.has(e));
  const msg = `ERR_LEGACY_PLAINTEXT_CONTAINER: This .kdna uses the removed v1 plaintext ZIP format (found: ${found.join(', ')}). Rebuild from source with KDNA Container v2.`;
  throw Object.assign(new Error(msg), { code: 'ERR_LEGACY_PLAINTEXT_CONTAINER' });
}

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

function readIndex() {
  const data = readJsonFile(PATHS.packageIndex);
  if (data?.packages && typeof data.packages === 'object') return data;
  return { version: INDEX_VERSION, packages: {} };
}

function writeIndex(index) {
  index.version = INDEX_VERSION;
  writeJsonFile(PATHS.packageIndex, index);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assetDigest(filePath) {
  return `sha256:${sha256File(filePath)}`;
}

function contentDigest(kdnaPath) {
  return assetReader.contentDigestSync(assetReader.openSync(kdnaPath));
}

function assetDir(scope, ident, version) {
  return path.join(PATHS.packages, scope, ident, version || 'unknown');
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
  if (asset.entries.has('payload.kdnab')) {
    const dataMap = assetReader.readDataMapSync(asset, undefined, options);
    // readDataMapSync only returns judgment files — add kdna.json explicitly
    if (asset.entries.has('kdna.json')) {
      dataMap['kdna.json'] = assetReader.readJsonSync(asset, 'kdna.json', options);
    }
    return dataMap;
  }
  // v1 fallback: read individual JSON files
  const dataMap = {};
  const v1Files = [
    'kdna.json',
    'KDNA_Core.json',
    'KDNA_Patterns.json',
    'KDNA_Scenarios.json',
    'KDNA_Cases.json',
    'KDNA_Reasoning.json',
    'KDNA_Evolution.json',
  ];
  for (const f of v1Files) {
    if (asset.entries.has(f)) {
      try {
        dataMap[f] = assetReader.readJsonSync(asset, f, options);
      } catch {
        /* skip */
      }
    }
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
  validateContainerV2(asset, kdnaPath);
  const dataMap = assetReader.readDataMapSync(asset, undefined, options);
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

function verifyAsset(kdnaPath, options = {}) {
  const asset = assetReader.openSync(kdnaPath);
  return assetReader.verifySync(asset, options);
}

function getInstalled(input) {
  const parsed = parseName(input);
  if (!parsed) return null;
  const index = readIndex();
  const entry = index.packages[parsed.full];
  if (!entry?.asset_path || !fs.existsSync(entry.asset_path)) return null;
  return { ...entry, parsed };
}

function listInstalled() {
  const index = readIndex();
  return Object.entries(index.packages)
    .map(([full, entry]) => ({ full, ...entry }))
    .filter((entry) => entry.asset_path && fs.existsSync(entry.asset_path))
    .sort((a, b) => a.full.localeCompare(b.full));
}

function readAssetManifest(assetPath) {
  return readContainerJson(assetPath, 'kdna.json') || {};
}

function receiptPathForAsset(assetPath) {
  return path.join(path.dirname(assetPath), 'receipt.json');
}

function installAsset({ sourcePath, name, version, source = {} }) {
  const parsed = parseName(name);
  if (!parsed) throw new Error(`Invalid scoped domain name: ${name}`);
  const finalVersion = version || 'unknown';
  const destDir = assetDir(parsed.scope, parsed.ident, finalVersion);
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
    asset_path: dest,
    asset_digest: computedAssetDigest,
    content_digest: computedContentDigest,
    package_version: finalVersion,
    judgment_version: manifest.judgment_version || null,
    access: manifest.access || 'open',
    signature: manifest.signature || null,
    installed_at: installedAt,
    source,
  };
  writeJsonFile(receiptPath, receipt);

  const index = readIndex();
  index.packages[parsed.full] = {
    name: parsed.full,
    version: finalVersion,
    asset_path: dest,
    receipt_path: receiptPath,
    asset_digest: computedAssetDigest,
    content_digest: computedContentDigest,
    judgment_version: manifest.judgment_version || null,
    access: manifest.access || 'open',
    signature: manifest.signature || null,
    installed_at: installedAt,
    source,
  };
  writeIndex(index);
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
    const full = manifest.name;
    const parsed = full ? parseName(full) : null;
    return {
      name: full || path.basename(abs, '.kdna'),
      parsed,
      asset_path: abs,
      receipt_path: null,
      version: manifest.version || null,
      judgment_version: manifest.judgment_version || null,
      access: manifest.access || 'open',
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
  const index = readIndex();
  const entry = index.packages[parsed.full];
  if (!entry) return false;
  delete index.packages[parsed.full];
  writeIndex(index);
  if (entry.asset_path) {
    const versionDir = path.dirname(entry.asset_path);
    fs.rmSync(versionDir, { recursive: true, force: true });
  }
  return true;
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
