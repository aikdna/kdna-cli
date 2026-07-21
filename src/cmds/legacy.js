const { error } = require('./_common');

function cmdPreview() {
  // Removed in v0.9 — no real user scenario for browser preview.
  // To inspect a .kdna file, use: kdna inspect <file.kdna>
  error(
    'kdna preview was removed in v0.9.\n' + 'Use: kdna inspect <file.kdna> to view a .kdna asset.',
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
  // Removed in v0.9. Evaluation is not a Runtime CLI validity gate.
  error(
    'kdna eval was removed in v0.9.\n' +
      'To inspect and exercise an asset, use:\n' +
      '  kdna validate <file.kdna>\n' +
      '  kdna plan-load <file.kdna>\n' +
      '  kdna load <file.kdna> --profile=compact --as=json',
  );
}

function cmdSelect() {
  // Removed in v0.9 — replaced by the agent-facing kdna-loader skill.
  // The skill discovers KDNA via 'kdna available' and decides fit
  // using optional applies_when fields. The agent makes the selection.
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
      'Use: kdna pack <source-dir> <output.kdna>',
  );
}

function cmdDemo() {
  error(
    'kdna demo was removed in v0.9.\n' +
      'To create a current local example, use:\n' +
      '  kdna demo judgment <output-dir>',
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
