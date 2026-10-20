import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { buildTeachingContext, validTeachingContext, cleanTeachingContext, teachingContextLimits, teachingContextNotice } from '../public/teaching-context.js';
import { blockGenerationContext, validOutline, validBlockContent } from '../public/blocks.js';
import { validGeneratedOutline, validGeneratedBlock, coursePromptVersion, blockTypeGuidance } from '../course-generation.mjs';

const block = (id,type,text=null) => ({id,type,title:`${id} 的主题`,objective:`能完成 ${id} 的任务`,content:text===null?null:{text}});
const course = () => ({intro:'课程目标',blocks:[block('r1','reading','基础定义\n操作前提\n关键方法在结尾。'),block('e1','example','对应案例\n必要输入\n预期结果。'),block('r2','reading','条件和边界。'),block('e2','example','条件变化的案例。'),block('p1','practice','独立操作与核对。'),block('q1','quiz'),block('s1','summary')]});
const initialRequest = (c,id) => {const b=c.blocks.find(b=>b.id===id);return {goal:'掌握任务方法',title:'本课',objective:'解释方法并核对结果',level:'零基础',minutes:25,...blockGenerationContext(c,id),block:{type:b.type,title:b.title,objective:b.objective}};};
async function serve(t,output){const sent=[];const server=createApp({env:{},model:'synthetic-test',fetchImpl:async(_url,init)=>{sent.push(JSON.parse(init.body));return Response.json({message:{content:JSON.stringify(output)}});}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});return {sent,post:async(path,data)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})};}

test('paired examples see full corresponding reading, including final steps and boundaries, with no private fields',()=>{
  const c=course();c.blocks[0].content.text='导语。'.repeat(500)+'\n结尾关键步骤：核对结果。';c.blocks[0].content.illustration={url:'private-image-url'};c.blocks[0].content.revisions=[{text:'private-old-text'}];c.annotations=['private-note'];
  const context=buildTeachingContext(c,'e1');assert.equal(validTeachingContext(context),true);
  assert.equal(context.pairedReadingId,'r1');assert.equal(context.sources[0].spans[0].text,c.blocks[0].content.text);assert.equal(context.sources[0].omitted,false);
  assert.ok(!JSON.stringify(context).includes('private-'));assert.deepEqual(cleanTeachingContext(context),context);
});

test('quizzes and summaries include early and late generated teaching rather than only the last three openings',()=>{
  const c=course();for(const id of ['q1','s1']){const context=buildTeachingContext(c,id);assert.equal(validTeachingContext(context),true);assert.equal(context.coverage.completeBefore,true);assert.deepEqual(context.sources.map(s=>s.id),['r1','e1','r2','e2','p1']);assert.ok(context.sources[0].spans[0].text.includes('关键方法在结尾'));assert.ok(context.sources.every(s=>s.type!=='quiz'));}
});

test('out-of-order generation tracks pending paired reading and limits quiz scope; no evidence means no model call',async t=>{
  const c=course();c.blocks[0].content=null;assert.match(teachingContextNotice(c,'e1'),/配套讲解尚未生成/);
  c.blocks[2].content=null;let context=buildTeachingContext(c,'q1');assert.equal(validTeachingContext(context),true);assert.equal(context.coverage.pendingBefore,2);assert.equal(context.coverage.completeBefore,false);assert.equal(context.catalog.find(x=>x.id==='r1').generated,false);
  for(const b of c.blocks)b.content=null;
  const app=await serve(t,{questions:[]});assert.equal((await app.post('/api/lesson-block',initialRequest(c,'q1'))).status,400);assert.equal((await app.post('/api/lesson-block',initialRequest(c,'s1'))).status,400);assert.equal(app.sent.length,0);
  c.blocks[4].content={text:'一个待做的实践任务，不是完整讲解。'};assert.equal((await app.post('/api/lesson-block',initialRequest(c,'q1'))).status,400);assert.equal(app.sent.length,0);
  assert.match(teachingContextNotice(c,'q1'),/不会自动生成其他模块/);
});

test('long context is fairly bounded and selected excerpts retain exact positions, beginnings and endings',()=>{
  const c={intro:'长课',blocks:Array.from({length:40},(_,i)=>block(`r${i}`,'reading',`## 开始 ${i}\n`+'说明文字。'.repeat(2000)+`\n## 适用边界 ${i}\n结尾关键判断。`))};c.blocks.push(block('s1','summary'));
  const context=buildTeachingContext(c,'s1');assert.equal(validTeachingContext(context),true);assert.equal(context.sources.length,24);assert.ok(context.sources.reduce((n,s)=>n+s.includedCharacters,0)<=teachingContextLimits.characters);assert.equal(context.coverage.omittedBefore,16);assert.equal(context.coverage.excerpted,true);assert.equal(context.coverage.completeBefore,false);
  assert.ok(context.sources.some(s=>s.id==='r0'));assert.ok(context.sources.some(s=>s.id==='r39'));
  for(const s of context.sources){const original=c.blocks.find(b=>b.id===s.id).content.text;assert.equal(s.spans[0].start,0);assert.equal(s.spans.at(-1).end,original.length);for(const p of s.spans)assert.equal(p.text,original.slice(p.start,p.end));}
  assert.ok(Buffer.byteLength(JSON.stringify(initialRequest(c,'s1')))<512000);
});

