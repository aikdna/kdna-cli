/**
 * kdna publish --check <path> — Quality gate for domain publication.
 *
 * Checks beyond structural validity: anti-vagueness, content completeness,
 * and registry readiness.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, selfCheckText, isYesNoSelfCheck } = require('./cmds/_common');

function error(msg, code = EXIT.VALIDATION_FAILED) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ─── Anti-vagueness checks ────────────────────────────────────────────

const VAGUE_PHRASES = [
  'is important',
  'is key',
  'matters',
  'is crucial',
  'is essential',
  'is critical',
  'be helpful',
  'be user-centered',
  'be customer-focused',
  'communicate effectively',
  'think strategically',
  'is vital',
  'plays a role',
  'is fundamental',
];

const SLOGAN_PATTERNS = [
  /^[A-Z][a-z]+ is [a-z]+\.?$/, // "Trust is important."
  /^Be [a-z]+\.?$/, // "Be helpful."
  /^[A-Z][a-z]+ matters\.?$/, // "Quality matters."
];

// ─── Anti-SOP checks ──────────────────────────────────────────────────
// Detects when KDNA content degrades into procedural instructions
// rather than judgment principles. Axioms should express what to
// PRIORITIZE or AVOID, not steps to follow.

const SOP_PATTERNS = [
  /^Step\s+\d/i, // "Step 1: identify the topic"
  /^First,?\s|^Next,?\s|^Then,?\s|^Finally,?\s/i, // "First, do X. Then do Y."
  /^Check\s(for|if|whether)\s/i, // "Check for spelling errors"
  /^Always\s+(use|do|make|include)/i, // "Always use active voice"
  /^Never\s+(use|do|make)/i, // "Never use passive voice"
  /^Generate\s/i, // "Generate three options"
  /^Create\s+(a|the)\s/i, // "Create a list of..."
  /^Make\s+sure\s/i, // "Make sure to check..."
  /^Remember\s+to\s/i, // "Remember to validate..."
  /^(You|The agent)\s+should\s+(use|do|make|include)/i, // "You should use X"
  /^Avoid\s+(using|doing)/i, // "Avoid using X" (too procedural)
];

function isSOP(text) {
  if (!text || typeof text !== 'string') return false;
  for (const pattern of SOP_PATTERNS) {
    if (pattern.test(text.trim())) return { pattern: pattern.source, text };
  }
  return false;
}

function isVague(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  for (const phrase of VAGUE_PHRASES) {
    if (lower.includes(phrase)) return { phrase, text };
  }
  return false;
}

function isSlogan(text) {
  if (!text || typeof text !== 'string') return false;
  for (const pattern of SLOGAN_PATTERNS) {
    if (pattern.test(text.trim())) return true;
  }
  return false;
}

function isNegationOnly(boundary) {
  if (!boundary || typeof boundary !== 'string') return false;
  const trimmed = boundary.toLowerCase().trim();
  return /^not\s/.test(trimmed) && trimmed.split(/\s+/).length <= 3;
}

function isDictionaryDefinition(essence) {
  if (!essence || typeof essence !== 'string') return false;
  // Dictionary-style: starts with "the", follows with "is" or "of"
  return /^the\s+(quality|state|act|process|ability|condition|fact|practice|use)\s+(of|in|to|that)/i.test(
    essence,
  );
}

function isStrawMan(wrong) {
  if (!wrong || typeof wrong !== 'string') return false;
  const lower = wrong.toLowerCase();
  const strawPatterns = [
    /doesn['']t matter/,
    /isn['']t important/,
    /is useless/,
    /never works/,
    /is a waste/,
    /should never/,
  ];
  for (const p of strawPatterns) {
    if (p.test(lower)) return true;
  }
  return false;
}

function isGenericSelfCheck(question) {
  if (!question || typeof question !== 'string') return false;
  const lower = question.toLowerCase();
  const generic = [
    'is this helpful',
    'is this response good',
    'is this clear',
    'did i do a good job',
    'is this useful',
    'is this correct',
    'is this accurate',
    'did i follow best practices',
  ];
  for (const g of generic) {
    if (lower.includes(g)) return true;
  }
  return false;
}

// ─── Human Lock Gate ──────────────────────────────────────────────────

/**
 * Check whether the domain satisfies Human Lock requirements.
 * Returns { passed, issues[] } — publish should be blocked if !passed.
 */
