'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const target = process.env.KDNA_CLI_TARGET_ROOT || path.join(__dirname, '..');
const { readAssetBytes } = require(path.join(target, 'src/authored-input.js'));
const limit = 25 * 1024 * 1024;

test('asset capture owns the complete bytes after replacement and enforces 25 MiB', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kdna-asset-input-'));
  try {
    const file = path.join(dir, 'asset.kdna');
    const source = Buffer.alloc(limit, 65);
    source[limit - 1] = 90;
    await fs.writeFile(file, source);
    const owned = await readAssetBytes(file);
    assert.deepEqual(owned, source);
    await fs.rename(file, file + '.old');
    await fs.writeFile(file, Buffer.from('replacement'));
    assert.deepEqual(owned, source);
    await fs.appendFile(file + '.old', Buffer.from([1]));
    await assert.rejects(readAssetBytes(file + '.old'), /KDNA_ASSET_INPUT_INVALID/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset capture rejects directory, symlink and FIFO without waiting for a writer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kdna-asset-kinds-'));
  try {
    const file = path.join(dir, 'file');
    await fs.writeFile(file, 'owned');
    await fs.symlink(file, path.join(dir, 'link'));
    await assert.rejects(readAssetBytes(dir), /KDNA_ASSET_INPUT_INVALID/);
    await assert.rejects(readAssetBytes(path.join(dir, 'link')), /KDNA_ASSET_INPUT_INVALID/);
    // The execution owner supplies a real FIFO; do not spawn a utility here.
    if (process.env.KDNA_CLI_ASSET_FIFO) {
      await assert.rejects(readAssetBytes(process.env.KDNA_CLI_ASSET_FIFO), /KDNA_ASSET_INPUT_INVALID/);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset capture bounds growth after stat and closes its single descriptor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kdna-asset-growth-'));
  const open = fs.open;
  let opened = 0, closed = 0;
  try {
    const file = path.join(dir, 'asset.kdna');
    await fs.writeFile(file, Buffer.alloc(limit, 1));
    fs.open = async (...args) => {
      opened++;
      const handle = await open(...args);
      const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
      handle.stat = async () => {
        const before = await stat();
        await fs.appendFile(file, Buffer.from([2]));
        return before;
      };
      handle.close = async () => { closed++; return close(); };
      return handle;
    };
    await assert.rejects(readAssetBytes(file), /KDNA_ASSET_INPUT_INVALID/);
    assert.equal(opened, 1); assert.equal(closed, 1);
  } finally { fs.open = open; await fs.rm(dir, { recursive: true, force: true }); }
});

test('asset capture observes an output stop before opening and after pending work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kdna-asset-stop-'));
  const open = fs.open;
  let opened = 0, closed = 0, stopped = false;
  const check = () => { if (stopped) throw new Error('output stopped'); };
  try {
    const file = path.join(dir, 'asset.kdna');
    await fs.writeFile(file, 'owned');
    fs.open = async (...args) => {
      opened++;
      const handle = await open(...args), close = handle.close.bind(handle);
      handle.close = async () => { closed++; return close(); };
      stopped = true;
      return handle;
    };
    stopped = true;
    await assert.rejects(readAssetBytes(file, check), /output stopped/);
    assert.equal(opened, 0);
    stopped = false;
    await assert.rejects(readAssetBytes(file, check), /KDNA_ASSET_INPUT_INVALID/);
    assert.equal(opened, 1); assert.equal(closed, 1);
  } finally { fs.open = open; await fs.rm(dir, { recursive: true, force: true }); }
});
