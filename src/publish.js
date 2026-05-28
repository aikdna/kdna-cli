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
    // Rule 1: Must be locked
    if (!card.status || !['locked', 'tested', 'published'].includes(card.status)) {
      issues.push(`${card.type} "${card.id}" is not locked. Human Lock required before publish.`);
      continue;
    }
    // Rule 2: Must have human_lock record
    if (!card.human_lock || !card.human_lock.by || !card.human_lock.statement) {
      issues.push(`${card.type} "${card.id}" is locked but has no valid Human Lock record.`);
      continue;
    }
    // Rule 3: Lock must confirm judgment fields were reviewed
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

  // ─── Human Lock Gate (must pass before any other checks) ──────────
  const hl = checkHumanLock(abs);
  if (!hl.passed) {
    if (args.includes('--force')) {
      console.warn('  ⚠  Human Lock Gate: OVERRIDDEN (--force). Proceeding with checks.');
      console.warn(`     ${hl.issues.length} unresolved Human Lock issue(s):`);
      for (const issue of hl.issues) {
        console.warn(`       ${issue}`);
      }
      console.warn('');
    } else {
      console.error('  Human Lock Gate: BLOCKED');
      console.error(`  ${hl.issues.length} issue(s) found:`);
      for (const issue of hl.issues) {
        console.error(`    ✗ ${issue}`);
      }
      console.error('');
      console.error('  Judgment-class cards (axiom, boundary, risk, aesthetic)');
      console.error('  must be locked with a valid Human Lock record before publishing.');
      console.error('  Use kdna-studio or manually add human_lock to each card.');
      console.error('  Use --force for emergency override (audited).');
      console.error('');
      process.exit(EXIT.HUMAN_LOCK_REQUIRED);
    }
  } else {
    console.log('  ✓ Human Lock Gate: passed');
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
      'Not found. A kdna.json manifest is recommended for registry publication.',
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
// v0.7: full publish pipeline (validate + pack + sign + upload + patch)
// ═══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { execSync, execFileSync } = require('child_process');
const identity = require('./identity');
const { fingerprint } = identity;

const NAME_RE = /^@([a-z][a-z0-9-]*)\/([a-z][a-z0-9_]*)$/;

function identityPaths() {
  // Recompute each call so KDNA_IDENTITY_DIR env var can be changed at runtime
  const dir =
    process.env.KDNA_IDENTITY_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kdna', 'identity');
  return {
    privateKeyPath: path.join(dir, 'kdna.key'),
    publicKeyPath: path.join(dir, 'kdna.pub'),
    dir,
  };
}

/**
 * Canonical signing payload: sorted (filename, sha256) pairs of all published
 * content entries inside the .kdna ZIP, joined as `name:hex\n`.
 *
 * Excludes the `signature` field from kdna.json itself (computed by removing it
 * before hashing). Digest self-reference fields are also excluded. All other files included as-is.
 */
function canonicalPayload(srcDir, opts = {}) {
  const files = listPublishEntries(srcDir);
  const parts = [];
  for (const f of files) {
    const full = f === 'mimetype' ? null : path.join(srcDir, f);
    let buf;
    if (f === 'mimetype') {
      buf = Buffer.from('application/vnd.aikdna.kdna+zip');
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
  const copy = { ...(manifest || {}) };
  delete copy.signature;
  delete copy.asset_digest;
  delete copy.container_sha256;
  if (!opts.includeContentDigest) delete copy.content_digest;
  delete copy._source;
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

function manifestForContentDigest(manifest) {
  const copy = { ...(manifest || {}) };
  delete copy.signature;
  delete copy.asset_digest;
  delete copy.container_sha256;
  delete copy.content_digest;
  delete copy._source;
  return copy;
}

function sourceContentDigest(srcDir) {
  const files = listPublishEntries(srcDir);
  const parts = [];
  for (const f of files) {
    let buf;
    if (f === 'mimetype') {
      buf = Buffer.from('application/vnd.aikdna.kdna+zip');
    } else if (f.endsWith('.json')) {
      const obj = JSON.parse(fs.readFileSync(path.join(srcDir, f), 'utf8'));
      const value = f === 'kdna.json' ? manifestForContentDigest(obj) : obj;
      buf = Buffer.from(stableStringify(value));
    } else {
      buf = fs.readFileSync(path.join(srcDir, f));
    }
    parts.push(`${f}:${crypto.createHash('sha256').update(buf).digest('hex')}`);
  }
  return `sha256:${crypto
    .createHash('sha256')
    .update(Buffer.from(parts.join('\n')))
    .digest('hex')}`;
}

function listPublishEntries(domainDir) {
  const entries = ['mimetype'];
  const skipDirs = new Set(['.git', 'node_modules', 'dist']);
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === 'mimetype') continue;
      if (name === '.DS_Store' || name === 'signature.json') continue;
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
        rel.startsWith('examples/') ||
        rel.startsWith('reports/')
      ) {
        entries.push(rel);
      }
    }
  }
  walk(domainDir);
  return entries;
}

