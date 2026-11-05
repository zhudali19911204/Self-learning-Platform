import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readMaterialBuffer } from '../desktop/material-reader.mjs';
import { wordFixture,pdfFixture } from '../test-support/materials.mjs';
import { validMaterial,validMaterials,localMaterialSource,MATERIAL_CONTEXT_LIMITS } from '../public/materials.js';
import { materialDocuments,materialCatalog,materialContextParts } from '../src/courses/course-materials.mjs';
import { blockGenerationContext,validBlockCourse } from '../public/blocks.js';
import { validGrounding,groundedContent,officialSource,sourceCitationIssue } from '../public/course-sources.js';
import { withInlineCourseCitations } from '../src/courses/course-inline-citations.mjs';
import { createApp } from '../src/server.mjs';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { createCoursePackage,instantiateCoursePackage } from '../desktop/course-sharing.mjs';
import { demoPlan } from '../public/demo.js';
import { factContent } from '../public/fact-check.js';
const material={version:1,id:'a'.repeat(64),name:'操作手册.md',type:'md',bytes:100,importedAt:1700000000000,parts:[{id:'part-1',location:'第 1–3 行',text:'保存文件后应重新打开文件，确认文件名、保存位置与内容正确。'}]};
const makePlan=()=>({...structuredClone(demoPlan),id:'material-course',materials:[structuredClone(material)],lessons:demoPlan.lessons.slice(0,3).map((l,i)=>({...l,id:`material-lesson-${i}`,minutes:20}))});
const library=()=>Array.from({length:20},(_,i)=>({...structuredClone(material),id:(i+1).toString(16).padStart(64,'0'),name:`资料-${i+1}.md`,parts:[{id:'part-1',location:`第 ${i+1} 页`,text:i===19?'sensor_zx9 的校准温度阈值为37摄氏度，校准失败时应重新采样。':`背景记录 ${i+1}：保存文件后需要重新打开核对文件名、目录与内容。`}]}));

function crossLanguageFixture() {
 const imported={...structuredClone(material),name:'Calibration guide.md',parts:Array.from({length:19},(_,i)=>({id:`part-${i+1}`,location:`第 ${i+1} 页`,text:i===9?'Calibration uses the provided reference value; confirm the measurement unit before classifying samples.':`Appendix entry ${i+1}: background and navigation.`}))};
 const part=imported.parts[9],docs=[{id:'S1',url:`learnflow-material:${imported.id}`,title:imported.name,publisher:'用户导入资料',retrievedAt:imported.importedAt,excerpts:[{id:'S1E1',text:part.text,partId:part.id,location:part.location}]}];
 const draft=withInlineCourseCitations('reading',{text:'校准与分类前，应核对给定参考值和计量单位。[S1E1]'});
 const course={intro:'依据导入资料练习校准。',blocks:[{id:'source-reading',type:'reading',title:'校准与分类规则',objective:'核对参考值及单位',content:{text:draft.text,grounding:groundedContent('reading',draft,docs)}},{id:'target-practice',type:'practice',title:'实操练习：校准并归类测量数据',objective:'使用教学示例数据练习校准与分类',content:null},{id:'target-quiz',type:'quiz',title:'检验校准',objective:'判断校准前提',content:null}]};
 const block=course.blocks[1],request={lessonId:'local-lesson',goal:'学习校准',level:'零基础',title:'仪器校准',objective:'核对参考值与计量单位',intro:course.intro,block:{type:block.type,title:block.title,objective:block.objective},...blockGenerationContext(course,block.id)};
 assert.equal(validBlockCourse(course),true);
 return {imported,course,request};
}

test('Chinese practice requests retain verified English source parts and adjacent split-page definitions',()=>{
 const {imported,course,request}=crossLanguageFixture(),original=structuredClone({imported,course,request});
 const preferred=materialContextParts([imported],request,course);assert.deepEqual(preferred,[{materialId:imported.id,partId:'part-10'}]);
 const docs=materialDocuments([imported],'校准并归类测量数据',{preferredParts:preferred}),parts=docs[0].excerpts.map(e=>e.partId);
 for(const id of ['part-9','part-10','part-11'])assert.ok(parts.includes(id),id);
 assert.ok(parts.length<=8);for(const e of docs[0].excerpts)assert.equal(e.text,imported.parts.find(p=>p.id===e.partId).text);
 assert.deepEqual({imported,course,request},original,'retrieval does not edit course text, source snapshots or requests');
 const all=[...library().slice(0,19),imported];
 const selected=materialDocuments(all,'保存文件',{preferredParts:preferred});assert.equal(selected[0].url,`learnflow-material:${imported.id}`);assert.ok(selected.length<=3);
});