function checkHumanLock(domainPath) {
  const core = readJson(path.join(domainPath, 'KDNA_Core.json'));
  if (!core) return { passed: false, issues: ['KDNA_Core.json not found'] };

  const issues = [];
  const cards = [];

  // Collect judgment-class cards from axioms, boundaries, risks
  if (core.axioms) {
    for (const a of core.axioms) {
      cards.push({ type: 'axiom', id: a.id || '?', status: a.status, human_lock: a.human_lock });
    }
  }
  if (core.boundaries) {
    for (const b of core.boundaries) {
      cards.push({ type: 'boundary', id: b.id || '?', status: b.status, human_lock: b.human_lock });
    }
  }
  if (core.risks || core.risk_model) {
    const risks = core.risks || core.risk_model || [];
    for (const r of risks) {
      cards.push({ type: 'risk', id: r.id || '?', status: r.status, human_lock: r.human_lock });
    }
  }

  if (cards.length === 0) return { passed: true, issues: [] };

  for (const card of cards) {
    // Rule 1: Legacy publish evidence requires Studio approval.
    if (!card.status || !['locked', 'tested', 'published'].includes(card.status)) {
      issues.push(`${card.type} "${card.id}" is not approved for legacy publish evidence.`);
      continue;
    }
    // Rule 2: Legacy publish evidence requires a human_lock record.
    if (!card.human_lock || !card.human_lock.by || !card.human_lock.statement) {
      issues.push(`${card.type} "${card.id}" is locked but has no valid Human Lock record.`);
      continue;
    }
    // Rule 3: Legacy Human Lock evidence must confirm judgment fields were reviewed.
    const checked = card.human_lock.checked || {};
    if (!checked.applies_when) {
      issues.push(
        `${card.type} "${card.id}" Human Lock does not confirm applies_when was reviewed.`,
      );
    }
    if (!checked.does_not_apply_when) {
      issues.push(
        `${card.type} "${card.id}" Human Lock does not confirm does_not_apply_when was reviewed.`,
      );
    }
    if (!checked.failure_risk) {
      issues.push(
        `${card.type} "${card.id}" Human Lock does not confirm failure_risk was reviewed.`,
      );
    }
  }

  return { passed: issues.length === 0, issues };
}

// ─── Main check function ──────────────────────────────────────────────

