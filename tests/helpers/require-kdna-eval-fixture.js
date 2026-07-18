const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_NAME = '@aikdna/kdna-eval';
const spec = JSON.parse(process.env.KDNA_TEST_EVAL_SPEC || '{}');
const functionExports = [
  'createConsumptionRunner',
  'loadConsumerIndex',
  'resolveConsumerIndex',
  'createMultiGateRunner',
  'createReplayEngine',
  'loadRouteCard',
  'applyRouteCard',
  'createCostTracker',
  'createAssayProfile',
  'validateFixtureSet',
  'classifyAsset',
  'runAssay',
  'generateEvidenceClaim',
  'runClusterAssay',
];

const loaded = Object.fromEntries(functionExports.map((name) => [name, () => ({})]));
loaded.FIXTURE_CATEGORIES = [];

for (const name of spec.omit || []) delete loaded[name];
for (const [name, type] of Object.entries(spec.types || {})) {
  if (type === 'function') loaded[name] = () => ({});
  else if (type === 'array') loaded[name] = [];
  else if (type === 'object') loaded[name] = {};
  else if (type === 'string') loaded[name] = 'wrong-type';
  else if (type === 'null') loaded[name] = null;
}
if (spec.getterError?.name) {
  Object.defineProperty(loaded, spec.getterError.name, {
    enumerable: true,
    get() {
      throw new Error(spec.getterError.message || 'getter failed');
    },
  });
}

const metadata = {
  name: spec.name === undefined ? PACKAGE_NAME : spec.name,
  version: spec.version === undefined ? '0.3.1' : spec.version,
  exports: {
    '.': { require: spec.requireEntry === undefined ? './src/index.js' : spec.requireEntry },
  },
};
const counts = { metadata: 0, root: 0, subpath: 0 };
const originalReadFileSync = fs.readFileSync;
const originalLoad = Module._load;

fs.readFileSync = function readEvalFixtureMetadata(file, options) {
  const normalized = typeof file === 'string' ? path.resolve(file) : '';
  const metadataSuffix = path.join('node_modules', '@aikdna', 'kdna-eval', 'package.json');
  if (normalized.endsWith(metadataSuffix)) {
    counts.metadata += 1;
    if (spec.metadataError) throw new Error(spec.metadataError);
    const value = JSON.stringify(metadata);
    return typeof options === 'string' || options?.encoding ? value : Buffer.from(value);
  }
  return Reflect.apply(originalReadFileSync, this, [file, options]);
};

Module._load = function loadEvalFixture(request, parent, isMain) {
  const normalized = typeof request === 'string' ? path.resolve(request) : '';
  const rootSuffix = path.join('node_modules', '@aikdna', 'kdna-eval', 'src', 'index.js');
  if (normalized.endsWith(rootSuffix)) {
    counts.root += 1;
    if (spec.rootError) throw new Error(spec.rootError);
    if (spec.rootValue === 'null') return null;
    return loaded;
  }
  if (request.startsWith(`${PACKAGE_NAME}/`)) {
    counts.subpath += 1;
    if (spec.subpathMarker) fs.writeFileSync(spec.subpathMarker, 'loaded\n');
    return { runClusterAssay: () => ({}) };
  }
  return Reflect.apply(originalLoad, this, [request, parent, isMain]);
};

global.__KDNA_EVAL_TEST_FIXTURE__ = counts;
