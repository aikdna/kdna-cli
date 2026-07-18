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

function buildTraceId(assetPath, task, policyHash, timestamp) {
  return crypto
    .createHash('sha256')
    .update(`${assetPath}:${task}:${policyHash}:${timestamp}`)
    .digest('hex')
    .slice(0, 32);
}

function cmdRoute(args) {
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
      'Usage: kdna route <asset-path> [options]\n' +
        '\n' +
        'Options:\n' +
        '  --task=<task>          Task verb (default: review)\n' +
        '  --policy=<path>        Route policy JSON file\n' +
        '  --route-card=<path>    Route card sidecar (replaces policy domain prefs)\n' +
        '  --consumer-index=<path> Consumer index for trust verification\n' +
        '  --budget=<profile>     interactive|code-review|offline-audit\n' +
        '  --as=<format>          Output: json|trace|prompt (default: prompt)\n' +
        '  --trace=<path>         Write trace to file\n',
    );
    if (args.includes('--help') || args.includes('-h')) {
      process.exit(0);
    }
    process.exit(EXIT.INPUT_ERROR);
  }

  const task = getFlag('--task') || 'review';
  const policyPath = getFlag('--policy');
  const budget = getFlag('--budget') || 'interactive';
  const as = getFlag('--as') || 'prompt';
  const tracePath = getFlag('--trace');
  const routeCardPath = getFlag('--route-card');
  const consumerIndexPath = getFlag('--consumer-index');

  const abs = path.resolve(assetPath);
  const manifest = loadManifest(abs);

  let policies = null;
  if (policyPath) {
    try {
      policies = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    } catch (e) {
      error(`Cannot read policy file: ${policyPath} — ${e.message}`, EXIT.INPUT_ERROR);
    }
  }

  const kdnaEval = loadKdnaEval('route');
  const { createConsumptionRunner, loadRouteCard, applyRouteCard } = kdnaEval;

  if (routeCardPath) {
    const cardResult = loadRouteCard(routeCardPath);
    if (!cardResult.valid) {
      error(`Invalid route card: ${cardResult.errors.join('; ')}`, EXIT.INPUT_ERROR);
    }
    policies = applyRouteCard(cardResult.card, policies);
  }

  let consumerIndexLoaded = null;
  if (consumerIndexPath) {
    const { loadConsumerIndex } = kdnaEval;
    const idxResult = loadConsumerIndex(consumerIndexPath);
    if (!idxResult.valid) {
      error(`Invalid consumer index: ${idxResult.errors.join('; ')}`, EXIT.INPUT_ERROR);
    }
    consumerIndexLoaded = idxResult.index;
  }
  const consumption = createConsumptionRunner({ policies, budgetProfile: budget });

  const asset = {
    path: assetPath,
    id: manifest?.asset_id || manifest?.asset_uid || null,
    text: manifest ? JSON.stringify({ title: manifest.title, version: manifest.version }) : null,
  };

  const ts = new Date().toISOString();
  const policyHash = policies
    ? crypto.createHash('sha256').update(JSON.stringify(policies)).digest('hex').slice(0, 12)
    : 'no-policy';

  // Run route gate
  const routeResult = consumption.route(asset, { task });

  // Run cost gate
  const costResult = consumption.cost(asset, { task, advisors: [] });

  // Build trace
  const traceId = buildTraceId(assetPath, task, policyHash, ts);

  const trace = {
    kdna_trace: '1.0.0',
    trace_id: traceId,
    timestamp: ts,
    operation: task,
    decision: {
      primary: routeResult.details.primary
        ? {
            domain_id: routeResult.details.primary,
            weight: 1,
            reason: `selected by route policy for operation "${task}"`,
          }
        : { domain_id: null, weight: 0, reason: 'no matching domain' },
      advisors: [],
      rejected: (routeResult.details.rejected || []).map((d) => ({
        domain_id: typeof d === 'string' ? d : d.id || d,
        reason: typeof d === 'string' ? 'skipped by policy' : d.reason || 'skipped',
      })),
      budget_profile: budget,
      confidence: routeResult.details.confidence || 'low',
      abstain_reason: routeResult.details.abstainReason || null,
    },
    cost: {
      tokens_consumed: costResult.details.consumed.tokens,
      chars_consumed: costResult.details.consumed.chars,
      assets_loaded: costResult.details.consumed.assets,
      over_budget: costResult.details.over_budget,
    },
    projection: {
      shape: 'answer-pattern',
    },
    provenance: {
      route_card_version: routeCardPath ? '0.1.0' : null,
      consumer_index_version: consumerIndexLoaded?.consumer_index || '0.2.0',
      consumer_index_path: consumerIndexPath || null,
      policy_input_hash: policyHash,
    },
  };

  // Check primary domain against consumer index trust status
  if (consumerIndexLoaded && trace.decision.primary.domain_id) {
    const { resolveConsumerIndex } = kdnaEval;
    const resolved = resolveConsumerIndex(
      consumerIndexLoaded,
      task,
      trace.decision.primary.domain_id,
    );
    if (!resolved.isTrusted) {
      trace.decision.confidence = 'low';
      trace.decision.abstain_reason =
        trace.decision.abstain_reason ||
        `domain "${trace.decision.primary.domain_id}" is not trusted in consumer index (status: ${resolved.status}, enabled: ${resolved.isEnabled})`;
    }
  }

  // Output
  if (as === 'trace') {
    const { validateTrace } = require(
      path.join(__dirname, '..', '..', 'schema', 'trace-validator'),
    );
    const validation = validateTrace(trace);
    const out = { ...trace, _validation: { valid: validation.valid, errors: validation.errors } };
    console.log(JSON.stringify(out, null, 2));
  } else if (as === 'json') {
    console.log(JSON.stringify(trace, null, 2));
  } else {
    console.log(formatRoutePrompt(trace, routeResult, costResult));
  }

  if (tracePath) {
    fs.writeFileSync(path.resolve(tracePath), JSON.stringify(trace, null, 2) + '\n');
  }
}

