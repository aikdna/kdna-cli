// KDNA shared path configuration — canonical source for ~/.kdna structure
// Spec: docs/local-kdna-home-spec.md
// NOTE: domains/ is NOT part of the runtime model (see local-kdna-home-spec.md §Invariants).
// The domains field below is retained ONLY for legacy migration. New code MUST use packages/.
//
// Two-tier store (roadmap-2026.md §5.1 Story 2):
// The package store now supports two roots — the user-global root
// (~/.kdna/packages/) and a project-local root (./.kdna/packages/).
// Project-local wins on conflict for reads; the user-global root
// is the default for writes (a `--local` flag opts in to the
// project-local root). See package-store.js for the merge logic.

const path = require('path');

const KDNA_HOME =
  process.env.KDNA_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna');

const PATHS = {
  root: KDNA_HOME,
  config: path.join(KDNA_HOME, 'config.json'),
  identity: path.join(KDNA_HOME, 'identity'),
  // LEGACY — domains/ is not part of the runtime model. Retained for migration only.
  domains: {
    root: path.join(KDNA_HOME, 'domains'),
    official: path.join(KDNA_HOME, 'domains', 'official'),
    local: path.join(KDNA_HOME, 'domains', 'local'),
    private: path.join(KDNA_HOME, 'domains', 'private'),
    legacy: path.join(KDNA_HOME, 'domains'),
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
  audit: path.join(KDNA_HOME, 'audit.jsonl'),
  feedback: path.join(KDNA_HOME, 'feedback'),
  evals: path.join(KDNA_HOME, 'evals'),
  cache: path.join(KDNA_HOME, 'cache'),
  licenses: path.join(KDNA_HOME, 'licenses'),
};

// Runtime asset store aliases
PATHS.USER_KDNA_DIR = KDNA_HOME;
PATHS.INSTALL_DIR = PATHS.packages;

// ─── Project-local paths (Story 2) ─────────────────────────────────────
//
// Resolved at access time, not at module load. The project root is
// determined by KDNA_PROJECT_ROOT (if set) or process.cwd() (if not).
// This is important because tests can change KDNA_PROJECT_ROOT after
// the module is first loaded.
//
// Use these properties as live getters, not snapshot values:
//   - PATHS.projectRoot     — absolute path to the project's .kdna
//   - PATHS.projectPackages — absolute path to project's packages dir
//   - PATHS.projectIndex    — absolute path to project's index.json
Object.defineProperties(PATHS, {
  projectRoot: {
    enumerable: true,
    get() {
      const root = process.env.KDNA_PROJECT_ROOT
        ? path.resolve(process.env.KDNA_PROJECT_ROOT)
        : process.cwd();
      return path.join(root, '.kdna');
    },
  },
  projectPackages: {
    enumerable: true,
    get() {
      return path.join(PATHS.projectRoot, 'packages');
    },
  },
  projectIndex: {
    enumerable: true,
    get() {
      return path.join(PATHS.projectRoot, 'index.json');
    },
  },
});

module.exports = PATHS;
module.exports.KDNA_HOME = KDNA_HOME;
