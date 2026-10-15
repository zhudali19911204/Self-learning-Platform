// Synthetic workflow tests, not human calibration data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { validState } from '../desktop/local-store.mjs';
import { qualitySnapshot, qualityFingerprint, applicableQualityRubric, makeQualityReport } from '../course-quality.mjs';
import { createRevisionService } from '../course-revision.mjs';
import { revisionDiff, revisionSnapshot, validRevisionJob } from '../public/course-revision.js';
import { demoPlan } from '../public/demo.js';

const gen = { mode:'ai',provider:'compatible',model:'generator-a' }, reviewer = { mode:'ai',provider:'compatible',model:'reviewer-b' };
function judgment(s, issues = []) { return { summary:'结合当前材料审查，事实未外部核验。', dimensions:applicableQualityRubric(s).map(r=>({id:r.id,rating:4,reason:'根据目标核对该维度。'})),issues,solutions:s.units.flatMap(u=>(u.questions||[]).map((q,questionIndex)=>({unitId:u.id,questionIndex,answer:q.answer,ambiguous:false,reason:'独立核对题目条件。'}))) }; }
async function fixture(t, legacy = false, grounding) {
  const directory = await mkdtemp(path.join(tmpdir(),'learnflow-revision-')); let learning = await createSqliteStore(directory);
  t.after(async()=>{learning.close();await rm(directory,{recursive:true,force:true});});
  if (!legacy) {
    const outline = learning.saveOutline('p1',{intro:'核对提交身份。',blocks:[{type:'reading',title:'身份配置',objective:'能配置提交身份'},{type:'quiz',title:'提交时机',objective:'能判断配置时机'}]});
    learning.saveBlock('p1',outline.blocks[0].id,{text:'提交前配置身份。', ...(grounding ? { grounding } : {})});
    learning.saveBlock('p1',outline.blocks[1].id,{questions:[{prompt:'何时配置身份？',options:['提交前','提交后','删除时','无关'],answer:0,explanation:'提交前需要身份。'}]});
  }
  const snapshot = qualitySnapshot(learning.overview(),'lesson','p1',learning.getLesson('p1'));
  const reading = snapshot.units.find(u=>u.type==='reading'), quiz = snapshot.units.find(u=>u.type==='quiz');
  const issue = (u,kind,quote) => ({unitId:u.id,severity:'minor',kind,quote,reason:'需要更具体的解释。',suggestion:'补充条件、示例和验证方法。'});
  const report = makeQualityReport(snapshot,judgment(snapshot,[issue(reading,'clarity',reading.text.slice(0,30)),issue(quiz,'quiz',quiz.questions[0].prompt)]),reviewer,gen);
  learning.saveQualityReport(report);
  const calls = {gen:0,review:0}; let genImpl,reviewImpl;
  const service = createRevisionService({learning,getGenerator:()=>({status:()=>gen,generate:async(instruction,input,validate)=>{
    calls.gen++; if(genImpl)return genImpl(input,validate);
    const changes = input.selectedUnits.map(unitId=>{const u=input.snapshot.units.find(u=>u.id===unitId);return {unitId,content:u.type==='quiz'?{questions:u.questions.map(q=>({...q,options:[...q.options.slice(1),q.options[0]],answer:3,explanation:'先配置再提交。'}))}:{text:u.text+'\n\n先设置 user.name 和 user.email，再核对配置。'},note:'补充条件与核对方法。'};});
    assert.equal(validate({changes}),true);return {changes};
  }}),getReviewer:()=>({status:()=>reviewer,generate:async(instruction,input,validate)=>{
    calls.review++; assert.ok(!JSON.stringify(input).includes('"answer":')); assert.ok(!JSON.stringify(input).includes('"score":'));
    if(reviewImpl)return reviewImpl(input,validate);
    const j=learning.revisionJobs('p1')[0],candidate=revisionSnapshot(j.baseSnapshot,j.changes),value=judgment(candidate);
    value.checks=input.selectedIssues.map(i=>({issueIndex:i.issueIndex,status:'not_found',reason:'当前稿补充了操作与边界。'}));
    assert.equal(validate(value),true);return value;
  }})});
  return {learning,service,snapshot,report,calls,setGen:fn=>genImpl=fn,setReview:fn=>reviewImpl=fn,reopen:async()=>{learning.close();learning=await createSqliteStore(directory);return learning;}};
}
async function reviewed(f, indexes=[0]) { let v=f.service.create(f.report.id,indexes,f.report.fingerprint);v=await f.service.generate(v.job.id,v.job.rev);return f.service.review(v.job.id,v.job.rev); }

