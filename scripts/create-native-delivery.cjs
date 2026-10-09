#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function members(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset, offset + 512).some(n => n !== 0)) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const number = (start, end) => { const text = field(start, end).trim(); if (!/^[0-7]+$/.test(text)) throw new Error('Invalid tar numeric field'); return parseInt(text, 8); };
    const expected = number(148, 156);
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (expected !== sum) throw new Error('Invalid tar header checksum');
    const prefix = field(345, 500), name = (prefix ? prefix + '/' : '') + field(0, 100);
    const type = header[156], size = number(124, 136), mode = number(100, 108);
    if (![0, 48].includes(type) || !name.startsWith('package/') || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..') || files.has(name)) throw new Error('Unsafe/duplicate/nonregular tar member');
    if (offset + 512 + size > tar.length) throw new Error('Truncated tar member');
    const content = tar.subarray(offset + 512, offset + 512 + size);
    files.set(name, { member: name, bytes: size, sha256: hash(content), mode, content });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (tar.subarray(offset).some(n => n !== 0)) throw new Error('Invalid tar trailer');
  return files;
}
const summary = ({content, ...member}) => member;
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination || process.argv.length !== 3 || fs.existsSync(destination)) {
  throw new Error('Usage: create-native-delivery.cjs <new-directory>; destination must not exist');
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdna-cli-delivery-'));
let created = false;
try {
  const inputs = JSON.parse(fs.readFileSync(path.join(root, 'release-surface/native-delivery-archives.json'))).archives;
  const dependencyInputs = JSON.parse(fs.readFileSync(path.join(root, 'release-surface/dependency-archives.json')));
  if (inputs.length !== 11 || inputs.length !== dependencyInputs.length) throw new Error('Expected eleven companion inputs');
  const inputMembers = new Map();
  for (const input of inputs) {
    if (path.basename(input.file) !== input.file) throw new Error('Archive filename must be a basename');
    const bytes = fs.readFileSync(path.join(root, 'vendor', input.file));
    if (hash(bytes) !== input.sha256 || bytes.length !== input.bytes ||
        `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` !== input.integrity)
      throw new Error(`Dependency archive changed: ${input.name}`);
    const dependency = dependencyInputs.find(d => d.name === input.name);
    if (!dependency || ['version','file','sha256','bytes','integrity'].some(k => dependency[k] !== input[k])) throw new Error('Companion receipts disagree');
    const packed = members(bytes); inputMembers.set(input.name, packed);
    if (packed.size !== input.members || typeof input.license !== 'string' || !Array.isArray(input.licenseMembers) || input.licenseMembers.length === 0) throw new Error('Incomplete license/member receipt');
    for (const license of input.licenseMembers) if (JSON.stringify(summary(packed.get(license.member) || {})) !== JSON.stringify(license)) throw new Error('License member changed');
  }
  const report = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  const reportPath = path.join(temp, 'pack-report.json');
  fs.writeFileSync(reportPath, JSON.stringify([report]));
  execFileSync(process.execPath, [path.join(root, 'scripts/check-surface.cjs'), reportPath], { cwd: root, stdio: 'pipe' });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const cliBytes = fs.readFileSync(path.join(temp, report.filename));
  const cliMembers = members(cliBytes);
  if (cliMembers.size !== report.files.length) throw new Error('Pack report/tar membership mismatch');
  const sourceMembers = [];
  for (const entry of report.files) {
    const packed = cliMembers.get('package/' + entry.path), sourcePath = path.join(root, entry.path);
    const stat = fs.lstatSync(sourcePath);
    const expectedMode = stat.mode & 0o111 ? 0o755 : 0o644;
    if (!stat.isFile() || !packed || packed.bytes !== stat.size || packed.sha256 !== hash(fs.readFileSync(sourcePath)) || packed.mode !== expectedMode) throw new Error('Source/pack member mismatch: ' + entry.path);
    sourceMembers.push({ source: entry.path, ...summary(packed) });
  }
  const archives = [...inputs, { name: pkg.name, version: pkg.version, file: report.filename,
    bytes: cliBytes.length, sha256: hash(cliBytes),
    integrity: `sha512-${crypto.createHash('sha512').update(cliBytes).digest('base64')}`,
    members: report.files.length, license: pkg.license,
    licenseMembers: ['LICENSE','LICENSE-DOCS','NOTICE'].map(name => summary(cliMembers.get('package/' + name))) }];
  fs.mkdirSync(destination); created = true; fs.mkdirSync(path.join(destination, 'vendor'));
  for (const input of archives) fs.copyFileSync(path.join(input.name === pkg.name ? temp : path.join(root, 'vendor'), input.file),
    path.join(destination, 'vendor', input.file), fs.constants.COPYFILE_EXCL);
  for (const receipt of archives) {
    const finalBytes = fs.readFileSync(path.join(destination, 'vendor', receipt.file));
    if (finalBytes.length !== receipt.bytes || hash(finalBytes) !== receipt.sha256 ||
        `sha512-${crypto.createHash('sha512').update(finalBytes).digest('base64')}` !== receipt.integrity)
      throw new Error('Final delivery archive changed: ' + receipt.name);
    const finalMembers = members(finalBytes);
    const manifest = JSON.parse(finalMembers.get('package/package.json').content);
    if (manifest.name !== receipt.name || manifest.version !== receipt.version || finalMembers.size !== receipt.members)
      throw new Error('Final delivery package identity changed: ' + receipt.name);
    for (const license of receipt.licenseMembers)
      if (JSON.stringify(summary(finalMembers.get(license.member) || {})) !== JSON.stringify(license)) throw new Error('Final license member changed');
  }
  const dependencies = Object.fromEntries(archives.map(input => [input.name, `file:vendor/${input.file}`]));
  const manifest = { name: 'kdna-native-cli-delivery', version: '1.0.0', private: true, dependencies,
    overrides: { '@aikdna/kdna-core': '$@aikdna/kdna-core', '@aikdna/kdna-read': '$@aikdna/kdna-read', 'fast-uri': '$fast-uri' } };
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  for (const name of ['LICENSE','LICENSE-DOCS','NOTICE']) fs.copyFileSync(path.join(root,name),path.join(destination,name),fs.constants.COPYFILE_EXCL);
  // Reuse the checked eleven-archive host graph; do not let npm resolution
  // add platform-specific optional accelerators from the caller's cache.
  const sourceLock = JSON.parse(fs.readFileSync(path.join(root,'release-surface/native-offline-host/package-lock.json')));
  assert.deepEqual(Object.keys(sourceLock.packages).sort(), ['', ...inputs.map(a=>'node_modules/'+a.name)].sort(), 'Companion lock closure differs');
  const packages = {'': { name:manifest.name, version:manifest.version, dependencies }};
  for (const receipt of inputs) {
    const key = 'node_modules/'+receipt.name, node = sourceLock.packages[key];
    assert.equal(node.version,receipt.version,'Companion lock version differs');
    assert.equal(node.integrity,receipt.integrity,'Companion lock integrity differs');
    assert.equal(node.resolved,'file:../../vendor/'+receipt.file,'Companion lock path differs');
    assert.notEqual(node.optional,true,'Companion archive is required');
    packages[key] = {...node,resolved:'file:vendor/'+receipt.file};
  }
  const cliReceipt=archives.find(a=>a.name===pkg.name);
  packages['node_modules/'+pkg.name]={version:pkg.version,resolved:'file:vendor/'+cliReceipt.file,
    integrity:cliReceipt.integrity,license:pkg.license,dependencies:pkg.dependencies,bin:pkg.bin,engines:pkg.engines};
  fs.writeFileSync(path.join(destination,'package-lock.json'),JSON.stringify({name:manifest.name,version:manifest.version,lockfileVersion:3,requires:true,packages},null,2)+'\n',{flag:'wx'});
  const finalLock = JSON.parse(fs.readFileSync(path.join(destination,'package-lock.json')));
  assert.deepEqual(finalLock.packages[''].dependencies, dependencies, 'Consumer root dependencies differ from receipts');
  assert.deepEqual(Object.keys(finalLock.packages).sort(), ['', ...archives.map(a=>'node_modules/'+a.name)].sort(), 'Consumer package closure differs from receipts');
  for (const receipt of archives) {
    const node = finalLock.packages['node_modules/'+receipt.name];
    assert.equal(node.version,receipt.version,'Consumer version differs');
    assert.equal(node.resolved,'file:vendor/'+receipt.file,'Consumer archive path differs');
    assert.equal(node.integrity,receipt.integrity,'Consumer integrity differs');
    assert.notEqual(node.optional,true,'Required archive must not be optional');
  }
  const host = Object.fromEntries(['package.json','package-lock.json'].map(name => {const bytes=fs.readFileSync(path.join(destination,name));return [name,{bytes:bytes.length,sha256:hash(bytes)}];}));
  const receipt = { archives, cliSourceMembers: sourceMembers, host,
    licenseFiles: ['LICENSE','LICENSE-DOCS','NOTICE'].map(name=>{const bytes=fs.readFileSync(path.join(destination,name));return {file:name,bytes:bytes.length,sha256:hash(bytes)};}),
    optionalNativeAcceleration: 'excluded; use omit=optional',
    source: 'Current source members matched byte-for-byte to npm tar; source publication is separate.' };
  fs.writeFileSync(path.join(destination, 'archives.json'), JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({ destination, cli: pkg.version, archives: archives.length,
    source: 'current source package plus SHA/SRI-verified dependency archives; not a publication claim' }) + '\n');
} catch (error) {
  if (created) fs.rmSync(destination, { recursive: true, force: true });
  throw error;
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
