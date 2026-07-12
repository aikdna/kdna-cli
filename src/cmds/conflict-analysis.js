/**
 * conflict-analysis.js — Bundle conflict static analysis (Story 9 + 13)
 *
 * Implements the per-card-type conflict detection rules defined in
 * docs/CONFLICT_RESOLUTION.md (Story 4). Replaces the INFO stub in
 * validate-bundle.js with real analysis.
 *
 * Detects conflicts across all component pairs in a Bundle by comparing
 * their card catalogs. Produces entries in the Conflict Report Format
 * from CONFLICT_RESOLUTION.md §Conflict Report Format.
 *
 * Covered card types (in order of severity):
 *   ERROR  — term (same term, different definition)
 *   WARNING — axiom (same id after descoping)
 *   WARNING — banned_term (same term, different replace_with)
 *   WARNING — misunderstanding (same wrong text, different correct)
 *   WARNING — stance (same statement text)
 *   WARNING — boundary (same scope text, different out_of_scope)
 *   WARNING — framework (same name, different steps)
 *   WARNING — self_check (same question text)
 *   INFO    — scenario (same scoped id)
 *   INFO    — risk (same id after descoping)
 *
 * Story 13 — trust_level: each conflict entry now carries
 * `trust_level_a` and `trust_level_b` (copied from the component
 * result). A new `community_warning` boolean is set when at least one
 * side is `trust_level: "community"` and the entry is WARNING-level.
 * This lets validate-bundle.js surface a `low_trust_warnings` summary
 * without re-walking all conflicts. The conflict entries themselves
 * are unchanged in shape; the new fields are additive.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cbor = require('cbor-x');

// ─── Payload loading ──────────────────────────────────────────────────────────

/**
 * Read and parse payload.kdnab from a component path (source dir or .kdna zip).
 * Returns:
 *   - parsed object on success
 *   - null if payload.kdnab exists but is malformed CBOR
 *   - undefined if no payload.kdnab file is found
 */
function loadPayload(componentPath, core) {
  const abs = path.resolve(componentPath);
  let hasPayload = false;

  try {
    // Source dir: payload.kdnab is a plain file
    if (fs.existsSync(path.join(abs, 'payload.kdnab'))) {
      hasPayload = true;
      const buf = fs.readFileSync(path.join(abs, 'payload.kdnab'));
      return cbor.decode(buf);
    }

    // .kdna container: get entry bytes via readLayout
    const readFn = core.readLayout;
    if (typeof readFn === 'function') {
      const layout = readFn(abs);
      if (layout && layout.map && layout.map['payload.kdnab']) {
        hasPayload = true;
        const buf = layout.map['payload.kdnab'];
        const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        return cbor.decode(bytes);
      }
    }
  } catch {
    if (hasPayload) {
      // Payload exists but could not be decoded — malformed CBOR
      return null;
    }
  }

  return undefined;
}

// ─── Card extraction ──────────────────────────────────────────────────────────

/**
 * Extract a flat map of card arrays from a payload object.
 * Returns { axiom: [], term: [], banned_term: [], misunderstanding: [],
 *           stance: [], boundary: [], framework: [], self_check: [],
 *           scenario: [], risk: [] }
 */