function cmdPublishCheck(domainPath, args = []) {
  const abs = path.resolve(domainPath);
  if (!fs.existsSync(abs)) error(`Domain not found: ${abs}`);

  console.log('═'.repeat(60));
  console.log(`  Publish Check: ${path.basename(abs)}`);
  console.log('═'.repeat(60));
  console.log('');

  // ─── Legacy Human Lock evidence gate ──────────────────────────────
  const hl = checkHumanLock(abs);
  if (!hl.passed) {
    console.warn('  ⚠  Legacy publish evidence gate: advisories (non-blocking)');
    console.warn(`     ${hl.issues.length} advisory issue(s):`);
    for (const issue of hl.issues) {
      console.warn(`       ${issue}`);
    }
    console.warn('');
    console.warn('  Human Lock records are optional quality evidence, not a publish');
    console.warn('  requirement. For current asset validation:');
    console.warn('    kdna validate <file.kdna>');
    console.warn('    kdna plan-load <file.kdna>');
    console.warn('');
  } else {
    console.log('  ✓ Legacy publish evidence gate: passed');
    console.log('');
  }

  let errors = 0;
  let warnings = 0;
  let passes = 0;

  function fail(file, field, item, reason) {
    console.error(`  ✗ ${file} > ${field}: ${reason}`);
    if (item) console.error(`    "${item.slice(0, 100)}${item.length > 100 ? '...' : ''}"`);
    errors++;
  }

  function warn(file, field, msg) {
    console.warn(`  ⚠ ${file} > ${field}: ${msg}`);
    warnings++;
  }

  function pass(file, field) {
    console.log(`  ✓ ${file} > ${field}`);
    passes++;
  }

  // Load Core
  const core = readJson(path.join(abs, 'KDNA_Core.json'));
  if (!core) error('KDNA_Core.json not found or invalid JSON');

  // Check axioms
  if (core.axioms && Array.isArray(core.axioms)) {
    for (const ax of core.axioms) {
      const label = ax.id || '?';

      if (!ax.one_sentence || ax.one_sentence.length < 20) {
        fail(
          'KDNA_Core.json',
          `axioms.${label}.one_sentence`,
          ax.one_sentence,
          'Too short (min 20 chars). Axioms must be specific claims, not labels.',
        );
      } else if (isSlogan(ax.one_sentence)) {
        fail(
          'KDNA_Core.json',
          `axioms.${label}.one_sentence`,
          ax.one_sentence,
          'Reads like a slogan. Axioms must be specific judgment principles.',
        );
      } else if (isSOP(ax.one_sentence)) {
        const s = isSOP(ax.one_sentence);
        fail(
          'KDNA_Core.json',
          `axioms.${label}.one_sentence`,
          ax.one_sentence,
          `Reads like a SOP ("${s.pattern}"). Axioms must be judgment principles, not step-by-step instructions.`,
        );
      } else if (isVague(ax.one_sentence)) {
        const v = isVague(ax.one_sentence);
        fail(
          'KDNA_Core.json',
          `axioms.${label}.one_sentence`,
          ax.one_sentence,
          `Vague phrase "${v.phrase}". Be specific about what the agent should judge.`,
        );
      } else {
        pass('KDNA_Core.json', `axioms.${label}.one_sentence`);
      }

      if (!ax.full_statement || ax.full_statement.length < 40) {
        fail(
          'KDNA_Core.json',
          `axioms.${label}.full_statement`,
          ax.full_statement,
          'Too short (min 40 chars). Full statement must be testable and domain-specific.',
        );
      } else if (isVague(ax.full_statement)) {
        warn(
          'KDNA_Core.json',
          `axioms.${label}.full_statement`,
          'Contains vague language. Consider making it more operational.',
        );
      } else {
        pass('KDNA_Core.json', `axioms.${label}.full_statement`);
      }

      if (!ax.why || ax.why.length < 20) {
        fail(
          'KDNA_Core.json',
          `axioms.${label}.why`,
          ax.why,
          'Too short. Must explain what the agent would get wrong without this axiom.',
        );
      } else {
        pass('KDNA_Core.json', `axioms.${label}.why`);
      }
    }
  }

  // Check ontology
  if (core.ontology && Array.isArray(core.ontology)) {
    for (const con of core.ontology) {
      const label = con.id || '?';

      if (!con.essence || isDictionaryDefinition(con.essence)) {
        fail(
          'KDNA_Core.json',
          `ontology.${label}.essence`,
          con.essence,
          'Reads like a dictionary definition. Essence must be operational — what the agent needs to check, not what a dictionary says.',
        );
      } else if (isVague(con.essence)) {
        warn('KDNA_Core.json', `ontology.${label}.essence`, 'Contains vague language.');
      } else {
        pass('KDNA_Core.json', `ontology.${label}.essence`);
      }

      if (!con.boundary || isNegationOnly(con.boundary)) {
        fail(
          'KDNA_Core.json',
          `ontology.${label}.boundary`,
          con.boundary,
          'Negation-only boundary. Must name a specific concept this is often confused with, not just "not X".',
        );
      } else {
        pass('KDNA_Core.json', `ontology.${label}.boundary`);
      }

      if (!con.trigger_signal || con.trigger_signal.length < 15) {
        warn(
          'KDNA_Core.json',
          `ontology.${label}.trigger_signal`,
          'Trigger signal too short. Should be observable words or patterns the agent can detect.',
        );
      } else {
        pass('KDNA_Core.json', `ontology.${label}.trigger_signal`);
      }
    }
  }

  // Check stances
  if (core.stances && Array.isArray(core.stances)) {
    if (core.stances.length < 2) {
      warn('KDNA_Core.json', 'stances', `Only ${core.stances.length} stance(s). Recommended: 2-5.`);
    }
    for (let i = 0; i < core.stances.length; i++) {
      const s = core.stances[i];
      const stanceText = typeof s === 'string' ? s : s && typeof s === 'object' ? s.stance : null;
      if (!stanceText || typeof stanceText !== 'string') {
        fail(
          'KDNA_Core.json',
          `stances[${i}]`,
          JSON.stringify(s),
          'Must be a string or an object with a stance string.',
        );
      } else if (isSlogan(stanceText)) {
        fail(
          'KDNA_Core.json',
          `stances[${i}]`,
          stanceText,
          'Reads like a slogan. Stances must be prescriptive positions that bias agent behavior.',
        );
      } else if (isVague(stanceText)) {
        warn('KDNA_Core.json', `stances[${i}]`, 'Contains vague language.');
      } else {
        pass('KDNA_Core.json', `stances[${i}]`);
      }
    }
  }

  // Load Patterns
  const patterns = readJson(path.join(abs, 'KDNA_Patterns.json'));
  if (!patterns) error('KDNA_Patterns.json not found or invalid JSON');

  // Check misunderstandings
  if (patterns.misunderstandings && Array.isArray(patterns.misunderstandings)) {
    for (const ms of patterns.misunderstandings) {
      const label = ms.id || '?';

      if (!ms.wrong || isStrawMan(ms.wrong)) {
        fail(
          'KDNA_Patterns.json',
          `misunderstandings.${label}.wrong`,
          ms.wrong,
          'Straw-man argument. Must describe a belief a real agent might actually hold, not an absurd position.',
        );
      } else {
        pass('KDNA_Patterns.json', `misunderstandings.${label}.wrong`);
      }

      if (!ms.key_distinction || ms.key_distinction.length < 15) {
        warn(
          'KDNA_Patterns.json',
          `misunderstandings.${label}.key_distinction`,
          'Key distinction too short. Must name the conceptual boundary.',
        );
      } else {
        pass('KDNA_Patterns.json', `misunderstandings.${label}.key_distinction`);
      }
    }
  }

  // Check self-checks
  if (patterns.self_check && Array.isArray(patterns.self_check)) {
    for (let i = 0; i < patterns.self_check.length; i++) {
      const sc = patterns.self_check[i];
      const text = selfCheckText(sc);
      if (!text) {
        fail(
          'KDNA_Patterns.json',
          `self_check[${i}]`,
          JSON.stringify(sc),
          'Must be a string or an object with a question string.',
        );
      } else if (isGenericSelfCheck(text)) {
        fail(
          'KDNA_Patterns.json',
          `self_check[${i}]`,
          text,
          'Generic question. Self-checks must be domain-specific, not "is this helpful?".',
        );
      } else if (!isYesNoSelfCheck(sc)) {
        warn('KDNA_Patterns.json', `self_check[${i}]`, 'Should be answerable with yes/no.');
        passes++;
      } else {
        pass('KDNA_Patterns.json', `self_check[${i}]`);
      }
    }
  }

  // Check kdna.json completeness
  const manifest = readJson(path.join(abs, 'kdna.json'));
  if (manifest) {
    const emptyFields = [];
    if (!manifest.description || manifest.description.length < 10) emptyFields.push('description');
    if (!manifest.keywords || manifest.keywords.length === 0) emptyFields.push('keywords');
    if (!manifest.author?.name) emptyFields.push('author.name');
    if (!manifest.author?.id) emptyFields.push('author.id');
    if (!manifest.registry?.repo) emptyFields.push('registry.repo');

    if (emptyFields.length > 0) {
      warn('kdna.json', 'manifest', `Empty fields: ${emptyFields.join(', ')}`);
    } else {
      pass('kdna.json', 'manifest');
    }
  } else {
    warn(
      'kdna.json',
      'manifest',
      'Not found. A kdna.json manifest is used for registry publication.',
    );
  }

  // Summary
  console.log('');
  console.log('═'.repeat(60));
  const total = errors + warnings + passes;
  console.log(`  ${passes} passed, ${warnings} warnings, ${errors} errors out of ${total} checks`);
  if (errors === 0) {
    console.log(`  ✓ Ready to publish`);
  } else {
    console.log(`  ✗ ${errors} issue(s) must be fixed before publishing`);
  }
  console.log('═'.repeat(60));

  if (errors > 0) process.exit(EXIT.POLICY_VIOLATION);
}

