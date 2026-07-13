/**
 * Agent-facing commands — what the kdna-loader skill calls.
 *
 *   kdna available --json
 *     List installed domains, lean JSON, including applies_when fields
 *     and yanked status. Excludes yanked. ~200 bytes per domain.
 *     The agent uses this as its primary discovery source and decides
 *     which domain (if any) fits the task by reading the applies_when
 *     and does_not_apply_when fields against the task in its own words.
 *
 *   kdna match "<task>" [--json]
 *     Auxiliary signal — does NOT decide which domain to use. Returns:
 *       - dropped: domains whose does_not_apply_when clearly matches the
 *         task (hard disqualification — agent should respect)
 *       - hints: substring overlap signals per domain (weak — agent should
 *         not treat as a fit decision; many false positives expected)
 *     The agent makes the final call using its own language understanding.
 *
 *   kdna load <name|file.kdna> [--as=prompt]
 *     Read the domain's judgment and emit context suitable for agent
 *     system-prompt injection (axioms one-liners + stances +
 *     banned-terms + misunderstandings + self-checks).
 *     For raw inspection use: kdna dev decode <file.kdna> --reveal
 *
 * These commands are the supported interface between the kdna-loader
 * skill and the KDNA file format. The skill should not read KDNA
 * internals directly.
 */

const fs = require('fs');
const { parseName } = require('./registry');
const { recordTrace } = require('./cmds/trace');
const {
  getInstalled,
  listInstalled: listInstalledAssets,
  readContainer,
  readContainerJson,
  resolveAsset,
} = require('./package-store');
const { licenseDecryptOptionsForManifest } = require('./cmds/license');
const { loadAuthorized, planLoad } = require('@aikdna/kdna-core');
const { loadExternalAuthorization } = require('./external-entitlement');

function detectAgent() {
  return process.env.KDNA_AGENT || 'cli';
}

function listInstalled() {
  return listInstalledAssets().map((entry) => {
    const parsed = parseName(entry.full);
    return { ...entry, scope: parsed.scope, ident: parsed.ident };
  });
}

function assetLabel(asset, fallback) {
  return asset.name || asset.parsed?.full || fallback;
}

function stringList(value) {
  if (Array.isArray(value))
    return value.filter((item) => item !== undefined && item !== null && item !== '');
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function traceAssetFields(asset, manifest = {}, license = null) {
  const fields = {
    asset_path: asset.asset_path,
    asset_digest: asset.asset_digest || null,
    content_digest: asset.content_digest || null,
    version: manifest.version || asset.version || null,
    judgment_version: manifest.judgment_version || asset.judgment_version || null,
    access: manifest.access || asset.access || null,
  };
  if (license?.license_id) fields.license_id = license.license_id;
  return fields;
}

function readDiscoveryAsset(entry) {
  let manifest = {};
  let externalSession = null;
  let plan = null;
  try {
    manifest = readContainerJson(entry.asset_path, 'kdna.json') || {};
  } catch (error) {
    return {
      manifest,
      core: {},
      loadable: false,
      plan: { state: 'invalid', issues: [{ code: 'KDNA_FORMAT_INVALID', message: error.message }] },
    };
  }

  try {
    externalSession = loadExternalAuthorization(entry.asset_path, manifest);
    plan = planLoad(entry.asset_path, { entitlement: externalSession?.entitlement });
    if (plan.can_load_now !== true) {
      return { manifest, core: {}, loadable: false, plan };
    }
    const capsule = loadAuthorized(entry.asset_path, {
      profile: 'compact',
      as: 'json',
      entitlement: externalSession?.entitlement,
      decryptEntry: externalSession?.decryptEntry,
    });
    return {
      manifest,
      core: { axioms: Array.isArray(capsule.context?.axioms) ? capsule.context.axioms : [] },
      loadable: true,
      plan,
    };
  } catch (error) {
    return {
      manifest,
      core: {},
      loadable: false,
      plan: {
        ...(plan || {}),
        state: 'invalid',
        issues: [{ code: error.code || 'KDNA_LOAD_FAILED', message: error.message }],
      },
    };
  } finally {
    externalSession?.dispose();
  }
}

// ─── kdna available ────────────────────────────────────────────────────

function cmdAvailable(args = []) {
  const wantJson = args.includes('--json');
  const installed = listInstalled();

  const out = [];
  for (const e of installed) {
    const { manifest = {}, core = {}, loadable, plan } = readDiscoveryAsset(e);
    if (manifest.yanked === true) continue;

    // Pull applies_when across all axioms (this is what the agent needs
    // for fit-check). Collapsing per-axiom into one set makes the agent's
    // matching decision much cheaper.
    const applies_when = [];
    const does_not_apply_when = [];
    const failure_risks = [];
    for (const a of core.axioms || []) {
      applies_when.push(...stringList(a.applies_when));
      does_not_apply_when.push(...stringList(a.does_not_apply_when));
      if (a.failure_risk) failure_risks.push(a.failure_risk);
    }

    out.push({
      name: manifest.name || e.full,
      version: manifest.version || null,
      judgment_version: manifest.judgment_version || null,
      status: manifest.status || 'experimental',
      description: manifest.description || '',
      core_insight: manifest.core_insight || '',
      keywords: manifest.keywords || [],
      applies_when,
      does_not_apply_when,
      failure_risks,
      loadable,
      load_state: plan.state || null,
      issues: (plan.issues || []).map((issue) => issue.code).filter(Boolean),
    });
  }

  if (wantJson) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  // Human format
  if (!out.length) {
    console.log('No KDNA domains installed.');
    console.log('Install with: kdna install <name>');
    return;
  }
  console.log(`${out.length} installed KDNA domain(s):`);
  for (const d of out) {
    console.log('');
    console.log(`  ${d.name}  v${d.version || '?'}  [${d.status}]`);
    if (d.description) console.log(`    ${d.description}`);
    if (d.applies_when.length) {
      console.log(`    applies when: ${d.applies_when.length} situations declared`);
    }
    if (d.does_not_apply_when.length) {
      console.log(`    does NOT apply when: ${d.does_not_apply_when.length} situations declared`);
    }
  }
}

// ─── kdna match ────────────────────────────────────────────────────────

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9_一-鿿]+/g)
    .filter(Boolean);
}