test('source-backed block evidence is saved for revision undo, not attached to an ungrounded new draft', async t => {
  const grounding = { version: 1, citations: [{ excerptId: 'S1E1', url: 'https://git-scm.com/docs/git-config', title: 'Git config', publisher: 'Git', retrievedAt: 1000, quote: 'Set the author name before committing.', claim: '提交前配置身份。' }] };
  const f = await fixture(t, false, grounding);
  const draft = f.service.create(f.report.id, [0], f.report.fingerprint);
  f.learning.setSourceSearch('p1', true);
  await assert.rejects(f.service.generate(draft.job.id, draft.job.rev), /批量修订暂不支持/); assert.equal(f.calls.gen, 0);
  f.learning.setSourceSearch('p1', false);
  let value = await f.service.generate(draft.job.id, draft.job.rev);
  value = await f.service.review(value.job.id, value.job.rev);
  value = f.service.apply(value.job.id, value.job.rev, true, true);
  assert.equal(f.learning.getLesson('p1').blockCourse.blocks[0].content.grounding, undefined);
  value = f.service.restore(value.job.id, value.job.rev);
  assert.deepEqual(f.learning.getLesson('p1').blockCourse.blocks[0].content.grounding, grounding);
});

test('revision jobs are free to create and inspect; generation and review leave original courses untouched until atomic apply',async t=>{
  const f=await fixture(t);
  const annotation={id:'annotation-1',source:`block:${f.snapshot.units[0].id}`,offset:0,quote:f.snapshot.units[0].text,text:'private-personal-note',created:Date.now()};f.learning.saveAnnotations('p1',[annotation]);
  f.learning.saveNote({id:'linked-card',lessonId:'p1',courseTitle:demoPlan.title,title:'提交身份',summary:'核对提交身份',content:'private-knowledge-card',tags:['Git'],source:'ai',updated:Date.now()-10000});
  const before=JSON.stringify(f.learning.getLesson('p1'));
  let v=f.service.create(f.report.id,[0],f.report.fingerprint); assert.equal(validRevisionJob(v.job),true);
  assert.deepEqual(f.calls,{gen:0,review:0});f.service.inspect(v.job.id);assert.deepEqual(f.calls,{gen:0,review:0});
  v=await f.service.generate(v.job.id,v.job.rev);assert.deepEqual(f.calls,{gen:1,review:0});assert.equal(JSON.stringify(f.learning.getLesson('p1')),before);
  assert.throws(()=>f.service.apply(v.job.id,v.job.rev,true,false),/复核/);
  v=await f.service.review(v.job.id,v.job.rev);assert.deepEqual(f.calls,{gen:1,review:1});assert.equal(JSON.stringify(f.learning.getLesson('p1')),before);
  assert.equal(f.learning.qualityReports('lesson','p1').length,1);
  assert.throws(()=>f.service.apply(v.job.id,v.job.rev,false,false),/确认/);
  v=f.service.apply(v.job.id,v.job.rev,true,false);
  assert.equal(v.job.status,'applied');assert.equal(f.learning.qualityReports('lesson','p1').length,2);
  assert.deepEqual(f.learning.getLesson('p1').annotations,[annotation]);assert.equal(f.learning.overview().notes[0].content,'private-knowledge-card');assert.ok(f.learning.overview().revisionNotices.p1.updated>f.learning.overview().notes[0].updated);
  assert.equal(qualityFingerprint(qualitySnapshot(f.learning.overview(),'lesson','p1',f.learning.getLesson('p1'))),v.job.review.fingerprint);
  assert.equal(validState(f.learning.exportState()),true);
  v=f.service.restore(v.job.id,v.job.rev);assert.equal(v.job.status,'restored');
  assert.equal(qualityFingerprint(qualitySnapshot(f.learning.overview(),'lesson','p1',f.learning.getLesson('p1'))),f.report.fingerprint);
});

