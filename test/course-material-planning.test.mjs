import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { directMaterialPlanning, fullMaterialBatches, prepareFullMaterialPlanning, materialAssignmentIssue, savedMaterialCoverage, createFullMaterialPlanningReader, materialPlanningCallCount } from '../course-material-planning.mjs';
import { validMaterialCoverage, materialCoverageParts } from '../public/material-coverage.js';
import { withGenerationSignal, generationAwait } from '../generation-cancellation.mjs';
import { createApp } from '../server.mjs';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { createCoursePackage, instantiateCoursePackage } from '../desktop/course-sharing.mjs';
import { validState } from '../desktop/local-store.mjs';
import { demoPlan } from '../public/demo.js';

const makeMaterial=(count=19)=>({version:1,id:'a'.repeat(64),name:'Purchasing guide.md',type:'md',bytes:10000,importedAt:1000,
  parts:Array.from({length:count},(_,i)=>({id:`part-${i+1}`,location:`第 ${i+1} 页`,text:i===7?'Repeated document header\n2.1.1 Deliveries from stocks\ncost price + storage and shipping costs = total cost\n+ 3.0 % markup = transfer price':`Repeated document header\nSection text ${i+1}: keep the original text and all applicable conditions.`}))});
const longMaterial=()=>({...makeMaterial(55),parts:makeMaterial(55).parts.map((p,i)=>({...p,text:p.text+'\n'+`Original paragraph ${i+1}. `.repeat(45).slice(0,850)}))});
const assign=(context)=>context.materialUnits.map((u,i)=>({unitId:u.id,lessonIndexes:[i%3+1]}));
const planFor=(context)=>({...structuredClone(demoPlan),lessons:demoPlan.lessons.slice(0,3).map((l,i)=>({...l,id:`full-material-lesson-${i}`,minutes:20})),materialAssignments:assign(context)});
const readReply=input=>({title:'完整章节知识清单',parts:input.parts.map(p=>({partId:p.id,summary:p.text.slice(0,450)}))});

test('small-library planning includes every original part, including late formulas and foreign-language rules, without another model request',async()=>{
  const materials=[makeMaterial()],context=directMaterialPlanning(materials);
  assert.equal(context.materialReading,'full-text');assert.equal(context.materialUnits.length,19);
  assert.equal(materialPlanningCallCount(materials),2);
  for(const [i,u]of context.materialUnits.entries()){assert.equal(u.text,materials[0].parts[i].text);assert.deepEqual(u.partIds,[`part-${i+1}`]);}
  assert.match(context.materialUnits[7].text,/3.0 % markup/);assert.equal(context.materialUnits[7].title,'2.1.1 Deliveries from stocks');
  let calls=0;const actual=await prepareFullMaterialPlanning(materials,{generate:()=>{calls++;}});assert.deepEqual(actual,context);assert.equal(calls,0);
});

test('large libraries are read in complete ordered batches and every original part is accounted for before planning',async()=>{
  const materials=[longMaterial()],original=structuredClone(materials),batches=fullMaterialBatches(materials),seen=[],events=[];
  assert.equal(directMaterialPlanning(materials),null);assert.ok(batches.length>1);
  assert.equal(materialPlanningCallCount(materials),batches.length+2);
  assert.deepEqual(batches.flatMap(b=>b.parts.map(p=>p.id)),materials[0].parts.map(p=>p.id));
  const context=await prepareFullMaterialPlanning(materials,{notify:s=>events.push(s),generate:async(prompt,input,validate)=>{
    assert.match(prompt,/每个part/);assert.equal(input.task,'read-all-materials');seen.push(...input.parts.map(p=>p.id));assert.equal(validate(readReply(input)),true);
  }});
  assert.equal(context.materialReading,'full-batch-scan');assert.deepEqual(seen,materials[0].parts.map(p=>p.id));assert.deepEqual(context.materialUnits.flatMap(u=>u.partIds),seen);
  assert.equal(events.filter(s=>s==='reading_materials').length,batches.length);assert.equal(events.at(-1),'materials_ready');assert.deepEqual(materials,original);
});

