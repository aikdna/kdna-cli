/**
 * kdna init <name>        — Deprecated alias for kdna dev scaffold <name>.
 * kdna dev scaffold <name> — Scaffold a non-canonical dev source workspace.
 * kdna cluster init <name> — Scaffold a new KDNA cluster from template.
 */

const fs = require('fs');
const path = require('path');

/**
 * Recursively copy a directory, applying string replacements.
 */
function copyRecursive(src, dest, replacements) {
  const entries = fs.readdirSync(src);
  for (const entry of entries) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyRecursive(srcPath, destPath, replacements);
    } else {
      let content = fs.readFileSync(srcPath, 'utf8');
      for (const [pattern, to] of Object.entries(replacements)) {
        content = content.replaceAll(pattern, to);
      }
      fs.writeFileSync(destPath, content);
    }
  }
}

function cmdInit(name, options = {}) {
  if (!name) {
    console.error('Error: Domain name required. Usage: kdna dev scaffold <name>');
    process.exit(1);
  }

  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    console.error(
      `Error: Invalid domain name "${name}". Must be lowercase letters, numbers, underscores. Start with a letter.`,
    );
    process.exit(1);
  }

  const templateDir = path.resolve(__dirname, '..', 'templates', 'minimal-domain');
  const targetDir = path.resolve(name);

  if (fs.existsSync(targetDir)) {
    console.error(`Error: Directory already exists: ${targetDir}`);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);

  fs.mkdirSync(targetDir, { recursive: true });
  copyRecursive(templateDir, targetDir, {
    example_domain: name,
    'YYYY-MM-DD': today,
  });

  if (options.deprecatedAlias) {
    console.warn(
      'Warning: kdna init is deprecated. Use kdna dev scaffold for dev source workspaces.',
    );
  }
  console.log(`✓ Created non-canonical KDNA dev source workspace: ${targetDir}/`);
  console.log(`  Files: KDNA_Core.json, KDNA_Patterns.json, kdna.json, tests/before-after.json`);
  console.log('  This workspace is an authoring/editing view, not a public KDNA asset.');
  console.log('  To create a runtime .kdna file, export through KDNA Studio or kdna dev pack.');

  // Run structural validation (lint + schema only). Content quality checks
  // are for release-evidence time, not scaffold time — the template contains placeholders
  // marked [TODO] that the author is expected to replace.
  try {
    const { execSync } = require('child_process');
    const cli = process.argv[1];
    const validCmd = `node "${cli}" validate "${targetDir}"`;
    const { status } = execSync(validCmd, { stdio: 'pipe', encoding: 'utf8' });
    // Structural validation passed (non-zero exit means purely structural failure)
    if (status === null || status === undefined) {
      console.log(`  ✓ Structural validation passed (lint + schema OK)`);
    }
  } catch (e) {
    console.error(`  ⚠ Structural validation had issues:`);
    const stderr = e.stderr?.toString() || e.stdout?.toString() || '';
    if (stderr)
      console.error(
        stderr
          .trim()
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      );
  }

  console.log('');
  console.log(`Next steps:`);
  console.log(`  1. Edit ${targetDir}/KDNA_Core.json — replace all [TODO] placeholders`);
  console.log(
    `  2. Edit ${targetDir}/KDNA_Patterns.json — replace terminology and misunderstandings`,
  );
  console.log(`  3. Edit ${targetDir}/kdna.json — set author, description, repo`);
  console.log(`  4. Run: kdna dev validate ${name}           (structural check)`);
  console.log(`  5. Run: kdna dev pack ${name} --out dist/${name}.kdna`);
  console.log(`  6. Run: kdna validate dist/${name}.kdna && kdna plan-load dist/${name}.kdna`);
}

/**
 * kdna cluster init <name> — Scaffold a new KDNA cluster from CANONICAL template.
 */
