/**
 * semver-util.js — Semver comparison helpers (Story 13)
 *
 * Re-exports parseSemver / compareSemver / satisfies from @aikdna/kdna-core,
 * which is the canonical implementation shared across the KDNA toolchain.
 * Requires @aikdna/kdna-core >= 0.15.10.
 *
 * isDeprecatedAt is a CLI-specific lifecycle helper defined here.
 */

'use strict';

const { parseSemver, compareSemver, satisfies } = require('@aikdna/kdna-core');

/**
 * Returns true if `since` is a semver range that includes the given version.
 * Used for deprecation lifecycle: `since: ">=0.28.0"` means "deprecated from
 * 0.28.0 onwards".
 *
 * @param {string} version
 * @param {string} since
 * @returns {boolean}
 */
function isDeprecatedAt(version, since) {
  if (!version || !since) return false;
  return Boolean(satisfies(version, since));
}

module.exports = { parseSemver, compareSemver, satisfies, isDeprecatedAt };
