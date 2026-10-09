'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { parseJsonBytes, readAuthoredInput, saveNewAsset } = require('../src/authored-input.js');

test('JSON transport preserves absence, order and prototype-looking authored keys', () => {
  const value = parseJsonBytes(Buffer.from('{"__proto__":{"x":1},"members":[],"payload":{"values":[0,false,null,"🙂"]}}'));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal(Object.hasOwn(value, 'manifest'), false);
  assert.deepEqual(value.payload.values, [0, false, null, '🙂']);
  assert.equal({}.x, undefined);
});

test('duplicate decoded keys and lossy JSON representations fail before authoring', () => {
  for (const text of ['{"x":1,"\\u0078":2}', '{"nested":{"x":1,"x":2}}', '1e10000', '"\\ud800"', '"\\udfff"', '{"x":1,}', '[1,]', '01', '{}{}']) {
    assert.throws(() => parseJsonBytes(Buffer.from(text)), undefined, text);
  }
  assert.throws(() => parseJsonBytes(Buffer.from([0xff])));
});

test('authored file transport owns exact bytes, refuses erased fields and bounds decoded bodies', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kdna-authored-'));
  const file = path.join(directory, 'input.json');
  const document = { manifest: {}, payload: {}, members: [{ name: 'attachments/a.bin', type: 'file', mode: 420, bytes_base64: 'AAH/' }] };
  try {
    await fs.writeFile(file, JSON.stringify(document));
    assert.deepEqual(Array.from((await readAuthoredInput(file)).members[0].bytes), [0, 1, 255]);
    for (const bad of [{ ...document, ignored: true }, { ...document, members: [{ ...document.members[0], ignored: true }] },
      { ...document, members: [{ ...document.members[0], bytes_base64: 'AB==' }] },
      { ...document, members: [{ ...document.members[0], bytes_base64: 'AAH/\n' }] },
      { ...document, members: [{ ...document.members[0], bytes_base64: 'AQ' }] }]) {
      await fs.writeFile(file, JSON.stringify(bad));
      await assert.rejects(readAuthoredInput(file));
    }
    const body = Buffer.alloc(8 * 1024 * 1024, 0xa5);
    document.members[0].bytes_base64 = body.toString('base64');
    await fs.writeFile(file, JSON.stringify(document));
    assert.deepEqual(Buffer.from((await readAuthoredInput(file)).members[0].bytes), body);
    document.members[0].bytes_base64 = Buffer.alloc(body.length + 1).toString('base64');
    await fs.writeFile(file, JSON.stringify(document)); await assert.rejects(readAuthoredInput(file));
    const handle = await fs.open(file, 'w'); await handle.truncate(20 * 1024 * 1024 + 1); await handle.close();
    await assert.rejects(readAuthoredInput(file));
    await assert.rejects(readAuthoredInput(directory));
    // Optional externally prepared FIFO fixture verifies ingress cannot wait
    // for a writer; the descriptor's regular-file check must reject it.
    if (process.env.KDNA_CLI_FIFO_FIXTURE) await assert.rejects(readAuthoredInput(process.env.KDNA_CLI_FIFO_FIXTURE));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('exclusive atomic save preserves old files and symlinks, including competing writers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kdna-save-'));
  const file = path.join(directory, 'asset.kdna'), old = Buffer.from('old complete asset');
  try {
    await fs.writeFile(file, old);
    await assert.rejects(saveNewAsset(file, Buffer.from('replacement')), { message: 'KDNA_OUTPUT_EXISTS' });
    assert.deepEqual(await fs.readFile(file), old);
    const link = path.join(directory, 'link.kdna'); await fs.symlink(file, link);
    await assert.rejects(saveNewAsset(link, Buffer.from('replacement')), { message: 'KDNA_OUTPUT_EXISTS' });
    assert.deepEqual(await fs.readFile(file), old); assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    const target = path.join(directory, 'new.kdna'), one = Buffer.alloc(524288, 0x31), two = Buffer.alloc(524288, 0x32);
    const results = await Promise.allSettled([saveNewAsset(target, one), saveNewAsset(target, two)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.message, 'KDNA_OUTPUT_EXISTS');
    assert.deepEqual(await fs.readFile(target), results[0].status === 'fulfilled' ? one : two);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['asset.kdna', 'link.kdna', 'new.kdna']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('post-publication cleanup failure preserves the saved result and exact bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kdna-retained-temporary-'));
  const file = path.join(directory, 'asset.kdna'), bytes = Buffer.from('complete asset');
  const unlink = fs.unlink;
  try {
    fs.unlink = async candidate => {
      if (path.dirname(candidate) === directory && path.basename(candidate).startsWith('.kdna-save-')) throw new Error('injected cleanup failure');
      return unlink(candidate);
    };
    assert.deepEqual(await saveNewAsset(file, bytes), { cleanup: 'temporary_retained' });
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.equal((await fs.readdir(directory)).length, 2);
  } finally { fs.unlink = unlink; await fs.rm(directory, { recursive: true, force: true }); }
});

test('observed output failure prevents publication before and after staging', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kdna-canceled-save-'));
  try {
    for (const failAt of [1, 2]) {
      let checks = 0;
      await assert.rejects(saveNewAsset(path.join(directory, 'asset.kdna'), Buffer.alloc(1024), () => {
        if (++checks === failAt) throw new Error('output failed');
      }));
      assert.deepEqual(await fs.readdir(directory), []);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
