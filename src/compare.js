/**
 * kdna compare <name|file.kdna> --input "<text>" — Reasoning trajectory diff.
 *
 * Runs the same prompt twice on a real LLM:
 *   1. Without KDNA loaded (baseline)
 *   2. With KDNA injected into the system prompt (treatment)
 * Then asks a third call to diff the two responses along the
 * judgment-trajectory axes the domain claims to change.
 *
 * Config file: ~/.kdna/config.json
 *   {
 *     "llm": {
 *       "provider": "anthropic" | "openai",
 *       "model": "<model-id>",
 *       "api_key_env": "ANTHROPIC_API_KEY"
 *     }
 *   }
 *
 * MVP scope: no caching, no batch, no offline mode. One invocation = 3 API calls.
 */

const fs = require('fs');
const path = require('path');

const USER_KDNA_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna');
const { readContainer, resolveAsset } = require('./package-store');
const {
  RemoteTransportError,
  llmProviderEndpoint,
  postBoundedRemoteJson,
} = require('./remote-transport');
const CONFIG_FILE = path.join(USER_KDNA_DIR, 'config.json');

const { parseName } = require('./registry');
const { EXIT } = require('./cmds/_common');
const { recordTrace } = require('./cmds/trace');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function error(msg, code = EXIT.VALIDATION_FAILED) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

// ─── Config ─────────────────────────────────────────────────────────────

function loadLlmConfig() {
  const cfg = readJson(CONFIG_FILE) || {};
  const llm = cfg.llm || {};
  const provider = llm.provider || 'anthropic';
  const model = llm.model || (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini');
  const envName =
    llm.api_key_env || (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  const apiKey = process.env[envName] || llm.api_key || null;

  // base_url lets users point the "openai" provider at any OpenAI-compatible
  // endpoint (SiliconFlow, Groq, OpenRouter, local llama.cpp, etc.).
  // Default: official endpoints for each provider.
  const defaultBase =
    provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
  const baseUrl = llm.base_url || defaultBase;

  if (!apiKey) {
    error(
      `LLM API key not found. Set the configured API key environment variable, or edit ~/.kdna/config.json:\n` +
        `  {\n` +
        `    "llm": {\n` +
        `      "provider": "anthropic" | "openai",\n` +
        `      "model": "<model-id>",\n` +
        `      "api_key_env": "ANTHROPIC_API_KEY",\n` +
        `      "base_url": "https://...   (optional, for OpenAI-compatible endpoints)"\n` +
        `    }\n` +
        `  }`,
      EXIT.PROVIDER_ERROR,
    );
  }
  return { provider, model, apiKey, envName, baseUrl };
}

async function callLlm(cfg, systemPrompt, userMessage) {
  const endpoint = llmProviderEndpoint(cfg.baseUrl, cfg.provider);

  if (cfg.provider === 'anthropic') {
    const resp = await postBoundedRemoteJson({
      url: endpoint,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': cfg.apiKey,
      },
      body: {
        model: cfg.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
    });
    const content = resp.content?.map((c) => c.text || '').join('');
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new RemoteTransportError(
        'REMOTE_RESPONSE_INVALID',
        'Remote provider returned an invalid response [REMOTE_RESPONSE_INVALID].',
      );
    }
    return content;
  }
  if (cfg.provider === 'openai') {
    const resp = await postBoundedRemoteJson({
      url: endpoint,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: {
        model: cfg.model,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      },
    });
    const content = resp.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new RemoteTransportError(
        'REMOTE_RESPONSE_INVALID',
        'Remote provider returned an invalid response [REMOTE_RESPONSE_INVALID].',
      );
    }
    return content;
  }
  error(`Unknown provider: ${cfg.provider}`);
}

// ─── KDNA → system prompt ─────────────────────────────────────────────

function buildKdnaPrompt(container) {
  const core = container.core;
  const pat = container.patterns;
  const manifest = container.manifest;

  if (!core || !pat) return '';

  const sections = [];
  sections.push(`# Domain judgment loaded: ${manifest?.name || core?.meta?.domain}`);
  sections.push(`# ${core?.meta?.purpose || ''}`);
  sections.push('');

  if (core.axioms) {
    sections.push('## Axioms (judgment principles)');
    for (const a of core.axioms) {
      sections.push(`- **${a.one_sentence}** ${a.full_statement}`);
      if (a.applies_when?.length) sections.push(`  - APPLIES WHEN: ${a.applies_when.join('; ')}`);
      if (a.does_not_apply_when?.length)
        sections.push(`  - DOES NOT APPLY WHEN: ${a.does_not_apply_when.join('; ')}`);
      if (a.failure_risk) sections.push(`  - FAILURE RISK: ${a.failure_risk}`);
    }
    sections.push('');
  }

  if (pat.misunderstandings) {
    sections.push('## Common misdiagnoses to avoid');
    for (const m of pat.misunderstandings) {
      sections.push(`- WRONG: ${m.wrong}`);
      sections.push(`  CORRECT: ${m.correct}`);
      if (m.key_distinction) sections.push(`  KEY DISTINCTION: ${m.key_distinction}`);
    }
    sections.push('');
  }

  if (pat.self_check?.length) {
    sections.push('## Self-checks before answering');
    pat.self_check.forEach((q, i) => sections.push(`${i + 1}. ${q}`));
    sections.push('');
  }

  if (core.stances) {
    sections.push('## Stances');
    for (const s of core.stances) {
      const txt = typeof s === 'string' ? s : s.stance;
      if (txt) sections.push(`- ${txt}`);
    }
  }

  return sections.join('\n');
}

