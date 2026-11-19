'use strict';
// Pure "Reading" capability: structural diff of two admitted whole-asset views
// (the objects returned by inspectWholeSectionSnapshot) and a plain-text renderer.
// No I/O, no ANSI colour, deterministic ordering (code-point order of ids).

const { wrap: wrapHuman } = require('./human.js');
const FORMAT = 'kdna.diff/1';

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Leaf-level comparison of two JSON values; returns [{path,left,right}] sorted by path.
// A missing side is reported as undefined->null-free: the key is simply absent (left/right = undefined is
// normalised to null with the `absent` marker so JSON output stays honest).
function fieldDiffs(left, right, path = '', out = []) {
  if (left !== undefined && right !== undefined && canonicalJson(left) === canonicalJson(right)) return out;
  if (isObject(left) && isObject(right)) {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      fieldDiffs(left[key], right[key], path === '' ? key : path + '.' + key, out);
    }
    return out;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) fieldDiffs(left[index], right[index], path + '[' + index + ']', out);
    return out;
  }
  out.push({ path: path === '' ? '(value)' : path, left: left === undefined ? null : left, right: right === undefined ? null : right, ...(left === undefined ? { left_absent: true } : {}), ...(right === undefined ? { right_absent: true } : {}) });
  return out;
}

function nodesOf(view) { return Array.isArray(view?.ir?.nodes) ? view.ir.nodes : []; }

const CONDITION_ROLES = new Set(['condition', 'exception', 'boundary', 'misuse']);
const RELATION_ROLES = new Set(['relationship']);
// Core emits `result`, `result_contract`, and `method_component` IR mirror nodes owned by a judgment
// whose full content is already embedded inside `judgment.value`; exclude judgment-owned mirror nodes
// from `declarations` so every judgment edit is reported once under `judgments` instead of triplicated.
const JUDGMENT_MIRROR_ROLES = new Set(['result', 'result_contract', 'method_component']);

// Group nodes by role family, keyed by "<role>|<target id>" (node ids are content hashes, so they
// cannot identify "the same item" across versions; the target id is the stable authored identity).
function indexNodes(view) {
  const judgments = new Map(), conditions = new Map(), declarations = new Map();
  let assetDeclaration = null;
  const allNodes = nodesOf(view);
  for (const node of allNodes) {
    if (node.role === 'judgment') {
      const target = node?.target?.id ?? node?.value?.id ?? node?.id;
      judgments.set(String(target), node.value);
    }
  }
  for (const node of allNodes) {
    if (node.role === 'judgment') continue;
    const target = node?.target?.id ?? node?.value?.id ?? node?.id;
    if (node.role === 'asset_declaration') { assetDeclaration = node.value ?? null; continue; }
    if (RELATION_ROLES.has(node.role)) continue;
    const ownerJudgment = node.owner_judgment_id ?? (node.owner?.kind === 'judgment' ? node.owner.id : null);
    if (JUDGMENT_MIRROR_ROLES.has(node.role) && ownerJudgment && judgments.has(String(ownerJudgment))) continue;
    if (CONDITION_ROLES.has(node.role)) conditions.set(node.role + '|' + target, node.value);
    else declarations.set(node.role + '|' + target, node.value);
  }
  return { judgments, conditions, declarations, assetDeclaration };
}

function nodeNames(view) {
  const names = new Map();
  for (const node of nodesOf(view)) names.set(node.id, node.role + ':' + (node?.target?.id ?? node.id));
  return names;
}