test('manual edits invalidate review, validate quiz schemas and retain drafts across reopen and export/import',async t=>{
  const f=await fixture(t);let v=await reviewed(f,[0,1]);
  const changed=structuredClone(v.job.changes);changed[0].content.text+='\n检查当前项目。';
  v=f.service.edit(v.job.id,v.job.rev,changed);assert.equal(v.job.review,null);assert.deepEqual(f.calls,{gen:1,review:1});
  assert.throws(()=>f.service.apply(v.job.id,v.job.rev,true,true),/复核/);
  const bad=structuredClone(changed);bad[1].content.questions[0].answer=9;
  assert.throws(()=>f.service.edit(v.job.id,v.job.rev,bad),/有效正文/);
  assert.equal(f.service.inspect(v.job.id).job.changes[0].content.text,changed[0].content.text);
  const exported=f.learning.exportState();assert.equal(validState(exported),true);
  await f.learning.replaceState(exported);assert.equal(f.service.inspect(v.job.id).job.review,null);
  const reopened=await f.reopen();assert.equal(reopened.revisionJob(v.job.id).changes[0].content.text,changed[0].content.text);
});

test('same-module problems merge; concurrent requests, stale reports and changed courses cannot duplicate calls or overwrite content',async t=>{
  const f=await fixture(t);const extra={...f.report,id:'report-two-issues',issues:[f.report.issues[0],{...f.report.issues[0],reason:'另一个表达问题。'}]};f.learning.saveQualityReport(extra);
  let release;f.setGen(async(input,validate)=>{assert.equal(input.selectedUnits.length,1);await new Promise(resolve=>release=resolve);return {changes:[{unitId:input.selectedUnits[0],content:{text:'改进后的正文。'},note:'补充说明。'}]};});
  const v=f.service.create(extra.id,[0,1],extra.fingerprint),pending=f.service.generate(v.job.id,v.job.rev);
  await assert.rejects(f.service.generate(v.job.id,f.service.inspect(v.job.id).job.rev),/正在生成/);assert.equal(f.calls.gen,1);
  const block=f.learning.getLesson('p1').blockCourse.blocks[0];f.learning.reviseBlock('p1',block.id,{text:'用户更新的新内容。'},block.content.text);
  release();const updated=await pending;assert.equal(updated.stale,true);
  await assert.rejects(f.service.review(v.job.id,updated.job.rev),/原课程已变化/);assert.equal(f.calls.review,0);
  assert.throws(()=>f.service.create(f.report.id,[0],f.report.fingerprint),/旧内容/);
});

test('continuing revision uses current draft and independent feedback instead of repeating the initial request',async t=>{
  const f=await fixture(t);let v=await reviewed(f),seen=false;
  f.setGen(async(input,validate)=>{seen=true;assert.equal(input.currentDraft[0].content.text,v.job.changes[0].content.text);assert.equal(input.reviewFeedback.checks[0].status,'not_found');assert.ok(!Object.hasOwn(input.reviewFeedback,'score'));const changes=input.currentDraft.map(c=>({...c,content:{text:c.content.text+'\n补充局部配置适用范围。'},note:'根据复核补充适用范围。'}));assert.equal(validate({changes}),true);return {changes};});
  v=await f.service.generate(v.job.id,v.job.rev);assert.equal(seen,true);assert.equal(v.job.review,null);assert.equal(f.calls.gen,2);
});

