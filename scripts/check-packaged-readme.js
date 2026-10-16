#!/usr/bin/env node
'use strict';
/*
 * Packaged-README consistency gate.
 *
 * Why it exists: the README inside a published tarball is immutable, but the
 * publication state it used to describe is not. This package's published
 * 0.43.0 tarball carries a README that says `0.42.0` is the published
 * coordinate and calls `0.43.0` an unpublished next candidate, inside the
 * 0.43.0 archive. The release chain packs from the release-tag commit, so a
 * README that names the coordinate a registry serves is written before the
 * publication it describes actually happens, and it stays wrong afterwards.
 *
 * The rule this gate enforces:
 *   1. identity: the packaged README must name the exact version it ships with;
 *   2. no moving publication state: it must not name the `latest` dist-tag or
 *      describe any version as published, unpublished or a candidate. That
 *      statement belongs to the generated status surface - the
 *      release-coordinate matrix in the kdna repository and the rendered block
 *      in that repository's README.md.
 *
 * Modes:
 *   --source (default)  check README.md against this package.json. Offline.
 *   --published         download the tarball the registry serves on `latest`
 *                       and check the README bytes it actually delivers.
 *   --report-only       print findings and exit 0.
 *
 * The coordinate served today for this package predates the rule, so
 * `--published` reports it until the next release of this package: published
 * bytes cannot be repaired in place. Source mode is the gate that must be
 * green on every change; the served-bytes audit for this coordinate also runs
 * from the kdna `publish-health-cron` workflow, which covers the whole release
 * matrix.
 *
 * usage: node scripts/check-packaged-readme.js [--source|--published] [--report-only] [--root <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Publication-state vocabulary. Each entry is a distinct way a packaged README
// can contradict the artifact's own frozen bytes, so each one is refused and
// each one has its own negative case in tests/packaged-readme.test.js.
const STATE_CLAIM_PATTERNS = Object.freeze([
  [/\blatest\b/iu, 'names the `latest` dist-tag, which moves after this artifact is frozen'],
  [/\bnot yet published\b/iu, 'states an unpublished status this artifact cannot keep true'],
  [/\bunpublished\b/iu, 'states an unpublished status this artifact cannot keep true'],
  [/\bnext candidate\b/iu, 'describes a moving candidate window'],
  [/\bsource candidate\b/iu, 'describes a moving candidate window'],
  [/\bcurrent candidate\b/iu, 'describes a moving candidate window'],
  [/\bR2 candidate\b/iu, 'labels the artifact as a candidate rather than the version it is'],
  [/\bstable distribution\b/iu, 'names a moving stable-distribution coordinate'],
  [/\bcarries the next\b/iu, 'describes this source as a leading candidate'],
  [/\bwill be published\b/iu, 'promises a future publication this artifact cannot verify'],
  [/\bpublished on\b/iu, 'names the registry state a consumer observes, not this artifact'],
]);

const REGISTRY = 'https://registry.npmjs.org/';
const PACKED_README_PATH = 'package/README.md';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// A version match must not be a prefix or suffix of a longer number, so
// `0.43.0` cannot be satisfied by `10.43.0` or by `0.43.01`.
function versionPattern(version) {
  return new RegExp(`(?<![0-9.])${escapeRegExp(version)}(?![0-9.-])`, 'u');
}

// Rules 1 and 2 for one packaged README. `version` is the version the artifact
// declares; `label` makes the finding self-describing.
function evaluatePackagedReadme({ readme, version, label }) {
  const findings = [];
  if (!versionPattern(version).test(readme)) {
    findings.push({ rule: 'identity', label, detail: `does not name its own version ${version}` });
  }
  for (const [pattern, reason] of STATE_CLAIM_PATTERNS) {
    const match = pattern.exec(readme);
    if (match) {
      findings.push({
        rule: 'publication-state',
        label,
        detail: `states "${match[0]}": ${reason}`,
      });
    }
  }
  return findings;
}

// Minimal tar reader for one regular-file member. npm pack archives are
// ustar/PAX with short `package/...` names, so the 512-byte header fields are
// enough; other member types are skipped rather than interpreted.
function readPackedMember(tarBytes, wantedPath) {
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '');
    const size = Number.parseInt(
      header.subarray(124, 136).toString('utf8').replace(/\0.*$/su, '').trim() || '0',
      8,
    );
    const body = tarBytes.subarray(offset + 512, offset + 512 + size);
    if (name === wantedPath) return body.toString('utf8');
    offset += 512 + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
  }
  return null;
}

function checkSource(root, readText) {
  const manifest = JSON.parse(readText(path.join(root, 'package.json')));
  return evaluatePackagedReadme({
    readme: readText(path.join(root, 'README.md')),
    version: manifest.version,
    label: `README.md (${manifest.name}@${manifest.version})`,
  });
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function checkPublished(root, readText, options = {}) {
  const fetchImpl = options.fetchBytes || fetchBytes;
  const manifest = JSON.parse(readText(path.join(root, 'package.json')));
  const findings = [];
  let served;
  try {
    const packument = JSON.parse(
      (await fetchImpl(`${REGISTRY}${manifest.name.replaceAll('/', '%2F')}`)).toString('utf8'),
    );
    served = packument['dist-tags']?.latest;
    const published = packument.versions?.[served];
    if (!published?.dist?.tarball) throw new Error(`latest ${served ?? 'unknown'} has no tarball`);
    const readme = readPackedMember(
      zlib.gunzipSync(await fetchImpl(published.dist.tarball)),
      PACKED_README_PATH,
    );
    if (readme === null) throw new Error(`${PACKED_README_PATH} is missing from the tarball`);
    findings.push(
      ...evaluatePackagedReadme({
        readme,
        version: served,
        label: `${manifest.name}@${served} tarball README`,
      }),
    );
  } catch (error) {
    findings.push({
      rule: 'published',
      label: `${manifest.name}`,
      detail: `unreadable: ${error.message}`,
    });
  }
  return { findings, served };
}

async function main(argv) {
  const reportOnly = argv.includes('--report-only');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? path.resolve(__dirname, '..') : path.resolve(argv[rootIndex + 1]);
  const readText = (file) => fs.readFileSync(file, 'utf8');
  let findings;
  let surface;
  if (argv.includes('--published')) {
    surface = 'the README inside the tarball the registry serves on `latest`';
    ({ findings } = await checkPublished(root, readText));
  } else {
    surface = 'the in-repository packaged README';
    findings = checkSource(root, readText);
  }
  for (const finding of findings) {
    console.error(`FAIL [${finding.rule}] ${finding.label}: ${finding.detail}`);
  }
  if (findings.length > 0) {
    console.error(
      `packaged-readme: ${findings.length} finding(s) on ${surface}` +
        (reportOnly ? ' (report-only)' : ''),
    );
    return reportOnly ? 0 : 1;
  }
  console.log(`packaged-readme: ${surface} names its own version and states no publication status`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`packaged-readme: ${error.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  STATE_CLAIM_PATTERNS,
  checkPublished,
  checkSource,
  evaluatePackagedReadme,
  readPackedMember,
  versionPattern,
};
