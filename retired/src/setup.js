#!/usr/bin/env node
/**
 * kdna setup — One-command KDNA installation.
 *
 * Detects the user's AI agent, installs the kdna-loader skill (the only
 * KDNA skill), creates the data directory, and initializes the local
 * registry cache. Zero domains are installed by default — domains are
 * a separate `kdna install <name>` action.
 *
 * The kdna-loader skill teaches the agent how to discover and use KDNA
 * domains via the kdna CLI's available/match/load commands. Domains
 * themselves are not skills.
 */

const fs = require('fs');
const path = require('path');

const PATHS = require('./paths');

const USER_KDNA_DIR = PATHS.root;
const DOMAINS_DIR = PATHS.domains.root;
const CLUSTERS_DIR = PATHS.clusters;

const AGENTS = [
  {
    name: 'OpenCode',
    dir: path.join(process.env.HOME || '', '.agents'),
    skillsDir: 'skills',
  },
  {
    name: 'Codex',
    dir: path.join(process.env.HOME || '', '.codex'),
    skillsDir: 'skills',
  },
  {
    name: 'Claude Code',
    dir: path.join(process.env.HOME || '', '.claude'),
    skillsDir: 'skills',
  },
  {
    name: 'Cursor',
    dir: path.join(process.env.HOME || '', '.cursor'),
    skillsDir: 'skills',
  },
  {
    name: 'Gemini Antigravity',
    dir: path.join(process.env.HOME || '', '.gemini', 'antigravity'),
    skillsDir: 'skills',
  },
];

function log(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}
function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function detectAgents() {
  return AGENTS.filter((a) => fs.existsSync(a.dir));
}

function installBundledSkill(agent, options = {}) {
  const skillDir = path.join(agent.dir, agent.skillsDir, 'kdna-loader');
  const dest = path.join(skillDir, 'SKILL.md');
  const local = path.join(__dirname, '..', 'skills', 'kdna-loader', 'SKILL.md');
  if (!fs.existsSync(local)) return { ok: false };

  const bundled = fs.readFileSync(local, 'utf8');

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing === bundled) return { ok: true, source: 'bundled', unchanged: true };
    if (!options.force) return { ok: true, source: 'existing customized copy', preserved: true };
  }

  ensureDir(skillDir);
  fs.writeFileSync(dest, bundled);
  return { ok: true, source: 'bundled', overwritten: fs.existsSync(dest) };
}

function cleanLegacySkills(agent) {
  // Pre-v0.9 we also installed kdna-create. Remove any stale copy.
  const legacy = path.join(agent.dir, agent.skillsDir, 'kdna-create');
  if (fs.existsSync(legacy)) {
    try {
      fs.rmSync(legacy, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function cmdSetup(args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: kdna setup [--force]');
    console.log(
      'Installs the bundled kdna-loader skill. Existing customized copies are preserved unless --force is used.',
    );
    return;
  }
  const force = args.includes('--force');
  console.log('');
  console.log('KDNA Setup');
  console.log('═'.repeat(40));
  console.log('');

  // 1. CLI version
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  log(`KDNA CLI ${pkg.version}`);

  // 2. KDNA data root — .kdna asset store
  ensureDir(PATHS.root);
  ensureDir(PATHS.packages);
  ensureDir(CLUSTERS_DIR);
  ensureDir(PATHS.registry);
  ensureDir(PATHS.traces);
  ensureDir(PATHS.feedback);
  ensureDir(PATHS.evals);
  ensureDir(PATHS.cache);
  ensureDir(PATHS.identity);
  ensureDir(PATHS.licenses);
  log(`Data root: ${USER_KDNA_DIR}/`);

  // 2b. Directory installs are not part of the runtime model.
  if (fs.existsSync(DOMAINS_DIR)) {
    const legacy = fs.readdirSync(DOMAINS_DIR).filter((e) => {
      if (e.startsWith('.')) return false;
      try {
        return fs.statSync(path.join(DOMAINS_DIR, e)).isDirectory();
      } catch {
        return false;
      }
    });
    if (legacy.length) {
      console.log('');
      warn(`Ignoring ${legacy.length} legacy domain director${legacy.length > 1 ? 'ies' : 'y'}.`);
      console.log('  Runtime assets now live under ~/.kdna/packages/ as .kdna files.');
      console.log('  Start with a packaged local .kdna file and validate it before loading.');
      console.log('');
    }
  }

  // 3. Detect agents
  const detected = detectAgents();

  if (!detected.length) {
    warn('No supported AI agents detected.');
    console.log('  Supported: OpenCode (~/.agents), Codex (~/.codex),');
    console.log('  Claude Code (~/.claude), Cursor (~/.cursor),');
    console.log('  Gemini Antigravity (~/.gemini/antigravity)');
    console.log('');
    console.log('  When you install one, re-run: kdna setup');
    console.log('');
  } else {
    log(`Detected agents: ${detected.map((a) => a.name).join(', ')}`);

    for (const agent of detected) {
      const result = installBundledSkill(agent, { force });
      if (result.ok) {
        if (result.preserved) {
          warn(
            `Preserved customized kdna-loader for ${agent.name}; use kdna setup --force to replace it.`,
          );
        } else {
          log(`kdna-loader → ${agent.name}  (${result.source})`);
        }
      } else {
        warn(`Failed to install kdna-loader for ${agent.name}`);
      }
      if (force && cleanLegacySkills(agent)) {
        log(`removed legacy kdna-create from ${agent.name}`);
      }
    }
  }

  console.log('');
  console.log('Setup complete. KDNA is ready.');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Create a local demo: kdna demo judgment ./judgment');
  console.log('  2. Package it:          kdna pack ./judgment ./judgment.kdna');
  console.log(
    '  3. Validate and plan:   kdna validate ./judgment.kdna && kdna plan-load ./judgment.kdna',
  );
  console.log('  4. Load Capsule:        kdna load ./judgment.kdna --profile=compact --as=json');
  console.log('  5. In your agent, ask a judgment-related question.');
  console.log('     The kdna-loader skill should use local .kdna files only when relevant.');
  console.log('');
}

module.exports = { cmdSetup, detectAgents, installBundledSkill };