function overlapScore(taskTokens, declaredText) {
  if (!declaredText) return { hits: 0, coverage: 0 };
  const declaredTokens = tokenize(declaredText);
  if (!declaredTokens.length) return { hits: 0, coverage: 0 };
  const dSet = new Set(declaredTokens);
  let hits = 0;
  for (const t of taskTokens) if (dSet.has(t)) hits++;
  const coverage = taskTokens.length ? hits / taskTokens.length : 0;
  return { hits, coverage };
}

// Minimum signal strength to report a hint (avoid noise from single-word matches)
const MIN_HITS = 2;
const MIN_COVERAGE = 0.15;

function domainRelevanceScore(taskTokens, domain) {
  let score = 0;
  const sources = [
    (domain.description || '').toLowerCase(),
    (domain.core_insight || '').toLowerCase(),
    (domain.keywords || []).join(' ').toLowerCase(),
  ];
  for (const source of sources) {
    const tokens = tokenize(source);
    const srcSet = new Set(tokens);
    for (const t of taskTokens) {
      if (srcSet.has(t)) score += 2;
    }
  }
  return score;
}

function cmdMatch(taskText, args = []) {
  const wantJson = args.includes('--json');
  if (!taskText) {
    console.error('Usage: kdna match "<task description>" [--json]');
    process.exit(2);
  }
  const taskTokens = tokenize(taskText);
  const installed = listInstalled();

  const dropped = [];
  const hints = [];

  for (const e of installed) {
    const { manifest = {}, core = {}, loadable, plan } = readDiscoveryAsset(e);
    if (!loadable) {
      dropped.push({
        name: manifest.name || e.full,
        reason: `not loadable (${plan.state || 'invalid'})`,
        issues: (plan.issues || []).map((issue) => issue.code).filter(Boolean),
      });
      continue;
    }
    if (manifest.yanked === true) {
      dropped.push({ name: manifest.name || e.full, reason: 'yanked' });
      continue;
    }

    // does_not_apply_when disqualification (HARD signal)
    let disqualified = null;
    for (const a of core.axioms || []) {
      for (const d of stringList(a.does_not_apply_when)) {
        const score = overlapScore(taskTokens, d);
        if (score.hits >= 2) {
          disqualified = { axiom: a.id, text: d };
          break;
        }
      }
      if (disqualified) break;
    }
    if (disqualified) {
      dropped.push({
        name: manifest.name || e.full,
        reason: `does_not_apply_when matched on ${disqualified.axiom}`,
        evidence: disqualified.text.slice(0, 120),
      });
      continue;
    }

    // applies_when hint signals (WEAK — for context only, not a decision)
    const signals = [];
    for (const a of core.axioms || []) {
      for (const ap of stringList(a.applies_when)) {
        const score = overlapScore(taskTokens, ap);
        if (score.hits >= MIN_HITS || score.coverage >= MIN_COVERAGE) {
          signals.push({
            source: `${a.id}.applies_when`,
            hits: score.hits,
            coverage: score.coverage,
            text: ap.slice(0, 120),
          });
        }
      }
    }

    // Domain-level relevance: check description, core_insight, keywords
    const domainRelevance = domainRelevanceScore(taskTokens, manifest);

    if (signals.length || domainRelevance >= 2) {
      hints.push({
        name: manifest.name || e.full,
        description: manifest.description || '',
        status: manifest.status || 'experimental',
        domain_relevance: domainRelevance,
        top_signals: signals.sort((a, b) => b.hits - a.hits).slice(0, 3),
      });
    }
  }

  // Sort hints by combined relevance (applies_when hits + domain relevance)
  hints.sort((a, b) => {
    const aScore = a.top_signals.reduce((s, sig) => s + sig.hits, 0) + (a.domain_relevance || 0);
    const bScore = b.top_signals.reduce((s, sig) => s + sig.hits, 0) + (b.domain_relevance || 0);
    return bScore - aScore;
  });

  const result = {
    task: taskText.slice(0, 200),
    dropped,
    hints,
    no_strong_matches: hints.length === 0,
    note:
      'These are surface keyword signals only — many false positives are normal. ' +
      "The agent must read each candidate domain's description + applies_when " +
      'in full and decide using language understanding. dropped is a hard signal: ' +
      'do not load any domain in dropped.',
  };

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  // Human format — make it clear this is hint not decision
  console.log(`Task: ${taskText.slice(0, 100)}${taskText.length > 100 ? '…' : ''}`);
  console.log('');
  console.log(`This is a HINT report. The agent makes the final fit decision`);
  console.log(`by reading each candidate's full description and applies_when.`);
  console.log('');

  if (dropped.length) {
    console.log(`Dropped (does_not_apply_when matched — do NOT load these):`);
    for (const d of dropped) {
      console.log(`  ✗ ${d.name}: ${d.reason}`);
      if (d.evidence) console.log(`    "${d.evidence}"`);
    }
    console.log('');
  }

  if (!hints.length) {
    console.log('No strong keyword matches from installed domains.');
    console.log('This means one of:');
    console.log('  - No KDNA domain fits this task yet');
    console.log('  - The fit is by meaning, not by word overlap');
    console.log('  - The matching domain is not installed');
    console.log('');
    console.log('Run: kdna available  to see what is installed and decide.');
    console.log('See the registry: kdna search "<query>"  (searches all published domains)');
  } else {
    console.log(`Keyword hints (${hints.length} domains had some token overlap):`);
    for (const h of hints) {
      console.log(`  ${h.name}  [${h.status}]`);
      console.log(`    ${h.description}`);
      const relevanceIndicator =
        h.domain_relevance >= 2
          ? ` (domain relevance: ${'★'.repeat(Math.min(h.domain_relevance, 5))})`
          : '';
      if (relevanceIndicator) console.log(relevanceIndicator);
      for (const s of h.top_signals) {
        const pct = Math.round((s.coverage || 0) * 100);
        console.log(`    ↳ ${s.source} (${s.hits} hits, ${pct}% coverage): ${s.text}`);
      }
    }
    console.log('');
    console.log('To load a domain: kdna load <name|file.kdna>');
  }
}