function formatRoutePrompt(trace, routeResult, costResult) {
  const lines = [];
  const d = trace.decision;

  lines.push(`# kdna route — ${trace.operation}`);
  lines.push(`# trace: ${trace.trace_id}`);
  lines.push(`# budget: ${d.budget_profile}`);
  lines.push('');

  lines.push('## Primary');
  if (d.primary.domain_id) {
    lines.push(`- **Domain:** ${d.primary.domain_id}`);
    lines.push(`- **Weight:** ${d.primary.weight}`);
    lines.push(`- **Reason:** ${d.primary.reason}`);
    lines.push(`- **Confidence:** ${d.confidence}`);
  } else {
    lines.push(`- **None** — ${d.abstain_reason || 'no matching domain'}`);
  }
  lines.push('');

  if (d.advisors.length > 0) {
    lines.push('## Advisors');
    for (const a of d.advisors) {
      lines.push(`- ${a.domain_id} (${a.role || 'advisor'})`);
    }
    lines.push('');
  }

  if (d.rejected.length > 0) {
    lines.push('## Rejected');
    for (const r of d.rejected) {
      lines.push(`- ${r.domain_id}: ${r.reason}`);
    }
    lines.push('');
  }

  lines.push('## Cost');
  lines.push(`- Tokens: ${trace.cost.tokens_consumed} / ${costResult.details.limits.maxTokens}`);
  lines.push(`- Chars: ${trace.cost.chars_consumed} / ${costResult.details.limits.maxChars}`);
  lines.push(`- Assets: ${trace.cost.assets_loaded} / ${costResult.details.limits.maxAssets}`);
  lines.push(`- Over budget: ${trace.cost.over_budget ? 'YES' : 'no'}`);
  lines.push('');

  lines.push('## Provenance');
  lines.push(`- Policy hash: ${trace.provenance.policy_input_hash}`);
  lines.push(`- Consumer index: ${trace.provenance.consumer_index_version}`);

  return lines.join('\n');
}

module.exports = { cmdRoute };
