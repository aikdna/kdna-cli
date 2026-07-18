/**
 * kdna eval asset — Run Asset Assay against a KDNA asset.
 *
 * Usage: kdna eval asset <asset.kdna> --fixtures <dir> --as json
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { error, EXIT } = require('./_common');
const { loadKdnaEval } = require('./_kdna-eval');

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
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
  return files
    .map((f) => {
      try {
        const fixture = JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8'));
        return fixture;
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function loadObservations(inputPath) {
  if (!inputPath || !fs.existsSync(inputPath)) return [];
  const files = fs.statSync(inputPath).isDirectory()
    ? fs
        .readdirSync(inputPath)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(inputPath, f))
    : [inputPath];
  const observations = [];
  for (const file of files) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rows = Array.isArray(value) ? value : value.observations || value.results || [];
      if (Array.isArray(rows)) observations.push(...rows);
    } catch (_) {}
  }
  return observations;
}

async function cmdEvalAsset(args) {
  const getFlag = (name) => {
    const eq = args.find((a) => a.startsWith(name + '='));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };

  const posArgs = args.filter((a) => !a.startsWith('--'));
  const assetPath = posArgs[0];

  if (!assetPath || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage: kdna eval asset <asset-path> [options]\n\n' +
        'Options:\n' +
        '  --fixtures=<dir>      Directory containing assay fixture JSON files\n' +
        '  --baselines=<dir>     Directory containing baseline fixture results\n' +
        '  --observations=<file>  JSON observations for every fixture × baseline arm\n' +
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
  const observationsPath = getFlag('--observations') || baselinesPath;
  const as = getFlag('--as') || 'json';
  const outPath = getFlag('--out');
  const profilePath = getFlag('--profile');
  const classifyOnly = args.includes('--classify');

  let resolvedTarget = assetPath;
  try {
    const { resolveAsset } = require('../package-store');
    const resolved = resolveAsset(assetPath);
    if (resolved?.asset_path) resolvedTarget = resolved.asset_path;
  } catch (_) {}
  const abs = path.resolve(resolvedTarget);
  const manifest = loadManifest(abs);

  if (!manifest) {
    error(`Cannot read asset: ${assetPath}`, EXIT.INPUT_ERROR);
  }

  const assetId = manifest.asset_id || manifest.name || path.basename(abs, '.kdna');
  const assetVersion = manifest.version || '0.1.0';

  const { createAssayProfile, validateFixtureSet, classifyAsset, runAssay, FIXTURE_CATEGORIES } =
    loadKdnaEval('eval-asset');

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
          fixture_id:
            rf.fixture_id ||
            `fixture_${crypto
              .createHash('sha256')
              .update(`${rf.category || 'positive_target'}:${rf.task}`)
              .digest('hex')
              .slice(0, 16)}`,
          category: rf.category || 'positive_target',
          task: rf.task,
          task_hash:
            rf.task_hash ||
            `sha256:${crypto
              .createHash('sha256')
              .update(rf.task || '')
              .digest('hex')}`,
          expected: rf.expected || {},
        });
      }
    }
  }

  // No fixtures? Generate a basic structural report
  if (fixtures.length === 0 && !observationsPath) {
    const structuralReport = {
      assay_version: '0.9.0',
      mode: 'structural_only',
      asset_id: assetId,
      asset_version: assetVersion,
      profile,
      fixture_validation: {
        valid: false,
        summary: { total: 0, by_category: {} },
        errors: ['No fixtures provided — only structural validation possible'],
      },
      note: 'Run with --fixtures <dir> to execute a full behavioral assay. Fixtures require task/expected JSON files.',
      fixture_categories_required: Object.fromEntries(
        FIXTURE_CATEGORIES.map((c) => [c, profile.thresholds[c + '_min_count'] || 0]),
      ),
    };
    output(JSON.stringify(structuralReport, null, 2), as, outPath);
    return;
  }

  // Validate fixture set
  const fixtureValidation = validateFixtureSet(fixtures, profile);

  const observations = loadObservations(observationsPath);
  if (observationsPath) {
    const byKey = new Map();
    for (const observation of observations) {
      const fixtureId = observation.fixture_id;
      const arm = observation.arm || observation.baseline_arm;
      if (fixtureId && arm)
        byKey.set(
          `${fixtureId}:${arm}`,
          observation.result || observation.judgment_result || observation,
        );
    }

    const assay = await runAssay({
      profile,
      fixtures,
      asset: {},
      runner: async (fixture, baselineArm) => {
        const key = `${fixture.fixture_id}:${baselineArm.arm}`;
        if (!byKey.has(key)) throw new Error(`Missing observation: ${key}`);
        return byKey.get(key);
      },
    });
    const comparisonArmsRun = Object.values(assay.results_by_arm || {}).filter(
      (row) => row.count > 0 && row.errors === 0,
    ).length;
    const classification = classifyAsset({
      format_valid: true,
      loads: true,
      assay_passed: assay.overall_verdict === 'pass',
      comparison_arms_run: comparisonArmsRun,
    });
    const report = {
      ...assay,
      mode: 'behavioral_observations',
      observations_loaded: observations.length,
      classification,
      evidence_claim: null,
      evidence_claim_status: {
        generated: false,
        reason:
          'CLI observation matrices do not prove JudgmentTrace provenance; generate a claim through the official Eval API only after independently validating and binding the trace.',
      },
    };
    output(JSON.stringify(report, null, 2), as, outPath);
    if (assay.overall_verdict !== 'pass') process.exitCode = EXIT.JUDGMENT_QUALITY_FAILED;
    return;
  }

  // Build output
  const report = {
    assay_version: '0.9.0',
    asset_id: assetId,
    asset_version: assetVersion,
    profile,
    fixture_validation: fixtureValidation,
    fixtures_loaded: fixtures.length,
    fixture_categories: FIXTURE_CATEGORIES.reduce(
      (acc, cat) => ({
        ...acc,
        [cat]: fixtures.filter((f) => f.category === cat).length,
      }),
      {},
    ),
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
        obj.fixture_validation.errors.forEach((e) => (md += `  - ${e}\n`));
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
      obj.next_steps.forEach((s) => (md += `1. ${s}\n`));
    }

    console.log(md);
  }

  if (!outPath) {
    // Already written to stdout
  }
}

module.exports = { cmdEvalAsset };
