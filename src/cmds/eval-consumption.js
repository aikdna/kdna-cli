const fs = require("node:fs");
const path = require("node:path");
const { error, EXIT } = require("./_common");

function loadKdnaEval() {
  try {
    return require("@aikdna/kdna-eval");
  } catch (e) {
    const altPaths = [
      process.env.KDNA_EVAL_PATH,
      path.resolve(__dirname, "..", "..", "..", "kdna", "packages", "kdna-eval"),
    ];
    for (const p of altPaths) {
      if (p) {
        try {
          return require(p);
        } catch (_) {}
      }
    }
    process.stderr.write(
      "Error: @aikdna/kdna-eval is required for eval-consumption.\n" +
        "Install it with: npm install @aikdna/kdna-eval@^0.2.0\n"
    );
    process.exit(EXIT.DEPENDENCY_ERROR || 6);
  }
}

function cmdEvalConsumption(args) {
  const getFlag = (name) => {
    const eq = args.find((a) => a.startsWith(name + "="));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx >= 0 ? args[idx + 1] : null;
  };

  const posArgs = args.filter((a) => !a.startsWith("--"));
  const assetPath = posArgs[0];

  if (posArgs.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stderr.write(
      "Usage: kdna eval-consumption <asset-path> [options]\n" +
        "\n" +
        "Options:\n" +
        "  --policy=<path>        Consumption route policy JSON file\n" +
        '  --fixtures=<path>      Replay fixture directory\n' +
        "  --gates=<list>         Gates to run, comma-separated (default: all)\n" +
        "  --mode=<list>          Replay modes, comma-separated (default: repair,holdout,fresh)\n" +
        "  --budget=<profile>     Budget profile: interactive|code-review|offline-audit\n" +
        "  --as=<format>          Output format: json|markdown (default: markdown)\n" +
        "  --out=<path>           Output file path (default: stdout)\n"
    );
    if (args.includes("--help") || args.includes("-h")) {
      process.exit(0);
    }
    process.exit(EXIT.INPUT_ERROR);
  }

  const policyPath = getFlag("--policy");
  const fixturesDir = getFlag("--fixtures");
  const gatesRaw = getFlag("--gates") || "route,compose,projection,cost,quality,promotion";
  const modesRaw = getFlag("--mode") || "repair,holdout,fresh";
  const budget = getFlag("--budget") || "interactive";
  const as = getFlag("--as") || "markdown";
  const outPath = getFlag("--out");

  const requestedGates = gatesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const modes = modesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { createMultiGateRunner, createConsumptionRunner, createReplayEngine } =
    loadKdnaEval();

  let policies = null;
  if (policyPath) {
    try {
      policies = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    } catch (e) {
      error(`Cannot read policy file: ${policyPath} — ${e.message}`, EXIT.INPUT_ERROR);
    }
  }

  let fixtures = [];
  if (fixturesDir) {
    try {
      const files = fs
        .readdirSync(fixturesDir)
        .filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const p = path.join(fixturesDir, f);
        try {
          const data = JSON.parse(fs.readFileSync(p, "utf8"));
          if (Array.isArray(data)) {
            fixtures.push(...data);
          } else {
            fixtures.push(data);
          }
        } catch (_) {}
      }
    } catch (e) {
      error(
        `Cannot read fixture directory: ${fixturesDir} — ${e.message}`,
        EXIT.INPUT_ERROR
      );
    }
  }

  // Build the consumption runner with actual route + cost gates.
  const consumptionRunner = createConsumptionRunner({
    policies,
    budgetProfile: budget,
  });

  // All 6 gates are now function gates. Zero string gates.
  const allGateDefs = [
    consumptionRunner.route,
    consumptionRunner.cost,
    consumptionRunner.compose,
    consumptionRunner.promotion,
    consumptionRunner.projection,
    consumptionRunner.quality,
  ];

  const selectedGates = allGateDefs.filter((g) => {
    const name = typeof g === "function" ? g.name : g;
    return requestedGates.includes(name);
  });

  const runner = createMultiGateRunner(
    selectedGates.length > 0 ? selectedGates : allGateDefs
  );

  // Build asset object for the consumption runner.
  const asset = {
    path: assetPath,
    text: null,
  };
  if (policies) {
    asset.text = JSON.stringify({ policies: Object.keys(policies) });
  }

  // Create replay engine for regression detection.
  const engine = createReplayEngine();

  // First mode serves as baseline.
  const baselineMode = modes[0];

  const modeResults = {};
  for (const mode of modes) {
    // Build promotion context: eval-consumption runs at eval_candidate level.
    const replayResults = {};
    for (const [m, data] of Object.entries(modeResults)) {
      replayResults[m] = {
        pass: data.aggregated ? data.aggregated.overall === "pass" : null,
      };
    }

    const context = {
      task: "review",
      mode,
      budget,
      assetPath,
      fixtures,
      source: "experiment-derived",
      reviewStatus: "eval_candidate",
      replayResults,
    };

    const gateResults = runner.runGates(context);
    const aggregated = runner.runAll ? runner.runAll(context) : null;

    // Build current run for replay comparison
    const currentRun = {
      mode,
      results: gateResults.map((g) => ({
        id: g.gate,
        score:
          g.score != null
            ? g.score
            : g.pass === true
              ? 1.0
              : g.pass === false
                ? 0.0
                : 0.5,
        pass: g.pass === true,
        dimensions: g.details || {},
      })),
    };

    const isBaseline = mode === baselineMode;
    const comparison = isBaseline
      ? { scoreDelta: 0, regressions: null }
      : engine.compareRuns(
          { results: modeResults[baselineMode]?._rawRun?.results || [] },
          currentRun
        );

    const regressionEntries = comparison.regressions || comparison.diff
      ? (comparison.diff || []).filter(
          (d) => d.kind === "pass-change" && d.b && d.b.pass !== true
        )
      : null;

    modeResults[mode] = {
      gates: gateResults.map((r, i) => ({
        gate: r.gate,
        pass: r.pass,
        score: r.score,
        details: r.details || {},
        errors: r.errors || [],
        regression:
          regressionEntries && regressionEntries.some((re) => re.index === i),
      })),
      aggregated: aggregated
        ? {
            overall: aggregated.overall,
            blocked_gates: aggregated.blocked_gates,
            passed_gates: aggregated.passed_gates,
            failed_gates: aggregated.failed_gates,
          }
        : null,
      comparison: {
        scoreDelta: comparison.scoreDelta || 0,
        regressions: regressionEntries || [],
      },
      _rawRun: currentRun,
    };
  }

  // Extract the cost report from the cost gate result of the first mode.
  let costReport = null;
  const firstModeResults = Object.values(modeResults)[0];
  if (firstModeResults) {
    const costGate = firstModeResults.gates.find((g) => g.gate === "cost");
    if (costGate && costGate.details && costGate.details.consumed) {
      costReport = costGate.details;
    }
  }
  if (!costReport) {
    const { createCostTracker } = loadKdnaEval();
    const t = createCostTracker(budget);
    costReport = t.getCostReport();
  }

  const output = {
    kdna_eval_consumption: "0.1.0",
    asset: {
      path: assetPath || null,
      version: policies?.version || null,
    },
    run: {
      timestamp: new Date().toISOString(),
      modes,
      gates: requestedGates,
      fixtures_loaded: fixtures.length,
      fixture_ids: fixtures.map((f) => f.id || f.domain_id || f.task).filter(Boolean),
    },
    fixture_summary: fixtures.length > 0
      ? buildFixtureSummary(fixtures, modeResults)
      : undefined,
    results: modeResults,
    verdict: computeVerdict(modeResults),
    budget: costReport,
  };

  const formatted =
    as === "json"
      ? JSON.stringify(output, null, 2)
      : formatMarkdown(output);

  if (outPath) {
    fs.writeFileSync(outPath, formatted + "\n");
  } else {
    process.stdout.write(formatted + "\n");
  }
}

