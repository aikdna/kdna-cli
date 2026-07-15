// KDNA dev pack — produces a development .kdna container from a source directory.
//
// The output uses the current KDNA asset format:
//   - mimetype: application/vnd.kdna.asset
//   - kdna.json with format_version: "0.1.0"
//   - payload.kdnab (CBOR-encoded judgment)
//
// This is a dev-only helper. Release assets should be produced through the
// official KDNA Studio compile/export pipeline.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _cbor = null;
function getCbor() {
  if (!_cbor) {
    try {
      _cbor = require('cbor-x');
    } catch {
      throw new Error('cbor-x is required for dev pack. Install: npm install cbor-x');
    }
  }
  return _cbor;
}

const MIMETYPE = 'application/vnd.kdna.asset';
const FORMAT_VERSION = '0.1.0';
const PROFILE = 'kdna.payload.judgment';
const PROFILE_VERSION = '0.1.0';
const MIN_LOADER_VERSION = '0.18.1';

const KDNA_FILES = [
  'KDNA_Core.json',
  'KDNA_Patterns.json',
  'KDNA_Scenarios.json',
  'KDNA_Cases.json',
  'KDNA_Reasoning.json',
  'KDNA_Evolution.json',
];

function packKdna(sourceDir, manifest, _options = {}) {
  const abs = path.resolve(sourceDir);

  // 1. Read source files
  const judgment = {};
  for (const f of KDNA_FILES) {
    const filePath = path.join(abs, f);
    if (fs.existsSync(filePath)) {
      try {
        judgment[
          f
            .replace(/^KDNA_/, '')
            .replace(/\.json$/, '')
            .toLowerCase()
        ] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (cause) {
        throw new Error(`Cannot parse ${f}: ${cause.message}`);
      }
    }
  }

  // 2. Build CBOR payload in canonical judgment profile format
  const coreData = judgment.core || {};
  const patternsData = judgment.patterns || {};
  const patterns = [];
  // Convert legacy KDNA_Patterns.json to canonical patterns array
  if (patternsData.terminology) {
    if (Array.isArray(patternsData.terminology.standard_terms)) {
      for (const t of patternsData.terminology.standard_terms)
        patterns.push({ type: 'term', term: t.term || t, preferred: t.preferred || true });
    }
    if (Array.isArray(patternsData.terminology.banned_terms)) {
      for (const t of patternsData.terminology.banned_terms)
        patterns.push({ type: 'term', term: t.term || t, banned: true });
    }
  }
  if (Array.isArray(patternsData.misunderstandings)) {
    for (const m of patternsData.misunderstandings)
      patterns.push({ type: 'misunderstanding', wrong: m.wrong, correct: m.correct });
  }
  if (Array.isArray(patternsData.self_check)) {
    for (const s of patternsData.self_check)
      patterns.push({
        type: 'self_check',
        question: typeof s === 'string' ? s : s.question || s.id,
      });
  }
  const payload = {
    profile: PROFILE,
    profile_version: PROFILE_VERSION,
    core: {
      highest_question: coreData.highest_question || coreData.meta?.purpose || '',
      axioms: Array.isArray(coreData.axioms) ? coreData.axioms : [],
    },
    patterns,
  };
  for (const field of ['worldview', 'value_order', 'judgment_role', 'boundaries', 'risk_model']) {
    if (coreData[field] !== undefined) payload.core[field] = coreData[field];
  }
  if (coreData.ontology) payload.core.ontology = coreData.ontology;
  if (judgment.scenarios) payload.scenarios = judgment.scenarios;
  if (judgment.cases) payload.cases = judgment.cases;
  if (judgment.reasoning) payload.reasoning = judgment.reasoning;
  if (Array.isArray(patternsData.self_check)) {
    payload.reasoning = { ...(payload.reasoning || {}), self_check: patternsData.self_check };
  }
  if (judgment.evolution) payload.evolution = judgment.evolution;
  const payloadBuf = getCbor().encode(payload);

  // 3. Build the current manifest. `name` is an authoring-only identifier used
  // to derive asset_id; every field emitted into kdna.json must belong to the
  // current manifest schema. Unknown fields fail closed rather than being
  // silently stripped or carried into the package.
  const { name: sourceName, ...sourceManifest } = { ...(manifest || {}) };
  const manifestSchema = require('../schema/manifest.schema.json');
  const supportedManifestFields = new Set(Object.keys(manifestSchema.properties || {}));
  const unsupportedFields = Object.keys(sourceManifest).filter(
    (key) => !supportedManifestFields.has(key),
  );
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Unsupported manifest fields: ${unsupportedFields.join(', ')}. ` +
        'Provide only fields from the current manifest schema.',
    );
  }
  const version = validSemver(sourceManifest.version) ? sourceManifest.version : '0.1.0';
  const assetId = sourceManifest.asset_id || deriveAssetId(sourceName, sourceDir);
  const singleManifest = {
    ...sourceManifest,
    format_version: FORMAT_VERSION,
    asset_id: assetId,
    asset_uid: sourceManifest.asset_uid || deterministicAssetUid(assetId),
    asset_type: sourceManifest.asset_type || 'domain',
    title: sourceManifest.title || coreData.meta?.domain || path.basename(abs),
    version,
    judgment_version: validSemver(sourceManifest.judgment_version)
      ? sourceManifest.judgment_version
      : version,
    created_at: asDateTime(sourceManifest.created_at || coreData.meta?.created),
    updated_at: asDateTime(sourceManifest.updated_at || coreData.meta?.updated),
    compatibility: {
      min_loader_version: MIN_LOADER_VERSION,
      profile: PROFILE,
      profile_version: PROFILE_VERSION,
    },
    payload: {
      path: 'payload.kdnab',
      encoding: 'cbor',
      encrypted: false,
    },
  };

  // 4. Delegate digest construction and format validation to current Core.
  const manifestJson = `${JSON.stringify(singleManifest, null, 2)}\n`;
  const core = require('@aikdna/kdna-core');
  if (typeof core.buildChecksums !== 'function' || typeof core.validate !== 'function') {
    throw new Error('Current @aikdna/kdna-core buildChecksums and validate APIs are required.');
  }
  const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kdna-dev-source-'));
  let checksums;
  try {
    fs.writeFileSync(path.join(temp, 'mimetype'), MIMETYPE);
    fs.writeFileSync(path.join(temp, 'kdna.json'), manifestJson);
    fs.writeFileSync(path.join(temp, 'payload.kdnab'), payloadBuf);
    checksums = core.buildChecksums(temp);
    fs.writeFileSync(path.join(temp, 'checksums.json'), `${JSON.stringify(checksums, null, 2)}\n`);
    const validation = core.validate(temp);
    if (!validation || validation.overall_valid !== true) {
      const problems = Array.isArray(validation?.problems) ? validation.problems.join('; ') : '';
      throw new Error(`Generated KDNA source failed current Core validation: ${problems}`);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const checksumsJson = `${JSON.stringify(checksums, null, 2)}\n`;

  return {
    entries: {
      mimetype: MIMETYPE,
      'kdna.json': manifestJson,
      'payload.kdnab': payloadBuf,
      'checksums.json': checksumsJson,
    },
    manifest: singleManifest,
    payload,
  };
}

function validSemver(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[+-].+)?$/.test(value);
}

function asDateTime(value) {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function deriveAssetId(name, sourceDir) {
  const raw = name || path.basename(path.resolve(sourceDir));
  const safe = String(raw)
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `kdna:domain:${safe || 'unnamed'}`;
}

function deterministicAssetUid(assetId) {
  const hex = sha256Hex(assetId);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sha256Hex(data) {
  return crypto
    .createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex');
}

function computeDirHash(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f);
    hash.update(fs.readFileSync(path.join(dir, f)));
  }
  return hash.digest('hex');
}

function verifySourceIntegrity(sourceDir, expectedDigest) {
  if (!expectedDigest) return { valid: false, error: 'No expected digest provided' };
  const actual = `sha256:${computeDirHash(sourceDir)}`;
  if (actual !== expectedDigest) {
    return { valid: false, error: `Digest mismatch: expected ${expectedDigest}, got ${actual}` };
  }
  return { valid: true, digest: actual };
}

module.exports = { packKdna, verifySourceIntegrity, computeDirHash };