function signPayload(payload, privateKeyPem) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload), privateKey);
  return sig.toString('hex');
}

function loadIdentity() {
  const { privateKeyPath, publicKeyPath, dir } = identityPaths();
  if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
    error(`No identity found at ${dir}. Run: kdna identity init  (or set KDNA_IDENTITY_DIR)`);
  }
  return {
    privateKey: fs.readFileSync(privateKeyPath, 'utf8'),
    publicKey: fs.readFileSync(publicKeyPath, 'utf8'),
  };
}

function publicKeyToScopeFormat(publicKeyPem) {
  // The trust_pubkey in registry is stored as "ed25519:<sha256-of-PEM-hex>"
  // because Ed25519 PEM is multi-line; the scope key is a stable fingerprint.
  return 'ed25519:' + crypto.createHash('sha256').update(publicKeyPem).digest('hex');
}

function packToFile(domainDir, outPath) {
  const files = listPublishEntries(domainDir).filter((f) => f !== 'mimetype');
  if (!files.includes('kdna.json'))
    error('kdna.json required in dev source directory for publish.');

  const script = `import zipfile, os
src = ${JSON.stringify(domainDir)}
out = ${JSON.stringify(outPath)}
files = ${JSON.stringify(files)}
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr(zipfile.ZipInfo('mimetype'), 'application/vnd.aikdna.kdna+zip', compress_type=zipfile.ZIP_STORED)
    for f in files:
        zf.write(os.path.join(src, f), f)
`;
  const tmpPy = `/tmp/kdna-publish-pack-${Date.now()}.py`;
  try {
    fs.writeFileSync(tmpPy, script);
    execSync(`python3 ${tmpPy}`, { stdio: 'pipe' });
  } finally {
    try {
      fs.unlinkSync(tmpPy);
    } catch {
      /* ignore */
    }
  }
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function outputDirFromArgs(args, fallback) {
  for (const flag of ['--output', '--out', '-o']) {
    const idx = args.indexOf(flag);
    if (idx >= 0) return args[idx + 1];
  }
  return fallback;
}

/**
 * kdna publish <path>  — Full publish pipeline.
 *
 * Steps:
 *   1. Validate name = @scope/name; load identity; validate author.pubkey
 *   2. Quality gate (cmdPublishCheck, soft)
 *   3. Write signature into kdna.json (canonical payload signed with identity)
 *   4. Pack into .kdna
 *   5. Compute sha256
 *   6. If --release-tag <tag> and --repo <owner/name>: upload via gh CLI
 *   7. Print registry patch JSON
 */
function cmdPublish(domainPath, args = []) {
  const abs = path.resolve(domainPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) error(`Not a directory: ${abs}`);

  const manifestPath = path.join(abs, 'kdna.json');
  if (!fs.existsSync(manifestPath)) error('kdna.json required at domain root.');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const name = manifest.name;
  const m = name && name.match(NAME_RE);
  if (!m) {
    error(`kdna.json.name "${name || '?'}" must be @scope/name format (e.g. @aikdna/writing).`);
  }
  if (!manifest.version) error('kdna.json.version required.');

  const { privateKey, publicKey } = loadIdentity();
  const scopeKey = publicKeyToScopeFormat(publicKey);

  console.log('═'.repeat(60));
  console.log(`  Publishing ${name}@${manifest.version}`);
  console.log('═'.repeat(60));

  // ─── Human Lock Gate ──────────────────────────────────────────────
  const hl = checkHumanLock(abs);
  if (!hl.passed) {
    console.error('');
    console.error('  Human Lock Gate: BLOCKED');
    for (const issue of hl.issues) {
      console.error(`    ✗ ${issue}`);
    }
    console.error('');
    console.error('  Use kdna publish --check for details, or --force to override.');
    if (!args.includes('--force')) {
      process.exit(EXIT.HUMAN_LOCK_REQUIRED);
    }
    console.warn('  ⚠  --force override: publishing without Human Lock (emergency only)');
  } else {
    console.log(`  ✓ Human Lock Gate: passed`);
  }
  console.log('');

  console.log(`  Identity fingerprint: ${fingerprint(publicKey)}`);
  console.log(`  Scope trust key:      ${scopeKey.slice(0, 28)}…`);
  console.log('');

  // 1. Update author.pubkey if missing/mismatch
  if (!manifest.author) manifest.author = {};
  if (manifest.author.pubkey && manifest.author.pubkey !== scopeKey) {
    error(
      `kdna.json.author.pubkey (${manifest.author.pubkey.slice(0, 20)}…) does not match your identity (${scopeKey.slice(0, 20)}…). Refusing to overwrite. Either remove the field, or use the matching identity.`,
    );
  }
  manifest.author.pubkey = scopeKey;
  // Embed full PEM so consumers can verify the signature against author.pubkey fingerprint
  manifest.author.public_key_pem = publicKey;

  // 2. Write signature
  delete manifest.signature;
  delete manifest.asset_digest;
  delete manifest.container_sha256;
  delete manifest.content_digest;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  manifest.content_digest = sourceContentDigest(abs);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const signedPayload = canonicalPayload(abs);
  const sig = signPayload(signedPayload, privateKey);
  manifest.signature = 'ed25519:' + sig;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`  ✓ Signed (payload covers ${listPublishEntries(abs).length} content entries)`);

  // 3. Pack
  const fileName = `${m[2]}-${manifest.version}.kdna`;
  const outDir = outputDirFromArgs(args, path.join(abs, 'dist'));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, fileName);
  packToFile(abs, outPath);
  const sha256 = sha256File(outPath);
  const assetDigest = `sha256:${sha256}`;
  const size = fs.statSync(outPath).size;
  console.log(`  ✓ Packed: ${outPath} (${size} bytes)`);
  console.log(`  ✓ asset_digest: ${assetDigest}`);

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
      execFileSync('gh', ['release', 'upload', tag, outPath, '--repo', repo, '--clobber'], {
        stdio: 'inherit',
      });
      kdnaUrl = `https://github.com/${repo}/releases/download/${tag}/${fileName}`;
      console.log(`  ✓ Uploaded: ${kdnaUrl}`);
    } catch {
      console.warn(`  ⚠ Upload failed. You can manually upload ${outPath}.`);
    }
  }

  // 5. Registry patch
  const patch = {
    name,
    type: manifest.cluster ? 'cluster' : 'domain',
    version: manifest.version,
    asset_url: kdnaUrl,
    asset_digest: assetDigest,
    content_digest: manifest.content_digest || null,
    signature: manifest.signature,
    release_status: kdnaUrl ? 'published_signed' : 'published_signed_local',
    author: { ...manifest.author },
  };

  console.log('');
  console.log('─'.repeat(60));
  console.log('Registry patch (apply to kdna-registry/domains.json):');
  console.log('─'.repeat(60));
  console.log(JSON.stringify(patch, null, 2));
  console.log('');
  console.log(
    `Next: open a PR to kdna-registry merging this patch into the matching entry by "name".`,
  );
}

module.exports = {
  cmdPublishCheck,
  cmdPublish,
  checkHumanLock,
  canonicalPayload,
  publicKeyToScopeFormat,
};
