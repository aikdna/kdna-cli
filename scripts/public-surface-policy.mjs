const EVIDENCE_PATH = 'tests/fixtures/core-0.19-candidate-evidence.json';
const FULL_HASH = /^[a-f0-9]{40}$/i;

export function allowFormalReleaseHash(match, context) {
  if (
    context.file !== EVIDENCE_PATH ||
    !/^\s*"(?:git_head|sha1)":\s*"[a-f0-9]{40}"\s*,?\s*$/i.test(context.line)
  ) {
    return false;
  }
  const hashes = context.text.match(/(?<![a-f0-9])[a-f0-9]{40}(?![a-f0-9])/gi) || [];
  const gitHeadKeys = context.text.match(/"git_head"\s*:/gi) || [];
  const sha1Keys = context.text.match(/"sha1"\s*:/gi) || [];
  if (hashes.length !== 2 || gitHeadKeys.length !== 1 || sha1Keys.length !== 1) return false;
  try {
    const evidence = JSON.parse(context.text);
    if (
      !Object.hasOwn(evidence, 'git_head') ||
      !Object.hasOwn(evidence, 'pack') ||
      !FULL_HASH.test(evidence.git_head || '') ||
      !FULL_HASH.test(evidence.pack?.sha1 || '')
    ) {
      return false;
    }
    const allowed = new Set([evidence.git_head.toLowerCase(), evidence.pack.sha1.toLowerCase()]);
    if (allowed.size !== 2 || hashes.some((hash) => !allowed.has(hash.toLowerCase()))) return false;
    const field = context.line.match(/^\s*"(git_head|sha1)"/i)?.[1]?.toLowerCase();
    return (
      (field === 'git_head' && evidence.git_head === match[0]) ||
      (field === 'sha1' && evidence.pack.sha1 === match[0])
    );
  } catch {
    return false;
  }
}

export function isRulePathExcluded(file, rule) {
  return (
    (rule.excludeExactPaths || []).includes(file) ||
    (rule.excludePathPrefixes || []).some((prefix) => file.startsWith(prefix))
  );
}
