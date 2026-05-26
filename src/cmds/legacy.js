const { error } = require('./_common');

function cmdPreview() {
  // Removed in v0.9 — no real user scenario for browser preview.
  // To inspect a .kdna file, use: kdna inspect <file.kdna>
  error(
    'kdna preview was removed in v0.9.\n' +
      'Use: kdna inspect <file.kdna> to view a .kdna asset.',
  );
}

function cmdProject() {
  // Removed in v0.9 — project-level .kdna/config.json violated the
  // "install ≠ load" safety model. KDNA loading is now a per-task
  // decision made by the agent (via kdna-loader skill), not a
  // project-level whitelist.
  error(
    'kdna project was removed in v0.9. The .kdna/config.json file is no\n' +
      'longer read by the kdna-loader skill — it would have forced KDNA\n' +
      'loading on tasks where the user did not ask for it.\n\n' +
      'The agent now discovers KDNA on demand through kdna available/load,\n' +
      'which read installed .kdna assets from the package index.\n\n' +
      'If you have stale .kdna/config.json files in your projects, you\n' +
      'can delete them — nothing reads them anymore.',
  );
}

function cmdEval() {
  // Removed in v0.9 — overlapped with kdna compare without adding
  // distinct value, and the agent-facing match/load commands cover
  // the discovery path.
  error(
    'kdna eval was removed in v0.9.\n' +
      'To compare with/without KDNA reasoning, use:\n' +
      '  kdna compare <name|file.kdna> --input "<task>"\n' +
      'To inspect a domain, use:\n' +
      '  kdna info <name>',
  );
}

function cmdSelect() {
  // Removed in v0.9 — replaced by the agent-facing kdna-loader skill.
  // The skill discovers KDNA via 'kdna available' and decides fit
  // using v2.1 applies_when fields. The agent makes the selection.
  error(
    'kdna select was removed in v0.9.\n' +
      'KDNA selection is now done by the kdna-loader skill (installed\n' +
      'into your agent at ~/.claude/skills/kdna-loader/ etc.).\n\n' +
      'To inspect what an agent would see, use:\n' +
      '  kdna available --json\n' +
      '  kdna match "<task>" --json',
  );
}

function cmdExport() {
  // Removed in v0.9 — was an alias for the old top-level pack command.
  error(
    'kdna export was removed in v0.9 (it was an alias for pack).\n' +
      'Use: kdna dev pack <source-dir> [--output <dir>]',
  );
}

function cmdDemo() {
  // Removed in v0.9 — internal demo, not a user feature. To see
  // before/after on a real input, use:
  //   kdna compare <name|file.kdna> --input "<task>"   (requires LLM API key)
  error(
    'kdna demo was removed in v0.9.\n' +
      'To see KDNA before/after on a real input, use:\n' +
      '  kdna compare @aikdna/writing --input "<your task>"\n' +
      '(requires ANTHROPIC_API_KEY, OPENAI_API_KEY, or an OpenAI-compatible\n' +
      'endpoint in ~/.kdna/config.json)',
  );
}

module.exports = {
  cmdPreview,
  cmdProject,
  cmdEval,
  cmdSelect,
  cmdExport,
  cmdDemo,
};