function buildFixtureSummary(fixtures, modeResults) {
  const summary = { total: fixtures.length, routed: 0, failed_routing: 0 };
  for (const [mode, data] of Object.entries(modeResults || {})) {
    const routeGate = data.gates?.find((g) => g.gate === "route");
    if (routeGate) {
      if (routeGate.pass === true) summary.routed++;
      else if (routeGate.pass === false) summary.failed_routing++;
    }
  }
  return summary;
}

function computeVerdict(modeResults) {
  const allGates = [];
  for (const mode of Object.values(modeResults)) {
    for (const g of mode.gates || []) {
      allGates.push(g);
    }
  }

  const failed = allGates.filter((g) => g.pass === false).map((g) => g.gate);
  const blocked = allGates.filter((g) => g.pass === null).map((g) => g.gate);

  const uniqueFailed = [...new Set(failed)];
  const uniqueBlocked = [...new Set(blocked)];

  const regressionFlags = [];
  for (const [mode, data] of Object.entries(modeResults)) {
    if (data.comparison?.regressions?.length > 0) {
      regressionFlags.push({
        mode,
        regressions: data.comparison.regressions,
      });
    }
  }

  return {
    overall:
      uniqueFailed.length === 0 &&
      uniqueBlocked.length === 0 &&
      regressionFlags.length === 0
        ? "pass"
        : "fail",
    blocked_gates: uniqueBlocked,
    failed_gates: uniqueFailed,
    regression_flags: regressionFlags,
  };
}