test('batch readers cannot omit a page, invent IDs, repeat a page or return an empty summary',async()=>{
  for(const mode of ['missing','invented','duplicate','empty']){
    let calls=0;
    await assert.rejects(prepareFullMaterialPlanning([longMaterial()],{generate:async(_prompt,input,validate)=>{
      calls++;const value=readReply(input);if(mode==='missing')value.parts.pop();else if(mode==='invented')value.parts[0].partId='part-999';else if(mode==='duplicate')value.parts[1].partId=value.parts[0].partId;else value.parts[0].summary='';validate(value);
    }}),error=>error.status===422&&/全文资料整理/.test(error.message));assert.equal(calls,1);
  }
});

test('coverage validation blocks missing assignments, unknown IDs, invalid lesson numbers and hiding formulas as reference-only',()=>{
  const context=directMaterialPlanning([makeMaterial()]),value=planFor(context);assert.equal(materialAssignmentIssue(value,context),null);
  for(const mutate of [v=>v.materialAssignments.pop(),v=>v.materialAssignments[0].unitId='U999',v=>v.materialAssignments[0].lessonIndexes=[4],v=>v.materialAssignments[1].unitId='U1',v=>v.materialAssignments[0].lessonIndexes=[]]){
    const invalid=structuredClone(value);mutate(invalid);assert.ok(materialAssignmentIssue(invalid,context));
  }
  const hidden=structuredClone(value);hidden.materialAssignments[7]={unitId:'U8',lessonIndexes:[],referenceReason:'仅作辅助资料'};assert.match(materialAssignmentIssue(hidden,context),/不能仅作为辅助资料/);
  const reference=structuredClone(value);reference.materialAssignments[0]={unitId:'U1',lessonIndexes:[],referenceReason:'文件导航说明，不作为教学知识'};assert.equal(materialAssignmentIssue(reference,context),null);
  const coverage=savedMaterialCoverage(reference,context);assert.equal(validMaterialCoverage(coverage,[makeMaterial()],3),true);
});

test('only complete scans are cached; changed text and a different model require re-reading',async()=>{
  const read=createFullMaterialPlanningReader(),materials=[longMaterial()],model={},other={};let calls=0;
  const options=model=>({model,generate:async(_prompt,input,validate)=>{calls++;validate(readReply(input));}});
  const first=await read(materials,options(model)),count=calls;assert.ok(count>1);
  const second=await read(materials,options(model));assert.equal(calls,count);assert.deepEqual(second,first);second.materialUnits[0].title='externally mutated';
  assert.notEqual((await read(materials,options(model))).materialUnits[0].title,'externally mutated');
  const changed=structuredClone(materials);changed[0].parts[0].text+=' changed';await read(changed,options(model));assert.ok(calls>count);
  const before=calls;await read(materials,options(other));assert.ok(calls>before);
});

test('cancelling a full scan starts no later batch and leaves no partial cache',async()=>{
  const read=createFullMaterialPlanningReader(),controller=new AbortController(),model={},materials=[longMaterial()];let entered,calls=0;
  const started=new Promise(resolve=>{entered=resolve;});
  const work=withGenerationSignal(controller.signal,()=>read(materials,{model,generate:async()=>{calls++;entered();await generationAwait(new Promise(()=>{}));}}));
  const rejected=assert.rejects(work,error=>error.code==='GENERATION_CANCELLED');await started;controller.abort();await rejected;assert.equal(calls,1);
  await read(materials,{model,generate:async(_prompt,input,validate)=>{calls++;validate(readReply(input));}});assert.ok(calls>2);
});

