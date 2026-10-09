'use strict';
const { parseJsonBytes, readBoundedFile } = require('./authored-input.js');
const EDIT_LIMIT = 20 * 1024 * 1024;
const invalid = () => { throw new Error('KDNA_SOURCE_EDITS_INVALID'); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// This is an editing transport, not a Source request or a replacement archive.
// Original resources are reopened and retained by the native Source producer.
async function readSourceEdits(file, assertActive = () => {}) {
  try {
    const bytes = await readBoundedFile(file, EDIT_LIMIT, 'KDNA_SOURCE_EDITS_INVALID', assertActive);
    assertActive();
    const edits = parseJsonBytes(bytes);
    if (!record(edits) || Object.keys(edits).length !== 2
      || !Object.hasOwn(edits, 'manifest') || !Object.hasOwn(edits, 'payload')
      || !record(edits.manifest) || !record(edits.payload)) invalid();
    return edits;
  } catch {
    assertActive();
    invalid();
  }
}

module.exports = { readSourceEdits };
