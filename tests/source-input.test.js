'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSourceEdits } = require('../src/source-input.js');
const limit = 20 * 1024 * 1024;
const error = { message: 'KDNA_SOURCE_EDITS_INVALID' };

async function fixture(work) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kdna-source-edits-'));
  try { await work(dir, path.join(dir, 'edits.json')); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('Source edits preserve nested authored values and prototype-looking keys exactly', async () => fixture(async (dir, file) => {
  const text = '{"manifest":{"version":"1.0.1","__proto__":{"owned":true}},"payload":{"values":[false,0,null,"🙂"],"empty":[],"constructor":{"x":1}}}';
  await fs.writeFile(file, text);
  const value = await readSourceEdits(file);
  assert.deepEqual(value, JSON.parse(text));
  assert.equal(Object.hasOwn(value.manifest, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(value.manifest), Object.prototype);
  assert.equal({}.owned, undefined);
  assert.equal(Object.hasOwn(value.payload, 'omitted'), false);
}));

test('Source edit root has exactly two object fields without erasing unknown input', async () => fixture(async (dir, file) => {
  for (const value of [null, [], {}, {manifest:{}}, {payload:{}}, {manifest:{},payload:null},
    {manifest:[],payload:{}}, {manifest:1,payload:{}}, {manifest:{},payload:"x"},
    {manifest:{},payload:{},members:[]}, {manifest:{},payload:{},observation:{}}]) {
    await fs.writeFile(file, JSON.stringify(value));
    await assert.rejects(readSourceEdits(file), error);
  }
}));

test('Source edits reject decoded duplicate keys, malformed UTF8 and non-JSON values', async () => fixture(async (dir, file) => {
  for (const text of ['{"manifest":{},"manifest":{},"payload":{}}',
    '{"manifest":{},"payload":{"x":1,"\\u0078":2}}',
    '{"manifest":{},"payload":{"x":"\\ud800"}}',
    '{"manifest":{},"payload":{"x":"\\udfff"}}',
    '{"manifest":{},"payload":{"x":1e10000}}',
    '{"manifest":{},"payload":{},}', '{"manifest":{},"payload":{}}{}']) {
    await fs.writeFile(file, text); await assert.rejects(readSourceEdits(file), error);
  }
  await fs.writeFile(file, Buffer.from([0xff])); await assert.rejects(readSourceEdits(file), error);
}));

test('Source edit transport accepts exactly 20 MiB and rejects one extra byte', async () => fixture(async (dir, file) => {
  const prefix = Buffer.from('{"manifest":{},"payload":{}}');
  const exact = Buffer.alloc(limit, 0x20); prefix.copy(exact);
  await fs.writeFile(file, exact); assert.deepEqual(await readSourceEdits(file), {manifest:{},payload:{}});
  await fs.appendFile(file, ' '); await assert.rejects(readSourceEdits(file), error);
}));

test('Source edit ingress rejects nonregular files and symbolic links without following them', async () => fixture(async (dir, file) => {
  await fs.writeFile(file, '{"manifest":{},"payload":{}}');
  const link = path.join(dir, 'link.json'); await fs.symlink(file, link);
  await assert.rejects(readSourceEdits(dir), error); await assert.rejects(readSourceEdits(link), error);
  // The scoped runner can supply its own real FIFO; no writer is needed.
  if (process.env.KDNA_CLI_SOURCE_FIFO_FIXTURE) await assert.rejects(readSourceEdits(process.env.KDNA_CLI_SOURCE_FIFO_FIXTURE), error);
}));

test('Source edit ingress bounds growth after stat and closes the owned descriptor', async () => fixture(async (dir, file) => {
  await fs.writeFile(file, '{"manifest":{},"payload":{}}');
  const open = fs.open; let opens = 0, closes = 0;
  try {
    fs.open = async (...args) => {
      assert.equal(args[0], file); assert.ok(args[1] & nativeFs.constants.O_NONBLOCK);
      const handle = await open(...args); opens++;
      const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
      handle.stat = async () => { const prior = await stat(); await fs.appendFile(file, Buffer.alloc(limit + 1 - prior.size, 0x20)); return prior; };
      handle.close = async () => { closes++; return close(); };
      return handle;
    };
    await assert.rejects(readSourceEdits(file), error);
    assert.equal(opens, 1); assert.equal(closes, 1);
  } finally { fs.open = open; }
}));

test('Source edits forward the active-output guard before and after pending file work', async () => fixture(async (dir, file) => {
  await fs.writeFile(file, '{"manifest":{},"payload":{}}');
  const open = fs.open; let opens = 0, closes = 0, stopped = false;
  const reason = new Error('observed output failure');
  const check = () => { if (stopped) throw reason; };
  try {
    fs.open = async (...args) => {
      opens++; const handle = await open(...args), close = handle.close.bind(handle);
      handle.close = async () => { closes++; return close(); };
      stopped = true; return handle;
    };
    stopped = true; await assert.rejects(readSourceEdits(file, check), e => e === reason);
    assert.equal(opens, 0);
    stopped = false; await assert.rejects(readSourceEdits(file, check), e => e === reason);
    assert.equal(opens, 1); assert.equal(closes, 1);
  } finally { fs.open = open; }
}));
