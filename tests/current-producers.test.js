'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('@aikdna/kdna-core');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-current-producers-'));
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test('shipped authoring templates preserve docs/evals and compile to current-Core sources', () => {
  for (const name of ['minimal-domain', 'standard-domain']) {
    const original = path.resolve(__dirname, '..', 'templates', name);
    const projectRoot = path.join(root, `template-${name}`);
    fs.cpSync(original, projectRoot, { recursive: true });
    assert.equal(fs.existsSync(path.join(projectRoot, 'README.md')), true);
    if (name === 'standard-domain') {
      assert.equal(fs.existsSync(path.join(projectRoot, 'USAGE.md')), true);
      assert.equal(fs.readdirSync(path.join(projectRoot, 'evals')).length, 5);
    } else {
      assert.equal(fs.existsSync(path.join(projectRoot, 'tests', 'before-after.json')), true);
    }
    for (const cardFile of fs.readdirSync(path.join(projectRoot, 'cards'))) {
      const cardPath = path.join(projectRoot, 'cards', cardFile);
      const cards = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
      for (const card of cards) card.locked = true;
      fs.writeFileSync(cardPath, `${JSON.stringify(cards, null, 2)}\n`);
    }
    run(['studio', 'compile', path.join(projectRoot, 'studio.project.json')]);
    const source = path.join(projectRoot, 'exports');
    const validation = core.validate(source);
    assert.equal(validation.overall_valid, true, validation.problems.join('\n'));
    assert.deepEqual(fs.readdirSync(source).sort(), [
      'checksums.json',
      'kdna.json',
      'mimetype',
      'payload.kdnab',
    ]);
  }
});

test('Studio compiles cards to one current asset source and Core packs it', () => {
  run(['studio', 'scaffold', 'studio-smoke', '--minimal']);
  const projectRoot = path.join(root, 'studio-smoke');
  const projectPath = path.join(projectRoot, 'studio.project.json');
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  Object.assign(project, {
    description: 'Review deployment decisions.',
    highest_question: 'Should this deployment proceed?',
    worldview: ['Reversible evidence should precede irreversible action.'],
    value_order: ['safety', 'clarity'],
    judgment_role: {
      acts_as: 'deployment reviewer',
      does_not_act_as: ['operator'],
      responsibility: 'surface qualitative risk',
    },
  });
  fs.writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
  for (const cardType of ['axioms', 'self_checks']) {
    const cardPath = path.join(projectRoot, 'cards', `${cardType}.json`);
    const cards = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    for (const card of cards) card.locked = true;
    fs.writeFileSync(cardPath, `${JSON.stringify(cards, null, 2)}\n`);
  }

  run(['studio', 'compile', projectPath]);
  const source = path.join(projectRoot, 'exports');
  const validation = core.validate(source);
  assert.equal(validation.overall_valid, true, validation.problems.join('\n'));
  assert.deepEqual(fs.readdirSync(source).sort(), [
    'checksums.json',
    'kdna.json',
    'mimetype',
    'payload.kdnab',
  ]);
  const packed = path.join(root, 'studio-smoke.kdna');
  run(['pack', source, packed]);
  assert.equal(core.validate(packed).overall_valid, true);
});

test('domain pack converts authoring JSON through current Core without mutating the source', () => {
  const authoring = path.join(root, 'domain-authoring');
  const output = path.join(root, 'domain-output');
  fs.mkdirSync(authoring);
  fs.mkdirSync(output);
  fs.writeFileSync(
    path.join(authoring, 'KDNA_Core.json'),
    JSON.stringify({
      meta: {
        domain: 'domain-smoke',
        version: '0.1.0',
        purpose: 'Should this decision proceed?',
        created: '2026-01-01',
      },
      axioms: [],
      boundaries: [],
    }),
  );
  fs.writeFileSync(
    path.join(authoring, 'KDNA_Patterns.json'),
    JSON.stringify({ misunderstandings: [], self_check: [] }),
  );

  run(['domain', 'pack', authoring, output]);
  assert.equal(fs.existsSync(path.join(authoring, 'kdna.json')), false);
  const asset = path.join(output, 'domain-smoke.kdna');
  const validation = core.validate(asset);
  assert.equal(validation.overall_valid, true, validation.problems.join('\n'));
});

test('standalone validators fail closed on malformed current input', () => {
  const invalid = path.join(root, 'invalid');
  fs.mkdirSync(invalid);
  fs.writeFileSync(path.join(invalid, 'kdna.json'), '{');
  for (const validator of ['kdna-validate.js', 'kdna-lint.js']) {
    const result = spawnSync(process.execPath, [path.resolve('validators', validator), invalid], {
      encoding: 'utf8',
      env: process.env,
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /valid\b/iu);
  }
});
