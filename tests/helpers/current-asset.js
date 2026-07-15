'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cbor = require('cbor-x');
const core = require('@aikdna/kdna-core');

const FORMAT_VERSION = '0.1.0';
const PROFILE_VERSION = '0.1.0';

function currentManifest(overrides = {}) {
  const { compatibility: compatibilityOverrides = {}, ...manifestOverrides } = overrides;
  const assetType = overrides.asset_type || 'domain';
  const profile =
    compatibilityOverrides.profile ||
    (assetType === 'bundle' ? 'kdna.payload.bundle' : 'kdna.payload.judgment');
  return {
    format_version: FORMAT_VERSION,
    asset_id: 'kdna:fixture:current-asset',
    asset_uid: 'urn:uuid:00000000-0000-4000-8000-000000000090',
    asset_type: assetType,
    title: 'Current Asset Fixture',
    version: '1.0.0',
    judgment_version: '1.0.0',
    created_at: '2026-07-16T00:00:00Z',
    updated_at: '2026-07-16T00:00:00Z',
    creator: { name: 'KDNA Test' },
    compatibility: {
      min_loader_version: '0.18.1',
      profile,
      profile_version: PROFILE_VERSION,
      ...compatibilityOverrides,
    },
    payload: { path: 'payload.kdnab', encoding: 'cbor', encrypted: false },
    ...manifestOverrides,
  };
}

function currentJudgmentPayload(overrides = {}) {
  return {
    profile: 'kdna.payload.judgment',
    profile_version: PROFILE_VERSION,
    core: { highest_question: 'What should be judged?', axioms: [], boundaries: [] },
    patterns: [],
    scenarios: [],
    cases: [],
    reasoning: { self_check: [], failure_modes: [] },
    ...overrides,
  };
}

function currentBundlePayload(components = [], overrides = {}) {
  return {
    profile: 'kdna.payload.bundle',
    profile_version: PROFILE_VERSION,
    components,
    ...overrides,
  };
}

function writeCurrentSource(sourceDir, { manifest, payload }) {
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'mimetype'), core.MIMETYPE);
  fs.writeFileSync(path.join(sourceDir, 'kdna.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(sourceDir, 'payload.kdnab'), cbor.encode(payload));
  fs.writeFileSync(
    path.join(sourceDir, 'checksums.json'),
    `${JSON.stringify(core.buildChecksums(sourceDir), null, 2)}\n`,
  );
  return sourceDir;
}

module.exports = {
  FORMAT_VERSION,
  PROFILE_VERSION,
  currentManifest,
  currentJudgmentPayload,
  currentBundlePayload,
  writeCurrentSource,
};
