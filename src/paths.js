// KDNA shared path configuration — canonical source for ~/.kdna structure
// Spec: docs/local-kdna-home-spec.md

const path = require('path');

const KDNA_HOME = process.env.KDNA_HOME
  || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna');

const PATHS = {
  root: KDNA_HOME,
  config: path.join(KDNA_HOME, 'config.json'),
  identity: path.join(KDNA_HOME, 'identity'),
  domains: {
    root: path.join(KDNA_HOME, 'domains'),
    official: path.join(KDNA_HOME, 'domains', 'official'),
    local: path.join(KDNA_HOME, 'domains', 'local'),
    private: path.join(KDNA_HOME, 'domains', 'private'),
    // Legacy flat path — used for migration only
    legacy: path.join(KDNA_HOME, 'domains'),
    // All three directories for scanning
    all: [
      path.join(KDNA_HOME, 'domains', 'official'),
      path.join(KDNA_HOME, 'domains', 'local'),
      path.join(KDNA_HOME, 'domains', 'private'),
    ],
  },
  clusters: path.join(KDNA_HOME, 'clusters'),
  packages: path.join(KDNA_HOME, 'packages'),
  packageIndex: path.join(KDNA_HOME, 'index.json'),
  registry: path.join(KDNA_HOME, 'registry'),
  registryCache: path.join(KDNA_HOME, 'registry', 'cache.json'),
  traces: path.join(KDNA_HOME, 'traces'),
  feedback: path.join(KDNA_HOME, 'feedback'),
  evals: path.join(KDNA_HOME, 'evals'),
  cache: path.join(KDNA_HOME, 'cache'),
  licenses: path.join(KDNA_HOME, 'licenses'),
};

// Runtime asset store aliases
PATHS.USER_KDNA_DIR = KDNA_HOME;
PATHS.INSTALL_DIR = PATHS.packages;

module.exports = PATHS;
module.exports.KDNA_HOME = KDNA_HOME;
