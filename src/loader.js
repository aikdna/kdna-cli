/**
 * KDNA Loader — Runtime library for loading KDNA domain cognition into agent context.
 *
 * This module provides the Node.js file-system-backed API.
 * Pure logic lives in @aikdna/kdna-core; this module handles I/O.
 */

const fs = require('fs');
const path = require('path');
const core = require('@aikdna/kdna-core');

const FILE_MAP = core.FILE_MAP;

/**
 * Read and parse a KDNA JSON file.
 * Returns null if the file does not exist.
 */
function readFile(sourceDir, filename) {
  const filePath = path.join(sourceDir, filename);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw Object.assign(
      new Error(`Failed to read ${filename}: ${e.message}`),
      { code: 'KDNA_LOADER_PARSE_ERROR', path: filePath },
    );
  }
}

/**
 * Load the minimum required KDNA files (Core + Patterns).
 * Always load these. They form the cognition baseline.
 */
function loadCorePatterns(sourceDir) {
  const coreData = readFile(sourceDir, FILE_MAP.core);
  const patternsData = readFile(sourceDir, FILE_MAP.patterns);
  return core.loadCorePatternsFromData(coreData, patternsData);
}

/**
 * Load a complete KDNA domain.
 *
 * @param {string} sourceDir — path to a dev source directory
 * @param {object} [options]
 * @param {string} [options.input] — user input text for conditional loading
 * @param {'all'|'minimum'|'auto'} [options.mode='auto'] — loading mode
 * @returns {object|null} loaded KDNA files keyed by type, or null if minimum files are missing
 */
function loadDomain(sourceDir, options = {}) {
  const dataMap = { core: null, patterns: null };

  dataMap.core = readFile(sourceDir, FILE_MAP.core);
  dataMap.patterns = readFile(sourceDir, FILE_MAP.patterns);

  if (!dataMap.core || !dataMap.patterns) return null;

  // Also read optional files that might be present
  for (const key of ['scenarios', 'cases', 'reasoning', 'evolution']) {
    const data = readFile(sourceDir, FILE_MAP[key]);
    if (data) dataMap[key] = data;
  }

  return core.loadDomainFromData(dataMap, options);
}

module.exports = {
  loadDomain,
  loadCorePatterns,
  classifyInput: core.classifyInput,
  formatContext: core.formatContext,
  FILE_MAP,
};
