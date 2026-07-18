/**
 * kdna eval cluster — Run Cluster Assay against a cluster manifest.
 */

const fs = require('node:fs');
const path = require('node:path');
const { error, EXIT, readJson } = require('./_common');
const { loadKdnaEval } = require('./_kdna-eval');

function cmdEvalCluster(args) {
  const getFlag = (name) => {
    const eq = args.find((a) => a === name + '=' || a.startsWith(name + '='));
    if (eq) return eq.split('=').slice(1).join('=');
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
  };

  const posArgs = args.filter((a) => !a.startsWith('--'));
  const target = posArgs[0];

  if (!target || args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      'Usage: kdna eval cluster <kdna.cluster.json> [options]\n\n' +
        'Run a diagnostic Cluster Assay. CLI mode keeps trust and economics promotion blocked\n' +
        'because it cannot prove external provenance; run the Eval API inside the trusted\n' +
        'evidence producer for full promotion.\n\n' +
        'Options:\n' +
        '  --task=<text>         Task to evaluate against\n' +
        '  --fixtures=<dir>      Directory of cluster assay fixtures\n' +
        '  --comparison-arms=<file> JSON arm results including primary_only and bounded_compose\n' +
        '  --as=<format>         json|md (default: json)\n' +
        '  --out=<path>          Write output to file\n' +
        '  --gates=<list>        Comma-separated gates to display; all remain required for promotion\n\n' +
        'Gates (all required for promotion):\n' +
        '  structural   — Does the cluster resolve and compose correctly?\n' +
        '  behavioral   — Does the cluster improve over primary-only?\n' +
        '  economics    — Does the cluster justify its asset count?\n' +
        '  trust        — Are all assets authorized and verified?\n' +
        '  product      — Can a user understand and operate this cluster?\n',
    );
    if (args.includes('--help') || args.includes('-h')) process.exit(0);
    process.exit(EXIT.INPUT_ERROR);
  }

  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) error(`Manifest not found: ${target}`, EXIT.INPUT_ERROR);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    error(`Invalid JSON: ${e.message}`, EXIT.INPUT_ERROR);
  }

  const task = getFlag('--task') || '';
  const fixturesPath = getFlag('--fixtures');
  const comparisonArmsPath = getFlag('--comparison-arms');
  const as = getFlag('--as') || 'json';
  const outPath = getFlag('--out');
  const gatesFilter = getFlag('--gates');

  const { runClusterAssay } = loadKdnaEval('eval-cluster');

  // Generate plan from cluster-engine
  let plan = null;
  try {
    const { generateClusterPlan } = require('../cluster-engine');
    plan = generateClusterPlan(manifest, task || 'default task');
  } catch (e) {
    // Plan generation failed — structural gate will catch this
  }

  // Load fixtures if provided
  const fixtures = [];
  if (fixturesPath && fs.existsSync(fixturesPath)) {
    for (const f of fs.readdirSync(fixturesPath).filter((f) => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(fixturesPath, f), 'utf8'));
        if (data.task) fixtures.push(data);
      } catch (_) {}
    }
  }

  let comparisonArms = [];
  if (comparisonArmsPath) {
    const comparisonData = readJson(path.resolve(comparisonArmsPath));
    comparisonArms = Array.isArray(comparisonData)
      ? comparisonData
      : comparisonData?.comparison_arms || [];
    if (!Array.isArray(comparisonArms)) {
      error(
        'Comparison arms file must contain an array or {comparison_arms:[...]}.',
        EXIT.INPUT_ERROR,
      );
    }
  }

  if (args.some((arg) => arg === '--trace' || arg.startsWith('--trace='))) {
    error(
      'External Cluster trace JSON cannot establish promotion provenance. Run the Eval API inside the trusted evidence producer instead.',
      EXIT.INPUT_ERROR,
    );
  }

  // Run assay
  const result = runClusterAssay({
    manifest,
    plan,
    assetsLoaded: undefined,
    executionCost: undefined,
    fixtures,
    comparisonArms,
  });

  // Filter gates if requested
  if (gatesFilter) {
    const availableGates = Object.keys(result.gates);
    const filterList = gatesFilter
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknownGates = filterList.filter((gate) => !availableGates.includes(gate));
    if (filterList.length === 0 || unknownGates.length > 0) {
      error(
        `Unknown Cluster assay gate${unknownGates.length === 1 ? '' : 's'}: ${unknownGates.join(', ') || '(empty)'}. Expected one or more of: ${availableGates.join(', ')}.`,
        EXIT.INPUT_ERROR,
      );
    }
    for (const gate of Object.keys(result.gates)) {
      if (!filterList.includes(gate)) delete result.gates[gate];
    }
  }

  // Output
  const json = JSON.stringify(result, null, 2);

  if (outPath) fs.writeFileSync(path.resolve(outPath), json + '\n');

  if (as === 'json') {
    console.log(json);
  } else if (as === 'md') {
    let md = `# Cluster Assay: ${manifest.cluster_id || manifest.name}\n\n`;
    md += `**Version:** ${manifest.version || '0.1.0'}\n`;
    md += `**Verdict:** ${result.verdict.overall === 'pass' ? '✓ PASS' : '✗ FAIL'}\n\n`;

    md += `## Gates\n\n`;
    for (const [name, gate] of Object.entries(result.gates)) {
      const icon = gate.pass === true ? '✓' : gate.pass === false ? '✗' : '?';
      md += `### ${icon} ${name} (score: ${gate.score})\n`;
      if (gate.issues?.length) {
        for (const iss of gate.issues) md += `- ${iss}\n`;
      }
      md += `\n`;
    }

    md += `## Marginal Value\n\n`;
    md += `- Primary-only: ${result.marginal_value.primary_only_score ?? 'N/A'}\n`;
    md += `- Cluster: ${result.marginal_value.cluster_score ?? 'N/A'}\n`;
    md += `- Delta: ${result.marginal_value.delta}\n`;
    md += `- Threshold met: ${result.marginal_value.threshold_met ? '✓' : '✗'} (≥${result.marginal_value.threshold})\n`;

    md += `\n## Comparison Arms\n\n`;
    for (const arm of result.comparison_arms) {
      md += `- **${arm.arm}** (${arm.status}): ${arm.score !== null ? arm.score : 'N/A'} — ${arm.description}\n`;
    }

    console.log(md);
  }

  // The report is useful on stdout even when promotion is denied, but the
  // command must still behave as a quality gate for CI and release scripts.
  if (!result.verdict.all_passed) {
    process.exitCode = EXIT.JUDGMENT_QUALITY_FAILED;
  }
}

module.exports = { cmdEvalCluster };
