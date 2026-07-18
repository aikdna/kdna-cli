#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  canonicalRegistryUrl,
  resolveTrustedNpmInvocation,
} = require('./runtime-candidate-binding');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_ARGS = [
  '--registry=https://registry.npmjs.org/',
  '--@aikdna:registry=https://registry.npmjs.org/',
];
const FAILURE =
  'Error: @aikdna/kdna-eval@0.3.2 is missing or incompatible; reinstall @aikdna/kdna-cli.\n';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 120_000,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function requireSuccess(result, label) {
  if (result.status !== 0 || result.signal != null) {
    throw new Error(`${label} failed: ${(result.stderr || '').trim()}`);
  }
}

function runCli(cli, args, expectedStatus = 0, env = process.env) {
  const result = run(process.execPath, [cli, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== expectedStatus || result.signal != null) {
    throw new Error(
      `packed CLI ${args.join(' ')} exited ${String(result.status)}: ${(result.stderr || '').trim()}`,
    );
  }
  return result;
}

function verifyEvalRuntimePackage() {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-eval-package-')));
  fs.chmodSync(workspace, 0o700);
  const artifactDir = path.join(workspace, 'artifact');
  const consumer = path.join(workspace, 'consumer');
  fs.mkdirSync(artifactDir);
  fs.mkdirSync(consumer);
  const npm = resolveTrustedNpmInvocation(ROOT);

  try {
    const pack = run(
      npm.command,
      [
        ...npm.prefixArgs,
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        artifactDir,
        ...REGISTRY_ARGS,
      ],
      { cwd: ROOT },
    );
    requireSuccess(pack, 'trusted npm pack');
    const reports = JSON.parse(pack.stdout);
    if (!Array.isArray(reports) || reports.length !== 1 || !reports[0]?.filename) {
      throw new Error('trusted npm pack did not report one artifact');
    }
    const tarball = path.join(artifactDir, reports[0].filename);
    const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    fs.writeFileSync(
      path.join(consumer, 'package.json'),
      JSON.stringify(
        {
          name: 'kdna-cli-eval-runtime-smoke',
          version: '1.0.0',
          private: true,
          dependencies: { [rootPackage.name]: `file:${tarball}` },
        },
        null,
        2,
      ) + '\n',
    );

    const install = run(
      npm.command,
      [
        ...npm.prefixArgs,
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...REGISTRY_ARGS,
      ],
      { cwd: consumer },
    );
    requireSuccess(install, 'isolated packed CLI install');

    const installedRoot = path.join(consumer, 'node_modules', '@aikdna');
    const cliRoot = path.join(installedRoot, 'kdna-cli');
    const cli = path.join(cliRoot, 'src', 'cli.js');
    const evalPackage = JSON.parse(
      fs.readFileSync(path.join(installedRoot, 'kdna-eval', 'package.json'), 'utf8'),
    );
    const expectedEval = rootPackage.dependencies['@aikdna/kdna-eval'];
    if (evalPackage.name !== '@aikdna/kdna-eval' || evalPackage.version !== expectedEval) {
      throw new Error('isolated install did not resolve the exact Eval dependency');
    }
    const lock = JSON.parse(fs.readFileSync(path.join(consumer, 'package-lock.json'), 'utf8'));
    const lockedEval = lock.packages?.['node_modules/@aikdna/kdna-eval'];
    if (lockedEval?.resolved !== canonicalRegistryUrl('@aikdna/kdna-eval', expectedEval)) {
      throw new Error('isolated install did not bind Eval to the canonical registry artifact');
    }

    const asset = path.join(cliRoot, 'fixtures', 'minimal');
    const cluster = path.join(cliRoot, 'fixtures', 'cluster-launch-decision.json');
    const ledger = path.join(workspace, 'ledger.jsonl');
    fs.writeFileSync(ledger, '');

    runCli(cli, ['compose', asset, '--primary=runtime-smoke', '--as=json']);
    runCli(cli, ['route', asset, '--as=json']);
    runCli(cli, ['eval-consumption', asset, '--as=json']);
    runCli(cli, ['eval', 'asset', asset, '--as=json']);
    runCli(cli, ['eval', 'cluster', cluster, '--as=json'], 4);
    runCli(cli, ['validate-compose-decisions', ledger, '--as=json']);

    const evalRoot = path.join(installedRoot, 'kdna-eval');
    fs.renameSync(evalRoot, path.join(installedRoot, 'kdna-eval-disabled'));
    const marker = path.join(workspace, 'environment-module-loaded');
    const replacement = path.join(workspace, 'replacement.js');
    fs.writeFileSync(
      replacement,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded\\n'); module.exports = {};\n`,
    );
    const nodePathRoot = path.join(workspace, 'hostile-node-path', 'node_modules');
    const hostileEvalRoot = path.join(nodePathRoot, '@aikdna', 'kdna-eval');
    const nodePathMarker = path.join(workspace, 'node-path-module-loaded');
    fs.mkdirSync(path.join(hostileEvalRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(hostileEvalRoot, 'package.json'),
      JSON.stringify({
        name: '@aikdna/kdna-eval',
        version: expectedEval,
        main: 'src/index.js',
        exports: { '.': { require: './src/index.js' } },
      }),
    );
    fs.writeFileSync(
      path.join(hostileEvalRoot, 'src', 'index.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(nodePathMarker)}, 'loaded\\n'); module.exports = {};\n`,
    );
    const rejected = runCli(cli, ['compose', asset, '--primary=runtime-smoke', '--as=json'], 6, {
      ...process.env,
      KDNA_EVAL_PATH: replacement,
      NODE_PATH: nodePathRoot,
    });
    if (rejected.stdout !== '' || rejected.stderr !== FAILURE) {
      throw new Error('packed CLI dependency failure was not stable and non-leaking');
    }
    if (fs.existsSync(marker)) throw new Error('packed CLI executed KDNA_EVAL_PATH replacement');
    if (fs.existsSync(nodePathMarker)) throw new Error('packed CLI executed NODE_PATH replacement');

    return Object.freeze({
      cli: `${rootPackage.name}@${rootPackage.version}`,
      eval: `${evalPackage.name}@${evalPackage.version}`,
      commands: 6,
    });
  } finally {
    npm.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const result = verifyEvalRuntimePackage();
    console.log(
      `Packed Eval runtime verified: ${result.cli} -> ${result.eval}; ${result.commands} command paths`,
    );
  } catch (error) {
    console.error(`Packed Eval runtime rejected: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyEvalRuntimePackage };
