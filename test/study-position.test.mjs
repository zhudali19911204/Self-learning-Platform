import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createStudyPositionTracker, validStudyPosition, validStudyPositions, studyPositionFor, studyAnchorVersion } from '../public/study-position.js';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { validState } from '../desktop/local-store.mjs';
import { createCoursePackage } from '../desktop/course-sharing.mjs';
import { demoPlan } from '../public/demo.js';

const position = (lessonId='lesson-a') => ({lessonId,tab:'read',anchor:{kind:'block',id:'b2',version:studyAnchorVersion('第二块正文')},offset:120,scrollTop:1700,label:'第二个栏目',syllabusCollapsed:true,collapsedBlockIds:['b1'],updated:1000});
function fixture(t) {
  const dom=new JSDOM('<section class="lesson-content"><header class="lesson-toolbar"></header><div class="lesson-intro">导语</div><section data-block-id="b1"></section><section data-block-id="b2"></section></section>');
  const {window}=dom,document=window.document,saved=[],timers=new Map();let timerId=0;
  Object.defineProperty(window,'scrollY',{value:0,writable:true,configurable:true});
  window.scrollTo=({top})=>{window.scrollY=top;};
  window.requestAnimationFrame=fn=>{fn();return 1;};
  const bounds=(selector,top,height,width=900)=>{document.querySelector(selector).getBoundingClientRect=()=>({top:top-window.scrollY,bottom:top+height-window.scrollY,height,width,left:0,right:width});};
  bounds('.lesson-content',170,4000);bounds('.lesson-toolbar',170,100);bounds('.lesson-intro',550,150);bounds('[data-block-id=b1]',800,700);bounds('[data-block-id=b2]',1600,800);
  let context={planId:'course-a',lessonId:'lesson-a',tab:'read',course:{intro:'导语',blocks:[{id:'b1',title:'第一个栏目',type:'reading',content:{text:'第一块正文'}},{id:'b2',title:'第二个栏目',type:'practice',content:{text:'第二块正文'}}]},lesson:null,chats:[],syllabusCollapsed:true,collapsedBlockIds:['b1']};
  const tracker=createStudyPositionTracker({document,window,getContext:()=>context,onSave:(planId,value,sync)=>saved.push({planId,value,sync}),setTimer:fn=>{timers.set(++timerId,fn);return timerId;},clearTimer:id=>timers.delete(id)});
  tracker.rendered();
  t.after(()=>{tracker.dispose();dom.window.close();});
  return {window,document,tracker,saved,timers,bounds,get context(){return context;},set context(value){context=value;}};
}

test('learning positions validate bounded metadata and route ownership without changing old backup contracts',()=>{
  const p=position(),plans=[{id:'course-a',lessons:[{id:'lesson-a'}]},{id:'course-b',lessons:[{id:'lesson-b'}]}];
  assert.equal(validStudyPosition(p),true);assert.equal(validStudyPositions({'course-a':p},plans),true);
  assert.equal(studyPositionFor(plans[1],{'course-a':p,'course-b':p}),null);
  for(const bad of [{...p,offset:Infinity},{...p,scrollTop:-1},{...p,tab:'unknown'},{...p,lessonId:'__proto__'},{...p,privateNotes:'not allowed'},{...p,collapsedBlockIds:['b1','b1']},{...p,anchor:{kind:'question',index:1,version:p.anchor.version}}]) assert.equal(validStudyPosition(bad),false);
  assert.equal(validStudyPositions({'course-b':p},plans),false);
  assert.equal(studyAnchorVersion('正文'),studyAnchorVersion('正文'));assert.notEqual(studyAnchorVersion('正文'),studyAnchorVersion('更新正文'));
});

