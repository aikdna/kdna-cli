'use strict';

function mapChanges(oldMap = {}, newMap = {}) {
  const oldIds = new Set(Object.keys(oldMap));
  const newIds = new Set(Object.keys(newMap));
  const added = [...newIds].filter((id) => !oldIds.has(id));
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  const changed = [...newIds].filter(
    (id) => oldIds.has(id) && JSON.stringify(oldMap[id]) !== JSON.stringify(newMap[id]),
  );

  const changedDetails = changed.map((id) => {
    const before = oldMap[id];
    const after = newMap[id];
    const boundaryChanges = {};
    for (const field of ['applies_when', 'does_not_apply_when', 'failure_risk', 'confidence']) {
      const oldValue = before[field] ?? null;
      const newValue = after[field] ?? null;
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        boundaryChanges[field] = { before: oldValue, after: newValue };
      }
    }
    return { id, before, after, boundary_changes: boundaryChanges };
  });

  return { added, removed, changed, changedDetails };
}

function listChanges(oldList = [], newList = []) {
  const oldSet = new Set(oldList);
  const newSet = new Set(newList);
  return {
    added: newList.filter((value) => !oldSet.has(value)),
    removed: oldList.filter((value) => !newSet.has(value)),
    changed: [],
  };
}

function judgmentChanges(oldJudgment, newJudgment) {
  return {
    axioms: mapChanges(oldJudgment.axioms, newJudgment.axioms),
    ontology: mapChanges(oldJudgment.ontology, newJudgment.ontology),
    misunderstandings: mapChanges(oldJudgment.misunderstandings, newJudgment.misunderstandings),
    banned_terms: mapChanges(oldJudgment.banned_terms, newJudgment.banned_terms),
    stances: listChanges(oldJudgment.stances, newJudgment.stances),
  };
}

function recommendedVersionBump(changes) {
  const sections = Object.values(changes || {});
  if (sections.some((section) => (section?.removed?.length || 0) > 0)) return 'major';
  if (
    sections.some(
      (section) => (section?.added?.length || 0) > 0 || (section?.changed?.length || 0) > 0,
    )
  ) {
    return 'minor';
  }
  return 'none';
}

function jsonChanges(changes) {
  return Object.fromEntries(
    Object.entries(changes).map(([name, section]) => [
      name,
      {
        added: section.added,
        removed: section.removed,
        changed: section.changed,
        ...(section.changedDetails
          ? {
              changed_details: section.changedDetails.map((detail) => ({
                id: detail.id,
                before: detail.before,
                after: detail.after,
                boundary_changes: detail.boundary_changes,
              })),
            }
          : {}),
      },
    ]),
  );
}

module.exports = {
  judgmentChanges,
  jsonChanges,
  listChanges,
  mapChanges,
  recommendedVersionBump,
};
