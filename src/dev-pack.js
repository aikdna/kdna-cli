// KDNA dev pack — produces a development .kdna container from a source directory.
//
// The output uses the single KDNA asset format:
//   - mimetype: application/vnd.kdna.asset
//   - kdna.json with kdna_version: "1.0"
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
      } catch {
        /* skip unreadable */
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
    profile: 'judgment-profile-v1',
    core: {
      highest_question: coreData.meta?.purpose || '',
      axioms: Array.isArray(coreData.axioms) ? coreData.axioms : [],
    },
    patterns,
  };
  if (coreData.ontology) payload.core.ontology = coreData.ontology;
  if (coreData.boundaries) payload.core.boundaries = coreData.boundaries;
  if (judgment.scenarios) payload.scenarios = judgment.scenarios;
  if (judgment.cases) payload.cases = judgment.cases;
  if (judgment.reasoning) payload.reasoning = judgment.reasoning;
  if (judgment.evolution) payload.evolution = judgment.evolution;
  const payloadBuf = getCbor().encode(payload);

  // 3. Build single-format manifest
  const singleManifest = {
    ...manifest,
    kdna_version: '1.0',
    payload: {
      path: 'payload.kdnab',
      encoding: 'cbor',
      encrypted: false,
    },
  };

  // 4. Compute checksums (matches Core buildChecksums algorithm)
  const manifestJson = JSON.stringify(singleManifest, null, 2);
  const manifestDigest = sha256Hex(Buffer.from(manifestJson, 'utf8'));
  const payloadDigest = sha256Hex(payloadBuf);
  const combined = `kdna.json:${manifestDigest}\npayload.kdnab:${payloadDigest}`;
  const assetDigest = sha256Hex(Buffer.from(combined, 'utf8'));
  const checksumsJson = JSON.stringify(
    {
      algorithm: 'sha256',
      manifest_digest: `sha256:${manifestDigest}`,
      payload_digest: `sha256:${payloadDigest}`,
      asset_digest: `sha256:${assetDigest}`,
      entries: {
        'kdna.json': { algorithm: 'sha256', value: manifestDigest },
        'payload.kdnab': { algorithm: 'sha256', value: payloadDigest },
      },
    },
    null,
    2,
  );

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
