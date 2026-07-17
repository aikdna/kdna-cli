#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cbor = require('cbor-x');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_NAMES = ['minimal', 'judgment'];
const PROFILE = 'kdna.payload.judgment';
const PROTOCOL_VERSION = '0.1.0';

function loadCore() {
  const sourceRoot = process.env.KDNA_CORE_SOURCE_ROOT;
  if (sourceRoot) return require(path.join(path.resolve(sourceRoot), 'src'));
  return require('@aikdna/kdna-core');
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function currentManifest(value) {
  const manifest = globalThis.structuredClone(value);
  manifest.format_version = PROTOCOL_VERSION;
  manifest.compatibility = {
    ...manifest.compatibility,
    min_loader_version: '0.20.0',
    profile: PROFILE,
    profile_version: PROTOCOL_VERSION,
  };
  if (typeof manifest.summary === 'string') {
    manifest.summary = manifest.summary.replace(/Phase 1 /g, '');
  }
  return manifest;
}

function currentPayload(value) {
  const payload = globalThis.structuredClone(value);
  payload.profile = PROFILE;
  payload.profile_version = PROTOCOL_VERSION;
  if (payload.reasoning && Object.hasOwn(payload.reasoning, 'self_checks')) {
    if (!Object.hasOwn(payload.reasoning, 'self_check')) {
      payload.reasoning.self_check = payload.reasoning.self_checks;
    }
    delete payload.reasoning.self_checks;
  }
  for (const entry of payload.evolution?.changelog || []) {
    if (typeof entry.changes === 'string') {
      entry.changes = entry.changes
        .replace(/Phase 1 /g, '')
        .replace(/v[0-9]+(?:\.[0-9]+)*-aligned /gi, '');
    }
  }
  return payload;
}

function sourcePayloadPath(name) {
  return path.join(ROOT, 'scripts', 'fixture-sources', `${name}.payload.json`);
}

function readSourcePayload(name) {
  const sourcePath = sourcePayloadPath(name);
  if (fs.existsSync(sourcePath)) return JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const runtimePath = path.join(ROOT, 'fixtures', name, 'payload.kdnab');
  return cbor.decode(fs.readFileSync(runtimePath));
}

function buildFixture(name, core) {
  const committed = path.join(ROOT, 'fixtures', name);
  const manifest = currentManifest(
    JSON.parse(fs.readFileSync(path.join(committed, 'kdna.json'), 'utf8')),
  );
  const payload = currentPayload(readSourcePayload(name));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `kdna-cli-${name}-fixture-`));
  try {
    fs.writeFileSync(path.join(temp, 'mimetype'), 'application/vnd.kdna.asset');
    fs.writeFileSync(path.join(temp, 'kdna.json'), json(manifest));
    fs.writeFileSync(path.join(temp, 'payload.kdnab'), cbor.encode(payload));
    fs.writeFileSync(path.join(temp, 'checksums.json'), json(core.buildChecksums(temp)));
    return {
      manifest,
      payload,
      files: Object.fromEntries(
        ['mimetype', 'kdna.json', 'payload.kdnab', 'checksums.json'].map((file) => [
          file,
          fs.readFileSync(path.join(temp, file)),
        ]),
      ),
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--write'].includes(mode)) {
    throw new Error('usage: generate-runtime-fixtures.js [--check|--write]');
  }
  const core = loadCore();
  const mismatches = [];
  for (const name of FIXTURE_NAMES) {
    const built = buildFixture(name, core);
    const sourcePath = sourcePayloadPath(name);
    if (mode === '--write') {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, json(built.payload));
    } else if (
      !fs.existsSync(sourcePath) ||
      !fs.readFileSync(sourcePath).equals(Buffer.from(json(built.payload)))
    ) {
      mismatches.push(path.relative(ROOT, sourcePath));
    }
    for (const [file, expected] of Object.entries(built.files)) {
      const output = path.join(ROOT, 'fixtures', name, file);
      if (mode === '--write') {
        fs.writeFileSync(output, expected);
      } else if (!fs.existsSync(output) || !fs.readFileSync(output).equals(expected)) {
        mismatches.push(path.relative(ROOT, output));
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Runtime fixtures are stale:\n${mismatches.map((file) => `- ${file}`).join('\n')}`,
    );
  }
  console.log(`Runtime fixture generation ${mode === '--write' ? 'completed' : 'verified'}.`);
}

main();
