'use strict';
// The binding's route_contracts record the exact contract bytes of the bound
// Core. cli-slice.test.js freezes the expected values as literals; this guard
// closes the other half of the loop by recomputing every digest from the
// installed dependency, so a Core re-pin that forgets to move route_contracts
// fails here instead of shipping stale digests. That is exactly what happened
// across the 0.37.2 -> 0.37.6 re-pin: the five digests stayed at the 0.37.2
// values through three published versions because nothing recomputed them.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const binding = require('../public-contract-binding.json');
const scoped = createRequire(path.join(root, 'package.json'));
const coreRoot = path.dirname(scoped.resolve('@aikdna/kdna-core/package.json'));

test('every route_contracts digest recomputes from the installed Core', () => {
  assert.ok(Array.isArray(binding.route_contracts) && binding.route_contracts.length > 0);
  for (const entry of binding.route_contracts) {
    assert.match(entry.file, /^[a-z0-9]+\/contract\.json$/u, `unrecognized contract path: ${entry.file}`);
    const bytes = fs.readFileSync(path.join(coreRoot, 'src', 'public-contract', entry.file));
    assert.equal(bytes.length, entry.bytes, `byte length drifted for ${entry.file}`);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256,
      `contract digest drifted for ${entry.file}: the bound Core moved without re-pinning route_contracts`);
  }
});
