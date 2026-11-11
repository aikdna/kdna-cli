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
  const left = summarize(leftView), right = summarize(rightView);
  const digestChanges = ['A', 'C', 'E'].filter(letter => left.digests[letter] !== right.digests[letter])
    .map(letter => ({ field: 'digests.' + letter, left: left.digests[letter], right: right.digests[letter] }));
  if (left.ir_digest !== right.ir_digest) digestChanges.push({ field: 'ir_digest', left: left.ir_digest, right: right.ir_digest });
  const sections = [judgments, conditions, relations, declarations];
  const identical = manifestChanged.length === 0 && sections.every(s => !s.added.length && !s.removed.length && !s.changed.length);
  return { format: FORMAT, left, right, identical, manifest: { changed: manifestChanged }, digests: { changed: digestChanges }, judgments, conditions, relations, declarations };
}

function wrap(text, width, indent) {
  return wrapHuman(text, indent, width);
}

function show(value) {
  const text = typeof value === 'string' ? JSON.stringify(value) : canonicalJson(value);
  return text.length > 300 ? text.slice(0, 297) + '...' : text;
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

/** Plain-text rendering of a kdna.diff/1 object; never throws on unknown shapes. */
function renderDiffHuman(diff) {
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
        out.push(wrap('- ' + show(change.left), 100, '      '));
        out.push(wrap('+ ' + show(change.right), 100, '      '));
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
      for (const entry of removed) out.push('  - ' + entry.id + (entry.focus ? '  ' + entry.focus : ''));
      for (const entry of added) out.push('  + ' + entry.id + (entry.focus ? '  ' + entry.focus : ''));
      for (const entry of changed) {
        out.push('  ~ ' + entry.id);
        const visibleFields = key === 'judgments' ? deduplicateHumanJudgmentFields(entry.fields) : (entry.fields ?? []);
        for (const field of visibleFields) {
          out.push('      ' + field.path);
          out.push(wrap('- ' + show(field.left), 100, '        '));
          out.push(wrap('+ ' + show(field.right), 100, '        '));
        }
      }
      out.push('');
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
