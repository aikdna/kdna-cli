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

function cmdCompose(args) {
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
      'Usage: kdna compose <asset-path> [options]\n' +
        '\n' +
        'Options:\n' +
        '  --task=<task>          Task verb (default: review)\n' +
        '  --primary=<domain>     Force primary domain\n' +
        '  --advisors=<list>      Advisor domain IDs, comma-separated\n' +
        '  --policy=<path>        Route policy JSON\n' +
        '  --consumer-index=<path> Consumer index for trust verification\n' +
        '  --budget=<profile>     interactive|code-review|offline-audit\n' +
        '  --source-hardmax=<n>   Max total assets from source (default: 3)\n' +
        '  --as=<format>          json|trace|prompt (default: prompt)\n' +
        '  --trace=<path>         Write trace to file\n',
    );
    if (args.includes('--help') || args.includes('-h')) {
      process.exit(0);
    }
    process.exit(EXIT.INPUT_ERROR);
  }

  const task = getFlag('--task') || 'review';
  const primaryFlag = getFlag('--primary');
  const advisorsRaw = getFlag('--advisors') || '';
  const policyPath = getFlag('--policy');
  const budget = getFlag('--budget') || 'interactive';
  const sourceHardmax = parseInt(getFlag('--source-hardmax') || '3', 10);
  const as = getFlag('--as') || 'prompt';
  const tracePath = getFlag('--trace');
  const consumerIndexPath = getFlag('--consumer-index');

  const requestedAdvisors = advisorsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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

  const kdnaEval = loadKdnaEval('compose');
  const { createConsumptionRunner } = kdnaEval;
  const consumption = createConsumptionRunner({ policies, budgetProfile: budget });

  let consumerIndexLoaded = null;
  if (consumerIndexPath) {
    const { loadConsumerIndex } = kdnaEval;
    const idxResult = loadConsumerIndex(consumerIndexPath);
    if (!idxResult.valid) {
      error(`Invalid consumer index: ${idxResult.errors.join('; ')}`, EXIT.INPUT_ERROR);
    }
    consumerIndexLoaded = idxResult.index;
  }

  const asset = {
    path: assetPath,
    id: manifest?.asset_id || manifest?.asset_uid || null,
    text: manifest ? JSON.stringify({ title: manifest.title, version: manifest.version }) : null,
  };

  // Determine primary
  let primary = primaryFlag || null;
  const routeResult = consumption.route(asset, { task });
  if (!primary && routeResult.details.primary) {
    primary = routeResult.details.primary;
  }

  if (!primary) {
    error(
      'Cannot determine primary domain for compose.\n' +
        'Provide --primary=<domain-id> or ensure a policy with a matching route is loaded.\n' +
        'Compose does not fall back to all-assets loading.',
      EXIT.INPUT_ERROR,
    );
  }

  // Build advisor list: user-specified takes priority
  let advisors = [];
  if (requestedAdvisors.length > 0) {
    advisors = requestedAdvisors;
  }

  // Check advisors against consumer index trust status
  if (consumerIndexLoaded && advisors.length > 0) {
    const { resolveConsumerIndex } = kdnaEval;
    const trustedAdvisors = [];
    for (const a of advisors) {
      const resolved = resolveConsumerIndex(consumerIndexLoaded, task, a);
      if (resolved.isTrusted) {
        trustedAdvisors.push(a);
      }
    }
    advisors = trustedAdvisors;
  }

  // Compose gate handles source-hardmax internally.
  // Do NOT pre-truncate advisors — let the gate produce rejected_advisors.

  // Run compose gate (from kdna-eval consume.js)
  const composeContext = {
    task,
    primary,
    advisors,
    sourceHardmax,
    policies,
  };
  const composeResult = consumption.compose(asset, composeContext);

  // Run cost gate with advisors
  const costContext = {
    task,
    advisors: (composeResult.details.advisors || [])
      .filter((a) => a.accepted)
      .map((a) => ({
        id: a.domain_id,
        estimatedTokens: 300,
        content: JSON.stringify({ domain: a.domain_id, role: a.role }),
      })),
  };
  const costResult = consumption.cost(asset, costContext);

  const ts = new Date().toISOString();
  const policyHash = policies
    ? crypto.createHash('sha256').update(JSON.stringify(policies)).digest('hex').slice(0, 12)
    : 'no-policy';

  const traceId = buildTraceId(assetPath, task, policyHash, ts);

  const trace = {
    kdna_trace: '1.0.0',
    trace_id: traceId,
    timestamp: ts,
    operation: task,
    decision: {
      primary: composeResult.details.primary || {
        domain_id: null,
        weight: 0,
        reason: 'none',
      },
      advisors: (composeResult.details.advisors || []).map((a) => ({
        domain_id: a.domain_id,
        weight: a.weight,
        role: a.role || 'advisor',
      })),
      rejected: (composeResult.details.rejected_advisors || []).map((r) => ({
        domain_id: r.domain_id,
        reason: r.reason,
      })),
      budget_profile: budget,
      confidence: composeResult.pass ? 'medium' : 'low',
      abstain_reason: composeResult.pass ? null : 'compose gate failed',
    },
    cost: {
      tokens_consumed: costResult.details.consumed.tokens,
      chars_consumed: costResult.details.consumed.chars,
      assets_loaded: costResult.details.consumed.assets,
      over_budget: costResult.details.over_budget,
    },
    projection: {
      shape: 'compact',
    },
    provenance: {
      route_card_version: null,
      consumer_index_version: consumerIndexLoaded?.consumer_index || '0.2.0',
      consumer_index_path: consumerIndexPath || null,
      policy_input_hash: policyHash,
    },
  };

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
    console.log(formatComposePrompt(trace, composeResult, costResult));
  }

  if (tracePath) {
    fs.writeFileSync(path.resolve(tracePath), JSON.stringify(trace, null, 2) + '\n');
  }
}

