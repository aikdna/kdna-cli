const fs = require('node:fs');
const path = require('node:path');
const { error, EXIT } = require('./_common');

const PACKAGE_NAME = '@aikdna/kdna-eval';
const PACKAGE_VERSION = '0.3.2';
const FAILURE_MESSAGE =
  '@aikdna/kdna-eval@0.3.2 is missing or incompatible; reinstall @aikdna/kdna-cli.';

const COMMAND_EXPORTS = Object.freeze({
  compose: Object.freeze({
    createConsumptionRunner: 'function',
    loadConsumerIndex: 'function',
    resolveConsumerIndex: 'function',
  }),
  'compose-review': Object.freeze({
    createMultiGateRunner: 'function',
    createConsumptionRunner: 'function',
    createReplayEngine: 'function',
  }),
  route: Object.freeze({
    createConsumptionRunner: 'function',
    loadRouteCard: 'function',
    applyRouteCard: 'function',
    loadConsumerIndex: 'function',
    resolveConsumerIndex: 'function',
  }),
  'eval-consumption': Object.freeze({
    createMultiGateRunner: 'function',
    createConsumptionRunner: 'function',
    createReplayEngine: 'function',
    createCostTracker: 'function',
  }),
  'eval-asset': Object.freeze({
    createAssayProfile: 'function',
    validateFixtureSet: 'function',
    classifyAsset: 'function',
    runAssay: 'function',
    FIXTURE_CATEGORIES: 'array',
  }),
  'eval-cluster': Object.freeze({
    runClusterAssay: 'function',
  }),
});

let cachedModule;

function fail() {
  error(FAILURE_MESSAGE, EXIT.PROVIDER_ERROR);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function dependencyRoots() {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const roots = [path.join(packageRoot, 'node_modules')];
  const segments = packageRoot.split(path.sep);
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  if (nodeModulesIndex >= 0) {
    roots.push(segments.slice(0, nodeModulesIndex + 1).join(path.sep) || path.sep);
  }
  return [...new Set(roots)];
}

function readOfficialPackageEntry() {
  for (const dependencyRoot of dependencyRoots()) {
    const metadataPath = path.join(dependencyRoot, '@aikdna', 'kdna-eval', 'package.json');
    let metadataText;
    try {
      metadataText = fs.readFileSync(metadataPath, 'utf8');
    } catch (cause) {
      if (cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR') continue;
      fail();
    }

    let metadata;
    try {
      metadata = JSON.parse(metadataText);
    } catch {
      fail();
    }
    if (metadata?.name !== PACKAGE_NAME || metadata?.version !== PACKAGE_VERSION) fail();

    const packageRoot = fs.realpathSync(path.dirname(metadataPath));
    const requireEntry = metadata?.exports?.['.']?.require;
    if (typeof requireEntry !== 'string' || !requireEntry.startsWith('./')) fail();
    const entryPath = fs.realpathSync(path.resolve(packageRoot, requireEntry));
    if (!isWithin(packageRoot, entryPath) || !fs.statSync(entryPath).isFile()) fail();
    return entryPath;
  }
  fail();
}

function loadOfficialPackage() {
  if (cachedModule) return cachedModule;

  let loaded;
  try {
    loaded = require(readOfficialPackageEntry());
  } catch {
    fail();
  }

  if (!loaded || (typeof loaded !== 'object' && typeof loaded !== 'function')) fail();
  cachedModule = loaded;
  return cachedModule;
}

function loadKdnaEval(command) {
  const requirements = COMMAND_EXPORTS[command];
  if (!requirements) throw new TypeError(`Unknown KDNA Eval command contract: ${command}`);

  const loaded = loadOfficialPackage();
  for (const [name, expectedType] of Object.entries(requirements)) {
    try {
      const value = loaded[name];
      const matches =
        expectedType === 'array' ? Array.isArray(value) : typeof value === expectedType;
      if (!matches) fail();
    } catch {
      fail();
    }
  }
  return loaded;
}

module.exports = {
  loadKdnaEval,
};
