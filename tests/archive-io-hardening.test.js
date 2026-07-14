'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('@aikdna/kdna-core');

const cli = path.join(__dirname, '..', 'src', 'cli.js');

test('domain unpack accepts shell-significant file names without a shell', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-domain-unpack-'));
  try {
    const source = path.join(tmp, 'source');
    fs.cpSync(path.join(__dirname, '..', 'fixtures', 'v1-judgment'), source, {
      recursive: true,
    });
    const assetPath = path.join(tmp, 'asset-"quoted"-$(printf ignored).kdna');
    core.pack(source, assetPath);

    const result = spawnSync(process.execPath, [cli, 'domain', 'unpack', assetPath], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const outputDir = assetPath.slice(0, -'.kdna'.length);
    assert.equal(fs.readFileSync(path.join(outputDir, 'mimetype'), 'utf8'), core.MIMETYPE);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('domain unpack rejects a corrupt container without command evaluation or partial output', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-domain-corrupt-'));
  try {
    const assetPath = path.join(tmp, 'broken-$(touch should-not-exist).kdna');
    fs.writeFileSync(assetPath, 'not a zip');

    const result = spawnSync(process.execPath, [cli, 'domain', 'unpack', assetPath], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(tmp, 'should-not-exist')), false);
    assert.equal(fs.existsSync(assetPath.slice(0, -'.kdna'.length)), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('archive I/O paths do not use shell command execution', () => {
  for (const relative of [
    'src/capsule-verify.js',
    'src/cmds/domain.js',
    'src/diff.js',
    'src/cmds/changelog.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.doesNotMatch(source, /\bexecSync\s*\(/, relative);
  }
});