function cmdClusterInit(name) {
  if (!name) {
    console.error('Error: Cluster name required. Usage: kdna cluster init <name>');
    process.exit(1);
  }

  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    console.error(
      `Error: Invalid cluster name "${name}". Must be lowercase letters, numbers, underscores. Start with a letter.`,
    );
    process.exit(1);
  }

  const targetDir = path.resolve(name);
  if (fs.existsSync(targetDir)) {
    console.error(`Error: Directory already exists: ${targetDir}`);
    process.exit(1);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // ── Create canonical kdna.cluster.json ────────────────────────────
  const manifest = {
    format: 'kdna-cluster',
    format_version: '0.9.0',
    cluster_id: `@aikdna/${name}`,
    name: name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    version: '0.1.0',
    description: '[TODO: What judgment system does this cluster provide?]',
    type: 'vertical',
    status: 'draft',
    access: 'public',
    domains: [
      {
        id: '@aikdna/domain-one',
        version: '^0.1.0',
        role: 'primary-candidate',
        required: true,
        load_condition:
          '[TODO: When should this domain activate? e.g., Task involves a deploy decision.]',
      },
      {
        id: '@aikdna/domain-two',
        version: '^0.1.0',
        role: 'advisor',
        required: false,
        load_condition: '[TODO: When does this advisor contribute?]',
        contribution_hypothesis_template:
          '[TODO: What distinct dimension does this advisor add beyond the primary?]',
      },
    ],
    composition: {
      strategy: 'signal_based',
      max_active_domains: 3,
      conflict_policy: 'surface',
      priority_order: ['@aikdna/domain-one', '@aikdna/domain-two'],
      primary_selection: 'exactly_one',
      advisor_selection: 'contribution_hypothesis_required',
    },
    budget: {
      profile: 'interactive',
      max_tokens: 800,
      max_assets: 3,
      enforcement: 'hard',
    },
    degradation_policy: {
      primary_unavailable: 'block',
      required_advisor_unavailable: 'block',
      optional_advisor_unavailable: 'continue_with_warning',
      budget_exceeded: 'block',
    },
  };

  fs.writeFileSync(
    path.join(targetDir, 'kdna.cluster.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  // Create README
  let readme = `# ${name}\n\n`;
  readme += `[TODO: Describe what judgment system this cluster provides.]\n\n`;
  readme += `## Domains\n\n`;
  readme += `- **@aikdna/domain-one** (primary-candidate, required)\n`;
  readme += `- **@aikdna/domain-two** (advisor, optional)\n\n`;
  readme += `## Usage\n\n`;
  readme += '```bash\n';
  readme += 'kdna cluster validate ./kdna.cluster.json\n';
  readme += 'kdna cluster plan-use ./kdna.cluster.json --task="Your task here"\n';
  readme += '```\n\n';
  readme += `## Composition\n\n`;
  readme += `- **Strategy:** signal_based — domains are selected based on task signal matching\n`;
  readme += `- **Conflict policy:** surface — conflicts are reported, not auto-resolved\n`;
  readme += `- **Advisor selection:** contribution_hypothesis_required — advisors must justify their inclusion\n`;

  fs.writeFileSync(path.join(targetDir, 'README.md'), readme);

  console.log(`✓ Created KDNA cluster: ${targetDir}/`);
  console.log(`  Files: kdna.cluster.json (canonical format), README.md`);
  console.log('');
  console.log(`Next steps:`);
  console.log(`  1. Edit ${targetDir}/kdna.cluster.json — replace all [TODO] placeholders`);
  console.log(`  2. Ensure each referenced domain exists as a validated .kdna asset`);
  console.log(`  3. Run: kdna cluster validate ${targetDir}/kdna.cluster.json`);
  console.log(
    `  4. Run: kdna cluster plan-use ${targetDir}/kdna.cluster.json --task="...test task..."`,
  );
}

module.exports = { cmdInit, cmdClusterInit };