// ─── kdna load ─────────────────────────────────────────────────────────

function cmdLoad(input, args = []) {
  const formatIdx = args.findIndex((a) => a.startsWith('--as'));
  let format = 'prompt';
  if (formatIdx >= 0) {
    const eq = args[formatIdx].indexOf('=');
    format = eq > 0 ? args[formatIdx].slice(eq + 1) : args[formatIdx + 1];
  }

  // --profile=<name> for load profiles (Phase 2)
  const profileIdx = args.findIndex((a) => a.startsWith('--profile'));
  let profile = null;
  let profileInput = null;
  if (profileIdx >= 0) {
    const eq = args[profileIdx].indexOf('=');
    const raw = eq > 0 ? args[profileIdx].slice(eq + 1) : args[profileIdx + 1];
    profile = raw || 'compact';
  }

  // --input for scenario profile
  const inputIdx = args.indexOf('--input');
  if (inputIdx >= 0) {
    profileInput = args[inputIdx + 1] || null;
  }

  // Resolve the asset first so we can fail early on a missing path
  // before asking the user for a password.
  const asset = resolveAsset(input);
  if (!asset) {
    console.error(`KDNA asset not found: ${input}. Use an installed name or a .kdna file.`);
    process.exit(2);
  }

  // Resolve the password for password-protected assets. Sources
  // (in priority order): --password <value> (legacy / insecure), the
  // KDNA_PASSWORD environment variable, and --password-stdin (read on
  // demand from fd 0). If none of these is set and the asset is
  // encrypted, loadAuthorized will throw a clear "no password"
  // error; we no longer silently pass `undefined` and let the user
  // discover the failure downstream.
  let password;
  const passwordIdx = args.indexOf('--password');
  if (passwordIdx >= 0 && args[passwordIdx + 1] && !args[passwordIdx + 1].startsWith('--')) {
    password = args[passwordIdx + 1];
  } else if (process.env.KDNA_PASSWORD) {
    password = process.env.KDNA_PASSWORD;
  } else if (args.includes('--password-stdin')) {
    if (process.stdin.isTTY) {
      console.error(
        '--password-stdin requires the password to be piped in on stdin.\n' +
          'Example:  echo "$KDNA_PASSWORD" | kdna load <asset> --password-stdin\n' +
          'If you are running interactively, omit --password-stdin and you will be prompted.',
      );
      process.exit(2);
    }
    try {
      password = require('fs').readFileSync(0, 'utf8').trim();
    } catch (e) {
      console.error(`Could not read password from stdin: ${e.message}`);
      process.exit(2);
    }
  }

  // B6: Route through Core's unified loadAuthorized instead of manual manifest/decrypt.
  let container;
  try {
    const core = require('@aikdna/kdna-core');
    const result = core.loadAuthorized(asset.asset_path, {
      profile: profile || 'compact',
      as: format === 'json' ? 'json' : 'json',
      password: password || undefined,
    });
    container = {
      core: result.domain?.core || result.core || {},
      patterns: result.domain?.patterns || result.patterns || {},
      manifest: result.manifest || {},
    };
  } catch (e) {
    if (e.plan) {
      console.error(`KDNA load denied: ${e.plan.state || 'invalid'} — ${e.message}`);
    } else {
      console.error(`Failed to load KDNA asset: ${e.message}`);
    }
    process.exit(3);
  }

  const manifest = container.manifest || {};
  const parsed = asset.parsed || parseName(manifest.name || '');
  const label = assetLabel(asset, input);
  if (manifest.yanked === true) {
    console.error(`${label}@${manifest.version} has been yanked.`);
    if (manifest.replaced_by) console.error(`Try: ${manifest.replaced_by}`);
    process.exit(2);
  }

  // ═══ Trust check before loading ═══
  const loadWarnings = [];
  const signature = manifest.signature;
  const isPlaceholder = !signature || signature === '' || signature.includes('placeholder');
  if (isPlaceholder) {
    loadWarnings.push(
      '⚠  Domain is unsigned — no cryptographic proof of authorship. Trust depends on source.',
    );
  }
  if (manifest.status === 'deprecated') {
    loadWarnings.push(
      `⚠  Domain is deprecated${manifest.replaced_by ? ', replaced by ' + manifest.replaced_by : ''}.`,
    );
  }
  const riskLevel = manifest.risk_level || 'R1';
  if (riskLevel === 'R3' || riskLevel === 'R4') {
    loadWarnings.push(
      `⚠  High risk domain (${riskLevel}) — may influence agent behavior in safety-critical ways.`,
    );
    if (manifest.quality_badge === 'untested' || !manifest.quality_badge) {
      loadWarnings.push(
        '⚠  High risk + untested — load only if you trust the source and understand the risks.',
      );
    }
  }
  if (loadWarnings.length > 0) {
    console.error(loadWarnings.join('\n'));
  }
  const core = container.core || {};
  const pat = container.patterns || {};

  // JSON format — removed from agent runtime
  if (format === 'json' || format === 'raw') {
    console.error(`ERR_RAW_LOAD_REMOVED: --as=${format} is not supported in agent runtime.`);
    console.error('Use: kdna dev decode <asset.kdna> --reveal');
    console.error('Agent consumption: kdna load @scope/name [--as=prompt]');
    process.exit(2);
  }

  // Load profiles
  if (profile) {
    emitProfile(parsed || { full: label }, manifest, core, pat, profile, profileInput);
    recordTrace({
      timestamp: new Date().toISOString(),
      agent: detectAgent(),
      domain: label,
      format: `profile:${profile}`,
      // License activation is now resolved inside Core (B6/B4); the CLI
      // trace call no longer has direct access. Pass null — license_id will
      // simply be omitted from the trace fields.
      asset: traceAssetFields(asset, manifest, null),
    });
    return;
  }

  // Default: --as=prompt — compact text optimized for system-prompt injection.
  emitCompact(parsed || { full: label }, manifest, core, pat);
  recordTrace({
    timestamp: new Date().toISOString(),
    agent: detectAgent(),
    domain: label,
    format: 'prompt',
    asset: traceAssetFields(asset, manifest, null),
  });
}