// ═══════════════════════════════════════════════════════════════════════
// Registry publish pipeline for existing .kdna assets.
// ═══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { execFileSync } = require('child_process');

/**
 * Canonical signing payload: sorted (filename, sha256) pairs of all published
 * content entries inside the .kdna ZIP, joined as `name:hex\n`.
 *
 * Excludes the `signature` field from kdna.json itself (computed by removing it
 * before hashing). Digest self-reference fields are also excluded. All other files included as-is.
 */
function canonicalPayload(srcDir, opts = {}) {
  const files = listPublishEntries(srcDir).sort();
  const parts = [];
  for (const f of files) {
    const full = f === 'mimetype' ? null : path.join(srcDir, f);
    let buf;
    if (f === 'mimetype') {
      buf = Buffer.from('application/vnd.kdna.asset');
    } else if (f.endsWith('.json')) {
      const obj = JSON.parse(fs.readFileSync(full, 'utf8'));
      const value = f === 'kdna.json' ? manifestForSigning(obj, opts) : obj;
      buf = Buffer.from(stableStringify(value));
    } else {
      buf = fs.readFileSync(full);
    }
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    parts.push(`${f}:${hash}`);
  }
  return parts.join('\n');
}

function manifestForSigning(manifest, opts = {}) {
  // Mirrors packages/kdna-core/src/asset-reader.js#manifestForSignature /
  // manifestForDigest. The two must agree on every field they strip,
  // otherwise the signing path and the digest path will hash different
  // representations of the same manifest and verifiers will report a
  // mismatch on otherwise-valid assets.
  //
  // Bug: prior version omitted the recursive `authoring.content_digest`
  // strip that both kdna-core and the studio-cli manifestForSigning
  // perform. A manifest with that field produced a different signing
  // payload here than anywhere else in the ecosystem.
  const copy = { ...(manifest || {}) };
  delete copy.signature;
  delete copy.asset_digest;
  delete copy.container_sha256;
  // Bug (#67): the previous `includeContentDigest` flag was the
  // semantic inverse of kdna-core's `stripDigestFields` option. Same
  // default value (omit the flag) produced the same behaviour, but a
  // caller that read the docs and set `includeContentDigest: true`
  // expecting "include" would actually be telling the signing path to
  // skip the strip — the opposite of what the name suggested. The
  // kdna-core convention (and the convention in
  // packages/kdna-core/src/asset-reader.js#manifestForSignature) is
  // `stripDigestFields: true`, so the fix accepts that name and
  // keeps `includeContentDigest` as a deprecated alias for the old
  // inverse behaviour.
  const stripDigestFields = opts.stripDigestFields !== false && opts.includeContentDigest !== true;
  if (stripDigestFields) delete copy.content_digest;
  delete copy._source;
  if (copy.authoring && typeof copy.authoring === 'object') {
    const auth = { ...copy.authoring };
    delete auth.content_digest;
    copy.authoring = auth;
  }
  return copy;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function listPublishEntries(domainDir) {
  const entries = ['mimetype'];
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'reports']);
  // Exclusions must match packages/kdna-core/src/asset-reader.js#buildContentDigest
  // — see docs/CANONICALIZATION.md. If publish.js signs a different set of
  // entries than the verifier digests, every signature will appear to fail.
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === 'mimetype') continue;
      if (name === '.DS_Store' || name === 'signature.json' || name === 'build-receipt.json')
        continue;
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        if (!skipDirs.has(name)) walk(abs, rel);
        continue;
      }
      if (
        rel.endsWith('.json') ||
        rel === 'README.md' ||
        rel === 'LICENSE' ||
        rel.startsWith('evals/') ||
        rel.startsWith('examples/')
      ) {
        entries.push(rel);
      }
    }
  }
  walk(domainDir);
  return entries;
}

