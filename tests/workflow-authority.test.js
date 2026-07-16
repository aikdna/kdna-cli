'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CHECKOUT_SHA,
  CODEQL_SHA,
  CORE_COMMIT,
  STALE_SHA,
  WORKFLOW_AUTHORITIES,
  validateWorkflowSet,
} = require('../scripts/check-workflow-authority');

const ROOT = path.resolve(__dirname, '..');

function sources() {
  return Object.fromEntries(
    WORKFLOW_AUTHORITIES.map(({ path: relative }) => [
      relative,
      fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8'),
    ]),
  );
}

function replaceExact(workflows, relative, before, after) {
  const source = workflows[relative];
  assert.ok(source.includes(before), `hostile fixture source is missing ${JSON.stringify(before)}`);
  return { ...workflows, [relative]: source.replace(before, after) };
}

test('workflow authority binds every current workflow to exact safe bytes', () => {
  const result = validateWorkflowSet(ROOT);
  assert.deepEqual(
    result.map(({ path: relative }) => relative),
    WORKFLOW_AUTHORITIES.map(({ path: relative }) => relative),
  );
});

test('workflow authority rejects hostile semantic mutations before remote execution', async (t) => {
  const base = sources();
  const ci = '.github/workflows/ci.yml';
  const publicSurface = '.github/workflows/public-surface.yml';
  const codeql = '.github/workflows/codeql-js.yml';
  const stale = '.github/workflows/stale.yml';
  const publish = '.github/workflows/publish.yml';
  const cases = [
    [
      'mutable checkout action',
      {
        sources: replaceExact(base, ci, `actions/checkout@${CHECKOUT_SHA}`, 'actions/checkout@v7'),
      },
    ],
    [
      'stale Core commit',
      {
        sources: replaceExact(
          base,
          ci,
          CORE_COMMIT,
          ['a257b92345af57e6fb20', '215576bc976a5291b297'].join(''),
        ),
      },
    ],
    [
      'paths-ignore trigger',
      {
        sources: replaceExact(
          base,
          ci,
          'on: [pull_request, push]\n',
          'on: [pull_request, push]\npaths-ignore:\n  - docs/**\n',
        ),
      },
    ],
    [
      'continue-on-error escape',
      {
        sources: replaceExact(
          base,
          ci,
          '    timeout-minutes: 20\n',
          '    timeout-minutes: 20\n    continue-on-error: true\n',
        ),
      },
    ],
    [
      'extra CI job',
      {
        sources: replaceExact(
          base,
          ci,
          '  golden-host-request:\n',
          '  bypass:\n    runs-on: ubuntu-latest\n    steps: []\n  golden-host-request:\n',
        ),
      },
    ],
    [
      'missing read-only permission',
      { sources: replaceExact(base, ci, 'permissions:\n  contents: read\n\n', '') },
    ],
    ['missing timeout', { sources: replaceExact(base, ci, '    timeout-minutes: 20\n', '') }],
    [
      'weakened Node 18 coordinate',
      {
        sources: replaceExact(base, ci, "node: ['18.20.8', '22.23.1']", "node: ['18', '22.23.1']"),
      },
    ],
    [
      'mutable CodeQL action',
      {
        sources: replaceExact(
          base,
          codeql,
          `github/codeql-action/init@${CODEQL_SHA}`,
          'github/codeql-action/init@v4',
        ),
      },
    ],
    [
      'public workflow skips its authority gate',
      {
        sources: replaceExact(
          base,
          publicSurface,
          '      - name: Enforce exact workflow authority\n        run: node scripts/check-workflow-authority.js\n',
          '',
        ),
      },
    ],
    [
      'unaudited workflow file',
      {
        sources: base,
        workflowPaths: [
          ...WORKFLOW_AUTHORITIES.map(({ path: relative }) => relative),
          '.github/workflows/bypass.yml',
        ].sort(),
      },
    ],
    [
      'mutable stale action',
      {
        sources: replaceExact(base, stale, `actions/stale@${STALE_SHA}`, 'actions/stale@v10'),
      },
    ],
    [
      'stale workflow loses issue permission',
      { sources: replaceExact(base, stale, '  issues: write\n', '') },
    ],
    [
      'stale workflow loses timeout',
      { sources: replaceExact(base, stale, '    timeout-minutes: 10\n', '') },
    ],
    [
      'publish workflow gains manual dispatch',
      {
        sources: replaceExact(
          base,
          publish,
          'on:\n  release:\n',
          'on:\n  workflow_dispatch:\n  release:\n',
        ),
      },
    ],
    [
      'publish workflow loses timeout',
      { sources: replaceExact(base, publish, '    timeout-minutes: 30\n', '') },
    ],
    [
      'publish workflow weakens Node coordinate',
      { sources: replaceExact(base, publish, "node-version: '22.23.1'", 'node-version: 22') },
    ],
    [
      'publish workflow permits latest Node lookup',
      { sources: replaceExact(base, publish, '          check-latest: false\n', '') },
    ],
  ];

  for (const [name, options] of cases) {
    await t.test(name, () =>
      assert.throws(() => validateWorkflowSet(ROOT, { ...options, enforceHashes: false })),
    );
  }
});

test('workflow authority rejects byte drift even when semantics remain unchanged', () => {
  const base = sources();
  const ci = '.github/workflows/ci.yml';
  const drifted = { ...base, [ci]: `${base[ci]}\n` };
  assert.throws(() => validateWorkflowSet(ROOT, { sources: drifted }), /exact bytes drifted/);
});