test('reading capture restores a stable block and its internal offset instead of the first lesson or page top',async t=>{
  const f=fixture(t);f.window.scrollY=1900;
  const saved=f.tracker.capture();
  assert.equal(saved.anchor.id,'b2');assert.equal(saved.offset,412);assert.equal(saved.label,'第二个栏目');assert.equal(saved.syllabusCollapsed,true);assert.deepEqual(saved.collapsedBlockIds,['b1']);
  assert.equal(validStudyPosition(saved),true);
  f.window.scrollY=0;assert.equal(await f.tracker.restore(saved),true);assert.equal(f.window.scrollY,1900);
  f.context={...f.context,lessonId:'another-lesson'};assert.equal(f.tracker.capture(),null,'old DOM cannot be saved under a new lesson');
});

test('scroll writes are debounced, opening the same point is a no-op, and shutdown can synchronously flush the last position',t=>{
  const f=fixture(t);f.window.scrollY=1700;
  f.window.dispatchEvent(new f.window.Event('scroll'));f.window.scrollY=1900;f.window.dispatchEvent(new f.window.Event('scroll'));
  assert.equal(f.timers.size,1);[...f.timers.values()][0]();assert.equal(f.saved.length,1);assert.equal(f.saved[0].value.scrollTop,1900);
  f.tracker.save();assert.equal(f.saved.length,1);
  f.window.scrollY=1950;f.window.dispatchEvent(new f.window.Event('beforeunload'));
  assert.equal(f.saved.length,2);assert.equal(f.saved[1].sync,true);assert.equal(f.saved[1].value.scrollTop,1950);
  assert.deepEqual(Object.keys(f.saved[1].value).sort(),['anchor','collapsedBlockIds','label','lessonId','offset','scrollTop','syllabusCollapsed','tab','updated'].sort());
});

test('changed or deleted content and user gestures never restore an obsolete offset into an unrelated block',async t=>{
  const f=fixture(t);f.window.scrollY=1900;const saved=f.tracker.capture();
  f.context.course.blocks[1].content.text='已经改写的正文';f.tracker.rendered();f.window.scrollY=0;
  await f.tracker.restore(saved);assert.equal(f.window.scrollY,1488,'changed body starts at its own block header');
  f.context.course.blocks.pop();f.document.querySelector('[data-block-id=b2]').remove();f.tracker.rendered();f.window.scrollY=0;
  await f.tracker.restore(saved);assert.equal(f.window.scrollY,154,'deleted anchor falls back to the lesson header');
  const queue=[];f.window.requestAnimationFrame=fn=>queue.push(fn);f.window.scrollY=0;
  const pending=f.tracker.restore(saved);f.window.dispatchEvent(new f.window.Event('wheel'));
  while(queue.length)queue.shift()();assert.equal(await pending,false);assert.equal(f.window.scrollY,0,'a delayed restore must not fight user scrolling');
});

test('question and chat anchors use content identity when indexes change and never save a learner answer',async t=>{
  const f=fixture(t),q=i=>({prompt:`题目${i}`,options:['甲','乙','丙','丁'],answer:0,explanation:'解析'});
  f.document.querySelector('.lesson-content').innerHTML='<header class="lesson-toolbar"></header><fieldset class="question"></fieldset><fieldset class="question"></fieldset>';
  f.bounds('.lesson-toolbar',170,100);
  const elements=f.document.querySelectorAll('.question');elements.forEach((el,i)=>{el.getBoundingClientRect=()=>({top:400+i*550-f.window.scrollY,height:450,width:900});});
  f.context={...f.context,tab:'quiz',course:null,lesson:{questions:[q(1),q(2)]}};f.tracker.rendered();f.window.scrollY=1000;
  const saved=f.tracker.capture();assert.equal(saved.anchor.kind,'question');assert.equal(saved.anchor.index,1);assert.equal(saved.label,'随堂练习 · 第 2 题');
  f.context.lesson.questions.reverse();f.tracker.rendered();f.window.scrollY=0;await f.tracker.restore(saved);assert.equal(f.window.scrollY,450);
  f.context.lesson.questions[0].prompt='已经改写';f.tracker.rendered();f.window.scrollY=0;await f.tracker.restore(saved);assert.equal(f.window.scrollY,154);
  assert.equal(JSON.stringify(saved).includes('题目2'),false);assert.equal(JSON.stringify(saved).includes('answer'),false);
  f.document.querySelector('.lesson-content').innerHTML='<header class="lesson-toolbar"></header><div class="chat-message"></div>';
  f.bounds('.lesson-toolbar',170,100);f.bounds('.chat-message',800,600);
  f.context={...f.context,tab:'chat',chats:[{role:'assistant',content:'已有对话'}]};f.tracker.rendered();f.window.scrollY=900;
  const chat=f.tracker.capture();assert.equal(chat.anchor.kind,'chat');assert.equal(chat.label,'AI 答疑');
  f.window.scrollY=0;await f.tracker.restore(chat);assert.equal(f.window.scrollY,900);
});