function formatMarkdown(output) {
  const lines = [];
  lines.push("# KDNA Eval-Consumption Report");
  lines.push("");

  lines.push("## Asset");
  if (output.asset.path) lines.push(`- **Path:** ${output.asset.path}`);
  if (output.asset.version) lines.push(`- **Version:** ${output.asset.version}`);
  lines.push("");

  lines.push("## Run");
  lines.push(`- **Timestamp:** ${output.run.timestamp}`);
  lines.push(`- **Modes:** ${output.run.modes.join(", ")}`);
  lines.push(`- **Gates:** ${output.run.gates.join(", ")}`);
  lines.push("");

  for (const [mode, data] of Object.entries(output.results)) {
    lines.push(`## Mode: ${mode}`);
    lines.push("");
    lines.push("| Gate | Pass | Score | Errors |");
    lines.push("|------|------|-------|--------|");

    for (const g of data.gates || []) {
      const passIcon =
        g.pass === true ? "PASS" : g.pass === false ? "FAIL" : "BLOCKED";
      const score = g.score != null ? g.score.toString() : "-";
      const errors = (g.errors || []).join("; ") || "-";
      lines.push(`| ${g.gate} | ${passIcon} | ${score} | ${errors} |`);
    }
    lines.push("");

    if (data.aggregated) {
      lines.push(`**Aggregate:** ${data.aggregated.overall}`);
      if (data.aggregated.failed_gates.length > 0) {
        lines.push(
          `**Failed gates:** ${data.aggregated.failed_gates.join(", ")}`
        );
      }
      lines.push("");
    }

    if (data.comparison && data.comparison.regressions?.length > 0) {
      lines.push(
        `**Regressions:** ${data.comparison.regressions.length} detected`
      );
      lines.push(`**Score Delta:** ${data.comparison.scoreDelta}`);
      lines.push("");
    }
  }

  lines.push("## Verdict");
  lines.push(`- **Overall:** ${output.verdict.overall}`);
  if (output.verdict.failed_gates.length > 0) {
    lines.push(
      `- **Failed gates:** ${output.verdict.failed_gates.join(", ")}`
    );
  }
  if (output.verdict.blocked_gates.length > 0) {
    lines.push(
      `- **Blocked gates:** ${output.verdict.blocked_gates.join(", ")}`
    );
  }
  if (output.verdict.regression_flags.length > 0) {
    lines.push(`- **Regressions:** ${output.verdict.regression_flags.length} mode(s)`);
    for (const rf of output.verdict.regression_flags) {
      lines.push(`  - Mode ${rf.mode}: ${rf.regressions.length} regression(s)`);
    }
  }
  lines.push("");

  lines.push("## Budget");
  lines.push(`- **Profile:** ${output.budget.profile}`);
  lines.push(
    `- **Tokens:** ${output.budget.consumed.tokens} / ${output.budget.limits.maxTokens}`
  );
  lines.push(
    `- **Chars:** ${output.budget.consumed.chars} / ${output.budget.limits.maxChars}`
  );
  lines.push(
    `- **Assets:** ${output.budget.consumed.assets} / ${output.budget.limits.maxAssets}`
  );
  lines.push(
    `- **Over Budget:** ${output.budget.over_budget ? "YES" : "no"}`
  );

  return lines.join("\n");
}

module.exports = { cmdEvalConsumption };
