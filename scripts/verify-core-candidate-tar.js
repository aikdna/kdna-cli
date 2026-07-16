#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CORE_CANDIDATE_PACKAGE,
  CORE_CANDIDATE_VERSION,
  readPinnedCoreCommit,
} = require('./core-candidate');
const {
  resolveTrustedNpmInvocation,
  verifyCandidateBinding,
} = require('./runtime-candidate-binding');
const {
  assertCoreSourceAuthorityUnchanged,
  coreSourcePackArguments,
  inspectCoreSourceAuthority,
  materializeCoreCommitPackage,
} = require('./core-source-authority');
const { initializeTrustedGitFixture, runTrustedGit } = require('./trusted-git');

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

function packOnce(packageRoot, destination, npm) {
  const report = JSON.parse(
    run(npm.command, [...npm.prefixArgs, ...coreSourcePackArguments(destination)], {
      cwd: packageRoot,
    }),
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
  const authority = inspectCoreSourceAuthority(sourceRoot, readPinnedCoreCommit(ROOT));
  const packageJson = authority.packageJson;
  assert.equal(packageJson.name, CORE_CANDIDATE_PACKAGE);
  assert.equal(packageJson.version, CORE_CANDIDATE_VERSION);
  return authority;
}

function verifyLifecycleScriptsAreDisabled(temporary, npm) {
  const hostilePackage = path.join(temporary, 'hostile-lifecycle-package');
  const destination = path.join(temporary, 'hostile-lifecycle-output');
  const marker = path.join(temporary, 'prepack-marker');
  fs.mkdirSync(hostilePackage);
  fs.mkdirSync(destination);
  fs.writeFileSync(
    path.join(hostilePackage, 'package.json'),
    `${JSON.stringify(
      {
        name: 'kdna-hostile-lifecycle-check',
        version: '1.0.0',
        scripts: { prepack: 'node prepack.js' },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(hostilePackage, 'prepack.js'),
    `'use strict';\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`,
  );
  packOnce(hostilePackage, destination, npm);
  assert.equal(
    fs.existsSync(marker),
    false,
    'npm pack must never execute package lifecycle scripts',
  );
}

function createNpmPathShadow(temporary) {
  const shadow = path.join(temporary, 'hostile-path');
  const marker = path.join(temporary, 'path-npm-marker');
  fs.mkdirSync(shadow);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(shadow, 'npm.cmd'),
      `@echo off\r\n>"${marker}" echo executed\r\nexit /b 0\r\n`,
    );
  } else {
    const executable = path.join(shadow, 'npm');
    fs.writeFileSync(executable, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`);
    fs.chmodSync(executable, 0o755);
  }
  return { marker, shadow };
}

