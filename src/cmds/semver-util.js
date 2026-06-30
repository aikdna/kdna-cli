/**
 * semver-util.js — Minimal semver comparison helpers (Story 13)
 *
 * Standalone implementation. When @aikdna/kdna-core@>=0.15.10 is installed,
 * this file can be replaced with re-exports from core. See kdna-core PR for
 * the export addition (parseSemver/compareSemver/satisfies added to module.exports
 * in v0.15.10).
 *
 * Supported range shapes:
 *   "1.2.3"          exact
 *   "^1.2.3"         same major, version >= min
 *   "~1.2.3"         same major.minor, version >= min
 *   ">=1.2.3"        greater-or-equal
 *   ">1.2.3"         strictly greater
 *   "<=1.2.3"        less-or-equal
 *   "<1.2.3"         strictly less
 *   ">=1.0.0 <2.0.0"  AND of multiple space-separated conditions
 *   "*" or ""         matches anything
 */

'use strict';

function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][a-zA-Z0-9.]+)?/);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
  };
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function satisfies(version, range) {
  if (range === null || range === undefined) return false;
  if (typeof range !== 'string') return false;
  const r = range.trim();
  if (r === '' || r === '*') return true;
  if (/^[0-9]/.test(r)) return compareSemver(version, r) === 0;
  if (r.startsWith('^')) {
    const min = r.slice(1);
    const pMin = parseSemver(min);
    const pVer = parseSemver(version);
    if (!pMin || !pVer) return false;
    if (pVer.major !== pMin.major) return false;
    return compareSemver(version, min) >= 0;
  }
  if (r.startsWith('~')) {
    const min = r.slice(1);
    const pMin = parseSemver(min);
    const pVer = parseSemver(version);
    if (!pMin || !pVer) return false;
    if (pVer.major !== pMin.major || pVer.minor !== pMin.minor) return false;
    return compareSemver(version, min) >= 0;
  }
  if (r.includes(' ')) return r.split(/\s+/).every((part) => satisfies(version, part));
  if (r.startsWith('>=')) return compareSemver(version, r.slice(2)) >= 0;
  if (r.startsWith('>'))  return compareSemver(version, r.slice(1)) >  0;
  if (r.startsWith('<=')) return compareSemver(version, r.slice(2)) <= 0;
  if (r.startsWith('<'))  return compareSemver(version, r.slice(1)) <  0;
  return false;
}

function isDeprecatedAt(version, since) {
  if (!version || !since) return false;
  return Boolean(satisfies(version, since));
}

module.exports = { parseSemver, compareSemver, satisfies, isDeprecatedAt };
