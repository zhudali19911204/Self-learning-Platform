import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMaterialPlanningCache } from '../desktop/material-planning-cache.mjs';
import { createFullMaterialPlanningReader, fullMaterialBatches, MATERIAL_PLANNING_CACHE_ENTRIES } from '../src/courses/course-material-planning.mjs';
import { createLLM } from '../src/models/llm.mjs';
import { createApp } from '../src/server.mjs';
import { demoPlan } from '../public/demo.js';
import { validMaterialCoverage } from '../public/material-coverage.js';

const material=()=>({version:1,id:'a'.repeat(64),name:'Reference.md',type:'md',bytes:50000,importedAt:1000,parts:Array.from({length:45},(_,i)=>({id:`part-${i+1}`,location:`Page ${i+1}`,text:`Topic ${i+1}: `+'Original reference text. '.repeat(40)}))});
const reply=input=>({title:'Reference topics',topics:[{title:'Related methods',scope:'Names, purposes and prerequisite topics; details stay in the original text.',partIds:input.parts.map(p=>p.id)}]});
const model=change=>createLLM({env:{},provider:'compatible',model:'mock',baseUrl:'http://localhost:9000/v1',...change});
async function setup(t){
  const directory=await mkdtemp(path.join(tmpdir(),'learnflow-material-index-'));
  let cache=createMaterialPlanningCache(directory);
  t.after(async()=>{cache.close();await rm(directory,{recursive:true,force:true});});
  return {directory,get cache(){return cache;},restart(){cache.close();cache=createMaterialPlanningCache(directory);return createFullMaterialPlanningReader({cache});}};
}

test('validated batches survive a failed scan and process restart; reimport timestamps do not force paid rereads',async t=>{
  const f=await setup(t),materials=[material()],count=fullMaterialBatches(materials).length;
  let read=createFullMaterialPlanningReader({cache:f.cache}),calls=0;
  await assert.rejects(read(materials,{model:model(),generate:async(_p,input,validate)=>{
    if(++calls===2)throw new Error('mock interruption');
    validate(reply(input));
  }}),/mock interruption/);
  read=f.restart();calls=0;
  materials[0].importedAt++;
  const result=await read(materials,{model:model(),generate:async(_p,input,validate)=>{calls++;validate(reply(input));}});
  assert.equal(calls,count-1);assert.equal(result.materialUnits.length,count);
  read=f.restart();
  const restored=await read(materials,{model:model(),generate:async()=>{throw new Error('must reuse every batch');}});
  assert.deepEqual(restored,result);
  for(const change of [{model:'other'},{baseUrl:'http://localhost:9001/v1'},{thinkingMode:'off'},{maxTokens:1024}]){
    let reread=0;await read(materials,{model:model(change),generate:async(_p,input,validate)=>{reread++;validate(reply(input));}});
    assert.equal(reread,count);
  }
  const changed=structuredClone(materials);changed[0].parts[0].text+='changed';let reread=0;
  await read(changed,{model:model(),generate:async(_p,input,validate)=>{reread++;validate(reply(input));}});
  assert.equal(reread,1);
});

test('persistent cache is bounded, stores no model credentials or original paragraphs, and rejects damaged JSON explicitly',async t=>{
  const f=await setup(t),key=i=>i.toString(16).padStart(64,'0'),value=reply({parts:[{id:'part-1'}]});
  for(let i=0;i<=MATERIAL_PLANNING_CACHE_ENTRIES;i++)f.cache.set(key(i),value);
  assert.equal(f.cache.get(key(0)),null);assert.deepEqual(f.cache.get(key(MATERIAL_PLANNING_CACHE_ENTRIES)),value);
  const db=new DatabaseSync(path.join(f.directory,'material-planning-cache.sqlite'));
  try{
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM material_indexes').get().n,MATERIAL_PLANNING_CACHE_ENTRIES);
    db.prepare('UPDATE material_indexes SET index_json=? WHERE cache_key=?').run('{broken',key(1));
    assert.throws(()=>f.cache.get(key(1)),error=>error.status===503&&/缓存无法读写/.test(error.message));
  }finally{db.close();}
  assert.throws(()=>f.cache.set('../unsafe',value),/缓存无法读写/);
  assert.throws(()=>f.cache.set(key(999),'x'.repeat(16001)),/缓存无法读写/);
});

test('cache I/O failure stops before generation rather than silently charging again',async t=>{
  const f=await setup(t);f.cache.close();
  await writeFile(path.join(f.directory,'material-planning-cache.sqlite'),'not a database');
  let calls=0;
  await assert.rejects(createFullMaterialPlanningReader({cache:f.cache})([material()],{model:model(),generate:async()=>{calls++;}}),error=>error.status===503&&/未自动重新调用模型/.test(error.message));
  assert.equal(calls,0);
});

test('server preview consumes compact indexes and reuses them across server and cache restarts',async t=>{
  const f=await setup(t),materials=[material()];let reads=0,plans=0;
  const config={env:{},provider:'compatible',model:'mock',baseUrl:'http://localhost:9000/v1',maxTokens:32768,fetchImpl:async(_url,options)=>{
    const payload=JSON.parse(options.body),input=JSON.parse(payload.messages[1].content);
    let value;
    if(input.task==='read-all-materials'){
      reads++;assert.equal(payload.max_tokens,4096);value=reply(input);
      value.topics.push({title:'Another concept',scope:'A shared passage also explains a related boundary.',partIds:[input.parts[0].id]});
    }else{
      plans++;assert.equal(payload.max_tokens,32768);assert.deepEqual(input.learningMaterials,[]);
      assert.ok(input.materialUnits.every(u=>u.summary.includes('Related methods')&&!u.summary.includes('Original reference text')));
      value={...structuredClone(demoPlan),lessons:demoPlan.lessons.slice(0,3).map(l=>({...l,minutes:20})),materialAssignments:input.materialUnits.map(u=>({unitId:u.id,lessonIndexes:[1]}))};
    }
    return Response.json({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]});
  }};
  for(let run=0;run<2;run++){
    if(run)f.restart();
    const server=createApp({...config,getPlanningMaterials:()=>materials,materialPlanningCache:f.cache});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const response=await fetch(`http://127.0.0.1:${server.address().port}/api/plan`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goal:'Learn all reference methods',level:'零基础',daily:25,days:14,materialIds:[materials[0].id]})});
      const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));
      assert.equal(validMaterialCoverage(value.materialCoverage,materials,value.lessons.length),true);
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  }
  assert.equal(reads,fullMaterialBatches(materials).length);assert.equal(plans,2);
  const db=new DatabaseSync(path.join(f.directory,'material-planning-cache.sqlite'),{readOnly:true});
  try{
    const saved=db.prepare('SELECT cache_key,index_json FROM material_indexes').all();
    assert.ok(saved.every(row=>/^[a-f0-9]{64}$/.test(row.cache_key)&&!row.index_json.includes('Original reference text')&&!row.index_json.includes('http://localhost')));
  }finally{db.close();}
});
