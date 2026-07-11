/**
 * kdna eval asset — Run Asset Assay against a KDNA asset.
 *
 * Usage: kdna eval asset <asset.kdna> --fixtures <dir> --as json
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { error, EXIT } = require('./_common');

function loadKdnaEval() {
  try {
    return require('@aikdna/kdna-eval');
  } catch (e) {
    const altPaths = [
      process.env.KDNA_EVAL_PATH,
      path.resolve(__dirname, '..', '..', '..', 'kdna', 'packages', 'kdna-eval'),
    ];
    for (const p of altPaths) {
      if (p) {
        try { return require(p); } catch (_) {}
      }
    }
    process.stderr.write(
      'Error: @aikdna/kdna-eval is required for kdna eval asset.\n' +
        'Install it with: npm install @aikdna/kdna-eval@^0.2.0\n',
    );
    process.exit(EXIT.DEPENDENCY_ERROR || 6);
  }
}

function loadManifest(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      const p = path.join(absPath, 'kdna.json');
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } else if (stat.isFile()) {
      try {
        const core = require('@aikdna/kdna-core');
        const m = core.inspect(absPath);
        if (m) return m;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

function loadFixtures(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      const fixture = JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8'));
      return fixture;
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

function cmdEvalAsset(args) {
  const getFlag = (name) => {
    const eq = args.find(a => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };

  const posArgs = args.filter(a => !a.startsWith('--'));
  const assetPath = posArgs[0];

  if (!assetPath || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage: kdna eval asset <asset-path> [options]\n\n' +
        'Options:\n' +
        '  --fixtures=<dir>      Directory containing assay fixture JSON files\n' +
        '  --baselines=<dir>     Directory containing baseline fixture results\n' +
        '  --as=<format>         Output: json|md (default: json)\n' +
        '  --out=<path>          Write output to file\n' +
        '  --profile=<json>      Assay profile JSON (overrides defaults)\n' +
        '  --classify            Only output asset classification (no assay run)\n',
    );
    if (args.includes('--help') || args.includes('-h')) process.exit(0);
    process.exit(EXIT.INPUT_ERROR);
  }

  const fixturesPath = getFlag('--fixtures');
  const baselinesPath = getFlag('--baselines');
  const as = getFlag('--as') || 'json';
  const outPath = getFlag('--out');
  const profilePath = getFlag('--profile');
  const classifyOnly = args.includes('--classify');

  const abs = path.resolve(assetPath);
  const manifest = loadManifest(abs);

  if (!manifest) {
    error(`Cannot read asset: ${assetPath}`, EXIT.INPUT_ERROR);
  }

  const assetId = manifest.asset_id || manifest.name || path.basename(abs, '.kdna');
  const assetVersion = manifest.version || '0.1.0';

  const {
    createAssayProfile,
    validateFixtureSet,
    classifyAsset,
    FIXTURE_CATEGORIES,
  } = loadKdnaEval();

  // Load profile
  let profile;
  if (profilePath && fs.existsSync(profilePath)) {
    try {
      const customProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      profile = createAssayProfile({ ...customProfile, assetId, assetVersion });
    } catch (e) {
      error(`Invalid profile JSON: ${e.message}`, EXIT.INPUT_ERROR);
    }
  } else {
    profile = createAssayProfile({ assetId, assetVersion });
  }

  // Classify-only mode
  if (classifyOnly) {
    const evidence = {
      format_valid: manifest.overall_valid !== false,
      loads: manifest.loadable !== false,
    };
    const classification = classifyAsset(evidence);
    output(JSON.stringify({ asset_id: assetId, classification }, null, 2), as, outPath);
    return;
  }

  // Load fixtures
  const fixtures = [];
  if (fixturesPath) {
    const rawFixtures = loadFixtures(fixturesPath);
    for (const rf of rawFixtures) {
      if (rf && rf.task) {
        fixtures.push({
          fixture_id: rf.fixture_id || `fixture_${crypto.randomBytes(8).toString('hex')}`,
          category: rf.category || 'positive_target',
          task: rf.task,
          task_hash: rf.task_hash || `sha256:${crypto.createHash('sha256').update(rf.task || '').digest('hex')}`,
          expected: rf.expected || {},
        });
      }
    }
  }

  // No fixtures? Generate a basic structural report
  if (fixtures.length === 0 && !baselinesPath) {
    const structuralReport = {
      assay_version: '0.9.0',
      mode: 'structural_only',
      asset_id: assetId,
      asset_version: assetVersion,
      profile,
      fixture_validation: { valid: false, summary: { total: 0, by_category: {} }, errors: ['No fixtures provided — only structural validation possible'] },
      note: 'Run with --fixtures <dir> to execute a full behavioral assay. Fixtures require task/expected JSON files.',
      fixture_categories_required: Object.fromEntries(FIXTURE_CATEGORIES.map(c => [c, profile.thresholds[c + '_min_count'] || 0])),
    };
    output(JSON.stringify(structuralReport, null, 2), as, outPath);
    return;
  }

  // Validate fixture set
  const fixtureValidation = validateFixtureSet(fixtures, profile);

  // Build output
  const report = {
    assay_version: '0.9.0',
    asset_id: assetId,
    asset_version: assetVersion,
    profile,
    fixture_validation: fixtureValidation,
    fixtures_loaded: fixtures.length,
    fixture_categories: FIXTURE_CATEGORIES.reduce((acc, cat) => ({
      ...acc, [cat]: fixtures.filter(f => f.category === cat).length
    }), {}),
    note: 'Full behavioral assay requires a runner function. Use kdna-eval/runAssay() programmatically to execute fixtures against baseline arms.',
    next_steps: [
      'Create 8+ positive_target fixtures',
      'Create 4+ non_applicable fixtures',
      'Create 4+ adjacent_ambiguous fixtures',
      'Create 2+ high_risk_failure fixtures',
      'Create 2+ regression fixtures',
      'Create 1+ holdout fixture',
      'Run runAssay() with a registered runner',
      'Classify asset based on assay results',
    ],
  };

  output(JSON.stringify(report, null, 2), as, outPath);
}

function output(data, format, outPath) {
  if (outPath) {
    fs.writeFileSync(path.resolve(outPath), data + '\n');
  }

  if (format === 'json') {
    console.log(data);
  } else if (format === 'md') {
    // Basic markdown rendering
    const obj = JSON.parse(data);
    let md = `# Asset Assay: ${obj.asset_id} v${obj.asset_version}\n\n`;
    md += `**Assay Version:** ${obj.assay_version}\n\n`;

    if (obj.fixture_validation) {
      md += `## Fixture Validation\n\n`;
      md += `- **Valid:** ${obj.fixture_validation.valid}\n`;
      md += `- **Total:** ${obj.fixture_validation.summary?.total || 0}\n`;
      if (obj.fixture_validation.errors?.length) {
        md += `- **Errors:**\n`;
        obj.fixture_validation.errors.forEach(e => md += `  - ${e}\n`);
      }
    }

    if (obj.fixture_categories) {
      md += `\n## Fixture Categories\n\n`;
      for (const [cat, count] of Object.entries(obj.fixture_categories)) {
        const required = obj.profile?.thresholds?.[cat + '_min_count'] || 0;
        md += `- **${cat}:** ${count} / ${required} required\n`;
      }
    }

    if (obj.next_steps) {
      md += `\n## Next Steps\n\n`;
      obj.next_steps.forEach(s => md += `1. ${s}\n`);
    }

    console.log(md);
  }

  if (!outPath) {
    // Already written to stdout
  }
}

module.exports = { cmdEvalAsset };
