import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSqliteStore} from '../desktop/sqlite-store.mjs';
import {demoPlan,demoLessons} from '../public/demo.js';
import {learningBriefWithAdjustment} from '../public/planning.js';

test('adjusted directories persist feedback through SQLite reopen and full backups without moving original teaching or learning records',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'learnflow-plan-adjust-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));
  let store=await createSqliteStore(directory);t.after(async()=>{store?.close();await rm(directory,{recursive:true,force:true});});
  store.saveLesson(demoPlan.lessons[0].id,demoLessons.p1);store.appendChat(demoPlan.lessons[0].id,'原有私人问题','原有回答');
  const before=store.exportState(),original=store.getLesson(demoPlan.lessons[0].id);
  const adjusted={...structuredClone(demoPlan),id:'adjusted-directory',source:'ai',learningBrief:learningBriefWithAdjustment(demoPlan,'先案例，后解释，再实践'),lessons:demoPlan.lessons.map((l,i)=>({...l,id:`adjusted-lesson-${i}`}))};
  store.savePlan(adjusted);const backup=store.exportState();
  assert.deepEqual(backup.plans.find(p=>p.id===demoPlan.id),before.plans[0]);assert.deepEqual(store.getLesson(demoPlan.lessons[0].id),original);
  store.close();store=await createSqliteStore(directory);assert.equal(store.overview().plans.find(p=>p.id===adjusted.id).learningBrief.adjustments[0],'先案例，后解释，再实践');
  await store.replaceState(backup);assert.deepEqual(store.exportState(),backup);assert.deepEqual(store.getLesson(demoPlan.lessons[0].id),original);
  assert.equal(store.getLesson(adjusted.lessons[0].id).lesson,null);assert.equal(store.getLesson(adjusted.lessons[0].id).blockCourse,null);
});