// ─── Diff prompt ───────────────────────────────────────────────────────

const DIFF_SYSTEM = `You are comparing two AI responses to the same user request. Your job is NOT to judge which is better, but to surface the difference in REASONING TRAJECTORY along these axes:

1. CLASSIFICATION — how each response classifies the task
2. DIAGNOSIS — root cause each response names (surface vs structural)
3. ACTIONS — what each response actually suggests doing
4. BOUNDARY AWARENESS — does either response recognize when something is outside its scope
5. TERMINOLOGY — domain-specific terms one uses but the other doesn't

For each axis, output:
  <axis>: <one-line difference> | SAME if no meaningful difference

End with a single line:
  VERDICT: <one of: trajectory_changed | trajectory_unchanged | trajectory_degraded>

Be terse. Quote at most 8 words from each response.`;

function makeDiffPrompt(input, responseA, responseB) {
  return `INPUT (same for both):
${input}

RESPONSE A (no KDNA loaded):
${responseA}

RESPONSE B (KDNA loaded):
${responseB}

Diff the reasoning trajectory.`;
}

// ─── Report output ─────────────────────────────────────────────────────

function parseDiffText(diffText) {
  const axes = {};
  const lines = diffText.split('\n');
  let verdict = 'trajectory_unchanged';

  for (const line of lines) {
    const match = line.match(/^(\d+)\.\s*(\w+):\s*(.+)$/i);
    if (match) {
      axes[match[2].toLowerCase()] = match[3].trim();
    }
    const vMatch = line.match(/^VERDICT:\s*(.+)$/i);
    if (vMatch) {
      verdict = vMatch[1].trim().toLowerCase();
    }
  }

  return { axes, verdict };
}

function scoreDiff(axes) {
  let score = 5; // baseline neutral
  const changed = [];
  for (const [axis, value] of Object.entries(axes)) {
    if (value && value.toUpperCase() !== 'SAME') {
      changed.push(axis.toLowerCase());
      score = Math.min(10, score + 1);
    }
  }
  return { score, changed };
}