function formatComposePrompt(trace, composeResult, costResult) {
  const lines = [];
  const d = trace.decision;

  lines.push(`# kdna compose — ${trace.operation}`);
  lines.push(`# trace: ${trace.trace_id}`);
  lines.push(`# budget: ${d.budget_profile}`);
  lines.push('');

  lines.push('## Primary');
  if (d.primary.domain_id) {
    lines.push(`- **Domain:** ${d.primary.domain_id}`);
  } else {
    lines.push('- **None**');
  }
  lines.push('');

  if (d.advisors.length > 0) {
    lines.push('## Advisors');
    for (const a of d.advisors) {
      lines.push(`- ${a.domain_id} (${a.role || 'advisor'}, weight: ${a.weight})`);
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

  const conflicts = composeResult.details.conflicts || [];
  if (conflicts.length > 0) {
    lines.push('## Conflicts');
    for (const c of conflicts) {
      lines.push(`- ${c.domain_a} vs ${c.domain_b}: ${c.description}`);
    }
    lines.push('');
  }

  lines.push('## Cost');
  lines.push(`- Tokens: ${trace.cost.tokens_consumed} / ${costResult.details.limits.maxTokens}`);
  lines.push(`- Chars: ${trace.cost.chars_consumed} / ${costResult.details.limits.maxChars}`);
  lines.push(`- Assets: ${trace.cost.assets_loaded} / ${costResult.details.limits.maxAssets}`);
  lines.push(`- Over budget: ${trace.cost.over_budget ? 'YES' : 'no'}`);
  lines.push('');

  lines.push('## Attribution');
  lines.push(`- Source hardmax: ${composeResult.details.source_hardmax}`);
  lines.push(`- Sources used: ${composeResult.details.sources_used}`);
  lines.push(`- Confidence: ${d.confidence}`);

  return lines.join('\n');
}

module.exports = { cmdCompose };