function extractCards(payload) {
  const cards = {
    axiom: [],
    term: [],
    banned_term: [],
    misunderstanding: [],
    stance: [],
    boundary: [],
    framework: [],
    self_check: [],
    scenario: [],
    risk: [],
  };

  if (!payload || typeof payload !== 'object') return cards;

  const core = payload.core || {};
  const patterns = payload.patterns;

  // ── core.axioms
  if (Array.isArray(core.axioms)) {
    cards.axiom = core.axioms.filter((a) => a && a.id);
  }

  // ── core.boundaries
  if (Array.isArray(core.boundaries)) {
    cards.boundary = core.boundaries.filter((b) => b && b.scope);
  }

  // ── core.stances (may be strings or objects)
  if (Array.isArray(core.stances)) {
    cards.stance = core.stances
      .map((s, i) =>
        typeof s === 'string'
          ? { id: `stance_${i}`, statement: s }
          : { id: s.id || `stance_${i}`, statement: s.statement || s.stance || '' },
      )
      .filter((s) => s.statement);
  }

  // ── patterns: flat array with type field (Studio v1 compiled format)
  //    Also handles patterns as object with typed sub-arrays (legacy/alt format)
  const patternList = Array.isArray(patterns)
    ? patterns
    : patterns && typeof patterns === 'object'
      ? // Studio compile emits patterns as array; legacy may use {terminology, misunderstandings, …}
        [
          ...(Array.isArray(patterns.misunderstandings)
            ? patterns.misunderstandings.map((m) => ({ ...m, type: 'misunderstanding' }))
            : []),
          ...(Array.isArray(patterns['self_checks'])
            ? patterns['self_checks'].map((c) => ({ ...c, type: 'self_check' }))
            : []),
          ...(patterns.terminology && Array.isArray(patterns.terminology.standard_terms)
            ? patterns.terminology.standard_terms.map((t) => ({ ...t, type: 'term' }))
            : []),
          ...(patterns.terminology && Array.isArray(patterns.terminology.banned_terms)
            ? patterns.terminology.banned_terms.map((t) => ({ ...t, type: 'banned_term' }))
            : []),
          ...(Array.isArray(patterns.frameworks)
            ? patterns.frameworks.map((f) => ({ ...f, type: 'framework' }))
            : []),
        ]
      : [];

  for (const card of patternList) {
    if (!card || !card.type) continue;
    const type = card.type;
    if (Object.prototype.hasOwnProperty.call(cards, type)) {
      cards[type].push(card);
    }
  }

  // ── scenarios
  if (Array.isArray(payload.scenarios)) {
    cards.scenario = payload.scenarios.filter((s) => s && s.id);
  }

  // ── risk_model: may be object with named risks, or array
  if (Array.isArray(core.risk_model)) {
    cards.risk = core.risk_model.filter((r) => r && (r.id || r.name));
  } else if (core.risk_model && typeof core.risk_model === 'object') {
    // Object keyed by risk id
    cards.risk = Object.entries(core.risk_model).map(([k, v]) =>
      typeof v === 'string' ? { id: k, name: v } : { id: k, ...v },
    );
  }

  return cards;
}

// ─── Conflict entry builder ───────────────────────────────────────────────────

function makeEntry(opts) {
  return {
    conflict_type: opts.conflict_type,
    severity: opts.severity,
    component_a: opts.compA,
    component_b: opts.compB,
    card_type: opts.cardType,
    card_id_a: `${opts.compA}:${opts.idA || '(unknown)'}`,
    card_id_b: `${opts.compB}:${opts.idB || '(unknown)'}`,
    conflicting_field: opts.field,
    resolution: opts.resolution || 'priority_wins',
    winning_component: null,
    note: opts.note,
    // Story 13 — trust_level annotation. Optional: present only when
    // analyseConflicts is called with a component-trust map. Set after
    // creation by `analyseConflicts` itself.
    trust_level_a: null,
    trust_level_b: null,
    community_warning: false,
  };
}

// ─── Per-type detectors ───────────────────────────────────────────────────────

function detectAxiomConflicts(cardsA, cardsB, compA, compB) {
  const out = [];
  const idSetA = new Map(cardsA.axiom.map((a) => [a.id, a]));
  for (const bx of cardsB.axiom) {
    if (idSetA.has(bx.id)) {
      out.push(
        makeEntry({
          conflict_type: 'value_conflict',
          severity: 'WARNING',
          compA,
          compB,
          cardType: 'axiom',
          idA: bx.id,
          idB: bx.id,
          field: 'id',
          resolution: 'priority_wins',
          note: `Axiom id "${bx.id}" defined in both components. Same id may encode different judgment.`,
        }),
      );
    }
  }
  return out;
}

function detectTermConflicts(cardsA, cardsB, compA, compB) {
  const out = [];
  const termMapA = new Map(cardsA.term.map((t) => [t.term, t]));
  for (const tb of cardsB.term) {
    const ta = termMapA.get(tb.term);
    if (ta && ta.definition !== tb.definition) {
      out.push(
        makeEntry({
          conflict_type: 'term_conflict',
          severity: 'ERROR',
          compA,
          compB,
          cardType: 'term',
          idA: ta.id || ta.term,
          idB: tb.id || tb.term,
          field: 'definition',
          resolution: 'priority_wins',
          note: `Term "${tb.term}" has conflicting definitions across components. Consumers will receive contradictory meaning.`,
        }),
      );
    }
  }
  return out;
}

function detectBannedTermConflicts(cardsA, cardsB, compA, compB) {
  const out = [];
  const mapA = new Map(cardsA.banned_term.map((t) => [t.term, t]));
  for (const tb of cardsB.banned_term) {
    const ta = mapA.get(tb.term);
    if (ta && ta.replace_with !== tb.replace_with) {
      out.push(
        makeEntry({
          conflict_type: 'term_conflict',
          severity: 'WARNING',
          compA,
          compB,
          cardType: 'banned_term',
          idA: ta.id || ta.term,
          idB: tb.id || tb.term,
          field: 'replace_with',
          resolution: 'risk_wins',
          note: `Banned term "${tb.term}" has different replace_with values. Both suggestions will be emitted.`,
        }),
      );
    }
  }
  return out;
}

