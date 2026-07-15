#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  CORE_CANDIDATE_PACKAGE,
  CORE_CANDIDATE_VERSION,
  readPinnedCoreCommit,
} = require('./core-candidate');

const ROOT = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status)}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function packOnce(packageRoot, destination) {
  const report = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', destination], { cwd: packageRoot }),
  );
  assert.equal(report.length, 1, 'npm pack must report one Core artifact');
  const metadata = report[0];
  const file = path.join(destination, metadata.filename);
  return { bytes: fs.readFileSync(file), file, metadata };
}

function copyCandidateCli(destination) {
  fs.cpSync(ROOT, destination, {
    recursive: true,
    filter(source) {
      const relative = path.relative(ROOT, source);
      if (relative === '') return true;
      const top = relative.split(path.sep)[0];
      return !['.git', '.cross-repo', 'node_modules'].includes(top);
    },
  });
}

function verifyCandidateSource(sourceRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, CORE_CANDIDATE_PACKAGE);
  assert.equal(packageJson.version, CORE_CANDIDATE_VERSION);
  const repository = path.resolve(sourceRoot, '..', '..');
  const head = run('git', ['-C', repository, 'rev-parse', 'HEAD']).trim();
  assert.equal(head, readPinnedCoreCommit(ROOT), 'Core source must match the exact CI commit pin');
  assert.equal(
    run('git', ['-C', repository, 'status', '--porcelain=v1']).trim(),
    '',
    'Core source worktree must be clean',
  );
}

function main() {
  const sourceRoot = process.env.KDNA_CORE_SOURCE_ROOT;
  if (!sourceRoot) throw new Error('KDNA_CORE_SOURCE_ROOT is required.');
  const absoluteSource = path.resolve(sourceRoot);
  verifyCandidateSource(absoluteSource);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-core-tar-'));
  try {
    const firstDirectory = path.join(temporary, 'first');
    const secondDirectory = path.join(temporary, 'second');
    const cliCopy = path.join(temporary, 'cli');
    const cache = path.join(temporary, 'empty-cache');
    for (const directory of [firstDirectory, secondDirectory, cache]) {
      fs.mkdirSync(directory, { recursive: true });
    }

    const first = packOnce(absoluteSource, firstDirectory);
    const second = packOnce(absoluteSource, secondDirectory);
    assert.ok(first.bytes.equals(second.bytes), 'two Core candidate packs must be byte-identical');
    assert.equal(first.metadata.name, CORE_CANDIDATE_PACKAGE);
    assert.equal(first.metadata.version, CORE_CANDIDATE_VERSION);

    copyCandidateCli(cliCopy);
    run('git', ['init', '--quiet'], { cwd: cliCopy });
    run('git', ['add', '--all'], { cwd: cliCopy });
    const packagePath = path.join(cliCopy, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const localTar = pathToFileURL(first.file).href;
    packageJson.dependencies[CORE_CANDIDATE_PACKAGE] = localTar;
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    assert.deepEqual(fs.readdirSync(cache), [], 'candidate install cache must start empty');
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        cache,
        '--prefer-online',
      ],
      { cwd: cliCopy, stdio: 'inherit' },
    );

    const installed = JSON.parse(
      fs.readFileSync(
        path.join(cliCopy, 'node_modules', '@aikdna', 'kdna-core', 'package.json'),
        'utf8',
      ),
    );
    assert.equal(installed.name, CORE_CANDIDATE_PACKAGE);
    assert.equal(installed.version, CORE_CANDIDATE_VERSION);
    const lock = JSON.parse(fs.readFileSync(path.join(cliCopy, 'package-lock.json'), 'utf8'));
    const locked = lock.packages[`node_modules/${CORE_CANDIDATE_PACKAGE}`];
    const actualIntegrity = `sha512-${crypto.createHash('sha512').update(first.bytes).digest('base64')}`;
    assert.equal(locked.version, CORE_CANDIDATE_VERSION);
    assert.equal(
      locked.integrity,
      actualIntegrity,
      'lock integrity must come from the local tar bytes',
    );
    assert.match(
      locked.resolved,
      /^file:/,
      'candidate lock must identify a local tar, not registry',
    );

    const env = {
      ...process.env,
      KDNA_CORE_CANDIDATE_TAR: '1',
      NO_UPDATE_NOTIFIER: '1',
    };
    for (const name of [
      'KDNA_CORE_SOURCE_ROOT',
      'KDNA_GOLDEN_CORE_ROOT',
      'KDNA_RUNTIME_CONTRACT_CORE_ROOT',
      'NODE_OPTIONS',
    ]) {
      delete env[name];
    }
    run('npm', ['test'], { cwd: cliCopy, env, stdio: 'inherit' });

    console.log(
      `Exact Core candidate tar verified: ${CORE_CANDIDATE_PACKAGE}@${CORE_CANDIDATE_VERSION} ${readPinnedCoreCommit(ROOT).slice(0, 12)}`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`Core candidate tar verification blocked: ${error.message}`);
  process.exitCode = 1;
}
