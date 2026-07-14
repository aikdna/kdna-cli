const path = require('node:path');
const Module = require('node:module');

const coreRoot = process.env.KDNA_GOLDEN_CORE_ROOT;
if (!coreRoot) {
  throw new Error('KDNA_GOLDEN_CORE_ROOT is required for the Golden cross-repo contract test.');
}

const candidateCore = require(path.join(path.resolve(coreRoot), 'src'));
const originalLoad = Module._load;

Module._load = function loadGoldenCore(request, parent, isMain) {
  if (request === '@aikdna/kdna-core') return candidateCore;
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