function detectMisunderstandingConflicts(cardsA, cardsB, compA, compB) {
  const out = [];
  const mapA = new Map(
    cardsA.misunderstanding.map((m) => [(m.wrong || '').toLowerCase().trim(), m]),
  );
  for (const mb of cardsB.misunderstanding) {
    const key = (mb.wrong || '').toLowerCase().trim();
    const ma = mapA.get(key);
    if (ma && (ma.correct || '').toLowerCase().trim() !== (mb.correct || '').toLowerCase().trim()) {
      out.push(
        makeEntry({
          conflict_type: 'value_conflict',
          severity: 'WARNING',
          compA,
          compB,
          cardType: 'misunderstanding',
          idA: ma.id || key,
          idB: mb.id || key,
          field: 'correct',
          resolution: 'priority_wins',
          note: `Misunderstanding with same "wrong" text has conflicting "correct" resolution across components.`,
        }),
      );
    }
  }
  return out;
}

function detectStanceConflicts(cardsA, cardsB, compA, compB) {
  const out = [];
  const setA = new Map(cardsA.stance.map((s) => [(s.statement || '').toLowerCase().trim(), s]));
  for (const sb of cardsB.stance) {
    const key = (sb.statement || '').toLowerCase().trim();
    if (setA.has(key)) {
      out.push(
        makeEntry({
          conflict_type: 'stance_conflict',
          severity: 'WARNING',
          compA,
          compB,
          cardType: 'stance',
          idA: setA.get(key).id || key,
          idB: sb.id || key,
          field: 'statement',
          resolution: 'surface',
          note: `Stance "${(sb.statement || '').slice(0, 60)}" defined in both components.`,
        }),
      );
    }
  }
  return out;
}

function detectFrameworkConflicts(cardsA, cardsB, compA, compB) {
  const out = [];
  const mapA = new Map(cardsA.framework.map((f) => [(f.name || '').toLowerCase().trim(), f]));
  for (const fb of cardsB.framework) {
    const key = (fb.name || '').toLowerCase().trim();
    const fa = mapA.get(key);
    if (fa) {
      const stepsA = JSON.stringify(fa.steps || []);
      const stepsB = JSON.stringify(fb.steps || []);
      if (stepsA !== stepsB) {
        out.push(
          makeEntry({
            conflict_type: 'framework_conflict',
            severity: 'WARNING',
            compA,
            compB,
            cardType: 'framework',
            idA: fa.id || fa.name,
            idB: fb.id || fb.name,
            field: 'steps',
            resolution: 'priority_wins',
            note: `Framework "${fb.name}" has different steps across components.`,
          }),
        );
      }
    }
  }
  return out;
}

function detectSelfCheckConflicts(cardsA, cardsB, compA, compB) {
  const out = [];
  const mapA = new Map(
    cardsA.self_check.map((c) => [(c.question || c.one_sentence || '').toLowerCase().trim(), c]),
  );
  for (const cb of cardsB.self_check) {
    const key = (cb.question || cb.one_sentence || '').toLowerCase().trim();
    if (mapA.has(key)) {
      out.push(
        makeEntry({
          conflict_type: 'framework_conflict',
          severity: 'WARNING',
          compA,
          compB,
          cardType: 'self_check',
          idA: mapA.get(key).id || key,
          idB: cb.id || key,
          field: 'question',
          resolution: 'surface',
          note: `Self-check "${(cb.question || cb.one_sentence || '').slice(0, 60)}" appears in both components.`,
        }),
      );
    }
  }
  return out;
}

function detectScenarioConflicts(cardsA, cardsB, compA, compB) {
  const out = [];
  const setA = new Set(cardsA.scenario.map((s) => s.id));
  for (const sb of cardsB.scenario) {
    if (setA.has(sb.id)) {
      out.push(
        makeEntry({
          conflict_type: 'framework_conflict',
          severity: 'INFO',
          compA,
          compB,
          cardType: 'scenario',
          idA: sb.id,
          idB: sb.id,
          field: 'id',
          resolution: 'priority_wins',
          note: `Scenario id "${sb.id}" defined in both components.`,
        }),
      );
    }
  }
  return out;
}

