'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const allow = require('../release-surface/npm-file-allowlist.json').files;
assert.deepEqual([...pkg.files, 'package.json'].sort(), [...allow].sort());
assert.equal(pkg.private, true);
assert.deepEqual(pkg.dependencies, {'@aikdna/kdna-core':'0.24.0-rc.component-semantics.2','@aikdna/kdna-read':'0.3.0-rc.component-semantics.2'});
assert.deepEqual(pkg.exports, {'.':'./src/public-cli.js','./package.json':'./package.json'});
const sourceFiles = [];
for (const entry of fs.readdirSync(path.join(root, 'src'), { withFileTypes: true })) {
  if (entry.isDirectory()) {
    // The current repository retains this empty historical directory.
    assert.equal(entry.name, 'cmds');
    assert.deepEqual(fs.readdirSync(path.join(root, 'src', entry.name)), []);
  } else {
    assert.equal(entry.isFile(), true, 'No source symlinks or special entries');
    sourceFiles.push(entry.name);
  }
}
assert.deepEqual(sourceFiles.sort(), ['cli.js', 'public-cli.js']);
if (process.argv[2]) {
  const packed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  assert.equal(packed.length, 1);
  assert.deepEqual(packed[0].files.map(f=>f.path).sort(), [...allow].sort());
}
console.log('Current CLI source/package allowlist MATCH; no publication asserted.');