test('legacy lesson sections, examples and practice tasks have independent anchors',async t=>{
  const f=fixture(t);
  f.document.querySelector('.lesson-content').innerHTML='<header class="lesson-toolbar"></header><section class="reading-section"></section><div class="code-block"></div><div class="challenge"></div>';
  f.bounds('.lesson-toolbar',170,100);f.bounds('.reading-section',400,500);f.bounds('.code-block',1000,500);f.bounds('.challenge',1700,500);
  f.context={...f.context,course:null,lesson:{sections:[{heading:'定义',body:'内容'}],example:'示例正文',challenge:'实践任务'}};f.tracker.rendered();
  for(const [top,kind] of [[500,'section'],[1100,'example'],[1800,'challenge']]){f.window.scrollY=top;const saved=f.tracker.capture();assert.equal(saved.anchor.kind,kind);f.window.scrollY=0;await f.tracker.restore(saved);assert.equal(f.window.scrollY,top);}
});

test('desktop positions survive reopen and full backup, reject stale/cross-route writes, and stay out of course sharing',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'learnflow-study-position-'));
  let store=await createSqliteStore(directory);
  t.after(async()=>{store?.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});});
  const plan=structuredClone(demoPlan),p={...position(plan.lessons[1].id),updated:2000};
  const before=store.exportState();assert.equal(validState(before),true);
  store.saveStudyPosition(plan.id,p);assert.deepEqual(store.overview().studyPositions[plan.id],p);
  store.saveStudyPosition(plan.id,{...p,updated:1000,offset:1});assert.equal(store.overview().studyPositions[plan.id].offset,120);
  assert.throws(()=>store.saveStudyPosition('other-route',p),/不属于/);
  const exported=store.exportState();assert.equal(validState(exported),true);
  const {studyPositions,...after}=exported;assert.deepEqual(after,before,'bookmark writes do not change lessons or scores');
  store.close();store=await createSqliteStore(directory);assert.deepEqual(store.overview().studyPositions[plan.id],p);
  const shared=createCoursePackage(plan,id=>store.getLesson(id));assert.equal(JSON.stringify(shared).includes('studyPositions'),false);assert.equal(JSON.stringify(shared).includes('collapsedBlockIds'),false);
  const restored=store.replaceState(JSON.parse(JSON.stringify(exported)));assert.deepEqual(restored.studyPositions[plan.id],p);
  const other={...plan,id:'other-route',source:'ai',lessons:plan.lessons.map((lesson,i)=>({...lesson,id:`other-${i}`}))};store.savePlan(other);
  store.saveStudyPosition(other.id,{...position(other.lessons[1].id),updated:3000});
  await writeFile(path.join(directory,'learning.json.bak'),JSON.stringify(store.exportState()));
  const deleted=await store.deletePlan(other.id);assert.equal(deleted.state.studyPositions[other.id],undefined);assert.deepEqual(deleted.state.studyPositions[plan.id],p);
  const cleaned=JSON.parse(await readFile(path.join(directory,'learning.json.bak'),'utf8'));assert.equal(validState(cleaned),true);assert.equal(cleaned.studyPositions[other.id],undefined);
});