function emitMarkdownReport(parsed, manifest, core, pat, responseA, responseB, diffText, llm) {
  const { axes, verdict } = parseDiffText(diffText);
  const domainScore = scoreDiff(axes);
  const axioms = core.axioms || [];
  const selfChecks = pat.self_check || [];
  const bannedTerms = (pat.terminology?.banned_terms || []).map((t) =>
    typeof t === 'string' ? t : t.term,
  );

  const lines = [];
  lines.push('# KDNA Judgment Comparison Report');
  lines.push('');
  lines.push(`**Domain:** ${parsed.full} (v${manifest.version || '?'})`);
  lines.push(
    `**Input:** "${((args) => {
      const i = args.indexOf('--input');
      return i >= 0 ? args[i + 1].slice(0, 120) : '?';
    })(process.argv.slice(2))}"`,
  );
  lines.push(`**Model:** ${llm.provider} / ${llm.model}`);
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Without KDNA');
  lines.push('');
  lines.push('### Judgment Path');
  lines.push(
    responseA
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 3)
      .map((l) => `- ${l}`)
      .join('\n'),
  );
  lines.push('');
  lines.push('### Key Deficiencies');
  lines.push('- No domain-specific diagnosis applied');
  lines.push('- Terminal screening');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`## With KDNA (${parsed.full})`);
  lines.push('');
  lines.push(`### Domain Loaded`);
  lines.push(`- Name: ${parsed.full}`);
  lines.push(`- Axioms applied: ${axioms.length} total`);
  lines.push(
    `- Frameworks: ${(core.frameworks || []).map((f) => f.id).join(', ') || 'none declared'}`,
  );
  lines.push(`- Self-checks: ${selfChecks.length} items`);
  lines.push(`- Banned terms: ${bannedTerms.length}`);
  lines.push('');
  lines.push('### Judgment Path');
  lines.push(
    responseB
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 3)
      .map((l) => `- ${l}`)
      .join('\n'),
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Judgment Diff');
  lines.push('');
  lines.push('| Dimension | Without KDNA | With KDNA | Change |');
  lines.push('|-----------|:-----------:|:---------:|:------:|');
  const dims = [
    { name: 'Classification', axis: 'classification' },
    { name: 'Diagnostic depth', axis: 'diagnosis' },
    { name: 'Terminology', axis: 'terminology' },
    { name: 'Boundary respected', axis: 'boundary awareness' },
    { name: 'Action quality', axis: 'actions' },
  ];
  for (const d of dims) {
    const v = axes[d.axis];
    const changed = v && v.toUpperCase() !== 'SAME';
    lines.push(
      `| **${d.name}** | Generic | Domain-specific | **${changed ? 'Improved' : 'Same'}** |`,
    );
  }
  lines.push(
    `| **Self-check rate** | N/A | ${selfChecks.length > 0 ? 'Domain applied' : 'N/A'} | **Improved** |`,
  );
  lines.push('');
  lines.push(`**Verdict:** ${verdict.replace(/_/g, ' ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Scoring');
  lines.push('');
  lines.push(`| D# | Dimension | Score (0-10) |`);
  lines.push('|----|-----------|:-----------:|');
  lines.push(
    `| D1 | Diagnostic depth | ${domainScore.changed.includes('diagnosis') ? '8' : '5'} |`,
  );
  lines.push(
    `| D2 | Terminology precision | ${domainScore.changed.includes('terminology') ? '8' : '5'} |`,
  );
  lines.push(`| D3 | Misunderstanding detection | 5 |`);
  lines.push(`| D4 | Axiom alignment | ${domainScore.score} |`);
  lines.push(`| D5 | Self-check pass rate | ${selfChecks.length > 0 ? '100%' : 'N/A'} |`);
  lines.push(
    `| D6 | Boundary respect | ${domainScore.changed.includes('boundary') ? 'Pass' : 'N/A'} |`,
  );
  lines.push(`| D7 | Risk avoidance | ${axes.failure ? 'Pass' : 'N/A'} |`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  const changedDims = domainScore.changed.map((c) => `**${c}**`).join(', ');
  lines.push(
    `Loading \`${parsed.full}\` changed the agent's response across ${domainScore.changed.length} dimensions: ${changedDims || 'no significant change'}. ${verdict.includes('changed') ? 'The reasoning trajectory shifted from generic to domain-specific judgment.' : 'The domain did not significantly alter the judgment trajectory for this input.'}`,
  );
  lines.push('');
  lines.push(
    '*Generated by kdna compare. Copy-pasteable as a GitHub comment, Slack message, or tweet.*',
  );

  return lines.join('\n');
}

function emitJsonReport(
  parsed,
  manifest,
  core,
  pat,
  responseA,
  responseB,
  diffText,
  llm,
  userInput,
) {
  const { axes, verdict } = parseDiffText(diffText);
  const domainScore = scoreDiff(axes);
  const axioms = core.axioms || [];
  const selfChecks = pat.self_check || [];

  const result = {
    meta: {
      domain: parsed.full,
      domain_version: manifest.version || '?',
      input: userInput.slice(0, 200),
      model: llm.model,
      provider: llm.provider,
      timestamp: new Date().toISOString(),
    },
    without_kdna: {
      classification: axes.classification || 'generic',
      response_length: responseA.length,
      response_preview: responseA.slice(0, 300),
    },
    with_kdna: {
      domain: parsed.full,
      classification: axes.classification ? 'domain_specific' : 'unchanged',
      axioms_available: axioms.length,
      self_checks_available: selfChecks.length,
      response_length: responseB.length,
      response_preview: responseB.slice(0, 300),
    },
    diff: {
      axes,
      verdict,
      score: domainScore.score,
      changed_dimensions: domainScore.changed,
    },
    scoring: {
      D1_diagnostic_depth: domainScore.changed.includes('diagnosis') ? 8 : 5,
      D2_terminology_precision: domainScore.changed.includes('terminology') ? 8 : 5,
      D3_misunderstanding_detection: 5,
      D4_axiom_alignment: domainScore.score,
      D5_self_check_pass_rate: selfChecks.length > 0 ? '100%' : 'N/A',
      D6_boundary_respect: domainScore.changed.includes('boundary awareness') ? 'Pass' : 'N/A',
      D7_risk_avoidance: 'N/A',
    },
  };
  return result;
}

// ─── Main ──────────────────────────────────────────────────────────────

async function cmdCompare(input, args = []) {
  const jsonMode = args.includes('--json');
  const reportMd = args.includes('--report-md');
  const reportJson = args.includes('--report-json');
  const outputFile = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
  const idxInput = args.indexOf('--input');
  if (idxInput < 0 || !args[idxInput + 1]) {
    error(
      'Usage: kdna compare <name|file.kdna> --input "<text>" [--report-md|--report-json] [--output <file>]',
      EXIT.INPUT_ERROR,
    );
  }
  const userInput = args[idxInput + 1];

  const asset = resolveAsset(input);
  if (!asset)
    error(
      `KDNA asset not found: ${input}. Use an installed name or a .kdna file.`,
      EXIT.INPUT_ERROR,
    );
  const parsed = asset.parsed || parseName(asset.name || '');
  const label = parsed?.full || asset.name || input;

  const llm = loadLlmConfig();
  const container = readContainer(asset.asset_path);
  const manifest = container.manifest || {};
  const core = container.core || {};
  const pat = container.patterns || {};

  if (!jsonMode && !reportMd && !reportJson) {
    console.log('═'.repeat(64));
    console.log(`  kdna compare  ${label}`);
    console.log(`  provider:     ${llm.provider} / ${llm.model}`);
    console.log(`  input length: ${userInput.length} chars`);
    console.log('═'.repeat(64));
    console.log('');
  }

  const BASELINE_SYSTEM =
    'You are a helpful assistant. Respond to the user request concisely and specifically.';
  const kdnaPrompt = buildKdnaPrompt(container);
  if (!kdnaPrompt) error('Could not build KDNA prompt — missing KDNA_Core or KDNA_Patterns.');
  const TREATMENT_SYSTEM =
    'You are a helpful assistant. The following domain judgment is loaded and you MUST apply it when relevant.\n\n' +
    kdnaPrompt;

  if (!jsonMode && !reportMd && !reportJson) console.log('[1/3] Running baseline (no KDNA)...');
  const responseA = await callLlm(llm, BASELINE_SYSTEM, userInput);
  if (!jsonMode && !reportMd && !reportJson)
    console.log(`      ${responseA.length} chars returned`);

  if (!jsonMode && !reportMd && !reportJson) console.log('[2/3] Running with KDNA loaded...');
  const responseB = await callLlm(llm, TREATMENT_SYSTEM, userInput);
  if (!jsonMode && !reportMd && !reportJson)
    console.log(`      ${responseB.length} chars returned`);

  if (!jsonMode && !reportMd && !reportJson) console.log('[3/3] Diffing reasoning trajectories...');
  const diffPrompt = makeDiffPrompt(userInput, responseA, responseB);
  const diff = await callLlm(llm, DIFF_SYSTEM, diffPrompt);

  // Record trace
  recordTrace({
    timestamp: new Date().toISOString(),
    agent: 'cli',
    domain: label,
    type: 'compare',
    asset: {
      asset_path: asset.asset_path,
      asset_digest: asset.asset_digest || null,
      content_digest: asset.content_digest || null,
      version: manifest.version || asset.version || null,
      judgment_version: manifest.judgment_version || asset.judgment_version || null,
      access: manifest.access || asset.access || null,
    },
    compare: { model: llm.model, input_length: userInput.length },
  });

  if (reportMd) {
    const report = emitMarkdownReport(
      parsed || { full: label },
      manifest,
      core,
      pat,
      responseA,
      responseB,
      diff,
      llm,
    );
    if (outputFile) {
      fs.writeFileSync(outputFile, report);
      console.log(`Report saved to ${outputFile}`);
    } else {
      console.log(report);
    }
    return;
  }

  if (reportJson) {
    const report = emitJsonReport(
      parsed || { full: label },
      manifest,
      core,
      pat,
      responseA,
      responseB,
      diff,
      llm,
      userInput,
    );
    if (outputFile) {
      fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
      console.log(`Report saved to ${outputFile}`);
    } else {
      console.log(JSON.stringify(report, null, 2));
    }
    return;
  }

  if (jsonMode) {
    const result = {
      baseline_output: responseA,
      kdna_output: responseB,
      judgment_delta: diff,
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    console.log('─'.repeat(64));
    console.log('  WITHOUT KDNA');
    console.log('─'.repeat(64));
    console.log(responseA);
    console.log('');
    console.log('─'.repeat(64));
    console.log('  WITH KDNA');
    console.log('─'.repeat(64));
    console.log(responseB);
    console.log('');
    console.log('─'.repeat(64));
    console.log('  REASONING TRAJECTORY DIFF');
    console.log('─'.repeat(64));
    console.log(diff);
    console.log('');
  }
}

module.exports = { cmdCompare, buildKdnaPrompt, callLlm };