test('material evidence priorities never trust client contexts, future blocks, edited claims or mismatched source files',()=>{
 const {imported,course,request}=crossLanguageFixture();
 assert.deepEqual(materialContextParts([imported],request),[]);
 assert.deepEqual(materialContextParts([imported],{...request,block:{...request.block,title:'另一个目标'}},course),[]);
 const modified=structuredClone(course);modified.blocks[0].content.text='原来知识已经被编辑删除，不能再提供旧引用。';
 assert.deepEqual(materialContextParts([imported],request,modified),[]);
 const changed=structuredClone(imported);changed.parts[9].text='The imported evidence was changed.';assert.deepEqual(materialContextParts([changed],request,course),[]);
 assert.deepEqual(materialContextParts([{...imported,id:'b'.repeat(64)}],request,course),[]);
 const future=structuredClone(course);future.blocks[0].content=null;future.blocks.push({...structuredClone(course.blocks[0]),id:'future-reading'});
 assert.deepEqual(materialContextParts([imported],request,future),[]);
 const forged=structuredClone(request);forged.teachingContext.sources[0].spans[0].text='用户伪造的来源文本';
 assert.deepEqual(materialContextParts([imported],forged,course),[{materialId:imported.id,partId:'part-10'}],'only server-owned spans determine evidence');
});

test('no-match fallback samples a long foreign-language document instead of only its first eight parts',()=>{
 const {imported}=crossLanguageFixture(),docs=materialDocuments([imported],'完全没有匹配词的中文目标'),parts=docs[0].excerpts.map(e=>e.partId);
 assert.ok(parts.includes('part-1'));assert.ok(parts.includes('part-10'));assert.ok(parts.includes('part-19'));assert.equal(parts.length,8);
});

