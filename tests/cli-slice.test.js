"use strict";
const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Writable, Readable } = require('node:stream');
const target = process.env.KDNA_CLI_TARGET_ROOT || path.resolve(__dirname, '..');
const local = createRequire(path.join(target, 'package.json'));
const { run } = local('@aikdna/kdna-cli');
const pkg = local('@aikdna/kdna-cli/package.json');
const binding = JSON.parse(fs.readFileSync(path.join(target, 'public-contract-binding.json')));
const bin = path.join(target, pkg.bin.kdna);
const fixtures = process.env.KDNA_CLI_FIXTURES || path.join(__dirname, 'fixtures');
let file = path.join(fixtures, 'native-graph-cross.kdna'), fixtureScratch;
// Produce one current native fixture into owned scratch. Frozen/legacy fixture
// files remain inputs and never receive a replacement asset.
before(async () => {
 if(process.env.KDNA_CLI_FIXTURES) return;
 fixtureScratch=fs.mkdtempSync(path.join(os.tmpdir(),'kdna-native-cli-fixture-'));
 file=path.join(fixtureScratch,'native-graph-cross.kdna');
 const out=sink();
 assert.equal(await run(['create',path.join(fixtures,'native-graph-cross.authored.json'),'--output',file,'--allow-create'],out),0);
 assert.equal(JSON.parse(out.lines.join('')).status,'saved');
});
after(()=>{if(fixtureScratch)fs.rmSync(fixtureScratch,{recursive:true,force:true});});
const request = (mode='exact_selection', handle=null) => ({ request_id:'request:cli-slice', tuple:binding.tuple, budget_bytes:1000000, mode, selection:['catalog','whole_asset'].includes(mode)?null:{asset_id:'asset:bytes',asset_version:'1.0.0',judgment_ids:['j:0']}, handle });
function sink() { const lines=[]; return {lines, write(value) {lines.push(value);return true;}}; }
async function invoke(argv, chunks=[]) {const out=sink();const code=await run(argv,out,Readable.from(chunks));return {code,rows:out.lines.join('').trim().split('\n').filter(Boolean).map(JSON.parse)};}
function binary(args,input) {const p=spawnSync(process.execPath,[bin,...args],{input,encoding:'utf8',env:process.env,timeout:5000});assert.equal(p.error,undefined);assert.equal(p.signal,null);return p;}
function session(makeRequest, args=[]) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[bin,'read',file,'--session','--allow-read',...args],{stdio:['pipe','pipe','pipe'],env:process.env});
  const rows=[];let stderr='';let finished=false;
  const timer=setTimeout(()=>{child.kill();reject(new Error('CLI session did not close'));},5000);
  child.on('error',reject);child.stderr.on('data',part=>stderr+=part);
  createInterface({input:child.stdout}).on('line',line=>{try {rows.push(JSON.parse(line));const next=makeRequest(rows);if(next)child.stdin.write(JSON.stringify(next)+'\n');else {finished=true;child.stdin.end();}}catch(e){child.kill();reject(e);}});
  child.on('close',(code,signal)=>{clearTimeout(timer);resolve({rows,code,signal,stderr,pid:child.pid,inputEnded:finished});});
  child.stdin.write(JSON.stringify(makeRequest(rows))+'\n');
 });
}
test('exact package/source record retains the public tuple and same Core module identity',()=>{
 assert.equal(pkg.version,'0.39.0-rc.native-sections.3');assert.equal(pkg.dependencies['@aikdna/kdna-core'],'0.37.1-rc.browser.1');assert.equal(pkg.dependencies['@aikdna/kdna-read'],'0.11.2-rc.browser.1');
 assert.equal(binding.tuple.read,'kdna.read/0.7.0-candidate');assert.equal(binding.tuple.container,'0.6.0');
 assert.deepEqual(binding.route_contracts, [
  {
    "file": "sections/contract.json",
    "bytes": 547981,
    "sha256": "e9cf4069906c3bf30ecfda953de9d75983f3941a10695ce9546101057593c372"
  },
  {
    "file": "sectionbytes/contract.json",
    "bytes": 31759,
    "sha256": "617c4d2e2fcbfebaa4df559fb39b61e729064ff6e4b458a24321a6284d44074a"
  },
  {
    "file": "retained/contract.json",
    "bytes": 291233,
    "sha256": "6675e6e72c76e89785da7d75c16fd29d66e2039047f14ef8b3a5e7517e0c4ac9"
  },
  {
    "file": "creation06/contract.json",
    "bytes": 71166,
    "sha256": "bf1bb5bf0b6f3d7d38c2a3c63c413942f377c061bd01eb9b0868a2d9fdca6f8f"
  },
  {
    "file": "source06/contract.json",
    "bytes": 76676,
    "sha256": "0129de8550b549622d9eb2cb5c17de4776944b719e2edf7c1aca82caf293b2d4"
  }
]);
 assert.equal(binding.accepted_core.tar_sha256,'12a2d5f234ed3404aee1b394442251ad875c1531c01cd6a4f3c0366d55e5d773');
 assert.equal(binding.accepted_read.tar_sha256,'c5c2d6b65c44dd30aeddd49d6f2a4c915e9fd4d8f2a28297d6d677564e261cb7');
 const readLocal=createRequire(local.resolve('@aikdna/kdna-read/retained-sections-node'));
 assert.equal(local.resolve('@aikdna/kdna-core/retained-sections-node'),readLocal.resolve('@aikdna/kdna-core/retained-sections-node'));
 assert.deepEqual(Object.keys(local('@aikdna/kdna-cli')),['run']);assert.equal(pkg.types,undefined);
});
test('real bin preserves all four modes, in-process handles, mutation rejection and cross-process isolation',async()=>{
 const modes=['catalog','whole_asset','exact_selection','expand','expand'];
 const first=await session(rows=>rows.length===5?null:request(modes[rows.length],rows.length>=3?rows[2].envelope.content.expansion_handles.find(h=>h.target.kind==='dependency'&&h.target.id==='dependency:optional'):null));
 assert.equal(first.code,0);assert.equal(first.signal,null);assert.equal(first.stderr,'');assert.equal(first.inputEnded,true);
 assert.ok(first.rows.every((r,i)=>r.envelope.status===(i===0?'catalog_only':'ready')));assert.equal(new Set(first.rows.map(r=>r.envelope.snapshot_id)).size,1);
 assert.deepEqual(first.rows[3].envelope.content,first.rows[4].envelope.content);
 assert.deepEqual(first.rows[3].envelope.content.closure.filter(n=>n.role==='judgment').map(n=>n.value.id),['j:0','j:2']);
 const handle=first.rows[2].envelope.content.expansion_handles.find(h=>h.target.kind==='dependency'&&h.target.id==='dependency:optional');
 const second=await session(rows=>rows.length?null:request('expand',handle));
 assert.notEqual(first.pid,second.pid);assert.equal(second.code,1);assert.equal(second.rows[0].status,'rejected');assert.equal(second.rows[0].diagnostic.code,'READ_HANDLE_STALE');assert.equal(second.rows[0].detail,'handle_invalid');assert.equal(second.rows[0].body,null);assert.equal(second.rows[0].body_bytes,0);
 const changed=await session(rows=>rows.length===2?null:rows.length?request('expand',{...rows[0].envelope.content.expansion_handles.find(h=>h.target.kind==='dependency'&&h.target.id==='dependency:optional'),scope:[]}):request());
 assert.equal(changed.code,1);assert.equal(changed.rows[1].status,'rejected');assert.equal(changed.rows[1].diagnostic.code,'READ_INPUT_INVALID');assert.equal(changed.rows[1].body,null);assert.equal(changed.rows[1].body_bytes,0);
 const forged=await session(rows=>rows.length===2?null:rows.length?request('expand',{...rows[0].envelope.content.expansion_handles.find(h=>h.target.kind==='dependency'&&h.target.id==='dependency:optional'),handle_id:'handle:unissued'}):request());
 assert.equal(forged.code,1);assert.equal(forged.rows[1].envelope.diagnostics[0].code,'READ_HANDLE_UNTRUSTED');
});
test('bin admission, explicit consent and zero budget keep reading and action separate',()=>{
 for(const command of ['inspect','validate']) {const p=binary([command,file]);assert.equal(p.status,0);const out=JSON.parse(p.stdout);assert.equal(out.states.action_authorization,'not_evaluated');assert.equal(out.states.read_permission,'not_evaluated');}
 const denied=binary(['read',file]);assert.equal(denied.status,1);assert.deepEqual(JSON.parse(denied.stdout),{status:'rejected',code:'KDNA_READ_PERMISSION_REQUIRED',action_authorized:false});
 const zero=binary(['read',file,'--allow-read','--budget','0']);assert.equal(zero.status,1);assert.equal(JSON.parse(zero.stdout).control.body_bytes,0);
 const allowed=binary(['read',file,'--allow-read']);assert.equal(allowed.status,0);assert.equal(JSON.parse(allowed.stdout).envelope.states.action_authorization,'not_evaluated');
});
test('session handles chunked UTF8, CRLF, empty EOF and final line without newline',async()=>{
 const good=Buffer.from(JSON.stringify({...request('catalog'),request_id:'request:🙂'})+'\r\n');
 const chunks=Array.from(good,byte=>Buffer.from([byte]));assert.equal((await invoke(['read',file,'--session','--allow-read'],chunks)).code,0);
 const final=binary(['read',file,'--session','--allow-read'],JSON.stringify(request('catalog')));assert.equal(final.status,0);assert.equal(JSON.parse(final.stdout).envelope.status,'catalog_only');
 const empty=binary(['read',file,'--session','--allow-read'],Buffer.alloc(0));assert.equal(empty.status,0);assert.equal(empty.stdout,'');assert.equal(empty.stderr,'');
 const three=binary(['read',file,'--session','--allow-read'],[request('catalog'),request('whole_asset')].map(JSON.stringify).join('\n'));assert.equal(three.status,0);assert.equal(three.stdout.trim().split('\n').length,2);
});
test('malformed and oversized transport lines fail before further input and close iterators',async()=>{
 for(const input of [Buffer.from([0xff,10]),Buffer.from('{\n'),Buffer.from('null\n')]) {
  const p=binary(['read',file,'--session','--allow-read'],input);assert.ok([1,2].includes(p.status));assert.equal(p.stderr,'');const result=JSON.parse(p.stdout);assert.ok(result.code==='KDNA_SESSION_JSON_INVALID'||result.status==='rejected'&&result.diagnostic?.code==='READ_INPUT_INVALID');
 }
 for(const size of [1048576,1048577]) {const p=binary(['read',file,'--session','--allow-read'],Buffer.alloc(size,32));assert.equal(p.status,2);assert.equal(JSON.parse(p.stdout).code,size===1048576?'KDNA_SESSION_JSON_INVALID':'KDNA_SESSION_INPUT_TOO_LARGE');}
 let closed=false;async function* input(){try{yield '{\n';throw new Error('must not consume following item');}finally{closed=true;}}
 const out=sink();assert.equal(await run(['read',file,'--session','--allow-read'],out,input()),2);assert.equal(closed,true);
});
test('invalid local containers are generated only in isolated scratch and never change frozen fixtures',()=>{
 const base=fs.mkdtempSync(path.join(process.env.KDNA_CLI_TEST_SCRATCH||os.tmpdir(),'cli-slice-input-'));
 try{const bad=path.join(base,'not-a-container.kdna');fs.writeFileSync(bad,Buffer.from([0x50,0x4b,0xff]));for(const p of [bad,path.join(base,'missing.kdna'),base]){const result=binary(['validate',p]);assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).status,'rejected');}}
 finally {fs.rmSync(base,{recursive:true,force:true});}
});
test('all retired commands and public execution claims remain unavailable',()=>{
 for(const name of ['plan','load','pack','unpack','migrate','execute','fork','attach','resolve','encrypt','convert','eval','route','use','compose','host-consent']){
  const p=binary([name,file]);assert.equal(p.status,2,name);const r=JSON.parse(p.stdout);assert.equal(r.status,'unavailable');assert.equal(r.action_authorized,false);
 }

 const noCreate=binary(['create',file,'--output',path.join(os.tmpdir(),'cli-denied-'+process.pid+'.kdna')]);
 assert.equal(noCreate.status,1);const deniedCreate=JSON.parse(noCreate.stdout);assert.equal(deniedCreate.code,'KDNA_CREATE_PERMISSION_REQUIRED');assert.equal(deniedCreate.action_authorized,false);assert.equal(deniedCreate.creation_accepted,false);
 assert.notEqual(pkg.private,true);assert.match(pkg.scripts.prepublishOnly,/LOCAL_RC_NOT_AUTHORIZED_FOR_PUBLICATION/);
 for(const sub of ['/src/public-cli.js','/retired/src/cli.js'])assert.throws(()=>local('@aikdna/kdna-cli'+sub),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
});
for(const kind of ['async-error','close-before-callback']) test('stdout '+kind+' rejects without success acknowledgement or leaked listeners',async()=>{
 let settled='pending';let writes=0;
 const output=new Writable({highWaterMark:1048576,write(chunk,encoding,callback){writes++;if(kind==='async-error')setImmediate(()=>callback(new Error('expected output failure')));else setImmediate(()=>this.destroy());}});
 const errors=[];output.on('error',error=>errors.push(error.message));const baseline={error:output.listenerCount('error'),close:output.listenerCount('close')};
 const operation=run(['--version'],output).then(()=>{settled='resolved';},()=>{settled='rejected';});
 await Promise.race([operation,new Promise(resolve=>setTimeout(resolve,100))]);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(settled,'rejected');assert.equal(writes,1);assert.equal(output.listenerCount('error'),baseline.error);assert.equal(output.listenerCount('close'),baseline.close);
});
test('real Writable callback completion precedes success and backpressure writes remain sequential',async()=>{
 const text=[];let pending=0;let maximum=0;
 const output=new Writable({highWaterMark:1,write(chunk,encoding,callback){pending++;maximum=Math.max(maximum,pending);setTimeout(()=>{text.push(chunk.toString());pending--;callback();},5);}});
 const code=await run(['read',file,'--session','--allow-read'],output,Readable.from([JSON.stringify(request('catalog'))+'\n'+JSON.stringify(request('whole_asset'))+'\n']));
 assert.equal(code,0);assert.equal(pending,0);assert.equal(maximum,1);assert.equal(text.length,2);assert.equal(output.listenerCount('error'),0);assert.equal(output.listenerCount('close'),0);output.end();
});
test('stdout failure during Read closes its input and rejects delivery',async()=>{
 let closed=false;async function* input(){try{yield JSON.stringify(request('catalog'))+'\n';yield JSON.stringify(request('whole_asset'))+'\n';}finally{closed=true;}}
 const output=new Writable({write(chunk,encoding,cb){setImmediate(()=>cb(new Error('delivery unavailable')));}});output.on('error',()=>{});
 await assert.rejects(run(['read',file,'--session','--allow-read'],output,input()));assert.equal(closed,true);
});

test('actual bin exits on a closed stdout pipe and releases its session input', async()=>{
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[bin,'read',file,'--session','--allow-read'],{stdio:['pipe','pipe','pipe'],env:process.env});
  let stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('closed output did not terminate CLI'));},5000);
  child.on('error',reject);child.stdin.on('error',()=>{});child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdout.destroy();
  child.on('close',(code,signal)=>{clearTimeout(timer);try{assert.equal(code,1);assert.equal(signal,null);assert.equal(stderr,'KDNA_CLI_UNAVAILABLE\n');resolve();}catch(error){reject(error);}});
  child.stdin.write(JSON.stringify(request('catalog'))+'\n');
 });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('test observation did not settle')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}
