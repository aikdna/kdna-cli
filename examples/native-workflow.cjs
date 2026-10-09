'use strict';

// Teaching recipe for the exact offline host. Source preparation is separate
// from executed admission, useful-task evidence and human acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function collector() {
  let pending = '';
  const rows = [];
  return {
    rows,
    write(text) {
      pending += text;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line) rows.push(JSON.parse(line));
      }
      return true; // Acknowledge only after storing the complete response.
    },
    finish() { assert.equal(pending, '', 'CLI response must end with a newline'); },
  };
}

function ready(row, expected = 'ready') {
  assert.equal(row?.channel, 'read_envelope');
  assert.equal(row.envelope.status, expected);
  return row.envelope;
}

async function main() {
  assert.equal(process.argv.length, 4, 'Usage: node native-workflow.cjs <author.json> <new-output-directory>');
  const authorFile = path.resolve(process.argv[2]);
  const outputDirectory = path.resolve(process.argv[3]);
  const authored = JSON.parse(fs.readFileSync(authorFile, 'utf8'));
  const host = createRequire(path.resolve('package.json'));
  const { run } = host('@aikdna/kdna-cli');
  assert.equal(host('@aikdna/kdna-cli/package.json').version, '0.39.0-rc.native-sections.3');
  fs.mkdirSync(outputDirectory, { mode: 0o700 }); // Existing directory is refused.
  const file = name => path.join(outputDirectory, name);
  const save = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

  async function invoke(name, argv, input) {
    const output = collector();
    const code = await run(argv, output, input);
    output.finish();
    save(name, { exit_code: code, responses: output.rows });
    assert.equal(code, 0, `${name} failed; its complete response is saved`);
    return output.rows;
  }

  const original = file('team-update-1.0.0.kdna');
  const created = (await invoke('create.json', ['create', authorFile, '--output', original, '--allow-create']))[0];
  assert.equal(created.status, 'saved');
  const originalDigest = digest(original);
  assert.equal(created.output.sha256, originalDigest);
  const inspected = (await invoke('inspect.json', ['inspect', original]))[0];
  assert.equal(inspected.status, 'accepted');
  const tuple = inspected.tuple; // Public inspect output; no private package subpath.
  const asset = inspected.asset;
  assert.equal(asset.asset_id, authored.manifest.asset_id);
  assert.equal(asset.asset_version, authored.manifest.version);
  const catalog = (await invoke('catalog.json', ['read', original, '--mode', 'catalog', '--allow-read']))[0];
  ready(catalog, 'catalog_only');

  const selection = { asset_id: asset.asset_id, asset_version: asset.asset_version, judgment_ids: ['update:order'] };
  const request = (mode, selected, handle) => ({
    request_id: 'request:' + randomUUID(), tuple, budget_bytes: 1000000,
    mode, selection: selected, handle,
  });
  const sessionOutput = collector();
  async function* sessionInput() {
    yield JSON.stringify(request('exact_selection', selection, null)) + '\n';
    assert.equal(sessionOutput.rows.length, 1);
    const selected = ready(sessionOutput.rows[0]);
    const handle = selected.content.expansion_handles.find(value =>
      value.target.kind === 'dependency' && value.target.id === 'dependency:update-rationale');
    assert.ok(handle, 'Selection must return the optional rationale handle');
    // Keep its entire object unchanged and its original selection in this run.
    yield JSON.stringify(request('expand', selection, handle)) + '\n';
    assert.equal(sessionOutput.rows.length, 2);
    const expanded = ready(sessionOutput.rows[1]);
    assert.equal(expanded.snapshot_id, selected.snapshot_id);
    assert.ok(expanded.content.closure.some(node => node.role === 'judgment' && node.value.id === 'update:rationale'));
  }
  const sessionCode = await run(['read', original, '--session', '--allow-read'], sessionOutput, sessionInput());
  sessionOutput.finish();
  save('selection-and-expansion.json', { exit_code: sessionCode, responses: sessionOutput.rows });
  assert.equal(sessionCode, 0);

  const expectedA = 'sha256:' + originalDigest;
  const opened = (await invoke('source-open.json', ['source-open', original, '--expected-a', expectedA, '--allow-source']))[0];
  assert.equal(opened.status, 'source_opened');
  const edits = structuredClone(opened.edits); // Complete replacement pair.
  const revisedStatement = 'For my team’s weekly asynchronous update, I prefer a blocker first when it needs a teammate’s decision; otherwise I keep completed changes first, then blockers, then the next concrete action.';
  const judgment = edits.payload.judgments.find(value => value.id === 'update:order');
  assert.ok(judgment);
  judgment.core_expression.statement = revisedStatement;
  judgment.result.value.value = revisedStatement;
  edits.manifest.version = edits.payload.asset.asset_version = '1.0.1';
  edits.manifest.judgment_version = edits.payload.asset.judgment_version = '1.0.1';
  const timestamp = new Date().toISOString();
  edits.manifest.updated_at = timestamp;
  edits.manifest.history.entries.push({
    id: 'history:team-update-format-1.0.1', version: '1.0.1', judgment_version: '1.0.1', at: timestamp,
    summary: 'Scripted example: the author qualifies update order for a blocker needing a decision.',
    affected_refs: [{ kind: 'judgment', id: 'update:order' }], actor_refs: ['actor:sample-team-author'],
  });
  save('source-edits.json', edits);
  const revised = file('team-update-1.0.1.kdna');
  const packed = (await invoke('source-pack.json', ['source-pack', original, '--edits', file('source-edits.json'),
    '--expected-a', expectedA, '--output', revised, '--allow-source']))[0];
  assert.equal(packed.status, 'saved');
  assert.equal(digest(original), originalDigest, 'Original asset must be unchanged');
  assert.equal(digest(revised), packed.output.sha256);
  assert.notEqual(packed.output.sha256, originalDigest);

  const consumed = (await invoke('revised-read.json', ['read', revised, '--mode', 'exact_selection',
    '--asset-id', asset.asset_id, '--asset-version', '1.0.1', '--judgment-id', 'update:order', '--allow-read']))[0];
  const revisedContent = ready(consumed).content;
  const revisedJudgment = revisedContent.closure.find(node => node.role === 'judgment' && node.value.id === 'update:order');
  assert.equal(revisedJudgment?.value.core_expression.statement, revisedStatement);
  const summary = { status: 'example_completed', original_sha256: originalDigest,
    revised_sha256: packed.output.sha256, original_unchanged: true,
    revised_statement: revisedStatement, task_adoption: 'not_observed', human_acceptance: 'not_observed' };
  save('summary.json', summary);
  process.stdout.write(JSON.stringify(summary) + '\n');
}

main().catch(error => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});