function main() {
  const sourceRoot = process.env.KDNA_CORE_SOURCE_ROOT;
  if (!sourceRoot) throw new Error('KDNA_CORE_SOURCE_ROOT is required.');
  const absoluteSource = path.resolve(sourceRoot);
  const sourceAuthority = verifyCandidateSource(absoluteSource);
  const npm = resolveTrustedNpmInvocation(ROOT);

  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-core-tar-')));
  try {
    verifyLifecycleScriptsAreDisabled(temporary, npm);
    const firstDirectory = path.join(temporary, 'first');
    const secondDirectory = path.join(temporary, 'second');
    const cliCopy = path.join(temporary, 'cli');
    const cache = path.join(temporary, 'empty-cache');
    const isolatedSource = path.join(temporary, 'core-commit-package');
    for (const directory of [firstDirectory, secondDirectory, cache, isolatedSource]) {
      fs.mkdirSync(directory, { recursive: true });
    }

    materializeCoreCommitPackage(sourceAuthority, isolatedSource);
    const first = packOnce(isolatedSource, firstDirectory, npm);
    const second = packOnce(isolatedSource, secondDirectory, npm);
    assertCoreSourceAuthorityUnchanged(sourceAuthority, verifyCandidateSource(absoluteSource));
    assert.ok(first.bytes.equals(second.bytes), 'two Core candidate packs must be byte-identical');
    assert.equal(first.metadata.name, CORE_CANDIDATE_PACKAGE);
    assert.equal(first.metadata.version, CORE_CANDIDATE_VERSION);
    const binding = verifyCandidateBinding(ROOT);
    const entry = binding.packages.find(({ name }) => name === CORE_CANDIDATE_PACKAGE);
    assert.ok(entry, 'Core candidate binding is missing');
    assert.ok(
      first.bytes.equals(fs.readFileSync(path.join(ROOT, entry.artifact))),
      'checked-in Core candidate bytes must equal the exact reproducible source pack',
    );

    copyCandidateCli(cliCopy);
    initializeTrustedGitFixture(cliCopy);
    runTrustedGit(cliCopy, ['add', '--all']);
    const packagePath = path.join(cliCopy, 'package.json');
    const lockPath = path.join(cliCopy, 'package-lock.json');
    const packageBefore = fs.readFileSync(packagePath);
    const lockBefore = fs.readFileSync(lockPath);

    assert.deepEqual(fs.readdirSync(cache), [], 'candidate install cache must start empty');
    run(
      npm.command,
      [
        ...npm.prefixArgs,
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        cache,
        '--prefer-online',
      ],
      { cwd: cliCopy, stdio: 'inherit' },
    );
    assert.ok(
      packageBefore.equals(fs.readFileSync(packagePath)),
      'npm ci must not rewrite the formal Core dependency',
    );
    assert.ok(lockBefore.equals(fs.readFileSync(lockPath)), 'npm ci must not rewrite the lockfile');

    const installed = JSON.parse(
      fs.readFileSync(
        path.join(cliCopy, 'node_modules', '@aikdna', 'kdna-core', 'package.json'),
        'utf8',
      ),
    );
    assert.equal(installed.name, CORE_CANDIDATE_PACKAGE);
    assert.equal(installed.version, CORE_CANDIDATE_VERSION);
    const lock = JSON.parse(fs.readFileSync(path.join(cliCopy, 'package-lock.json'), 'utf8'));
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const locked = lock.packages[`node_modules/${CORE_CANDIDATE_PACKAGE}`];
    const actualIntegrity = `sha512-${crypto.createHash('sha512').update(first.bytes).digest('base64')}`;
    assert.equal(packageJson.dependencies[CORE_CANDIDATE_PACKAGE], CORE_CANDIDATE_VERSION);
    assert.equal(lock.packages[''].dependencies[CORE_CANDIDATE_PACKAGE], CORE_CANDIDATE_VERSION);
    assert.equal(locked.version, CORE_CANDIDATE_VERSION);
    assert.equal(
      locked.integrity,
      actualIntegrity,
      'lock integrity must come from the local tar bytes',
    );
    assert.equal(
      locked.resolved,
      `file:${entry.artifact}`,
      'candidate lock must identify the checked-in local tar',
    );

    const env = {
      ...process.env,
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
    const npmShadow = createNpmPathShadow(temporary);
    env.PATH = `${npmShadow.shadow}${path.delimiter}${env.PATH || ''}`;
    run(process.execPath, ['scripts/run-complete-suite.js', '--complete'], {
      cwd: cliCopy,
      env,
      stdio: 'inherit',
    });
    assert.equal(
      fs.existsSync(npmShadow.marker),
      false,
      'complete candidate test suite must not resolve npm through PATH',
    );

    console.log(
      `Exact Core candidate tar verified: ${CORE_CANDIDATE_PACKAGE}@${CORE_CANDIDATE_VERSION} ${readPinnedCoreCommit(ROOT).slice(0, 12)}`,
    );
  } finally {
    npm.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`Core candidate tar verification blocked: ${error.message}`);
  process.exitCode = 1;
}