function idleInput({ cleanup = 'cooperative', first = true } = {}) {
  const waiting = deferred(), pending = deferred();
  let reads = 0, returns = 0;
  const input = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      reads++;
      if (first && reads === 1) return Promise.resolve({ done: false, value: JSON.stringify(request('catalog')) + '\n' });
      waiting.resolve(); return pending.promise;
    },
    return() {
      returns++;
      if (cleanup === 'cooperative') { pending.resolve({ done: true }); return Promise.resolve({ done: true }); }
      if (cleanup === 'reject') return Promise.reject(new Error('late cleanup failure'));
      return new Promise(() => {});
    },
  };
  return { input, waiting: waiting.promise, pending, state: () => ({ reads, returns }) };
}
for (const phase of ['before-first-input', 'after-ready']) {
  for (const event of ['error', 'close']) test('idle output '+event+' at '+phase+' rejects and returns cooperative input', async () => {
    const observed = idleInput({ first: phase === 'after-ready' }), lines = [];
    const output = new Writable({ write(chunk, encoding, callback) { lines.push(chunk.toString()); callback(); } });
    const result = run(['read', file, '--session', '--allow-read'], output, observed.input).then(code => ({ code }), error => ({ error }));
    await bounded(observed.waiting);
    const first = new Error('IDLE_OUTPUT_FIRST_FAILURE');
    output.destroy(event === 'error' ? first : undefined);
    const end = await bounded(result);
    if (event === 'error') assert.equal(end.error, first);
    else assert.equal(end.error.message, 'KDNA_CLI_OUTPUT_CLOSED');
    assert.equal(observed.state().returns, 1);
    assert.equal(lines.length, phase === 'after-ready' ? 1 : 0);
    if (lines.length) assert.equal(JSON.parse(lines[0]).envelope.status, 'catalog_only');
    assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0);
  });
}
test('idle failure destroys actual Node Readable input and restores output listeners', async () => {
  const input = new Readable({ read() {} }), wrote = deferred();
  const output = new Writable({ write(chunk, encoding, callback) { callback(); wrote.resolve(); } });
  const result = run(['read', file, '--session', '--allow-read'], output, input).then(code => ({ code }), error => ({ error }));
  input.push(JSON.stringify(request('catalog')) + '\n'); await bounded(wrote.promise);
  await new Promise(resolve => setImmediate(resolve));
  const first = new Error('NODE_IDLE_FAILURE'); output.destroy(first);
  assert.equal((await bounded(result)).error, first); assert.equal(input.destroyed, true);
  assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0);
});
for (const cleanup of ['reject', 'pending']) test('uncooperative '+cleanup+' cleanup cannot replace output failure or revive a late input', async () => {
  const observed = idleInput({ cleanup }), lines = [];
  const output = new Writable({ write(chunk, encoding, cb) { lines.push(chunk.toString()); cb(); } });
  const result = run(['read', file, '--session', '--allow-read'], output, observed.input).then(code => ({ code }), error => ({ error }));
  await bounded(observed.waiting); const first = new Error('FIRST_OUTPUT_ERROR'); output.destroy(first);
  assert.equal((await bounded(result)).error, first); assert.equal(observed.state().returns, 1);
  if (cleanup === 'reject') observed.pending.reject(new Error('late input rejection'));
  else observed.pending.resolve({ done: false, value: JSON.stringify(request('whole_asset')) + '\n' });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(lines.length, 1); assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0);
});
test('output failure in completion turn cannot become successful EOF', async () => {
  const first = new Error('OUTPUT_FAILURE_BEFORE_COMPLETION');
  const output = new Writable({ write(chunk, encoding, callback) { callback(); setImmediate(() => this.destroy(first)); } });
  await assert.rejects(run(['read', file, '--session', '--allow-read'], output, Readable.from([JSON.stringify(request('catalog')) + '\n'])), error => error === first);
  assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0);
});
test('already closed output rejects before idle input and requests return', async () => {
  const output = new Writable({ write(chunk, encoding, cb) { cb(); } });
  output.destroy(); await new Promise(resolve => output.once('close', resolve));
  const observed = idleInput({ first: false });
  await assert.rejects(bounded(run(['read', file, '--session', '--allow-read'], output, observed.input)), /KDNA_CLI_OUTPUT_CLOSED/);
  assert.equal(observed.state().reads, 0); assert.equal(observed.state().returns, 1);
});
test('healthy multi-message EOF preserves all catalog rows without ending caller output', async () => {
  const lines = []; const output = new Writable({ highWaterMark: 1, write(chunk, encoding, cb) { lines.push(chunk.toString()); setImmediate(cb); } });
  const input = Readable.from([Array.from({ length: 64 }, (_, i) => JSON.stringify({ ...request('catalog'), request_id: 'multi:'+i })+'\n').join('')]);
  assert.equal(await run(['read', file, '--session', '--allow-read'], output, input), 0);
  assert.equal(lines.length, 64); assert.ok(lines.every(line => JSON.parse(line).envelope.status === 'catalog_only'));
  assert.equal(output.writableEnded, false); assert.equal(output.listenerCount('error'), 0); output.end();
});
test('actual bin preserves first row then exits when a later write observes closed pipe', async () => {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'read', file, '--session', '--allow-read'], { stdio: ['pipe','pipe','pipe'], env: process.env });
    let stderr = '', first = '', sent = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('late closed pipe did not terminate')); }, 5000);
    child.on('error', reject); child.stdin.on('error', () => {}); child.stderr.on('data', part => stderr += part);
    child.stdout.on('data', part => {
      first += part;
      if (!sent && first.includes('\n')) { sent = true; child.stdout.destroy(); child.stdin.write(JSON.stringify(request('whole_asset'))+'\n'); }
    });
    child.on('close', (code, signal) => { clearTimeout(timer); try { assert.equal(code, 1); assert.equal(signal, null); assert.equal(JSON.parse(first.trim()).envelope.status, 'catalog_only'); assert.equal(stderr, 'KDNA_CLI_UNAVAILABLE\n'); resolve(); } catch (error) { reject(error); } });
    child.stdin.write(JSON.stringify(request('catalog'))+'\n');
  });
});