// ─── Load profiles ─────────────────────────────────────────────────────

function emitProfile(parsed, manifest, core, pat, profile, input) {
  const lines = [];
  lines.push(`# KDNA loaded: ${manifest.name || parsed.full}`);
  if (manifest.judgment_version) lines.push(`# judgment_version: ${manifest.judgment_version}`);
  lines.push('');

  const axioms = core.axioms || [];
  emitRequiredOutput(lines, manifest, core, pat);

  switch (profile) {
    case 'index':
      // Minimal: name + axioms list + applies_when only
      if (manifest.core_insight) lines.push(`# insight: ${manifest.core_insight}`);
      lines.push('');
      if (axioms.length) {
        lines.push('## Axiom index');
        for (const a of axioms) {
          lines.push(`- ${a.one_sentence}`);
          if (a.applies_when?.length) lines.push(`  APPLIES: ${a.applies_when.join('; ')}`);
          if (a.does_not_apply_when?.length)
            lines.push(`  NOT: ${a.does_not_apply_when.join('; ')}`);
        }
        lines.push('');
      }
      break;

    case 'scenario':
      // Scenario-aware: include axioms whose applies_when matches the input
      lines.push(`# Scenario input: ${(input || '').slice(0, 200)}`);
      lines.push('');
      if (axioms.length) {
        const taskTokens = tokenize(input || '');
        const relevant = axioms.filter((a) => {
          if (!a.applies_when?.length) return false;
          const combinedText = [
            ...a.applies_when,
            a.one_sentence || '',
            a.full_statement || '',
          ].join(' ');
          const score = overlapScore(taskTokens, combinedText);
          return score.hits >= 1 || score.coverage >= 0.1;
        });
        const selected = relevant.length > 0 ? relevant : axioms;
        lines.push(`## Axioms (${selected.length}/${axioms.length} relevant)`);
        for (const a of selected) {
          lines.push(`- ${a.one_sentence}`);
          if (a.applies_when?.length) {
            lines.push(`  APPLIES WHEN: ${a.applies_when.join('; ')}`);
          }
          if (a.failure_risk) lines.push(`  RISK IF MISAPPLIED: ${a.failure_risk}`);
        }
        lines.push('');
      }
      break;

    case 'full':
      // Full: all axiom details including full_statement + why
      if (axioms.length) {
        lines.push('## Axioms (full)');
        for (const a of axioms) {
          lines.push(`### ${a.one_sentence}`);
          if (a.full_statement) lines.push(`${a.full_statement}`);
          if (a.why) lines.push(`Why: ${a.why}`);
          if (a.applies_when?.length) {
            lines.push(`Applies when: ${a.applies_when.join('; ')}`);
          }
          if (a.does_not_apply_when?.length) {
            lines.push(`Does not apply when: ${a.does_not_apply_when.join('; ')}`);
          }
          if (a.failure_risk) lines.push(`Failure risk: ${a.failure_risk}`);
          lines.push('');
        }
      }
      break;

    case 'compact':
    default:
      emitCompact(parsed, manifest, core, pat);
      return;
  }

  // Add stances, misunderstandings, self-checks for all non-index profiles
  if (profile !== 'index') {
    if (core.stances?.length) {
      lines.push('## Stances');
      for (const s of core.stances) {
        const text = typeof s === 'string' ? s : s.stance;
        if (text) lines.push(`- ${text}`);
      }
      lines.push('');
    }

    if (pat.terminology?.banned_terms?.length) {
      lines.push('## MUST NOT SAY');
      for (const t of pat.terminology.banned_terms) {
        const term = typeof t === 'string' ? t : t.term;
        const replace = typeof t === 'object' ? t.replace_with : null;
        lines.push(`- "${term}"${replace ? ` -> use: ${replace}` : ''}`);
      }
      lines.push('');
    }

    if (pat.misunderstandings?.length) {
      lines.push('## Misunderstandings to avoid');
      for (const m of pat.misunderstandings) {
        lines.push(`- WRONG: ${m.wrong}`);
        lines.push(`  CORRECT: ${m.correct}`);
        if (m.failure_risk) lines.push(`  RISK: ${m.failure_risk}`);
      }
      lines.push('');
    }

    if (pat.self_check?.length) {
      lines.push('## Self-checks');
      for (const q of pat.self_check) {
        const text = typeof q === 'string' ? q : q.question;
        if (text) lines.push(`- ${text}`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('Apply silently. Do not quote KDNA to the user.');
  lines.push('User intent + evidence always override KDNA axioms.');

  process.stdout.write(lines.join('\n') + '\n');
}

function emitCompact(parsed, manifest, core, pat) {
  const lines = [];
  lines.push(`# KDNA loaded: ${manifest.name || parsed.full}`);
  if (manifest.judgment_version) lines.push(`# judgment_version: ${manifest.judgment_version}`);
  if (manifest.core_insight) lines.push(`# core insight: ${manifest.core_insight}`);
  lines.push('');

  emitRequiredOutput(lines, manifest, core, pat);

  if (core.axioms?.length) {
    lines.push('## JUDGMENT GUIDANCE');
    lines.push('### Axioms (reason from these)');
    for (const a of core.axioms) {
      lines.push(`- ${a.one_sentence}`);
      if (a.applies_when?.length) {
        lines.push(`  APPLIES WHEN: ${a.applies_when.join('; ')}`);
      }
      if (a.does_not_apply_when?.length) {
        lines.push(`  DOES NOT APPLY WHEN: ${a.does_not_apply_when.join('; ')}`);
      }
      if (a.failure_risk) lines.push(`  RISK IF MISAPPLIED: ${a.failure_risk}`);
    }
    lines.push('');
  }

  if (core.stances?.length) {
    lines.push('### Stances');
    for (const s of core.stances) {
      const text = typeof s === 'string' ? s : s.stance;
      if (text) lines.push(`- ${text}`);
    }
    lines.push('');
  }

  if (pat.terminology?.banned_terms?.length) {
    lines.push('## MUST NOT SAY');
    for (const t of pat.terminology.banned_terms) {
      const term = typeof t === 'string' ? t : t.term;
      const replace = typeof t === 'object' ? t.replace_with : null;
      lines.push(`- "${term}"${replace ? ` -> use: ${replace}` : ''}`);
    }
    lines.push('');
  }

  if (pat.misunderstandings?.length) {
    if (!core.axioms?.length) lines.push('## JUDGMENT GUIDANCE');
    lines.push('### Misunderstandings to detect and avoid');
    for (const m of pat.misunderstandings) {
      lines.push(`- WRONG: ${m.wrong}`);
      lines.push(`  CORRECT: ${m.correct}`);
      if (m.failure_risk) lines.push(`  RISK: ${m.failure_risk}`);
    }
    lines.push('');
  }

  if (pat.self_check?.length) {
    lines.push('## SELF-CHECK');
    lines.push('Answer before final output.');
    for (const q of pat.self_check) {
      const text = typeof q === 'string' ? q : q.question;
      if (text) lines.push(`- ${text}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('Apply silently. Do not quote KDNA to the user. Do not say "according to KDNA".');
  lines.push('User intent + evidence always override KDNA axioms.');

  process.stdout.write(lines.join('\n') + '\n');
}

function emitRequiredOutput(lines, manifest, core, pat) {
  const required = uniqueStrings([
    ...asStringArray(manifest.required_output),
    ...asStringArray(manifest.must_include),
    ...asStringArray(core.required_output),
    ...asStringArray(core.must_include),
    ...asStringArray(pat.required_output),
    ...asStringArray(pat.must_include),
    ...asStringArray(pat.output_constraints?.required_output),
    ...asStringArray(pat.output_constraints?.must_include),
  ]);

  if (!required.length) return;

  lines.push('## REQUIRED OUTPUT');
  lines.push('Include these statements when they are relevant to the user request.');
  for (const item of required) lines.push(`- ${item}`);
  lines.push('');
}

function asStringArray(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim());
}

function uniqueStrings(items) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

// ─── kdna select ───────────────────────────────────────────────────────

function cmdSelect(args = []) {
  const wantJson = args.includes('--json');
  const inputIdx = args.indexOf('--input');
  const input = inputIdx >= 0 ? args[inputIdx + 1] : '';
  const maxIdx = args.indexOf('--max-domains');
  const maxDomains = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) || 3 : 3;

  if (!input) {
    if (wantJson) {
      console.log(
        JSON.stringify({ error: 'Usage: kdna select --input "<task>" [--max-domains=N] [--json]' }),
      );
      process.exit(2);
    }
    console.error('Usage: kdna select --input "<task>" [--max-domains=N] [--json]');
    process.exit(2);
  }

  const taskTokens = tokenize(input);
  const installed = listInstalled();
  const scores = [];

  for (const e of installed) {
    const { manifest = {}, core = {} } = readContainer(e.asset_path);
    if (manifest.yanked === true) continue;

    // Check does_not_apply_when hard exclusion
    let excluded = false;
    for (const a of core.axioms || []) {
      for (const d of a.does_not_apply_when || []) {
        if (overlapScore(taskTokens, d).hits >= 2) {
          excluded = true;
          break;
        }
      }
      if (excluded) break;
    }
    if (excluded) continue;

    // Score: applies_when matches + domain relevance
    let score = 0;
    const reasons = [];

    for (const a of core.axioms || []) {
      for (const ap of a.applies_when || []) {
        const s = overlapScore(taskTokens, ap);
        if (s.hits >= 2) {
          score += s.hits * 3;
          reasons.push({ source: `${a.id}.applies_when`, hits: s.hits, text: ap.slice(0, 120) });
        }
      }
    }

    score += domainRelevanceScore(taskTokens, manifest);

    if (score > 0) {
      scores.push({
        domain: manifest.name || e.full,
        version: manifest.version || null,
        status: manifest.status || 'experimental',
        score,
        reasons: reasons.slice(0, 5),
      });
    }
  }

  // Sort descending, take top N
  scores.sort((a, b) => b.score - a.score);
  const selected = scores.slice(0, maxDomains);

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          input: input.slice(0, 200),
          selected,
          max_domains: maxDomains,
          total_candidates: scores.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!selected.length) {
    console.log(`No domains selected for input: "${input.slice(0, 100)}"`);
    console.log('Run: kdna match "<task>"  for candidate hints');
    console.log('Run: kdna list --available  to see all registered domains');
    return;
  }

  console.log(`Selected ${selected.length} domain(s) for: "${input.slice(0, 100)}"`);
  console.log('');
  for (const s of selected) {
    console.log(`  ${s.domain.padEnd(36)}  score:${s.score}  v${s.version || '?'}  [${s.status}]`);
    for (const r of s.reasons) {
      console.log(`    ↳ ${r.source} (${r.hits} hits): ${r.text}`);
    }
  }
}

// ─── kdna postvalidate ─────────────────────────────────────────────────

function cmdPostvalidate(args = []) {
  const wantJson = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const input = positional[1];
  const outputIdx = args.indexOf('--output');
  const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : null;

  if (!input) {
    console.error('Usage: kdna postvalidate <domain> --output <response-file> [--json]');
    process.exit(2);
  }

  const parsed = parseName(input);
  if (!parsed) {
    console.error(`Invalid name "${input}".`);
    process.exit(2);
  }
  const installed = getInstalled(parsed.full);
  if (!installed) {
    console.error(`${parsed.full} is not installed.`);
    process.exit(2);
  }

  const container = readContainer(installed.asset_path);
  const core = container.core || {};
  const pat = container.patterns || {};

  // Read agent output
  let agentOutput = '';
  if (outputFile) {
    try {
      agentOutput = fs.readFileSync(outputFile, 'utf8');
    } catch {
      console.error(`Cannot read output file: ${outputFile}`);
      process.exit(2);
    }
  } else {
    // Read from stdin. Bug (#64): prior version read fd 0 without a
    // TTY check, so an interactive caller who forgot to pipe the
    // output (or who hit this path by accident) would see the command
    // hang forever. Refuse up front on a TTY with a clear error.
    if (process.stdin.isTTY) {
      console.error(
        'Reading agent output from stdin requires the data to be piped in.\n' +
          'Example:  kdna agent evaluate <domain> --input <task> < agent-output.txt\n' +
          'Or pass --output <file> to read from a file.',
      );
      process.exit(2);
    }
    try {
      agentOutput = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
    } catch {
      // ignore
    }
  }

  const results = {
    violations: [],
    warnings: [],
    passed: [],
  };

  // Check banned terms
  const bannedTerms = (pat.terminology?.banned_terms || []).map((t) =>
    typeof t === 'string' ? t : t.term,
  );
  for (const term of bannedTerms) {
    const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (regex.test(agentOutput)) {
      results.violations.push(`banned term used: "${term}"`);
    } else {
      results.passed.push(`banned term avoided: "${term}"`);
    }
  }

  // Check misunderstandings (wrong patterns)
  const misunderstandings = pat.misunderstandings || [];
  for (const ms of misunderstandings) {
    const wrongTokens = tokenize(ms.wrong || '');
    const agentTokens = tokenize(agentOutput);
    const overlap = wrongTokens.filter((t) => agentTokens.includes(t));
    if (overlap.length >= 3) {
      results.warnings.push(`possible misunderstanding: "${ms.wrong?.slice(0, 80)}"`);
    } else {
      results.passed.push(`misunderstanding avoided: "${(ms.wrong || '').slice(0, 60)}"`);
    }
  }

  // Check self-checks absence (can't verify answers, but flag missing checks)
  const selfChecks = pat.self_check || [];
  if (selfChecks.length > 0) {
    let foundChecks = 0;
    for (const sc of selfChecks) {
      const text = typeof sc === 'string' ? sc : sc.question;
      if (text) {
        const keywords = tokenize(text)
          .filter((t) => t.length > 3)
          .slice(0, 3);
        const found = keywords.some((k) => agentOutput.toLowerCase().includes(k));
        if (found) foundChecks++;
      }
    }
    if (foundChecks === 0) {
      results.warnings.push('no self-check traces found in output');
    } else {
      results.passed.push(`self-check traces: ${foundChecks}/${selfChecks.length}`);
    }
  }

  // Check boundary violations
  const boundaries = core.axioms || [];
  let boundaryViolations = 0;
  for (const ax of boundaries) {
    for (const notApply of ax.does_not_apply_when || []) {
      if (overlapScore(tokenize(agentOutput), notApply).hits >= 2) {
        boundaryViolations++;
        results.violations.push(
          `boundary violation: ${ax.id} (should not apply when "${notApply.slice(0, 80)}")`,
        );
        break;
      }
    }
  }
  if (boundaryViolations === 0) {
    results.passed.push('no boundary violations detected');
  }

  // Risk flags
  for (const ax of core.axioms || []) {
    if (ax.failure_risk) {
      const riskTokens = tokenize(ax.failure_risk);
      const match = riskTokens.filter((t) => tokenize(agentOutput).includes(t)).length;
      if (match >= riskTokens.length * 0.5) {
        results.warnings.push(`failure risk matched: ${ax.id} — "${ax.failure_risk.slice(0, 80)}"`);
      }
    }
  }

  if (wantJson) {
    const result = {
      domain: parsed.full,
      violations: results.violations.length,
      warnings: results.warnings.length,
      passed: results.passed.length,
      details: results,
    };
    console.log(JSON.stringify(result, null, 2));
    recordTrace({
      timestamp: new Date().toISOString(),
      agent: detectAgent(),
      domain: parsed.full,
      type: 'postvalidate',
      postvalidate: {
        result: results.violations.length ? 'fail' : 'pass',
        violations: results.violations.length,
        passed: results.passed.length,
      },
    });
    process.exit(results.violations.length ? 1 : 0);
  }

  console.log(`Post-validation: ${parsed.full}`);
  console.log('');
  console.log(
    `  Violations: ${results.violations.length}  Warnings: ${results.warnings.length}  Passed: ${results.passed.length}`,
  );
  console.log('');

  if (results.violations.length) {
    console.log('Violations:');
    results.violations.forEach((v) => console.log(`  ✗ ${v}`));
    console.log('');
  }
  if (results.warnings.length) {
    console.log('Warnings:');
    results.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
    console.log('');
  }
  if (results.passed.length) {
    console.log('Passed:');
    results.passed.forEach((p) => console.log(`  ✓ ${p}`));
  }

  recordTrace({
    timestamp: new Date().toISOString(),
    agent: detectAgent(),
    domain: parsed.full,
    type: 'postvalidate',
    postvalidate: {
      result: results.violations.length ? 'fail' : 'pass',
      violations: results.violations.length,
      passed: results.passed.length,
    },
  });
  process.exit(results.violations.length ? 1 : 0);
}

// ─── kdna route ─────────────────────────────────────────────────────────

function cmdRoute(taskText, args = []) {
  const wantJson = args.includes('--json');

  if (!taskText) {
    const err = { error: 'Usage: kdna route "<task description>" [--json] [--discover]' };
    if (wantJson) {
      console.log(JSON.stringify(err));
      process.exit(2);
    }
    console.error(err.error);
    process.exit(2);
  }

  const traceId = `route_${require('crypto').randomUUID()}`;
  const taskTokens = tokenize(taskText);
  const installed = listInstalled();
  const result = {
    status: 'SKIP_NO_JUDGMENT_NEEDED',
    action: 'skip',
    needs_kdna: false,
    selected_domain: null,
    reason: '',
    confidence: 0,
    candidates: [],
    rejected_domains: [],
    trust: null,
    ambiguity: null,
    registry_suggestions: [],
    auto_install: false,
    trace_id: traceId,
    created_at: new Date().toISOString(),
  };

  // ═══ Gate 1: Intent — does this task need domain judgment? ═══
  const judgmentKeywords = [
    'review',
    'diagnose',
    'critique',
    'evaluate',
    'assess',
    'judge',
    'should i',
    'is this good',
    'is this correct',
    'how would you rate',
    '分析',
    '诊断',
    '评估',
    '判断',
    '审查',
    '该怎么',
    '好不好',
  ];
  const mechanicalKeywords = [
    'format',
    'translate',
    'convert',
    'list',
    'find',
    'lookup',
    'search',
    'run',
    'execute',
    'compile',
    'build',
    'fix syntax',
    'fix the bug',
    '格式化',
    '翻译',
    '转换',
    '列出',
    '查找',
    '搜索',
    '运行',
    '执行',
    '编译',
    '修复语法',
  ];

  const taskLower = taskText.toLowerCase();
  const hasJudgmentSignal = judgmentKeywords.some((k) => taskLower.includes(k));
  const hasMechanicalSignal = mechanicalKeywords.some((k) => taskLower.includes(k));

  result.needs_kdna = hasJudgmentSignal && !hasMechanicalSignal;

  if (!result.needs_kdna) {
    result.status = 'SKIP_NO_JUDGMENT_NEEDED';
    result.action = 'skip';
    result.reason = hasMechanicalSignal
      ? 'task is mechanical — no domain judgment required'
      : 'task does not appear to need domain judgment';
    if (wantJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('SKIP (no judgment needed)');
    return;
  }

  if (!installed.length) {
    result.status = 'SKIP_NO_LOCAL_DOMAIN';
    result.action = 'skip';
    result.reason = 'task may benefit from judgment, but no KDNA domains are installed';
    if (wantJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('SKIP (no domains installed)');
    return;
  }

  // ═══ Gate 2: Negative Match First — check does_not_apply_when ═══
  // ═══ Gate 3: Domain Fit — evaluate applies_when + relevance ═══
  const candidates = [];

  for (const e of installed) {
    const { manifest = {}, core = {} } = readContainer(e.asset_path);
    if (manifest.yanked === true) {
      result.rejected_domains.push({
        domain: manifest.name || e.full,
        triggered_rule: 'yanked',
        reason: 'domain has been yanked',
      });
      continue;
    }

    // Negative match: does_not_apply_when
    let disqualified = null;
    for (const a of core.axioms || []) {
      for (const d of a.does_not_apply_when || []) {
        const score = overlapScore(taskTokens, d);
        if (score.hits >= 2) {
          disqualified = { axiom: a.id, text: d, hits: score.hits };
          break;
        }
      }
      if (disqualified) break;
    }

    if (disqualified) {
      result.rejected_domains.push({
        domain: manifest.name || e.full,
        triggered_rule: `${disqualified.axiom}.does_not_apply_when`,
        reason: `"${disqualified.text.slice(0, 100)}"`,
      });
      continue;
    }

    // Positive fit: applies_when + domain relevance
    let fitScore = 0;
    const fitReasons = [];

    for (const a of core.axioms || []) {
      for (const ap of a.applies_when || []) {
        const score = overlapScore(taskTokens, ap);
        if (score.hits >= 2) {
          fitScore += score.hits * 3;
          fitReasons.push({ source: a.id, hits: score.hits, text: ap.slice(0, 120) });
        }
      }
    }
    fitScore += domainRelevanceScore(taskTokens, manifest);

    // Confidence based on fitScore normalized
    const confidence = Math.min(0.95, fitScore > 0 ? 0.5 + fitScore * 0.05 : 0.15);

    candidates.push({
      domain: manifest.name || e.full,
      version: manifest.version || '?',
      status: manifest.status || 'experimental',
      score: fitScore,
      confidence,
      reasons: fitReasons.slice(0, 5),
      description: manifest.description || '',
    });
  }

  // Sort by score
  candidates.sort((a, b) => b.score - a.score);

  // ═══ Gate 4: Decision ═══
  const strongCandidates = candidates.filter((c) => c.score >= 6);
  const weakCandidates = candidates.filter((c) => c.score > 0 && c.score < 6);

  if (strongCandidates.length === 0 && weakCandidates.length === 0) {
    // No matches at all
    result.status = 'SKIP_NO_LOCAL_DOMAIN';
    result.action = 'skip';
    result.reason = 'no installed domain matches this task';
    if (result.rejected_domains.length > 0) {
      result.reason += ` (${result.rejected_domains.length} domains explicitly excluded by does_not_apply_when)`;
    }
    result.candidates = candidates.map((c) => ({
      domain: c.domain,
      decision: 'rejected',
      reason: 'insufficient match score',
      confidence: c.confidence,
    }));
  } else if (strongCandidates.length > 1) {
    // Multiple strong matches — ambiguity
    result.status = 'ASK_AMBIGUOUS_DOMAIN';
    result.action = 'ask';
    result.reason = `${strongCandidates.length} domains strongly match this task with different judgment frames`;

    result.ambiguity = {
      domains: strongCandidates.slice(0, 3).map((c) => ({
        domain: c.domain,
        description: c.description,
        judgment_frame: c.reasons.length > 0 ? c.reasons[0].text : c.description,
        risk_if_wrong: `may misclassify the task as a ${c.domain.split('/').pop()} problem`,
      })),
      recommendation:
        'Choose the domain whose judgment frame best matches the task intent. Do not blend domains.',
    };

    result.candidates = strongCandidates.map((c) => ({
      domain: c.domain,
      decision: 'ambiguous',
      reason: `score ${c.score}`,
      confidence: c.confidence,
    }));
  } else if (strongCandidates.length === 1) {
    // One strong match + possible weak matches
    const selected = strongCandidates[0];
    result.candidates = [
      {
        domain: selected.domain,
        decision: 'strong_match',
        reason: `score ${selected.score}`,
        confidence: selected.confidence,
      },
      ...weakCandidates.map((c) => ({
        domain: c.domain,
        decision: 'weak_match',
        reason: `score ${c.score}`,
        confidence: c.confidence,
      })),
    ];

    // ═══ Trust Gate ═══
    const trust = checkTrust(selected.domain);
    result.trust = trust;

    if (!trust.passed) {
      result.status = 'BLOCK_TRUST_FAILED';
      result.action = 'block';
      result.reason = `domain matched but trust check failed: ${trust.failures.join(', ')}`;
    } else {
      result.status = 'LOAD_STRONG_FIT';
      result.action = 'load';
      result.selected_domain = selected.domain;
      result.confidence = selected.confidence;
      result.reason = `match: "${selected.description.slice(0, 100)}"`;
    }
  } else {
    // Only weak matches — skip
    result.status = 'SKIP_WEAK_FIT';
    result.action = 'skip';
    result.reason =
      weakCandidates.length > 0
        ? `${weakCandidates.length} domain(s) have weak match only — skipping to avoid contamination`
        : 'no installed domain matches this task';
    result.candidates = weakCandidates.map((c) => ({
      domain: c.domain,
      decision: 'weak_match',
      reason: `score ${c.score}`,
      confidence: c.confidence,
    }));
  }

  // Add rejected domains to candidates array for full trace
  for (const r of result.rejected_domains) {
    result.candidates.push({
      domain: r.domain,
      decision: 'rejected',
      reason: r.reason,
      confidence: 0,
      matched_does_not_apply_when: r.triggered_rule,
    });
  }

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human output
  console.log(`Task: ${taskText.slice(0, 100)}${taskText.length > 100 ? '…' : ''}`);
  console.log(`Route: ${result.status} → ${result.action}`);
  if (result.reason) console.log(`Reason: ${result.reason}`);
  if (result.selected_domain) console.log(`Domain: ${result.selected_domain}`);
  if (result.rejected_domains.length) {
    console.log(`Rejected: ${result.rejected_domains.map((r) => r.domain).join(', ')}`);
  }
}

function checkTrust(domainName) {
  const failures = [];
  const warnings = [];
  const entry = getInstalled(domainName);
  if (!entry) {
    failures.push('domain asset not found in package index');
    return { passed: false, failures, warnings };
  }

  const { manifest = {}, core = {}, evolution = {} } = readContainer(entry.asset_path);

  let planAccess = manifest.access;
  try {
    const plan = planLoad(entry.asset_path);
    planAccess = plan.access || manifest.access || 'public';
  } catch {
    planAccess = manifest.access || 'public';
  }

  // 1. Yank check
  if (manifest.yanked === true) {
    failures.push('domain is yanked');
  }

  // 2. Deprecation check
  if (manifest.status === 'deprecated') {
    warnings.push(
      `domain is deprecated${manifest.replaced_by ? ', replaced by ' + manifest.replaced_by : ''}`,
    );
  }

  // 3. Signature check
  const signature = manifest.signature;
  const isPlaceholder = !signature || signature === '' || signature.includes('placeholder');
  if (planAccess === 'licensed' || planAccess === 'runtime') {
    if (isPlaceholder) {
      failures.push('commercial domain has no valid signature');
    }
  } else if (isPlaceholder) {
    warnings.push('domain is unsigned — trust depends on source');
  }

  // 4. Risk level check
  const riskLevel = manifest.risk_level || entry.risk_level || 'R1';
  const riskMap = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };
  const riskNum = riskMap[riskLevel] || 1;
  if (riskNum >= 3) {
    warnings.push(
      `domain risk level is ${riskLevel} — high-risk judgment may influence agent behavior`,
    );
  }
  if (riskNum >= 2 && (manifest.quality_badge === 'untested' || !manifest.quality_badge)) {
    warnings.push(
      `risk level ${riskLevel} with quality_badge '${manifest.quality_badge || 'none'}' — consider requiring review`,
    );
  }

  // 5. KDNA container version check
  const kdnaVersion = manifest.kdna_version || 'unknown';
  const supportedVersions = ['1.0'];
  if (!supportedVersions.includes(kdnaVersion)) {
    warnings.push(
      `KDNA container version '${kdnaVersion}' may not be fully compatible with current loader`,
    );
  }

  // 6. License validity (commercial domains)
  if (planAccess === 'licensed' || planAccess === 'runtime') {
    const licenseCheck = licenseDecryptOptionsForManifest({ ...manifest, name: domainName });
    if (!licenseCheck.ok) {
      warnings.push(
        'commercial domain has no active entitlement — run: kdna license activate ' +
          domainName +
          ' --server <url>',
      );
    }
  }

  // 7. Human Lock check (judgment-class cards)
  const axioms = core.axioms || [];
  const hasJudgmentCards = axioms.length > 0;
  if (hasJudgmentCards) {
    const humanLocks = evolution.human_locks || [];
    const lockedAxioms = axioms.filter((a) => {
      // Check if axiom has a human_lock field OR if an evolution lock covers it
      return a.human_lock || humanLocks.some((hl) => hl.lock_type === 'accept');
    }).length;
    if (lockedAxioms === 0 && humanLocks.length === 0) {
      warnings.push(
        'domain has no Human Lock records — judgment-class content may not be human-verified',
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    riskLevel,
    kdnaVersion,
    signatureValid: !isPlaceholder,
  };
}

module.exports = {
  cmdAvailable,
  cmdMatch,
  cmdLoad,
  cmdSelect,
  cmdPostvalidate,
  cmdRoute,
  checkTrust,
};
