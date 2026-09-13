#!/usr/bin/env node
'use strict';
/*
 * Required check-context gate.
 *
 * Why it exists: this repository's release branch requires a fixed set of
 * status contexts before a pull request can merge. A workflow edit that
 * removes a job, or drops one value out of a matrix, silently deletes a
 * required context: the pull request then waits forever for a check that will
 * never be reported, and no test in the repository notices. That already
 * happened here once, when the CI workflow was reduced to a single job.
 *
 * What it does: reads the workflow files, derives the exact status-context
 * names they can report (job id or job `name`, plus the matrix expansion), and
 * fails if any required context is no longer producible.
 *
 * It parses only the structure it needs and fails closed on anything it cannot
 * read, so a malformed workflow cannot pass by being unparseable.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

// The contexts this repository must be able to report. Keep in step with the
// release branch's required status checks.
const REQUIRED_CONTEXTS = Object.freeze([
  'test',
  'check',
  'golden-host-request',
  'runtime-contract (ubuntu-latest, 22.23.1)',
  'runtime-contract (windows-latest, 22.23.1)',
  'runtime-contract (ubuntu-latest, 24.18.0)',
  'runtime-contract (windows-latest, 24.18.0)',
  'Analyze (javascript-typescript) (javascript-typescript)',
]);

function fail(message) {
  console.error(`required-contexts: FAIL ${message}`);
  process.exitCode = 1;
}

function indentation(line) {
  return line.length - line.replace(/^\s*/, '').length;
}

function scalar(raw) {
  return raw.trim().replace(/^['"]/, '').replace(/['"]$/, '');
}

// `[a, 'b']` -> ['a', 'b']; a YAML block list under the key is read separately.
function inlineList(raw) {
  const inner = raw.trim();
  if (!inner.startsWith('[') || !inner.endsWith(']')) return null;
  return inner
    .slice(1, -1)
    .split(',')
    .map((entry) => scalar(entry))
    .filter((entry) => entry !== '');
}

function blockList(lines, index, keyIndent) {
  const items = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentation(line) <= keyIndent) break;
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!match) break;
    items.push(scalar(match[1]));
  }
  return items;
}

// Returns { jobs: { id: { name, matrixKeys, matrixValues } } } for one file.
function parseWorkflow(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt < 0) throw new Error(`${path.basename(file)} has no top-level jobs: mapping`);
  const jobs = {};
  let current = null;
  let matrixAt = null;
  let matrixKeys = [];

  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentation(line) === 0) break; // end of the jobs mapping
    const jobMatch = /^ {2}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (jobMatch) {
      current = jobMatch[1];
      jobs[current] = { name: null, matrixKeys: [], matrixValues: {} };
      matrixAt = null;
      matrixKeys = [];
      continue;
    }
    if (!current) continue;
    const nameMatch = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch) {
      jobs[current].name = scalar(nameMatch[1]);
      continue;
    }
    if (/^ {6}matrix:\s*$/.test(line)) {
      matrixAt = index;
      matrixKeys = [];
      continue;
    }
    if (matrixAt !== null) {
      const keyMatch = /^ {8}([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(line);
      if (keyMatch) {
        const key = keyMatch[1];
        const values = inlineList(keyMatch[2]) ?? blockList(lines, index, 8);
        if (values.length === 0) throw new Error(`${current}.matrix.${key} has no readable values`);
        matrixKeys.push(key);
        jobs[current].matrixValues[key] = values;
        continue;
      }
      if (indentation(line) <= 6 && line.trim() !== '') matrixAt = null;
    }
    if (jobs[current]) jobs[current].matrixKeys = matrixKeys;
  }
  for (const job of Object.values(jobs)) {
    if (job.matrixKeys.length === 0) job.matrixKeys = [];
  }
  return jobs;
}

function combinations(keys, values, prefix = [], out = []) {
  if (keys.length === 0) {
    out.push(prefix);
    return out;
  }
  const [head, ...rest] = keys;
  for (const value of values[head]) combinations(rest, values, [...prefix, value], out);
  return out;
}

function contextsFor(id, job) {
  const base = (job.name || id).replace(/\$\{\{\s*matrix\.([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    const declared = job.matrixValues[key];
    if (!declared || declared.length !== 1) {
      throw new Error(`${id}.name interpolates matrix.${key}, which is not a single-valued matrix`);
    }
    return declared[0];
  });
  if (job.matrixKeys.length === 0) return [base];
  return combinations(job.matrixKeys, job.matrixValues).map(
    (values) => `${base} (${values.join(', ')})`,
  );
}

function main() {
  if (!fs.existsSync(WORKFLOW_DIR)) throw new Error('no .github/workflows directory');
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
  if (files.length === 0) throw new Error('no workflow files found');

  const producible = new Map();
  for (const name of files) {
    const jobs = parseWorkflow(path.join(WORKFLOW_DIR, name));
    for (const [id, job] of Object.entries(jobs)) {
      for (const context of contextsFor(id, job)) {
        if (!producible.has(context)) producible.set(context, []);
        producible.get(context).push(`${name}#${id}`);
      }
    }
  }

  const missing = REQUIRED_CONTEXTS.filter((context) => !producible.has(context));
  for (const context of REQUIRED_CONTEXTS) {
    const sources = producible.get(context);
    console.log(`  ${sources ? 'OK  ' : 'MISS'} ${context}${sources ? `  <- ${sources.join(', ')}` : ''}`);
  }
  console.log(`required-contexts: workflows=${files.length} producible=${producible.size} required=${REQUIRED_CONTEXTS.length}`);
  if (missing.length > 0) {
    fail(`${missing.length} required context(s) cannot be produced: ${missing.join(' | ')}`);
    return;
  }
  console.log('required-contexts: MATCH every required context is producible');
}

try {
  main();
} catch (error) {
  fail(error.message);
}
