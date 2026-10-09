'use strict';
const test = require('node:test');
const {before,after} = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {Readable} = require('node:stream');
const {run} = require('../src/public-cli.js');
const binding = require('../public-contract-binding.json');
const {fixture,claims,ext}=require('./helpers/native-components.cjs');
let scratch,file,serial=0;
const request=(mode='exact_selection')=>({request_id:'cli:components',tuple:binding.tuple,budget_bytes:1000000,mode,selection:mode==='catalog'?null:{asset_id:'asset:bytes',asset_version:'1.0.0',judgment_ids:['j:0']},handle:null});
async function invoke(args,requests=[]){const lines=[];const code=await run(args,{write(t){lines.push(t);return true;}},Readable.from(requests.map(r=>JSON.stringify(r)+'\n')));return {code,rows:lines.join('').trim().split('\n').filter(Boolean).map(JSON.parse)};}
async function create(asset){const id=++serial,input=path.join(scratch,id+'.json'),output=path.join(scratch,id+'.kdna');fs.writeFileSync(input,JSON.stringify(asset));return {...await invoke(['create',input,'--output',output,'--allow-create']),file:output};}
before(async()=>{scratch=fs.mkdtempSync(path.join(os.tmpdir(),'cli-native-components-'));const r=await create(fixture().asset);assert.equal(r.code,0,JSON.stringify(r.rows));file=r.file;});
after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
test('native create, inspect, validate and retained Read preserve three supported profiles and authored roles',async()=>{
 for(const command of ['inspect','validate']){const r=await invoke([command,file]);assert.equal(r.code,0);assert.equal(r.rows[0].status,'accepted');assert.equal(r.rows[0].states.action_authorization,'not_evaluated');assert.equal(r.rows[0].content,undefined);}
 const r=await invoke(['read',file,'--session','--allow-read'],[request('catalog'),request(),request()]);assert.equal(r.code,0);assert.equal(r.rows[0].envelope.status,'catalog_only');assert.equal(new Set(r.rows.map(x=>x.envelope.snapshot_id)).size,1);
 const judgment=r.rows[1].envelope.content.closure.find(n=>n.role==='judgment'&&n.value.id==='j:0');
 assert.deepEqual(judgment.value.method.components.map(c=>c.role),['识别特征','类别定义','匹配办法','易混淆情况']);
 const interpretations=judgment.method_interpretation.component_interpretations;
 assert.deepEqual([...new Set(interpretations.map(c=>c.component_type))].sort(),['candidate-set','discriminator-set','taxonomy']);assert.ok(interpretations.every(c=>c.status==='supported'));
 assert.equal(interpretations.find(c=>c.component_type==='taxonomy').body.broader.length,2);assert.equal(interpretations.find(c=>c.component_type==='discriminator-set').body.items[0].contrasts.length,2);
 assert.deepEqual(r.rows[1].envelope.content.closure,r.rows[2].envelope.content.closure);
 assert.equal(r.rows[1].envelope.states.action_authorization,'not_evaluated');
});
for(const [name,mutate,reason] of [
 ['component definition',a=>{a.payload.judgments[0].extensions[0].value.fields.find(f=>f.name==='definition_digest').value.value='sha256:'+'0'.repeat(64);},'READ_COMPONENT_DECLARATION_INVALID'],
 ['content digest',a=>{a.payload.judgments[0].extensions[0].value.fields.find(f=>f.name==='content_digest').value.value='sha256:'+'0'.repeat(64);},'READ_COMPONENT_BINDING_INVALID'],
 ['declaration digest',a=>{a.payload.judgments[0].extensions[0].value.fields.find(f=>f.name==='component_declaration_digest').value.value='sha256:'+'0'.repeat(64);},'READ_COMPONENT_BINDING_INVALID'],
 ['bindings digest',a=>{a.payload.judgments[0].extensions[0].value.fields.find(f=>f.name==='bindings_digest').value.value='sha256:'+'0'.repeat(64);},'READ_COMPONENT_BINDING_INVALID'],
 ['adoption definition',a=>{a.payload.extensions[0].value.fields.find(f=>f.name==='definition_digest').value.value='sha256:'+'0'.repeat(64);},'READ_COMPONENT_ADOPTION_INVALID'],
 ['aggregate declaration',a=>{a.payload.extensions[0].value.fields.find(f=>f.name==='declaration_set_digest').value.value='sha256:'+'0'.repeat(64);},'READ_COMPONENT_ADOPTION_INVALID'],
 ['aggregate proposal',a=>{a.payload.extensions[0].value.fields.find(f=>f.name==='proposal_set_digest').value.value='sha256:'+'0'.repeat(64);},'READ_COMPONENT_ADOPTION_INVALID'],
 ['criticality',a=>{a.payload.judgments[0].extensions[0].critical=false;},'READ_COMPONENT_DECLARATION_INVALID'],
 ['duplicate carrier field',a=>{const f=a.payload.judgments[0].extensions[0].value.fields;f.push(structuredClone(f[0]));},'READ_COMPONENT_DECLARATION_INVALID'],
 ['authored statement mismatch',a=>{a.payload.judgments[0].method.components[0].statement='Changed without re-adoption';},'READ_COMPONENT_BINDING_INVALID'],
 ['missing aggregate',a=>{a.payload.extensions=[];},'READ_COMPONENT_ADOPTION_INVALID'],
])test('native component creation rejects '+name+' without saving or disclosing',async()=>{
 const a=fixture().asset;mutate(a);const r=await create(a);assert.equal(r.code,1);assert.equal(fs.existsSync(r.file),false);assert.equal(r.rows[0].status,'core_rejected');
 assert.equal(r.rows[0].core.status,'rejected'); assert.equal(r.rows[0].core.reason,reason); assert.equal(r.rows[0].body,null); assert.equal(r.rows[0].body_bytes,0);assert.equal(r.rows[0].bytes,undefined);assert.equal(r.rows[0].snapshot,undefined);
});
for(const [name,edit,reason] of [
 ['taxonomy cycle',x=>x.contents[3].content.broader.push({narrowerKey:'first',broaderKey:'shared'}),'READ_COMPONENT_GRAPH_CYCLE'],
 ['missing candidate',x=>x.contents[0].content.items[0].contrasts[0].candidateKey='absent','READ_COMPONENT_REFERENCE_INVALID'],
 ['invalid content',x=>x.contents[1].content.items[0].meaning=' trailing ','READ_COMPONENT_CONTENT_INVALID'],
 ['item limit',x=>x.contents[2].content.items=Array.from({length:129},(_,i)=>({key:'n'+i,title:'Candidate',meaning:'Synthetic meaning'})),'READ_COMPONENT_LIMIT_EXCEEDED'],
])test('native component creation preserves rebuilt-claim '+name+' classification',async()=>{const x=fixture();edit(x);const r=await create(claims(x.asset,x.contents));assert.equal(r.code,1);assert.equal(fs.existsSync(r.file),false);assert.ok(JSON.stringify(r.rows[0]).includes(reason),JSON.stringify(r.rows[0]));});
test('unopted typed meanings stay undeclared, current authored roles stay declared',async()=>{
 const a=fixture().asset,j=a.payload.judgments[0];j.extensions=[];a.payload.extensions=[];j.method.bindings=j.method.bindings.map(({target_ref,...b})=>({...b,target:{kind:'judgment',id:target_ref}}));
 const c=await create(a);assert.equal(c.code,0,JSON.stringify(c.rows));const r=await invoke(['read',c.file,'--session','--allow-read'],[request()]);assert.equal(r.code,0);
 const m=r.rows[0].envelope.content.closure.find(n=>n.role==='judgment'&&n.value.id==='j:0').method_interpretation;assert.ok(m.component_interpretations.every(c=>c.status==='undeclared'&&c.body===null));assert.deepEqual(m.declaration_presence,{components_state:'declared',bindings_state:'declared'});
});
test('native component read keeps consent, zero budget and mixed tuple boundaries',async()=>{
 const denied=await invoke(['read',file]);assert.equal(denied.code,1);assert.deepEqual(denied.rows[0],{status:'rejected',code:'KDNA_READ_PERMISSION_REQUIRED',action_authorized:false});
 const zero=await invoke(['read',file,'--allow-read','--budget','0']);assert.equal(zero.code,1);assert.equal(zero.rows[0].channel,'no_body_control');assert.equal(zero.rows[0].control.body_bytes,0);
 const wrong=request();wrong.tuple={...wrong.tuple,read:'kdna.read/0.2.0'};const r=await invoke(['read',file,'--session','--allow-read'],[wrong]);assert.equal(r.code,1);assert.equal(r.rows[0].diagnostic.code,'READ_MIXED_VERSION_TUPLE');assert.equal(r.rows[0].body,null);assert.equal(r.rows[0].body_bytes,0);
});
