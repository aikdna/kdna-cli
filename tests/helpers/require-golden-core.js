const path = require('node:path');
const Module = require('node:module');

const coreRoot = process.env.KDNA_CORE_SOURCE_ROOT || process.env.KDNA_GOLDEN_CORE_ROOT;
if (!coreRoot) {
  throw new Error(
    'KDNA_CORE_SOURCE_ROOT (or KDNA_GOLDEN_CORE_ROOT) must point to the candidate Core package.',
  );
}

const candidateCore = require(path.join(path.resolve(coreRoot), 'src'));
const originalLoad = Module._load;

Module._load = function loadCandidateCore(request, parent, isMain) {
  if (request === '@aikdna/kdna-core') return candidateCore;
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};