async function serve(t,handler,materials=[makeMaterial()],extra={}){
  const calls=[];const model={generate:async(prompt,input,validate)=>{
    calls.push({prompt,input:structuredClone(input)});const value=await handler(input,calls.length);
    if(!validate(value))throw Object.assign(new Error('结构不符合要求'),{status:502});return value;
  }};
  const server=createApp({getLLM:()=>model,getPlanningMaterials:()=>materials,...extra});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {calls,post:(endpoint='plan',input={goal:'学习材料计算规则',level:'零基础',daily:25,days:14,materialIds:materials.map(m=>m.id)})=>fetch(`http://127.0.0.1:${server.address().port}/api/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})};
}

test('plan endpoint receives the complete source and repairs a missing final assignment exactly once',async t=>{
  const f=await serve(t,(input,count)=>{assert.equal(input.materialUnits.length,19);assert.deepEqual(input.learningMaterials,[]);const v=planFor(input);if(count===1)v.materialAssignments.pop();return v;});
  const response=await f.post();assert.equal(response.status,200);const value=await response.json();assert.equal(f.calls.length,2);assert.match(f.calls[1].prompt,/漏安排1项资料单元/);
  assert.equal(validMaterialCoverage(value.materialCoverage,value.materials,value.lessons.length),true);assert.equal(value.materialCoverage.units.length,19);
});

test('repeated omission fails the outline, and insufficient time never saves a partial plan or retries the model',async t=>{
  const missing=await serve(t,input=>{const value=planFor(input);value.materialAssignments.pop();return value;});const response=await missing.post();assert.equal(response.status,502);assert.match((await response.json()).error,/漏安排/);assert.equal(missing.calls.length,2);
  const short=await serve(t,()=>({materialPlanningInsufficient:true,reason:'完整资料包含多个复杂流程，需要更长学习时间'}));const insufficient=await short.post();assert.equal(insufficient.status,422);assert.match((await insufficient.json()).error,/未保存部分大纲/);assert.equal(short.calls.length,1);
});

test('course material coverage survives SQLite, full backups and new-ID course sharing and supplies the correct lesson sources',async t=>{
  const material=makeMaterial(),context=directMaterialPlanning([material]),value=planFor(context),coverage=savedMaterialCoverage(value,context);
  const plan={...value,id:'full-material-plan',goal:'完整学习资料',daily:25,days:14,source:'ai',materials:[material],materialCoverage:coverage};
  const state={version:1,plans:[plan],active:plan.id,lessons:{},progress:{},notes:[],reflections:{},chats:{}};assert.equal(validState(state),true);
  assert.deepEqual(materialCoverageParts(undefined,'absent'),[]);assert.deepEqual(materialCoverageParts(plan,'absent'),[]);
  const selected=materialCoverageParts(plan,plan.lessons[1].id);assert.ok(selected.some(p=>p.partId==='part-8'));
  const invalid=structuredClone(state);invalid.plans[0].materialCoverage.units.pop();assert.equal(validState(invalid),false);
  const directory=await mkdtemp(path.join(tmpdir(),'learnflow-full-material-'));assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));
  let store=await createSqliteStore(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});store.savePlan(plan);store.close();store=await createSqliteStore(directory);
  assert.deepEqual(store.overview().plans.find(p=>p.id===plan.id).materialCoverage,coverage);
  const backup=store.exportState();await store.replaceState(backup);assert.deepEqual(store.overview().plans.find(p=>p.id===plan.id).materialCoverage,coverage);
  const packed=createCoursePackage(plan,id=>store.getLesson(id)),shared=instantiateCoursePackage(packed);assert.deepEqual(shared.plans[0].materialCoverage,coverage);assert.notEqual(shared.plans[0].lessons[1].id,plan.lessons[1].id);assert.deepEqual(materialCoverageParts(shared.plans[0],shared.plans[0].lessons[1].id),selected);
  const imported=store.importCoursePackage(packed),copy=store.overview().plans.find(p=>p.id===imported.planId);assert.deepEqual(copy.materialCoverage,coverage);
  await store.deletePlan(imported.planId);assert.equal(store.exportState().plans.some(p=>p.id===imported.planId),false);
});

test('lesson-outline retrieval prioritizes the assigned original page in a foreign-language file',async t=>{
  const materials=[makeMaterial()],f=await serve(t,input=>{
    assert.ok(input.learningMaterials[0].excerpts.some(e=>e.partId==='part-17'));
    return {intro:'按原文安排教学。',blocks:[{type:'reading',title:'计算规则',objective:'理解规则'},{type:'example',title:'规则应用',objective:'观察完整推演'},{type:'quiz',title:'规则检验',objective:'判断适用边界'}]};
  },materials,{getCourseMaterials:()=>materials,getCourseMaterialParts:()=>[{materialId:materials[0].id,partId:'part-17'}]});
  const response=await f.post('lesson-outline',{lessonId:'lesson-1',goal:'学习计算',level:'零基础',title:'费用计算',objective:'解释计算规则'});assert.equal(response.status,200);assert.equal(f.calls.length,1);
});