function publicKeyToScopeFormat(publicKeyPem) {
  // The trust_pubkey in registry is stored as "ed25519:<sha256-of-PEM-hex>"
  // because Ed25519 PEM is multi-line; the scope key is a stable fingerprint.
  return 'ed25519:' + crypto.createHash('sha256').update(publicKeyPem).digest('hex');
}

/**
 * kdna publish <file.kdna> — Publish an existing Studio-compiled asset.
 *
 * Publishing no longer packs arbitrary source directories. Source directories
 * are non-canonical dev workspaces; release-evidence assets come from
 * Studio-compatible compile/export pipelines.
 */
function cmdPublish(assetPath, args = []) {
  const abs = path.resolve(assetPath);
  if (!fs.existsSync(abs)) error(`Path not found: ${abs}`, EXIT.INPUT_ERROR);
  if (fs.statSync(abs).isDirectory()) {
    error(
      'kdna publish only accepts existing .kdna assets. Source directories are authoring inputs; compile or pack the asset before publishing evidence.',
      EXIT.INPUT_ERROR,
    );
  }
  if (!abs.endsWith('.kdna')) error('kdna publish requires a .kdna asset file.', EXIT.INPUT_ERROR);

  const core = require('@aikdna/kdna-core');
  if (core.detectContainerFormat(abs) !== 'kdna') {
    error('kdna publish requires a current KDNA container.', EXIT.INPUT_ERROR);
  }
  const validation = core.validate(abs);
  if (validation?.overall_valid !== true) {
    error(`kdna publish requires a valid current KDNA asset: ${validation?.problems?.join('; ')}`);
  }

  const { readAssetManifest, assetDigest, contentDigest } = require('./package-store');
  const manifest = readAssetManifest(abs);
  const assetId = manifest.asset_id;
  if (typeof assetId !== 'string' || assetId.length === 0) error('kdna.json.asset_id required.');
  if (!manifest.version) error('kdna.json.version required.');

  console.log('═'.repeat(60));
  console.log(`  Publishing ${assetId}@${manifest.version}`);
  console.log('═'.repeat(60));

  const provenanceIssues = validateAuthoringProvenance(manifest);
  if (provenanceIssues.length) {
    error(
      `Authoring provenance gate failed:\n${provenanceIssues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
  }

  const digest = assetDigest(abs);
  const content = contentDigest(abs);
  const size = fs.statSync(abs).size;
  console.log(`  ✓ Asset: ${abs} (${size} bytes)`);
  console.log(`  ✓ asset_digest: ${digest}`);
  console.log(`  ✓ content_digest: ${content}`);
  if (manifest.authoring) {
    console.log(
      `  ✓ Authoring: ${manifest.authoring.created_by} / ${manifest.authoring.compiler || '?'}`,
    );
  }

  // 4. Optional upload via gh CLI
  const tagIdx = args.indexOf('--release-tag');
  const repoIdx = args.indexOf('--repo');
  let kdnaUrl = null;
  if (tagIdx >= 0 && repoIdx >= 0) {
    const tag = args[tagIdx + 1];
    const repo = args[repoIdx + 1];
    console.log('');
    console.log(`  Uploading to ${repo} release ${tag}...`);
    try {
      execFileSync('gh', ['release', 'upload', tag, abs, '--repo', repo, '--clobber'], {
        stdio: 'inherit',
      });
      kdnaUrl = `https://github.com/${repo}/releases/download/${tag}/${path.basename(abs)}`;
      console.log(`  ✓ Uploaded: ${kdnaUrl}`);
    } catch {
      console.warn(`  ⚠ Upload failed. You can manually upload ${abs}.`);
    }
  }

  const evidence = {
    type: 'kdna.publication-evidence',
    evidence_version: '0.1.0',
    asset_id: assetId,
    asset_uid: manifest.asset_uid,
    asset_type: manifest.asset_type,
    version: manifest.version,
    asset_digest: digest,
    content_digest: manifest.content_digest || content,
    artifact_url: kdnaUrl,
    authoring: manifest.authoring || null,
  };

  console.log('');
  console.log('─'.repeat(60));
  console.log('Publication evidence:');
  console.log('─'.repeat(60));
  console.log(JSON.stringify(evidence, null, 2));
  console.log('');
  console.log('Next: retain this evidence with the exact packaged .kdna artifact.');
}

function validateAuthoringProvenance(manifest) {
  const issues = [];
  const authoring = manifest.authoring;

  if (!authoring) return issues;
  const conformance = authoring.conformance;
  if (!conformance || conformance.passed !== true) {
    issues.push('authoring evidence requires authoring.conformance.passed = true');
  }
  if (!conformance || !conformance.format_version) {
    issues.push('authoring evidence requires authoring.conformance.format_version');
  }
  if (!authoring.compiler) issues.push('authoring evidence requires authoring.compiler');
  if (!authoring.compiler_version)
    issues.push('authoring evidence requires authoring.compiler_version');
  if (!authoring.compiled_at) issues.push('authoring evidence requires authoring.compiled_at');
  for (const field of ['asset_uid', 'project_uid', 'build_id', 'domain_id', 'content_digest']) {
    if (!authoring[field] && !manifest[field]) {
      issues.push(`authoring evidence requires ${field} in authoring provenance or manifest`);
    }
  }
  return issues;
}

module.exports = {
  cmdPublishCheck,
  cmdPublish,
  checkHumanLock,
  canonicalPayload,
  publicKeyToScopeFormat,
  validateAuthoringProvenance,
};
