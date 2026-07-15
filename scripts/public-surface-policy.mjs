export function allowFormalReleaseGitHead(match, context) {
  if (
    context.file !== 'tests/fixtures/core-0.18-release-evidence.json' ||
    !/^\s*"git_head":\s*"[a-f0-9]{40}"\s*,?\s*$/i.test(context.line)
  ) {
    return false;
  }
  const commitHashes = context.text.match(/(?<![a-f0-9])[a-f0-9]{40}(?![a-f0-9])/gi) || [];
  const gitHeadKeys = context.text.match(/"git_head"\s*:/gi) || [];
  if (commitHashes.length !== 1 || gitHeadKeys.length !== 1) return false;
  try {
    const evidence = JSON.parse(context.text);
    return Object.hasOwn(evidence, 'git_head') && evidence.git_head === match[0];
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