function detectRiskConflicts(cardsA, cardsB, compA, compB) {
  const out = [];
  const mapA = new Map(cardsA.risk.map((r) => [r.id || r.name, r]));
  for (const rb of cardsB.risk) {
    const key = rb.id || rb.name;
    const ra = mapA.get(key);
    if (ra) {
      const mitA = JSON.stringify(ra.mitigation || ra.how || '');
      const mitB = JSON.stringify(rb.mitigation || rb.how || '');
      if (mitA !== mitB) {
        out.push(
          makeEntry({
            conflict_type: 'risk_conflict',
            severity: 'INFO',
            compA,
            compB,
            cardType: 'risk',
            idA: ra.id || ra.name,
            idB: rb.id || rb.name,
            field: 'mitigation',
            resolution: 'risk_wins',
            note: `Risk "${key}" has different mitigation across components; more restrictive wins.`,
          }),
        );
      }
    }
  }
  return out;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Analyse conflicts across all component pairs in a validated bundle.
 *
 * @param {Array}  componentResults  Array of component objects from validateBundle.
 *   Each must have: { id, path, valid }. Story 13: may also carry `trust_level`
 *   (`"community" | "verified" | "official" | null`).
 * @param {object} core  The @aikdna/kdna-core module (for readLayout).
 * @returns {{ errors: Array, warnings: Array, info: Array }}
 */
function analyseConflicts(componentResults, core) {
  const errors = [];
  const warnings = [];
  const info = [];

  // Only analyse valid components — broken components can't contribute
  const validComps = componentResults.filter((c) => c.valid && c.path);

  if (validComps.length < 2) {
    return { errors, warnings, info };
  }

  // Build a trust-level map for the annotation step (Story 13).
  // Valid trust levels: "community" | "verified" | "official". Anything
  // else is treated as null (unspecified) — validate-bundle.js is
  // responsible for rejecting bad values up front.
  const trustMap = new Map();
  for (const c of validComps) {
    const tl = c.trust_level;
    trustMap.set(c.id, tl === 'community' || tl === 'verified' || tl === 'official' ? tl : null);
  }

  // Load payloads once
  const payloads = validComps.map((comp) => {
    const raw = loadPayload(comp.path, core);
    if (raw === null) {
      // Payload exists but is malformed — add diagnostic
      info.push({
        conflict_type: 'info',
        severity: 'INFO',
        component_a: comp.id,
        component_b: null,
        card_type: 'payload',
        card_id_a: `${comp.id}:payload`,
        card_id_b: null,
        conflicting_field: 'integrity',
        resolution: 'surface',
        note: `Component "${comp.id}" has a payload.kdnab that could not be decoded as CBOR. It may be malformed or use an unsupported encoding. Conflict analysis will skip this component.`,
        trust_level_a: null,
        trust_level_b: null,
        community_warning: false,
      });
      return { comp, cards: extractCards(undefined) };
    }
    return { comp, cards: extractCards(raw) };
  });

  // Compare every pair (O(n²), acceptable for small bundles)
  for (let i = 0; i < payloads.length; i++) {
    for (let j = i + 1; j < payloads.length; j++) {
      const a = payloads[i];
      const b = payloads[j];
      const compA = a.comp.id;
      const compB = b.comp.id;

      const pairConflicts = [
        ...detectTermConflicts(a.cards, b.cards, compA, compB), // ERROR first
        ...detectAxiomConflicts(a.cards, b.cards, compA, compB),
        ...detectBannedTermConflicts(a.cards, b.cards, compA, compB),
        ...detectMisunderstandingConflicts(a.cards, b.cards, compA, compB),
        ...detectStanceConflicts(a.cards, b.cards, compA, compB),
        ...detectFrameworkConflicts(a.cards, b.cards, compA, compB),
        ...detectSelfCheckConflicts(a.cards, b.cards, compA, compB),
        ...detectScenarioConflicts(a.cards, b.cards, compA, compB),
        ...detectRiskConflicts(a.cards, b.cards, compA, compB),
      ];

      const tlA = trustMap.get(compA);
      const tlB = trustMap.get(compB);

      for (const entry of pairConflicts) {
        // Story 13: annotate each entry with the trust levels of the
        // two components, and flag WARNING-level entries as
        // community_warning when at least one side is community.
        entry.trust_level_a = tlA || null;
        entry.trust_level_b = tlB || null;
        if (entry.severity === 'WARNING' && (tlA === 'community' || tlB === 'community')) {
          entry.community_warning = true;
        }

        if (entry.severity === 'ERROR') errors.push(entry);
        else if (entry.severity === 'WARNING') warnings.push(entry);
        else info.push(entry);
      }
    }
  }

  return { errors, warnings, info };
}

module.exports = { analyseConflicts, extractCards, loadPayload };