// Relations: ir.relationships rows (authored relationship values) plus ir.references (edges between nodes).
function indexRelations(view) {
  const names = nodeNames(view), map = new Map();
  const relationships = Array.isArray(view?.ir?.relationships) ? view.ir.relationships : [];
  for (const row of relationships) {
    const value = isObject(row) && isObject(row.value) ? row.value : row;
    const participants = Array.isArray(value?.participants)
      ? value.participants.map(p => (p?.role?.term ?? '') + '=' + (p?.judgment_ref ?? '')).sort().join(',') : '';
    const key = 'relationship|' + (value?.kind?.term ?? value?.kind ?? '') + '|' + (participants || value?.id || canonicalJson(value));
    map.set(key, value);
  }
  const references = Array.isArray(view?.ir?.references) ? view.ir.references : [];
  for (const ref of references) {
    if (!isObject(ref)) continue;
    const source = names.get(ref.source_node) ?? ref.source_node, target = names.get(ref.target_node) ?? ref.target_node;
    const key = 'reference|' + source + '->' + target + '|' + (ref.role ?? '');
    const { id, source_node, target_node, ...rest } = ref; // eslint-disable-line no-unused-vars
    map.set(key, { source, target, ...rest });
  }
  return map;
}

function compareMaps(leftMap, rightMap, label) {
  const added = [], removed = [], changed = [];
  let unchanged = 0;
  for (const key of [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort(cmp)) {
    const id = key;
    if (!leftMap.has(key)) added.push(label(id, rightMap.get(key)));
    else if (!rightMap.has(key)) removed.push(label(id, leftMap.get(key)));
    else if (canonicalJson(leftMap.get(key)) === canonicalJson(rightMap.get(key))) unchanged++;
    else changed.push({ id, fields: fieldDiffs(leftMap.get(key), rightMap.get(key)) });
  }
  return { added, removed, changed, unchanged_count: unchanged };
}

function summarize(view) {
  const digest = letter => view?.digests?.[letter]?.observed ?? null;
  return {
    asset: view?.asset ?? null,
    tuple: view?.tuple ?? null,
    digests: { A: digest('A'), C: digest('C'), E: digest('E') },
    ir_digest: view?.verification?.ir_digest?.digest ?? null,
    judgment_count: Array.isArray(view?.ir?.catalog) ? view.ir.catalog.length : 0,
  };
}

function scalarChanges(prefix, left, right) {
  return fieldDiffs(left ?? {}, right ?? {}).map(entry => ({ field: prefix + (entry.path === '(value)' ? '' : '.' + entry.path), left: entry.left, right: entry.right }));
}

function computeAffectedByChange(leftView, rightView, judgmentsDiff, leftJudgments, rightJudgments) {
  const touched = new Set([
    ...(judgmentsDiff.changed ?? []).map(e => e.id),
    ...(judgmentsDiff.removed ?? []).map(e => e.id),
  ]);
  if (touched.size === 0) return [];
  const collectEdges = (view) => {
    const out = [];
    const rels = Array.isArray(view?.ir?.relationships) ? view.ir.relationships : [];
    for (const row of rels) {
      const value = isObject(row) && isObject(row.value) ? row.value : row;
      const kind = value?.kind?.term ?? value?.kind;
      if (!['support', 'qualify', 'conflict'].includes(kind)) continue;
      const parts = (value?.participants ?? [])
        .map(p => ({ role: p?.role?.term ?? null, ref: typeof p?.judgment_ref === 'string' ? p.judgment_ref : null }))
        .filter(p => p.ref !== null);
      if (kind === 'support' || kind === 'qualify') {
        const src = parts.find(p => p.role === 'supporter' || p.role === 'qualifier');
        const dst = parts.find(p => p.role === 'claim' || p.role === 'qualified');
        if (src && dst) out.push({ from: src.ref, to: dst.ref, kind, relation_id: value?.id ?? null });
      } else if (kind === 'conflict' && parts.length === 2) {
        out.push({ from: parts[0].ref, to: parts[1].ref, kind: 'conflict', relation_id: value?.id ?? null });
        out.push({ from: parts[1].ref, to: parts[0].ref, kind: 'conflict', relation_id: value?.id ?? null });
      }
    }
    return out;
  };
  const affectedMap = new Map();
  const seenEdges = new Set();
  for (const edge of [...collectEdges(rightView), ...collectEdges(leftView)]) {
    if (!touched.has(edge.from) || touched.has(edge.to)) continue;
    // Only report downstream judgments that still exist on the right side (if right has any judgments)
    if (rightJudgments.size > 0 && !rightJudgments.has(edge.to)) continue;
    const edgeKey = `${edge.to}|${edge.from}|${edge.kind}|${edge.relation_id ?? ''}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    if (!affectedMap.has(edge.to)) {
      const targetVal = rightJudgments.get(edge.to) ?? leftJudgments.get(edge.to);
      affectedMap.set(edge.to, { judgment_id: edge.to, focus: targetVal?.focus ?? null, affected_by: [] });
    }
    affectedMap.get(edge.to).affected_by.push({
      judgment_id: edge.from,
      kind: edge.kind,
      ...(edge.relation_id ? { relation_id: edge.relation_id } : {}),
    });
  }
  return [...affectedMap.values()]
    .sort((a, b) => cmp(a.judgment_id, b.judgment_id))
    .map(entry => ({
      ...entry,
      affected_by: entry.affected_by.sort((a, b) => cmp(a.judgment_id + ':' + a.kind, b.judgment_id + ':' + b.kind)),
    }));
}

/**
 * Compare two admitted whole-asset views.
 * @param {object} leftView  result of inspectWholeSectionSnapshot (the "before" asset)
 * @param {object} rightView result of inspectWholeSectionSnapshot (the "after" asset)
 * @returns {object} kdna.diff/1 JSON. `identical` is a semantic statement (identity, tuple, manifest
 *   declaration, judgments, conditions, relations and other declarations all equal); byte/content
 *   digest differences are reported separately under `digests`.
 */
function diffViews(leftView, rightView) {
  const L = indexNodes(leftView), R = indexNodes(rightView);
  const manifestChanged = [
    ...scalarChanges('asset', leftView?.asset, rightView?.asset),
    ...scalarChanges('tuple', leftView?.tuple, rightView?.tuple),
    ...scalarChanges('declaration', L.assetDeclaration, R.assetDeclaration),
  ];
  const labelJudgment = (id, value) => ({ id, focus: value?.focus ?? null });
  const judgments = compareMaps(L.judgments, R.judgments, labelJudgment);
  const conditions = compareMaps(L.conditions, R.conditions, (id, value) => ({ id, summary: value?.statement ?? value?.id ?? null }));
  const relations = compareMaps(indexRelations(leftView), indexRelations(rightView), (id, value) => ({ id, value }));
  const declarations = compareMaps(L.declarations, R.declarations, (id, value) => ({ id, summary: value?.name ?? value?.statement ?? value?.id ?? null }));
  const affectedByChange = computeAffectedByChange(leftView, rightView, judgments, L.judgments, R.judgments);
  const left = summarize(leftView), right = summarize(rightView);
  const digestChanges = ['A', 'C', 'E'].filter(letter => left.digests[letter] !== right.digests[letter])
    .map(letter => ({ field: 'digests.' + letter, left: left.digests[letter], right: right.digests[letter] }));
  if (left.ir_digest !== right.ir_digest) digestChanges.push({ field: 'ir_digest', left: left.ir_digest, right: right.ir_digest });
  const sections = [judgments, conditions, relations, declarations];
  const identical = manifestChanged.length === 0 && sections.every(s => !s.added.length && !s.removed.length && !s.changed.length);
  return {
    format: FORMAT,
    left,
    right,
    identical,
    manifest: { changed: manifestChanged },
    digests: { changed: digestChanges },
    judgments,
    conditions,
    relations,
    declarations,
    affected_by_change: affectedByChange,
  };
}

function wrap(text, width, indent) {
  return wrapHuman(text, indent, width);
}

const HUMAN_FULL_LIMIT = 1200;
const DIFF_CONTEXT_WINDOW = 160;

function showFull(value) {
  return typeof value === 'string' ? JSON.stringify(value) : canonicalJson(value);
}

function showSummary(value, verbose = false) {
  const full = showFull(value);
  if (verbose || full.length <= HUMAN_FULL_LIMIT) return full;
  return full.slice(0, HUMAN_FULL_LIMIT - 1) + '…';
}

// Normalize a field value into a clean human-readable representation instead of raw JSON blobs.
function humanizeValue(value) {
  if (value === null || value === undefined) return { kind: 'literal', text: 'none' };
  if (typeof value === 'string') return { kind: 'string', text: value };
  if (isObject(value)) {
    if (typeof value.statement === 'string') {
      const prefix = typeof value.role === 'string' && value.role
        ? `[${value.role}] `
        : typeof value.effect === 'string' && value.effect
          ? `[${value.effect}] `
          : '';
      return { kind: 'string', text: prefix + value.statement };
    }
    if (isObject(value.effect) && value.effect.kind === 'replace_limit' && typeof value.effect.replacement?.statement === 'string') {
      return { kind: 'string', text: `[replace_limit] ${value.effect.replacement.statement}` };
    }
    if (typeof value.name === 'string' && typeof value.kind === 'string') {
      return { kind: 'string', text: `[${value.kind}] ${value.name}` };
    }
  }
  return { kind: 'json', text: canonicalJson(value) };
}

// Focus on the actual changed span with generous surrounding context so tail/middle edits
// in very long texts (> 1200 chars) are never clipped out.
function sliceAroundDiff(leftText, rightText, context = DIFF_CONTEXT_WINDOW) {
  const L = [...leftText], R = [...rightText];
  const minLen = Math.min(L.length, R.length);
  let prefix = 0;
  while (prefix < minLen && L[prefix] === R[prefix]) prefix++;
  let suffix = 0;
  while (suffix < minLen - prefix && L[L.length - 1 - suffix] === R[R.length - 1 - suffix]) suffix++;
  const windowOf = arr => {
    const start = Math.max(0, prefix - context);
    const end = Math.min(arr.length, arr.length - suffix + context);
    return (start > 0 ? '…' : '') + arr.slice(start, end).join('') + (end < arr.length ? '…' : '');
  };
  return [windowOf(L), windowOf(R)];
}

function formatChangePair(leftVal, rightVal, { verbose = false } = {}) {
  if (verbose) return [showFull(leftVal), showFull(rightVal)];
  const L = humanizeValue(leftVal);
  const R = humanizeValue(rightVal);
  if (L.text.length <= HUMAN_FULL_LIMIT && R.text.length <= HUMAN_FULL_LIMIT) {
    return [
      L.kind === 'string' ? JSON.stringify(L.text) : L.text,
      R.kind === 'string' ? JSON.stringify(R.text) : R.text,
    ];
  }
  if (L.kind === R.kind && (L.kind === 'string' || L.kind === 'json')) {
    const [lWin, rWin] = sliceAroundDiff(L.text, R.text);
    return [
      L.kind === 'string' ? JSON.stringify(lWin) : lWin,
      R.kind === 'string' ? JSON.stringify(rWin) : rWin,
    ];
  }
  const renderOne = item => {
    if (item.kind === 'string') return JSON.stringify(item.text);
    if (item.kind === 'json' && item.text.length > HUMAN_FULL_LIMIT) {
      return item.text.slice(0, HUMAN_FULL_LIMIT - 42) + '… (truncated; pass --verbose for full JSON)';
    }
    return item.text;
  };
  return [renderOne(L), renderOne(R)];
}

const INTERNAL_JUDGMENT_FIELD_PATTERNS = [
  /(?:^|\.)id$/,
  /\.material_refs(?:\[\d+\])?$/,
  /\.declared_by$/,
  /\.applies_to(?:\.|$)/,
  /\.exception_refs(?:\[\d+\])?$/,
  /^subject\.actor_ids(?:\[\d+\])?$/,
  /^subject\.statement$/,
  /^result_contract\./,
  /^ports(?:\[\d+\])?\./,
  /^result\.contract_ref$/,
];

function isInternalJudgmentField(fieldPath) {
  return INTERNAL_JUDGMENT_FIELD_PATTERNS.some(re => re.test(String(fieldPath ?? '')));
}

function formatRelationHuman(entry) {
  const value = entry?.value;
  if (entry?.id?.startsWith('relationship|') && isObject(value)) {
    const kind = value.kind?.term ?? value.kind ?? 'relation';
    const parts = Array.isArray(value.participants)
      ? value.participants.map(p => `${p?.role?.term ? p.role.term + ':' : ''}${p?.judgment_ref ?? '?'}`).join(' -> ')
      : entry.id;
    const stmt = typeof value.statement === 'string' && value.statement.trim() ? ` — ${value.statement.trim()}` : '';
    return `[${kind}] ${parts}${stmt}`;
  }
  return entry?.id ?? '(relation)';
}

function assetLabel(side) {
  const asset = side?.asset;
  return asset ? `${asset.asset_id ?? '?'} @ ${asset.asset_version ?? '?'}` : '(unknown asset)';
}

function deduplicateHumanJudgmentFields(fields) {
  if (!Array.isArray(fields)) return [];
  const coreField = fields.find(f => f.path === 'core_expression.statement');
  if (!coreField) return fields;
  return fields.filter(f => {
    if (f.path !== 'result.value.value') return true;
    return canonicalJson(f.left) !== canonicalJson(coreField.left) || canonicalJson(f.right) !== canonicalJson(coreField.right);
  });
}

/**
 * Plain-text rendering of a kdna.diff/1 object; never throws on unknown shapes.
 * By default (`verbose: false`), collapses internal IR reference edge noise and mechanical ID/wiring
 * field churn so authors immediately see substantive judgment changes and downstream impact.
 * Pass `{ verbose: true }` to expand every internal field and IR reference edge losslessly.
 */
function renderDiffHuman(diff, options = {}) {
  const verbose = Boolean(options && options.verbose === true);
  try {
    if (!isObject(diff) || diff.format !== FORMAT) return 'Not a kdna.diff/1 result.\n' + JSON.stringify(diff, null, 2) + '\n';
    const out = [];
    out.push('KDNA diff');
    out.push('  - ' + assetLabel(diff.left));
    out.push('  + ' + assetLabel(diff.right));
    out.push('');
    if (diff.identical) out.push('The two assets are semantically identical (same identity, manifest, judgments, conditions, relations).');
    const changes = diff.manifest?.changed ?? [];
    if (changes.length) {
      out.push('Manifest / identity (' + changes.length + ' changed)');
      for (const change of changes) {
        out.push('  ~ ' + change.field);
        const [leftText, rightText] = formatChangePair(change.left, change.right, { verbose });
        out.push(wrap('- ' + leftText, 100, '      '));
        out.push(wrap('+ ' + rightText, 100, '      '));
      }
      out.push('');
    }
    const sections = [['Judgments', 'judgments'], ['Conditions', 'conditions'], ['Relations', 'relations'], ['Other declarations', 'declarations']];
    const totals = [];
    for (const [title, key] of sections) {
      const s = diff[key];
      if (!s) continue;
      const added = s.added ?? [], removed = s.removed ?? [], changed = s.changed ?? [];
      totals.push(`${title.toLowerCase()}: +${added.length} -${removed.length} ~${changed.length} =${s.unchanged_count ?? 0}`);
      if (!added.length && !removed.length && !changed.length) continue;
      out.push(`${title} (+${added.length} -${removed.length} ~${changed.length}, ${s.unchanged_count ?? 0} unchanged)`);
      if (key === 'relations' && !verbose) {
        const isRef = entry => typeof entry?.id === 'string' && entry.id.startsWith('reference|');
        const authoredRemoved = removed.filter(e => !isRef(e));
        const authoredAdded = added.filter(e => !isRef(e));
        const authoredChanged = changed.filter(e => !isRef(e));
        const hiddenRefCount = (removed.length - authoredRemoved.length) + (added.length - authoredAdded.length) + (changed.length - authoredChanged.length);
        for (const entry of authoredRemoved) out.push(wrap('- ' + formatRelationHuman(entry), 100, '  '));
        for (const entry of authoredAdded) out.push(wrap('+ ' + formatRelationHuman(entry), 100, '  '));
        for (const entry of authoredChanged) {
          out.push('  ~ ' + entry.id);
          for (const field of (entry.fields ?? [])) {
            out.push('      ' + field.path);
            const [leftText, rightText] = formatChangePair(field.left, field.right, { verbose });
            out.push(wrap('- ' + leftText, 100, '        '));
            out.push(wrap('+ ' + rightText, 100, '        '));
          }
        }
        if (hiddenRefCount > 0) {
          out.push(`  (${hiddenRefCount} internal IR reference edge change${hiddenRefCount === 1 ? '' : 's'} hidden; pass --verbose to show)`);
        }
        out.push('');
        continue;
      }
      for (const entry of removed) out.push('  - ' + entry.id + (entry.focus ? '  ' + entry.focus : entry.summary ? '  ' + showSummary(entry.summary, verbose) : ''));
      for (const entry of added) out.push('  + ' + entry.id + (entry.focus ? '  ' + entry.focus : entry.summary ? '  ' + showSummary(entry.summary, verbose) : ''));
      for (const entry of changed) {
        out.push('  ~ ' + entry.id);
        const deduped = key === 'judgments' ? deduplicateHumanJudgmentFields(entry.fields) : (entry.fields ?? []);
        let visibleFields = deduped;
        let hiddenInternal = 0;
        if (key === 'judgments' && !verbose) {
          visibleFields = deduped.filter(f => !isInternalJudgmentField(f.path));
          hiddenInternal = deduped.length - visibleFields.length;
          // Never hide everything if only internal fields changed.
          if (visibleFields.length === 0 && deduped.length > 0) {
            visibleFields = deduped;
            hiddenInternal = 0;
          }
        }
        for (const field of visibleFields) {
          out.push('      ' + field.path);
          const [leftText, rightText] = formatChangePair(field.left, field.right, { verbose });
          out.push(wrap('- ' + leftText, 100, '        '));
          out.push(wrap('+ ' + rightText, 100, '        '));
        }
        if (hiddenInternal > 0) {
          out.push(`      (+${hiddenInternal} internal ID/wiring field change${hiddenInternal === 1 ? '' : 's'} hidden; pass --verbose to inspect)`);
        }
      }
      out.push('');
      if (key === 'judgments' && Array.isArray(diff.affected_by_change) && diff.affected_by_change.length > 0) {
        out.push(`Affected related judgments (${diff.affected_by_change.length} downstream to review)`);
        for (const item of diff.affected_by_change) {
          const causes = (item.affected_by ?? []).map(c => `${c.kind} from ${c.judgment_id}`).join(', ');
          const label = `${item.judgment_id}${item.focus ? ' — ' + item.focus : ''} (${causes})`;
          out.push(wrap('! ' + label, 100, '  '));
        }
        out.push('');
      }
    }
    const digestChanges = diff.digests?.changed ?? [];
    if (digestChanges.length) {
      out.push('Digests differ: ' + digestChanges.map(c => c.field).join(', '));
      out.push('');
    }
    out.push('Summary: ' + totals.join('; '));
    return out.join('\n') + '\n';
  } catch (error) {
    return 'Could not render diff (' + (error?.message ?? 'error') + ').\n' + JSON.stringify(diff, null, 2) + '\n';
  }
}

module.exports = { diffViews, renderDiffHuman, canonicalJson };
