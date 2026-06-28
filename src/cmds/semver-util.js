/**
 * semver-util.js — Minimal semver comparison helpers (Story 13)
 *
 * Used by the deprecation lifecycle check in `kdna load` and `kdna plan-load`.
 * We do not pull in the full `semver` package because:
 *
 *  - The CLI only needs a small subset: parse, compare, and a few
 *    range shapes (^, ~, >=, >, <=, <, exact, AND-of-conditions).
 *  - The Core package (`@aikdna/kdna-core`) has its own internal
 *    `parseSemver` / `compareSemver` / `satisfies` for dependency
 *    resolution. Those are NOT exported in Core's public API. Pulling
 *    in the `semver` npm package for one CLI feature would add a
 *    dependency just for this story.
 *  - Story 13's deprecation range format is intentionally narrow.
 *    See `parseRange`. We document supported shapes inline.
 *
 * Supported range shapes (kept in lockstep with kdna-core v1/index.js):
 *   "1.2.3"          exact
 *   "^1.2.3"         same major, version >= min
 *   "~1.2.3"         same major.minor, version >= min
 *   ">=1.2.3"        greater-or-equal
 *   ">1.2.3"         strictly greater
 *   "<=1.2.3"        less-or-equal
 *   "<1.2.3"         strictly less
 *   ">=1.0.0 <2.0.0"  AND of multiple space-separated conditions
 *   "*" or ""         matches anything
 *
 * Pre-release tags (-alpha.1, +build.5) are stripped on parse. The
 * semver core (major.minor.patch) is what we compare.
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

  // Specific version: "1.2.3"
  if (/^[0-9]/.test(r)) {
    return compareSemver(version, r) === 0;
  }

  // ^1.2.3
  if (r.startsWith('^')) {
    const min = r.slice(1);
    const pMin = parseSemver(min);
    const pVer = parseSemver(version);
    if (!pMin || !pVer) return false;
    if (pVer.major !== pMin.major) return false;
    return compareSemver(version, min) >= 0;
  }

  // ~1.2.3
  if (r.startsWith('~')) {
    const min = r.slice(1);
    const pMin = parseSemver(min);
    const pVer = parseSemver(version);
    if (!pMin || !pVer) return false;
    if (pVer.major !== pMin.major || pVer.minor !== pMin.minor) return false;
    return compareSemver(version, min) >= 0;
  }

  // AND of conditions: ">=1.0.0 <2.0.0"
  if (r.includes(' ')) {
    return r.split(/\s+/).every((part) => satisfies(version, part));
  }

  if (r.startsWith('>=')) return compareSemver(version, r.slice(2)) >= 0;
  if (r.startsWith('>'))  return compareSemver(version, r.slice(1)) >  0;
  if (r.startsWith('<=')) return compareSemver(version, r.slice(2)) <= 0;
  if (r.startsWith('<'))  return compareSemver(version, r.slice(1)) <  0;

  return false;
}

/**
 * Returns true if `since` is a semver range that includes the given version.
 * `since` may be a version literal ("1.2.3" = "1.2.3 exactly") or a range
 * (">=0.28.0", "^0.27.0", etc.). For deprecation lifecycle, callers should
 * typically use `since: ">=0.28.0"` to mean "deprecated from 0.28.0 onwards".
 *
 * @param {string} version
 * @param {string} since
 * @returns {boolean}
 */
function isDeprecatedAt(version, since) {
  if (!version || !since) return false;
  return Boolean(satisfies(version, since));
}

module.exports = {
  parseSemver,
  compareSemver,
  satisfies,
  isDeprecatedAt,
};
