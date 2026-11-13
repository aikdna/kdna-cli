'use strict';
const { parseJsonBytes, readBoundedFile } = require('./authored-input.js');
const EDIT_LIMIT = 20 * 1024 * 1024;
const invalid = diagnostic => {
  const err = new Error('KDNA_SOURCE_EDITS_INVALID');
  if (diagnostic) err.diagnostic = diagnostic;
  throw err;
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// This is an editing transport, not a Source request or a replacement archive.
// Original resources are reopened and retained by the native Source producer.
async function readSourceEdits(file, assertActive = () => {}) {
  let edits;
  try {
    const bytes = await readBoundedFile(file, EDIT_LIMIT, 'KDNA_SOURCE_EDITS_INVALID', assertActive);
    assertActive();
    edits = parseJsonBytes(bytes);
  } catch {
    assertActive();
    invalid();
  }
  if (!record(edits)) invalid();
  if (edits.status === 'source_opened' && record(edits.edits)) {
    invalid({
      field: '/',
      reason: 'source_open_envelope',
      expected: '{manifest, payload}',
      hint: 'Pass the inner .edits object ({manifest, payload}) from `kdna source-open` output rather than the outer source_opened envelope (for example: jq .edits opened.json > edits.json).',
    });
  }
  if (Object.keys(edits).length !== 2
    || !Object.hasOwn(edits, 'manifest') || !Object.hasOwn(edits, 'payload')
    || !record(edits.manifest) || !record(edits.payload)) invalid();
  return edits;
}

module.exports = { readSourceEdits };
