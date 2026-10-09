'use strict';
// Synthetic component declarations adapted from the Apache-2.0 Core public
// component conformance model. No real author/Agent adoption is asserted.
const {getComponentSemanticsContract}=require('@aikdna/kdna-core/components');
const {executionDigest}=require('@aikdna/kdna-core/execution');
const descriptor=getComponentSemanticsContract();
const compareUtf8=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
function canonicalJson(x){if(x===null||typeof x!=='object')return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonicalJson).join(',')+']';return '{'+Object.keys(x).sort(compareUtf8).map(k=>JSON.stringify(k)+':'+canonicalJson(x[k])).join(',')+'}';}
const H=x=>'sha256:'+require('node:crypto').createHash('sha256').update(canonicalJson(x)).digest('hex');
function value(x){if(x===null)return {kind:'null'};if(Array.isArray(x))return {kind:'list',items:x.map(value)};if(typeof x==='object')return {kind:'record',fields:Object.entries(x).map(([name,x])=>({name,value:value(x)}))};return {kind:typeof x==='string'?'text':typeof x,value:x};}
function ext(kind,x){const c=kind==='presence'?{id:'kdna.method-declaration-presence/1',definition:'Authored method field presence for KDNA public component semantics 1.0.0.'}:descriptor.carriers[kind];return {id:c.id,critical:true,definition:c.definition,value:value(x)};}
function claims(asset,contents){
 const j=asset.payload.judgments[0];j.method={method:{term:'recognition'},components:contents.map((x,i)=>({id:x.id,method:{term:'recognition'},role:['识别特征','类别定义','匹配办法','易混淆情况'][i],material_refs:[],statement:'Synthetic authored role '+i+': '+canonicalJson(x.content)})),bindings:[{component_ref:'j:0:candidates',role:'observations',target_ref:j.id},{component_ref:'j:0:candidates',role:'comparison-context',target_ref:j.id}]};
 const declarations=contents.map(x=>{
  const c=j.method.components.find(c=>c.id===x.id);const bindings=j.method.bindings.filter(b=>b.component_ref===c.id).sort((a,b)=>compareUtf8(a.role,b.role)||compareUtf8(a.target_ref,b.target_ref));
  return {contract_id:descriptor.contract_id,contract_version:descriptor.contract_version,definition_digest:descriptor.definition_digest,judgment_ref:j.id,component_ref:c.id,component_type:x.type,profile_id:descriptor.profiles.find(p=>p.component_type===x.type).profile_id,content:x.content,content_digest:H(x.content),component_declaration_digest:H({component:c,statement_origin:'authored'}),statement_origin:'authored',bindings_digest:H(bindings),adoption_proposal_digest:H({synthetic_fixture:true,component:c.id,content:x.content})};
 });
 j.extensions=declarations.map(d=>ext('component',d));
 // This is a static, deliberately synthetic fixture record. It proves no
 // actual Agent/editor adoption, human confirmation or strong Creation.
 asset.payload.extensions=[ext('adoption',{contract_id:descriptor.contract_id,contract_version:descriptor.contract_version,definition_digest:descriptor.definition_digest,declaration_set_digest:H(declarations.slice().sort((a,b)=>compareUtf8(a.judgment_ref,b.judgment_ref)||compareUtf8(a.component_ref,b.component_ref))),proposal_set_digest:H([...new Set(declarations.map(d=>d.adoption_proposal_digest))].sort(compareUtf8)),decision_digest:H('synthetic test decision only'),adoption_kind:'delegated_agent_editorial'})];return asset;
}
function fixture(){
 const contents=[{id:'j:0:discriminators',type:'discriminator-set',content:{candidateSetRef:'j:0:candidates',items:[{key:'evidence',title:'具体证据',prompt:'查看来源和实际输入',contrasts:[{candidateKey:'retrieval',criterion:'来源存在但未取到。'},{candidateKey:'source',criterion:'来源原文缺少所需信息。'}]}]}},{id:'j:0:candidates',type:'candidate-set',content:{items:[{key:'source',title:'来源问题',meaning:'原材料可能缺少证据。'},{key:'retrieval',title:'检索问题',meaning:'取回的内容可能不足。'}]}},{id:'j:0:other-candidates',type:'candidate-set',content:{items:[]}},{id:'j:0:taxonomy',type:'taxonomy',content:{items:[{key:'shared',title:'共享类别',meaning:'属于两个父类。'},{key:'first',title:'相同名称',meaning:'第一个父类。'},{key:'second',title:'相同名称',meaning:'第二个父类。'}],broader:[{narrowerKey:'shared',broaderKey:'second'},{narrowerKey:'shared',broaderKey:'first'}]}}];return {asset:claims(structuredClone(require('../fixtures/native-graph-cross.authored.json')),contents),contents};
}

module.exports={fixture,claims,ext};
