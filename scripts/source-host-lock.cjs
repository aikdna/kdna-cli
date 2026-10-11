'use strict';
const assert = require('node:assert/strict');
// npm validates these optional declarations even when --omit=optional prevents
// their installation. Only this named accelerator graph may accompany the
// required archive graph; caches cannot contribute additional lock entries.
const OPTIONAL_ACCELERATOR_ENTRIES = Object.freeze([
  'node_modules/cbor-extract',
  'node_modules/@cbor-extract/cbor-extract-darwin-arm64',
  'node_modules/@cbor-extract/cbor-extract-darwin-x64',
  'node_modules/@cbor-extract/cbor-extract-linux-arm',
  'node_modules/@cbor-extract/cbor-extract-linux-arm64',
  'node_modules/@cbor-extract/cbor-extract-linux-x64',
  'node_modules/@cbor-extract/cbor-extract-win32-x64',
  'node_modules/detect-libc',
  'node_modules/node-gyp-build-optional-packages',
]);
function selectOptionalLockNodes(lock, requiredKeys) {
  assert.equal(lock.lockfileVersion, 3, 'source lock closure requires lockfileVersion 3');
  const allowed = new Set(OPTIONAL_ACCELERATOR_ENTRIES);
  const nodes = {}, required = [];
  for (const [key, node] of Object.entries(lock.packages ?? {})) {
    if (allowed.has(key)) {
      assert.equal(node.optional, true, 'accelerator lock node must remain optional');
      nodes[key] = structuredClone(node);
    } else required.push(key);
  }
  assert.deepEqual(required.sort(), [...requiredKeys].sort(), 'source lock closure differs');
  return nodes;
}
function verifyOptionalLockNodes(lock, requiredKeys, expected) {
  const observed = selectOptionalLockNodes(lock, requiredKeys);
  assert.deepEqual(observed, expected, 'installed optional lock declarations changed');
  return true;
}
module.exports = { OPTIONAL_ACCELERATOR_ENTRIES, selectOptionalLockNodes, verifyOptionalLockNodes };