for (const event of ['error', 'close']) for (const late of ['resolve', 'reject']) {
  test('whole run ends during pending return: '+event+' then late '+late, async () => {
    const entered = deferred(), closing = deferred(); let reads = 0, returns = 0, completed = 0;
    const input = { [Symbol.asyncIterator]() { return this; }, next() { reads++; return Promise.resolve({ done: false, value: '{\n' }); }, return() { returns++; entered.resolve(); return closing.promise; } };
    const lines = [], first = new Error('WHOLE_RUN_FIRST_OUTPUT');
    const output = new Writable({ write(chunk, encoding, cb) { lines.push(chunk.toString()); cb(); completed++; } });
    const operation = run(['read', file, '--session', '--allow-read'], output, input).then(code => ({ code }), error => ({ error }));
    await bounded(entered.promise); assert.equal(completed, 1); assert.equal(JSON.parse(lines[0]).code, 'KDNA_SESSION_JSON_INVALID');
    output.destroy(event === 'error' ? first : undefined);
    const result = await bounded(operation);
    if (event === 'error') assert.equal(result.error, first); else assert.equal(result.error.message, 'KDNA_CLI_OUTPUT_CLOSED');
    assert.equal(returns, 1); assert.equal(reads, 1); assert.equal(lines.length, 1);
    if (late === 'resolve') closing.resolve({ done: true }); else closing.reject(new Error('LATE_CLEANUP_ERROR'));
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(returns, 1); assert.equal(reads, 1); assert.equal(lines.length, 1);
    assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0);
  });
}
test('healthy diagnostic owns callback before delayed cleanup and preserves output ownership', async () => {
  const wrote = deferred(), entered = deferred(), closing = deferred(); let callback, returns = 0, settled = false;
  const input = { [Symbol.asyncIterator]() { return this; }, next() { return Promise.resolve({ done: false, value: '{\n' }); }, return() { returns++; entered.resolve(); return closing.promise; } };
  const output = new Writable({ highWaterMark: 1, write(chunk, encoding, cb) { callback = cb; wrote.resolve(); } });
  const operation = run(['read', file, '--session', '--allow-read'], output, input).then(code => { settled = true; return code; });
  await bounded(wrote.promise); assert.equal(returns, 0); assert.equal(settled, false);
  callback(); await bounded(entered.promise); assert.equal(settled, false); assert.equal(returns, 1);
  closing.resolve({ done: true }); assert.equal(await bounded(operation), 2); assert.equal(output.writableEnded, false);
  assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0); output.end();
});
for (const kind of ['throw', 'false']) test('write-only sink '+kind+' settles failure without waiting on external cleanup', async () => {
  let returns = 0; const first = new Error('SYNC_OUTPUT_FAILURE');
  const input = { [Symbol.asyncIterator]() { return this; }, next() { return Promise.resolve({ done: false, value: '{\n' }); }, return() { returns++; return new Promise(() => {}); } };
  const output = { write() { if (kind === 'throw') throw first; return false; } };
  await assert.rejects(bounded(run(['read', file, '--session', '--allow-read'], output, input)), error => kind === 'throw' ? error === first : error.message === 'KDNA_CLI_OUTPUT_UNAVAILABLE');
  assert.equal(returns, 1);
});
for (const kind of ['throw', 'reject']) test('healthy output retains original cleanup '+kind+' identity', async () => {
  const first = new Error('ORIGINAL_CLEANUP_FAILURE'); let returns = 0;
  const input = { [Symbol.asyncIterator]() { return this; }, next() { return Promise.resolve({ done: false, value: '{\n' }); }, return() { returns++; if (kind === 'throw') throw first; return Promise.reject(first); } };
  const output = new Writable({ write(chunk, encoding, cb) { cb(); } });
  await assert.rejects(bounded(run(['read', file, '--session', '--allow-read'], output, input)), error => error === first);
  assert.equal(returns, 1); assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0); output.end();
});
test('external failure during pending write keeps first error when callback rejects later', async () => {
  const wrote = deferred(); let callback; const first = new Error('FIRST_TERMINAL_ERROR');
  const output = new Writable({ write(chunk, encoding, cb) { callback = cb; wrote.resolve(); } });
  const operation = run(['--version'], output).then(code => ({ code }), error => ({ error }));
  await bounded(wrote.promise); output.destroy(first); assert.equal((await bounded(operation)).error, first);
  callback(new Error('LATE_WRITE_CALLBACK_ERROR')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0);
});
test('whole run observes late admission after output failure without another output', async () => {
  let writes = 0; const first = new Error('ADMISSION_PHASE_OUTPUT_ERROR');
  const output = new Writable({ write(chunk, encoding, cb) { writes++; cb(); } });
  const operation = run(['inspect', file], output).then(code => ({ code }), error => ({ error }));
  output.destroy(first); assert.equal((await bounded(operation)).error, first);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(writes, 0); assert.equal(output.listenerCount('error'), 0); assert.equal(output.listenerCount('close'), 0);
});

for (const reason of [undefined, null, false, 0, '']) for (const phase of ['output', 'cleanup']) {
  test('terminal rejection keeps '+String(reason)+' identity from '+phase, async () => {
    let returns = 0;
    const input = { [Symbol.asyncIterator]() { return this; }, next() { return Promise.resolve({ done: false, value: '{\n' }); }, return() { returns++; return phase === 'cleanup' ? Promise.reject(reason) : new Promise(() => {}); } };
    const output = { write() { if (phase === 'output') throw reason; return true; } };
    const result = await bounded(run(['read', file, '--session', '--allow-read'], output, input).then(code => ({ rejected: false, code }), error => ({ rejected: true, error })));
    assert.equal(result.rejected, true); assert.equal(result.error, reason); assert.equal(returns, 1);
  });
}