test('practice generation sends the verified late source once, keeps search off and still rejects genuine insufficiency',async t=>{
 const {imported,course,request}=crossLanguageFixture();let calls=0,searches=0,insufficient=false;
 const server=createApp({getCourseMaterials:()=>[imported],getCourseBlockCourse:()=>course,courseSources:{prepare:async()=>{searches++;throw Error('must not search');}},getLLM:()=>({generate:async(_prompt,input,validate)=>{
   calls++;const part=input.officialDocuments[0].excerpts.find(e=>e.partId==='part-10');assert.ok(part,'the actual reference page must reach the model');assert.ok(input.officialDocuments[0].excerpts.length<=8);
   const result=insufficient?{sourceInsufficient:true}:{text:`教学示例：请核对参考值与计量单位后归类测量数据。[${part.id}]`};assert.equal(validate(result),true);return result;
 }})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 const post=()=>fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,sourceSearch:{enabled:true,revision:0}})});
 const response=await post();assert.equal(response.status,200);const result=await response.json();assert.equal(result.grounding.citations[0].partId,'part-10');assert.equal(result.grounding.citations[0].location,'第 10 页');
 insufficient=true;assert.equal((await post()).status,422);assert.equal(calls,2);assert.equal(searches,0);
});
test('a 20-file library retrieves relevant late files, reassigns citation IDs and rejects unused library IDs',()=>{
 const all=library();assert.equal(validMaterials(all),true);assert.equal(validMaterials([...all,{...material,id:'f'.repeat(64)}]),false);
 const docs=materialDocuments(all,'sensor_zx9 校准温度阈值');
 assert.equal(docs[0].url,`learnflow-material:${all[19].id}`);assert.equal(docs[0].id,'S1');assert.ok(docs.length<=3);
 assert.ok(!docs.some(d=>d.url===`learnflow-material:${all[0].id}`));
 const output=withInlineCourseCitations('reading',{text:'校准温度阈值为37摄氏度。[S1E1]'});
 const saved=groundedContent('reading',output,docs);assert.equal(validGrounding(saved),true);
 assert.equal(saved.citations[0].materialId,all[19].id);assert.equal(saved.citations[0].location,'第 20 页');
 const bad=withInlineCourseCitations('reading',{text:'错误地使用资料库序号。[S20E1]'});
 assert.match(sourceCitationIssue('reading',bad,docs),/未提供/);
 assert.equal(validGrounding({...saved,citations:[{...saved.citations[0],excerptId:'S20E1'}]}),false);
 const files=materialDocuments(all,'保存文件');assert.ok(files.every(d=>d.url!==`learnflow-material:${all[19].id}`));
});
test('library capacity and per-request text budget are independent; planning sees a bounded index of every file',()=>{
 const parts=n=>Array.from({length:Math.ceil(n/1100)},(_,i)=>({id:`part-${i+1}`,location:`第 ${i+1} 段`,text:'字'.repeat(Math.min(1100,n-i*1100))}));
 const million=library().slice(0,4).map(m=>({...m,parts:parts(250000)}));
 assert.equal(validMaterials(million),true);assert.equal(validMaterials([...million,material]),false);
 assert.equal(validMaterial({...material,parts:parts(300001)}),false);
 const all=library().map(m=>({...m,parts:Array.from({length:20},(_,i)=>({id:`part-${i+1}`,location:`第 ${i+1} 段`,text:'校准参数'.repeat(275)}))}));
 assert.equal(validMaterials(all),true);
 for(const planning of [false,true]) {
  const docs=materialDocuments(all,'校准参数',{planning});
  assert.equal(docs.length,3);assert.ok(docs.every(d=>d.excerpts.length<=8));
  const size=docs.reduce((n,d)=>n+d.excerpts.reduce((a,e)=>a+e.text.length,0),0);
  assert.ok(size<=MATERIAL_CONTEXT_LIMITS.characters);assert.equal(size,19800);
 }
 const catalog=materialCatalog(all);assert.equal(catalog.length,20);
 assert.ok(catalog.every(m=>m.samples.length<=3&&m.samples.every(s=>s.text.length<=80)));
 assert.equal(materialDocuments([],'empty').length,0);
});
test('real PDF, DOCX and UTF-8 imports preserve text and honest positions; scans and invalid files fail',async()=> {
 const md=await readMaterialBuffer(Buffer.from('# 操作手册\n\n保存文件后应重新打开文件，核对文件名、位置与内容。'),'操作.md');
 assert.equal(validMaterial(md),true);assert.match(md.parts[0].location,/行/);assert.match(md.parts[0].text,/保存/);
 const word=await readMaterialBuffer(await wordFixture('保存文件之后，应重新打开核对文件名、目录和实际内容。\n不要把快捷方式当作原文件。'),'手册.docx');
 assert.equal(word.parts[1].location,'第 2 段');assert.match(word.parts[1].text,/快捷方式/);
 const pdf=await readMaterialBuffer(pdfFixture(),'guide.pdf');
 assert.deepEqual(pdf.parts.map(p=>p.location),['第 1 页','第 2 页']);assert.match(pdf.parts[1].text,/destination folder/);
 await assert.rejects(readMaterialBuffer(pdfFixture(['']),'scan.pdf'),/OCR/);
 await assert.rejects(readMaterialBuffer(Buffer.from('invalid'),'bad.docx'),/DOCX/);
 await assert.rejects(readMaterialBuffer(Buffer.from([255,254,255]),'bad.md'),/UTF-8/);
 await assert.rejects(readMaterialBuffer(Buffer.from('old word document'),'old.doc'),/docx/);
 await assert.rejects(readMaterialBuffer(Buffer.alloc(10*1024*1024+1),'large.md'),/10 MB/);
 await assert.rejects(readMaterialBuffer(pdfFixture(Array(201).fill('test page')),'long.pdf'),/200 页/);
 const oversizedZip=await wordFixture();oversizedZip.writeUInt32LE(41*1024*1024,oversizedZip.indexOf(Buffer.from('504b0102','hex'))+24);
 await assert.rejects(readMaterialBuffer(oversizedZip,'oversized.docx'),/解压内容过大/);
});
test('limits, bounded retrieval, exact provenance and reviewer snapshots preserve local source identity',()=> {
 assert.equal(validMaterials([material,material]),false);
 assert.equal(validMaterials([{...material,parts:[{...material.parts[0],text:'x'.repeat(1101)}]}]),false);
 assert.equal(localMaterialSource('file:///C:/secret'),null);assert.equal(officialSource(`learnflow-material:${material.id}`),null);
 const docs=materialDocuments([material],'保存文件');
 const result=withInlineCourseCitations('reading',{text:'保存后需要核对文件。[S1E1]'});
 const grounding=groundedContent('reading',result,docs);
 assert.equal(validGrounding(grounding),true);assert.equal(grounding.citations[0].partId,'part-1');
 assert.equal(grounding.citations[0].location,'第 1–3 行');
 assert.equal(validGrounding({...grounding,citations:[{...grounding.citations[0],materialId:'b'.repeat(64)}]}),false);
 assert.equal(validGrounding({...grounding,citations:[{...grounding.citations[0],url:'file:///C:/secret',materialId:undefined}]}),false);
 assert.deepEqual(factContent({text:result.text,grounding}).grounding,grounding);
 const many={...material,parts:Array.from({length:20},(_,i)=>({id:`part-${i+1}`,location:`第 ${i+1} 段`,text:i===19?'核对保存位置':'背景资料'}))};
 const plan=materialDocuments([many],'保存位置',{planning:true})[0];
 assert.ok(plan.excerpts.length<=8);assert.ok(plan.excerpts.some(e=>e.partId==='part-1'));assert.ok(plan.excerpts.some(e=>e.partId==='part-11'));assert.ok(plan.excerpts.some(e=>e.partId==='part-20'));
});
test('saved documents ground generation with search on or off; forged IDs and insufficient material never save or search',async t=> {
 let calls=0,searches=0,output={text:'保存后需要核对文件。[S1E1]'};
 const server=createApp({getCourseMaterials:id=>{assert.equal(id,'local-lesson');return [material];},getLLM:()=>({generate:async(prompt,input,validate)=>{calls++;assert.match(prompt,/用户导入/);assert.equal(input.officialDocuments[0].excerpts[0].location,material.parts[0].location);assert.equal(validate(output),true);return output;}}),courseSources:{prepare:async()=>{searches++;throw Error('must not search');}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const post=enabled=>fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lessonId:'local-lesson',goal:'学习文件管理',level:'零基础',title:'保存文件',objective:'学会核对文件',intro:'引言',block:{type:'reading',title:'保存并核对',objective:'核对内容'},sourceSearch:{enabled,revision:0}})});
 for(const enabled of [false,true]) {const response=await post(enabled);assert.equal(response.status,200);assert.equal((await response.json()).grounding.citations[0].materialId,material.id);}
 output={text:'无效引用。[S3E8]'};assert.equal((await post(false)).status,422);
 output={sourceInsufficient:true};assert.equal((await post(false)).status,422);
 assert.equal(calls,4);assert.equal(searches,0);
});
test('planning supplies bounded extracted text and binds all 20 originals to the returned course',async t=> {
 const all=library();
 const server=createApp({getPlanningMaterials:ids=>{assert.deepEqual(ids,all.map(m=>m.id));return all;},getLLM:()=>({generate:async(prompt,input,validate)=>{assert.match(prompt,/知识范围/);assert.equal(input.learningMaterialCatalog.length,20);assert.ok(input.learningMaterials.length<=3);assert.equal(input.materialUnits.length,20);const result={...makePlan(),materialAssignments:input.materialUnits.map(u=>({unitId:u.id,lessonIndexes:[1]}))};assert.equal(validate(result),true);return result;}})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/plan`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goal:'学习文件管理',level:'零基础',daily:25,days:7,materialIds:all.map(m=>m.id)})});
 assert.equal(response.status,200);assert.deepEqual((await response.json()).materials,all);
});
test('SQLite restart, full backups and course sharing retain material text and references; deletion removes owned data',async t=> {
 const dir=await mkdtemp(path.join(tmpdir(),'learnflow-materials-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir())+path.sep));
 const all=[material,...library().slice(0,19)];
 let store=await createSqliteStore(dir);store.savePlan({...makePlan(),materials:all});
 const outline=store.saveOutline('material-lesson-0',{intro:'课程导言',blocks:[{type:'reading',title:'保存文件',objective:'核对文件内容'},{type:'quiz',title:'测验',objective:'判断保存步骤'}]});
 const block=outline.blocks[0],result=withInlineCourseCitations('reading',{text:'保存后需要核对文件。[S1E1]'});
 store.saveBlock('material-lesson-0',block.id,{text:result.text,grounding:groundedContent('reading',result,materialDocuments([material],'文件'))});
 const backup=store.exportState();assert.deepEqual(backup.plans.find(p=>p.id==='material-course').materials,all);
 store.close();store=await createSqliteStore(dir);
 await store.replaceState(backup);
 const plan=store.overview().plans.find(p=>p.id==='material-course');assert.deepEqual(plan.materials,all);
 const course=createCoursePackage(plan,id=>store.getLesson(id));const shared=instantiateCoursePackage(course);
 assert.deepEqual(shared.plans[0].materials,all);
 assert.equal(shared.blockCourses[shared.plans[0].lessons[0].id].blocks[0].content.grounding.citations[0].location,'第 1–3 行');
 const imported=store.importCoursePackage(course);
 assert.deepEqual(imported.state.plans.find(p=>p.id===imported.planId).materials,all);
 assert.equal(store.getLesson(imported.state.plans.find(p=>p.id===imported.planId).lessons[0].id).blockCourse.blocks[0].content.grounding.citations[0].location,'第 1–3 行');
 await store.deletePlan(imported.planId);
 await store.deletePlan('material-course');assert.equal(store.exportState().plans.some(p=>p.materials),false);store.close();
});