test('large historical courses keep context catalogs bounded and never mark omitted material as complete',()=>{
  const c={intro:'历史长课',blocks:Array.from({length:1000},(_,i)=>block(`b${i}`,i===999?'summary':'reading',i===999?null:'示例正文。'))};
  const context=buildTeachingContext(c,'b999');assert.equal(validTeachingContext(context),true);assert.equal(context.catalog.length,80);assert.equal(context.coverage.catalogOmitted,920);assert.equal(context.coverage.completeBefore,false);assert.ok(context.catalog.some(x=>x.id==='b999'));
});

test('teaching context rejects forged spans, counts, duplicate IDs and oversized sources and strips extra metadata',async t=>{
  const request=initialRequest(course(),'q1'),app=await serve(t,{text:'正文'});
  for(const mutate of [v=>v.sources[0].spans[0].end++,v=>v.coverage.generatedBefore=0,v=>v.sources[0].includedCharacters=1,v=>v.catalog[0].id=v.catalog[1].id,v=>v.sources[0].type='quiz',v=>v.targetType='summary',v=>v.sources[0].objective=42,v=>v.sources[0].spans=[null],v=>v.sources=[null],v=>v.catalog=[null]]){const data=structuredClone(request);mutate(data.teachingContext);assert.equal((await app.post('/api/lesson-block',data)).status,400);}
  assert.equal(app.sent.length,0);
  const context=buildTeachingContext(course(),'e1');context.apiKey='private-key';context.sources[0].annotations='private-annotation';assert.equal(validTeachingContext(context),true);const cleaned=cleanTeachingContext(context);assert.ok(!JSON.stringify(cleaned).includes('private-'));
});

test('new generation rules reject unmatched readings and duplicate outcomes without invalidating old courses',()=>{
  const legacy={intro:'历史课',blocks:[{type:'reading',title:'概念',objective:'解释概念'},{type:'quiz',title:'检查',objective:'检验概念'}]};assert.equal(validOutline(legacy),true);assert.equal(validGeneratedOutline(legacy),false);
  const upgraded={...legacy,blocks:[legacy.blocks[0],{type:'example',title:'概念案例',objective:'使用概念解释案例'},legacy.blocks[1]]};assert.equal(validGeneratedOutline(upgraded),true);
  assert.equal(validGeneratedOutline({...upgraded,blocks:upgraded.blocks.map(b=>({...b,objective:'重复目标'}))}),false);
  assert.equal(validGeneratedOutline({...upgraded,blocks:[upgraded.blocks[2],...upgraded.blocks.slice(0,2)]}),false);
  const q={prompt:'何时使用？',options:['A','B','C','D'],answer:0,explanation:'A的条件成立。'};
  assert.equal(validBlockContent('quiz',{questions:[q]}),true);assert.equal(validGeneratedBlock('quiz',{questions:[q]}),false);
  const next={questions:[q,{...q,prompt:'条件改变后？'},{...q,prompt:'如何识别边界？'},{...q,prompt:'哪个条件不可省略？'}]};assert.equal(validGeneratedBlock('quiz',next),true);assert.equal(validGeneratedBlock('quiz',{questions:next.questions.map((item,i)=>i===1?{...item,options:['A','A','C','D']}:item)}),false);
});

test('generation API sends validated evidence and teaching rules; output failures never trigger hidden retries',async t=>{
  const q={prompt:'判断方法？',options:['方法A','方法B','方法C','方法D'],answer:0,explanation:'根据材料条件选择A。'};
  const app=await serve(t,{questions:[q,{...q,prompt:'变化情境如何判断？'},{...q,prompt:'如何识别边界？'},{...q,prompt:'哪个条件不可省略？'}]});const request=initialRequest(course(),'q1');assert.equal((await app.post('/api/lesson-block',request)).status,200);
  const payload=app.sent[0],input=JSON.parse(payload.messages[1].content);assert.deepEqual(input.teachingContext,request.teachingContext);assert.match(payload.messages[0].content,/题干给齐必要条件/);assert.match(payload.messages[0].content,/JSON 正文字符串内部可以使用/);assert.match(payload.messages[0].content,/完整代码/);assert.match(payload.messages[0].content,/整课总学习时间/);
  assert.equal(input.questionCount,4);assert.equal(input.quizMode,'initial');
  const bad=await serve(t,{questions:[q]});const rejected=await bad.post('/api/lesson-block',request);assert.equal(rejected.status,422);assert.match((await rejected.json()).error,/首次生成固定4题，模型返回1题/);assert.equal(bad.sent.length,1);
  assert.equal(coursePromptVersion,'course-generation-v2');assert.equal(Object.keys(blockTypeGuidance).length,5);
});

test('outline gets the lesson time budget and new structural checks while old callers may omit minutes',async t=>{
  const output={intro:'本课成果',blocks:[{type:'reading',title:'方法',objective:'解释适用条件'},{type:'example',title:'方法案例',objective:'推演示例结果'},{type:'quiz',title:'方法判断',objective:'判断变化情境'}]},app=await serve(t,output);
  const request={goal:'完成具体任务',title:'本课',objective:'能完成任务',level:'零基础',minutes:15};assert.equal((await app.post('/api/lesson-outline',request)).status,200);assert.equal(JSON.parse(app.sent[0].messages[1].content).minutes,15);assert.match(app.sent[0].messages[0].content,/总预算/);
  assert.equal((await app.post('/api/lesson-outline',{...request,minutes:0})).status,400);assert.equal(app.sent.length,1);
  assert.equal((await app.post('/api/lesson-outline',{...request,minutes:undefined})).status,200);
});
