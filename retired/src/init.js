/**
 * kdna cluster init <name> — Scaffold a new KDNA cluster from template.
 */

const fs = require('fs');
const path = require('path');

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

module.exports = { cmdClusterInit };