test('review failure preserves previous review; risk acknowledgment is required for unresolved or unverified items',async t=>{
  const f=await fixture(t);let v=await reviewed(f);
  const oldId=v.job.review.report.id;
  f.setReview(async()=>{throw new Error('模型暂不可用。');});
  await assert.rejects(f.service.review(v.job.id,v.job.rev),/暂不可用/);
  v=f.service.inspect(v.job.id);assert.equal(v.job.review.report.id,oldId);assert.equal(v.job.status,'draft');assert.equal(f.calls.review,2);
  f.setReview(async(input,validate)=>{const j=f.learning.revisionJob(v.job.id),value=judgment(revisionSnapshot(j.baseSnapshot,j.changes));value.checks=[{issueIndex:0,status:'needs_verification',reason:'还需核对来源。'}];assert.equal(validate(value),true);return value;});
  v=await f.service.review(v.job.id,v.job.rev);assert.throws(()=>f.service.apply(v.job.id,v.job.rev,true,false),/明确确认风险/);
  assert.equal(f.service.apply(v.job.id,v.job.rev,true,true).job.status,'applied');
});

test('quiz revisions preserve versioned historical grades, reject stale submissions and restore the old version own progress',async t=>{
  const f=await fixture(t),old={completed:true,attempts:3,lastScore:100,bestScore:100,lastAnswers:[0],updated:Date.now()};f.learning.saveProgress('p1',old);
  let v=await reviewed(f,[1]);v=f.service.apply(v.job.id,v.job.rev,true,false);
  let record=f.learning.getLesson('p1').quizRecord;
  assert.notEqual(record.currentFingerprint,record.progressFingerprint);assert.equal(record.history[0].progress.bestScore,100);
  assert.deepEqual(f.learning.overview().progress.p1,old);assert.throws(()=>f.learning.saveProgress('p1',{...old,quizFingerprint:record.progressFingerprint}),/题目版本已变化/);
  const current={completed:false,attempts:1,lastScore:0,bestScore:0,lastAnswers:[0],updated:Date.now()};f.learning.saveProgress('p1',{...current,quizFingerprint:record.currentFingerprint});
  record=f.learning.getLesson('p1').quizRecord;assert.equal(record.currentFingerprint,record.progressFingerprint);
  v=f.service.restore(v.job.id,v.job.rev);record=f.learning.getLesson('p1').quizRecord;
  assert.equal(record.currentFingerprint,record.progressFingerprint);assert.equal(record.history.length,2);assert.deepEqual(f.learning.overview().progress.p1,old);
  assert.equal(validState(f.learning.exportState()),true);
});

test('legacy course sections and quizzes support the same revision and restore workflow',async t=>{
  const f=await fixture(t,true);let v=await reviewed(f,[0,1]);v=f.service.apply(v.job.id,v.job.rev,true,false);
  assert.equal(v.job.status,'applied');assert.equal(f.learning.getLesson('p1').blockCourse,null);
  v=f.service.restore(v.job.id,v.job.rev);assert.equal(qualityFingerprint(qualitySnapshot(f.learning.overview(),'lesson','p1',f.learning.getLesson('p1'))),f.report.fingerprint);
});

test('triage records, revision tasks and quiz records are owned by their course and deleted with it',async t=>{
  const f=await fixture(t);let v=await reviewed(f,[1]);v=f.service.apply(v.job.id,v.job.rev,true,false);
  f.service.disposition(f.report.id,0,'deferred','暂时保留，之后核对。');
  assert.equal(f.learning.exportState().qualityDispositions.length,1);
  const other=structuredClone(demoPlan);other.id='other-route';other.lessons=other.lessons.map((l,i)=>({...l,id:`other-${i}`}));f.learning.savePlan(other);
  await f.learning.deletePlan(demoPlan.id);const exported=f.learning.exportState();
  assert.ok(!exported.qualityJobs && !exported.qualityDispositions && !exported.quizRecords && !exported.revisionNotices);assert.equal(validState(exported),true);
});

test('line differences preserve unchanged content and never treat text as executable HTML',()=>{
  const diff=revisionDiff('相同\n旧行\n结尾','相同\n<script>新行</script>\n结尾');
  assert.equal(diff.before[0].changed,false);assert.equal(diff.before[1].changed,true);assert.equal(diff.after[1].text,'<script>新行</script>');
  assert.equal(diff.after[2].changed,false);
});
