const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PATHS = require('./paths');
const { nameFromAssetId, parseName, compareExactVersions } = require('./registry');
const core = require('@aikdna/kdna-core');
const cbor = require('cbor-x');

if (typeof core.createKdnaAssetReader !== 'function') {
  throw new Error('@aikdna/kdna-core >=0.5.0 is required for direct .kdna asset loading');
}

const assetReader = core.createKdnaAssetReader();

const INDEX_VERSION = 3;
const INDEX_LOCK_TIMEOUT_MS = 60000;
const INDEX_LOCK_STALE_MS = 30000;

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
  const dir = path.dirname(file);
  ensureDir(dir);
  const temporary = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(data, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    try {
      const directoryDescriptor = fs.openSync(dir, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {
      // Directory fsync is not available on every supported platform.
    }
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* best effort */
      }
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function withIndexLock(tier, callback) {
  const indexPath = indexPathFor(tier);
  const lockDir = `${indexPath}.lock`;
  const recoveryDir = `${lockDir}.recovery`;
  const ownerPath = path.join(lockDir, 'owner.json');
  const started = Date.now();
  ensureDir(path.dirname(indexPath));

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      try {
        fs.writeFileSync(
          ownerPath,
          JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
      } catch (ownerError) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        throw ownerError;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        const owner = readJsonFile(ownerPath);
        stale = age >= INDEX_LOCK_STALE_MS && (!owner || !processIsAlive(owner.pid));
      } catch {
        // A lock owner may still be creating its owner record.
      }
      if (stale) {
        try {
          fs.mkdirSync(recoveryDir);
          try {
            const age = Date.now() - fs.statSync(lockDir).mtimeMs;
            const owner = readJsonFile(ownerPath);
            if (age >= INDEX_LOCK_STALE_MS && (!owner || !processIsAlive(owner.pid))) {
              fs.rmSync(lockDir, { recursive: true });
            }
          } finally {
            fs.rmSync(recoveryDir, { recursive: true, force: true });
          }
        } catch {
          // Another process may have recovered it first.
        }
        continue;
      }
      if (Date.now() - started >= INDEX_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the ${tier} package index lock.`);
      }
      waitSync(20);
    }
  }

  try {
    return callback();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
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

function compareVersions(a, b) {
  return compareExactVersions(a, b);
}

function latestVersion(versions) {
  return (
    Object.keys(versions || {})
      .sort(compareVersions)
      .at(-1) || null
  );
}

function normalizePackageRecord(full, record) {
  if (!record || typeof record !== 'object') return null;

  const versions = {};
  if (record.versions && typeof record.versions === 'object') {
    for (const [version, entry] of Object.entries(record.versions)) {
      if (!entry || typeof entry !== 'object') continue;
      versions[version] = {
        ...entry,
        name: entry.name || full,
        version: entry.version || version,
      };
    }
  } else if (record.asset_path) {
    const version = record.version || 'unknown';
    versions[version] = { ...record, name: record.name || full, version };
  }

  const activeVersion =
    (record.active_version && versions[record.active_version] && record.active_version) ||
    (record.version && versions[record.version] && record.version) ||
    latestVersion(versions);
  if (!activeVersion) return null;

  const active = versions[activeVersion];
  return {
    ...active,
    name: active.name || full,
    active_version: activeVersion,
    versions,
  };
}

function normalizeIndex(data) {
  const normalized = { version: INDEX_VERSION, packages: {} };
  if (!data?.packages || typeof data.packages !== 'object') return normalized;
  for (const [full, record] of Object.entries(data.packages)) {
    const next = normalizePackageRecord(full, record);
    if (next) normalized.packages[full] = next;
  }
  return normalized;
}

function selectVersion(record, version = null) {
  if (!record) return null;
  const selectedVersion = version || record.active_version;
  return selectedVersion && record.versions?.[selectedVersion]
    ? record.versions[selectedVersion]
    : null;
}

function installedIntegrity(entry) {
  const problems = [];
  if (!entry?.asset_path) {
    return { valid: false, problems: ['installed asset path is missing'] };
  }
  let actualAssetDigest = null;
  let actualContentDigest = null;
  let receipt = null;
  try {
    const stat = fs.lstatSync(entry.asset_path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      problems.push('installed asset is not a regular file');
    } else {
      actualAssetDigest = assetDigest(entry.asset_path);
      if (!entry.asset_digest || actualAssetDigest !== entry.asset_digest) {
        problems.push('asset digest does not match the install receipt');
      }
      actualContentDigest = contentDigest(entry.asset_path);
      if (!entry.content_digest || actualContentDigest !== entry.content_digest) {
        problems.push('content digest does not match the install receipt');
      }
    }
  } catch (error) {
    problems.push(`installed asset cannot be verified: ${error.message}`);
  }
  try {
    if (!entry.receipt_path || fs.lstatSync(entry.receipt_path).isSymbolicLink()) {
      problems.push('install receipt is missing or is a symbolic link');
    } else {
      receipt = readJsonFile(entry.receipt_path);
      if (!receipt) {
        problems.push('install receipt is not valid JSON');
      } else {
        if (receipt.name !== entry.name || receipt.package_version !== entry.version) {
          problems.push('install receipt identity does not match the index');
        }
        if (
          receipt.asset_path !== entry.asset_path ||
          receipt.asset_digest !== entry.asset_digest ||
          receipt.content_digest !== entry.content_digest
        ) {
          problems.push('install receipt does not match the index digests or path');
        }
      }
    }
  } catch (error) {
    problems.push(`install receipt cannot be verified: ${error.message}`);
  }
  return {
    valid: problems.length === 0,
    problems,
    actual_asset_digest: actualAssetDigest,
    actual_content_digest: actualContentDigest,
    receipt,
  };
}

function assertInstalledIntegrity(entry, reference) {
  const integrity = installedIntegrity(entry);
  if (!integrity.valid) {
    throw new Error(
      `Installed ${reference} failed integrity: ${integrity.problems.join('; ')}. ` +
        `Run "kdna remove ${reference}", then reinstall it from a trusted source.`,
    );
  }
  return integrity;
}

function recoverReceiptEntry(tier, scope, ident, version, versionDir) {
  const full = `${scope}/${ident}`;
  if (!parseName(full)) return null;
  const assetPath = path.join(versionDir, assetFileName(ident, version));
  const receiptPath = receiptPathForAsset(assetPath);
  try {
    if (fs.lstatSync(assetPath).isSymbolicLink() || fs.lstatSync(receiptPath).isSymbolicLink()) {
      return null;
    }
    const receipt = readJsonFile(receiptPath);
    if (
      !receipt ||
      receipt.name !== full ||
      receipt.tier !== tier ||
      receipt.package_version !== version
    ) {
      return null;
    }
    const manifest = readAssetManifest(assetPath);
    if (installNameFromManifest(manifest) !== full || manifest.version !== version) return null;
    if (typeof core.validate === 'function' && core.validate(assetPath)?.overall_valid !== true) {
      return null;
    }
    const computedAssetDigest = assetDigest(assetPath);
    const computedContentDigest = contentDigest(assetPath);
    if (
      receipt.asset_digest !== computedAssetDigest ||
      receipt.content_digest !== computedContentDigest
    ) {
      return null;
    }
    return {
      name: full,
      version,
      tier,
      asset_path: assetPath,
      receipt_path: receiptPath,
      asset_digest: computedAssetDigest,
      content_digest: computedContentDigest,
      judgment_version: receipt.judgment_version || manifest.judgment_version || null,
      access: receipt.access || manifest.access || 'public',
      signature: receipt.signature || manifest.signature || null,
      installed_at: receipt.installed_at || null,
      source: receipt.source || { type: 'recovered-receipt' },
    };
  } catch {
    return null;
  }
}

function recoverOrphanVersions(tier, index) {
  const packagesDir = packagesDirFor(tier);
  let scopeEntries;
  try {
    scopeEntries = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return index;
  }

  for (const scopeEntry of scopeEntries) {
    if (
      !scopeEntry.isDirectory() ||
      scopeEntry.isSymbolicLink() ||
      !scopeEntry.name.startsWith('@')
    ) {
      continue;
    }
    const scopeDir = path.join(packagesDir, scopeEntry.name);
    let identEntries;
    try {
      identEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const identEntry of identEntries) {
      if (!identEntry.isDirectory() || identEntry.isSymbolicLink()) continue;
      const identDir = path.join(scopeDir, identEntry.name);
      let versionEntries;
      try {
        versionEntries = fs.readdirSync(identDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const versionEntry of versionEntries) {
        if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink()) continue;
        const full = `${scopeEntry.name}/${identEntry.name}`;
        const existing = index.packages[full];
        if (existing?.versions?.[versionEntry.name]) continue;
        const recovered = recoverReceiptEntry(
          tier,
          scopeEntry.name,
          identEntry.name,
          versionEntry.name,
          path.join(identDir, versionEntry.name),
        );
        if (!recovered) continue;
        const versions = { ...(existing?.versions || {}), [recovered.version]: recovered };
        index.packages[full] = normalizePackageRecord(full, {
          active_version: existing?.active_version || latestVersion(versions),
          versions,
        });
      }
    }
  }
  return index;
}

function readIndexFor(tier) {
  const data = readJsonFile(indexPathFor(tier));
  return recoverOrphanVersions(tier, normalizeIndex(data));
}

function writeIndexForUnlocked(tier, index) {
  writeJsonFile(indexPathFor(tier), normalizeIndex(index));
}

function mergeIndexes(currentData, incomingData) {
  const current = normalizeIndex(currentData);
  const incoming = normalizeIndex(incomingData);
  const merged = normalizeIndex(current);
  for (const [full, incomingRecord] of Object.entries(incoming.packages)) {
    const currentRecord = merged.packages[full];
    const versions = {
      ...(currentRecord?.versions || {}),
      ...(incomingRecord.versions || {}),
    };
    merged.packages[full] = normalizePackageRecord(full, {
      active_version: currentRecord?.active_version || incomingRecord.active_version,
      versions,
    });
  }
  return merged;
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
  // Backward-compat alias. A stale caller may add recovered entries, but may
  // not erase packages or change the active version committed by another process.
  withIndexLock('global', () => {
    const current = readIndexFor('global');
    writeIndexForUnlocked('global', mergeIndexes(current, index));
  });
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
    manifest: asset.entries.has('kdna.json')
      ? assetReader.readJsonSync(asset, 'kdna.json', options)
      : {},
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
    const projected = assetReader.readDataMapSync(asset, options);
    // Core 0.17 projects only the historical payload.judgment envelope and
    // returns an empty map for the formal top-level payload shape. Newer Core
    // deliberately rejects this legacy projection API. In either case, use
    // the same payload bytes to provide package-store's compatibility view.
    if (Object.keys(projected || {}).length > 0 || !asset.entries.has('payload.kdnab')) {
      return projected || {};
    }
  } catch (e) {
    const message = String(e?.message || '');
    const canProjectCurrentPayload =
      asset.entries.has('payload.kdnab') &&
      (e?.code === 'KDNA_LEGACY_DATA_MAP_UNSUPPORTED' ||
        message.includes('legacy source-tree API'));
    const canReadHistoricalEntries =
      !asset.entries.has('payload.kdnab') && message.includes('payload.kdnab');
    if (!canProjectCurrentPayload && !canReadHistoricalEntries) {
      throw e;
    }
  }

  if (asset.entries.has('payload.kdnab')) {
    let payload;
    try {
      payload = cbor.decode(assetReader.readEntrySync(asset, 'payload.kdnab'));
    } catch (e) {
      throw new Error(`payload.kdnab could not be decoded: ${e.message}`);
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error('payload.kdnab did not decode to a KDNA judgment object');
    }
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
  // Project-local wins on the same name/version. An explicit version may
  // still fall back to the global tier when the project tier does not carry it.
  for (const tier of ['project', 'global']) {
    const index = readIndexFor(tier);
    const record = index.packages[parsed.full];
    const entry = selectVersion(record, parsed.version);
    if (entry?.asset_path && fs.existsSync(entry.asset_path)) {
      return {
        ...entry,
        parsed,
        tier,
        active: record.active_version === entry.version,
        active_version: record.active_version,
      };
    }
  }
  return null;
}

function listInstalled(options = {}) {
  const allVersions = options.allVersions === true;
  // Merge: project entries override global entries on name conflict.
  // Each entry gets a `tier` field ('project' | 'global') so callers
  // can show the user where each package lives.
  const projectIndex = readIndexFor('project');
  const globalIndex = readIndexFor('global');
  const merged = new Map();

  const addTier = (index, tier) => {
    for (const [full, record] of Object.entries(index.packages)) {
      if (allVersions) {
        for (const [version, entry] of Object.entries(record.versions || {})) {
          if (entry?.asset_path && fs.existsSync(entry.asset_path)) {
            merged.set(`${full}@${version}`, {
              full,
              ...entry,
              tier,
              active_version: record.active_version,
            });
          }
        }
      } else {
        const entry = selectVersion(record);
        if (entry?.asset_path && fs.existsSync(entry.asset_path)) {
          merged.set(full, {
            full,
            ...entry,
            tier,
            active: true,
            active_version: record.active_version,
          });
        }
      }
    }
  };

  // Global first so the project map can override the same key.
  addTier(globalIndex, 'global');
  addTier(projectIndex, 'project');

  const entries = [...merged.values()];
  if (allVersions) {
    const selectedByName = new Map();
    for (const entry of listInstalled()) selectedByName.set(entry.full, entry);
    for (const entry of entries) {
      const selected = selectedByName.get(entry.full);
      entry.active = Boolean(
        selected && selected.tier === entry.tier && selected.version === entry.version,
      );
    }
  }
  return entries.sort(
    (a, b) => a.full.localeCompare(b.full) || compareVersions(a.version, b.version),
  );
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

function installAssetUnlocked({ sourcePath, name, version, source = {}, local = false }) {
  const parsed = parseName(name);
  if (!parsed) throw new Error(`Invalid scoped domain name: ${name}`);
  const finalVersion = version || 'unknown';
  const tier = local ? 'project' : 'global';
  const destDir = assetDirFor(tier, parsed.scope, parsed.ident, finalVersion);
  const dest = path.join(destDir, assetFileName(parsed.ident, finalVersion));
  const receiptPath = receiptPathForAsset(dest);
  const manifest = readAssetManifest(sourcePath);
  const manifestName = installNameFromManifest(manifest);
  if (manifestName !== parsed.full) {
    throw new Error(
      `Asset identity mismatch: expected ${parsed.full}, manifest declares ${manifestName || 'none'}.`,
    );
  }
  if (manifest.version !== finalVersion) {
    throw new Error(
      `Asset version mismatch: expected ${finalVersion}, manifest declares ${manifest.version || 'none'}.`,
    );
  }
  const sourceAssetDigest = assetDigest(sourcePath);
  const sourceContentDigest = contentDigest(sourcePath);

  const index = readIndexFor(tier);
  const existing = index.packages[parsed.full];
  const existingVersion = existing?.versions?.[finalVersion];
  if (existingVersion) {
    if (
      existingVersion.asset_digest !== sourceAssetDigest ||
      existingVersion.content_digest !== sourceContentDigest
    ) {
      throw new Error(
        `${parsed.full}@${finalVersion} is already installed with a different immutable digest.`,
      );
    }
    if (!existingVersion.asset_path || !fs.existsSync(existingVersion.asset_path)) {
      throw new Error(
        `${parsed.full}@${finalVersion} has a missing installed asset; repair it first.`,
      );
    }
    assertInstalledIntegrity(existingVersion, `${parsed.full}@${finalVersion}`);
    index.packages[parsed.full] = normalizePackageRecord(parsed.full, {
      active_version: finalVersion,
      versions: existing.versions,
    });
    writeIndexForUnlocked(tier, index);
    return existingVersion;
  }

  if (fs.existsSync(destDir)) {
    throw new Error(
      `Refusing to overwrite unindexed version directory for ${parsed.full}@${finalVersion}.`,
    );
  }

  ensureDir(path.dirname(destDir));
  const stagingDir = `${destDir}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const stagedAsset = path.join(stagingDir, path.basename(dest));
  ensureDir(stagingDir);
  const installedAt = new Date().toISOString();
  const receipt = {
    version: 1,
    name: parsed.full,
    tier,
    asset_path: dest,
    asset_digest: sourceAssetDigest,
    content_digest: sourceContentDigest,
    package_version: finalVersion,
    judgment_version: manifest.judgment_version || null,
    access: manifest.access || 'public',
    signature: manifest.signature || null,
    installed_at: installedAt,
    source,
  };

  const entry = {
    name: parsed.full,
    version: finalVersion,
    tier,
    asset_path: dest,
    receipt_path: receiptPath,
    asset_digest: sourceAssetDigest,
    content_digest: sourceContentDigest,
    judgment_version: manifest.judgment_version || null,
    access: manifest.access || 'public',
    signature: manifest.signature || null,
    installed_at: installedAt,
    source,
  };
  try {
    fs.copyFileSync(sourcePath, stagedAsset);
    // Windows requires a writable descriptor for fsync/_commit. The staged
    // copy is owned by this transaction, so open it read/write before the
    // durability barrier and verify its bytes immediately afterward.
    const descriptor = fs.openSync(stagedAsset, fs.constants.O_RDWR);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (
      assetDigest(stagedAsset) !== sourceAssetDigest ||
      contentDigest(stagedAsset) !== sourceContentDigest
    ) {
      throw new Error(`Staged digest mismatch for ${parsed.full}@${finalVersion}.`);
    }
    writeJsonFile(path.join(stagingDir, 'receipt.json'), receipt);
    fs.renameSync(stagingDir, destDir);

    const versions = { ...(existing?.versions || {}), [finalVersion]: entry };
    index.packages[parsed.full] = normalizePackageRecord(parsed.full, {
      active_version: finalVersion,
      versions,
    });
    writeIndexForUnlocked(tier, index);
    return entry;
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function installAsset(options) {
  const tier = options.local ? 'project' : 'global';
  return withIndexLock(tier, () => installAssetUnlocked(options));
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
    const removed = withIndexLock(tier, () => {
      const index = readIndexFor(tier);
      const record = index.packages[parsed.full];
      const entry = selectVersion(record, parsed.version);
      if (!entry) return false;
      const versions = { ...record.versions };
      delete versions[entry.version];
      if (entry.asset_path) {
        const versionDir = path.dirname(entry.asset_path);
        fs.rmSync(versionDir, { recursive: true, force: true });
      }
      if (Object.keys(versions).length === 0) {
        delete index.packages[parsed.full];
      } else {
        const activeVersion =
          record.active_version === entry.version ? latestVersion(versions) : record.active_version;
        index.packages[parsed.full] = normalizePackageRecord(parsed.full, {
          active_version: activeVersion,
          versions,
        });
      }
      writeIndexForUnlocked(tier, index);
      return true;
    });
    if (removed) return true;
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
  installedIntegrity,
  assertInstalledIntegrity,
  INDEX_VERSION,
};
