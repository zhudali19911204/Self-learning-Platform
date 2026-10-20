// Synthetic regression fixtures, not human-reviewed calibration samples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { demoPlan } from '../public/demo.js';
import { createLocalStore, defaults, validState } from '../desktop/local-store.mjs';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { assertDistinctQualityModels, validQualityReport } from '../public/course-quality.js';
import { qualitySnapshot, qualityFingerprint, qualityRules, applicableQualityRubric, qualityReviewerInput, validQualityJudgment, qualityJudgmentProblems, normalizeQualityScoreJudgment, makeQualityReport, createQualityService } from '../course-quality.mjs';
import { withGenerationSignal, isGenerationCancelled } from '../generation-cancellation.mjs';

const generator = { mode: 'ai', model: 'generator-a', provider: 'compatible' };
const reviewerStatus = { mode: 'ai', model: 'reviewer-b', provider: 'compatible' };
const course = () => ({ intro: '练习提交前先配置身份。', blocks: [
  { id: 'reading-1', type: 'reading', title: '提交与身份', objective: '能解释提交身份', content: { text: '首次提交前配置 user.name 和 user.email。' } },
  { id: 'example-1', type: 'example', title: '配置案例', objective: '能完成身份配置', content: null },
  { id: 'quiz-1', type: 'quiz', title: '提交测验', objective: '能检查提交身份', content: { questions: [{ prompt: '身份配置写在哪个步骤？', options: ['提交前', '提交后', '删除仓库时', '与提交无关'], answer: 0, explanation: '提交前配置。' }] } }
] });
const state = () => ({ version: 1, plans: [structuredClone(demoPlan)], active: demoPlan.id, lessons: {}, progress: {}, notes: [], reflections: {}, chats: {} });
function judgment(snapshot, rating = 4) {
  return { summary: '当前已生成内容的审查建议；关键事实尚未外部核验。', dimensions: applicableQualityRubric(snapshot).map(r => ({ id: r.id, rating, reason: '已结合本模块目标检查表达、条件与步骤。' })), issues: [], solutions: snapshot.units.flatMap(u => (u.questions || []).map((q, questionIndex) => ({ unitId: u.id, questionIndex, answer: q.answer, ambiguous: false, reason: '独立分析应先配置身份再提交。' }))) };
}
async function database(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'learnflow-quality-'));
  let learning = await createSqliteStore(directory);
  const saved = learning.saveOutline('p1', { intro: course().intro, blocks: course().blocks.map(({ content, id, ...spec }) => spec) });
  learning.saveBlock('p1', saved.blocks[0].id, course().blocks[0].content);
  learning.saveBlock('p1', saved.blocks[2].id, course().blocks[2].content);
  t.after(async () => { learning.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, learning, saved, reopen: async () => { learning.close(); learning = await createSqliteStore(directory); return learning; } };
}

test('model roles exclude the same model across providers, endpoints, case and default Ollama tags', () => {
  for (const model of ['generator-a', ' GENERATOR-A ', 'generator-a:latest']) assert.throws(() => assertDistinctQualityModels(generator, { model, provider: 'ollama', baseUrl: 'http://localhost:11434' }), /必须不同/);
  assert.doesNotThrow(() => assertDistinctQualityModels(generator, reviewerStatus));
  assert.doesNotThrow(() => assertDistinctQualityModels({ model: '' }, reviewerStatus));
});

test('review settings keep encrypted keys and provider drafts independent, with both save directions guarded', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'learnflow-quality-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secrets = { encrypt: async s => Buffer.from(s).toString('base64'), decrypt: async s => Buffer.from(s, 'base64').toString() };
  let review;
  const generation = createLocalStore(directory, secrets, { validateChange: next => assertDistinctQualityModels(next, review?.getModelConfig()) });
  await generation.initialize();
  review = createLocalStore(directory, secrets, { filename: 'quality-settings.json', validateChange: next => assertDistinctQualityModels(generation.getModelConfig(), next) });
  await review.initialize();
  const input = { ...defaults, provider: 'compatible', localOnly: false, baseUrl: 'https://example.test/v1', model: 'generator-a', keyAction: 'replace', apiKey: 'generation-secret-only' };
  await generation.saveSettings(input);
  await assert.rejects(review.saveSettings({ ...input, apiKey: 'review-secret-only' }), /必须不同/);
  await review.saveSettings({ ...input, model: 'reviewer-b', apiKey: 'review-secret-only' });
  await assert.rejects(generation.saveSettings({ ...input, model: 'reviewer-b' }), /必须不同/);
  assert.equal(generation.getModelConfig().model, 'generator-a');
  assert.equal(generation.getModelConfig().apiKey, 'generation-secret-only');
  assert.equal(review.getModelConfig().apiKey, 'review-secret-only');
  const safe = JSON.stringify(review.getSettings());
  assert.ok(!safe.includes('review-secret-only') && !safe.includes('generation-secret-only'));
  const file = await readFile(path.join(directory, 'quality-settings.json'), 'utf8');
  assert.ok(!file.includes('review-secret-only'));
  const reopened = createLocalStore(directory, secrets, { filename: 'quality-settings.json' });
  await reopened.initialize(); assert.equal(reopened.getModelConfig().apiKey, 'review-secret-only');
  await review.saveSettings({ ...input, model: 'reviewer-b', keyAction: 'keep', apiKey: '' });
  assert.equal(review.getModelConfig().apiKey, 'review-secret-only');
});

test('snapshots keep full course text but omit personal records, keys, image URLs and revision history', () => {
  const snapshot = qualitySnapshot({ ...state(), reflections: { p1: 'private-reflection' }, chats: { p1: ['private-chat'] } }, 'lesson', 'p1', { blockCourse: course(), annotations: ['private-note'], reflection: 'private-reflection' });
  const input = qualityReviewerInput(snapshot), bytes = JSON.stringify(input);
  assert.ok(!bytes.includes('private-'));
  assert.ok(!bytes.includes('"answer":') && !bytes.includes('"explanation":'));
  assert.equal(input.units[0].text, course().blocks[0].content.text);
  assert.equal(qualityRules(snapshot).partial, true);
  assert.ok(!applicableQualityRubric(snapshot).some(r => r.id === 'practice'));
  const route = qualitySnapshot(state(), 'route', demoPlan.id);
  assert.ok(!applicableQualityRubric(route).some(r => ['facts', 'quiz', 'practice'].includes(r.id)));
  const changed = structuredClone(snapshot); changed.units[0].text += '新增条件';
  assert.notEqual(qualityFingerprint(snapshot), qualityFingerprint(changed));
});

test('judgment validation requires real source quotes, complete dimensions and one independent answer per question', () => {
  const snapshot = qualitySnapshot(state(), 'lesson', 'p1', { blockCourse: course() });
  const value = judgment(snapshot);
  assert.equal(validQualityJudgment(value, snapshot), true);
  const issue = { unitId: 'reading-1', severity: 'minor', kind: 'clarity', quote: '首次提交前配置', reason: '需要解释身份用途。', suggestion: '添加简短解释。' };
  value.issues = [issue]; assert.equal(validQualityJudgment(value, snapshot), true);
  value.issues = [{ ...issue, quote: '并不存在的原文' }]; assert.equal(validQualityJudgment(value, snapshot), false);
  value.issues = [{ ...issue, unitId: 'example-1', quote: '' }]; assert.equal(validQualityJudgment(value, snapshot), false);
  value.issues = []; value.solutions = []; assert.equal(validQualityJudgment(value, snapshot), false);
  const second = judgment(snapshot); second.dimensions[0].rating = 5; assert.equal(validQualityJudgment(second, snapshot), false);
  for (const field of ['dimensions', 'issues', 'solutions']) {
    const malformed = judgment(snapshot); malformed[field] = [null];
    assert.equal(validQualityJudgment(malformed, snapshot), false);
  }
  assert.equal(validQualityReport({ dimensions: [null] }), false);
});

test('partial AI reviews solve quizzes blind, flag answer disagreements and persist without changing course records', async t => {
  const { learning } = await database(t);
  const snapshot = qualitySnapshot(learning.overview(), 'lesson', 'p1', learning.getLesson('p1'));
  const before = JSON.stringify(learning.getLesson('p1'));
  let calls = 0;
  const reviewer = { status: () => reviewerStatus, generate: async (instruction, input, validate) => {
    calls++; assert.ok(!JSON.stringify(input).includes('"answer":'));
    const result = judgment(snapshot); result.solutions[0].answer = 1;
    assert.equal(validate(result), true); return result;
  } };
  const service = createQualityService({ learning, getReviewer: () => reviewer, getGenerator: () => generator });
  const first = service.inspect('lesson', 'p1'); assert.equal(calls, 0);
  const evaluated = await service.evaluate('lesson', 'p1', first.fingerprint);
  assert.equal(calls, 1);
  const report = evaluated.reports[0];
  assert.equal(validQualityReport(report), true); assert.equal(report.partial, true);
  assert.equal(report.score, 100); assert.equal(report.status, 'needs_revision');
  assert.match(report.issues[0].reason, /不一致/); assert.equal(report.verification, 'unverified');
  assert.equal(evaluated.currentReportId, report.id);
  assert.equal(JSON.stringify(learning.getLesson('p1')), before);
  const exported = learning.exportState(); assert.equal(validState(exported), true);
  assert.equal(exported.qualityReports[0].id, report.id);
  assert.equal(validQualityReport({ ...report, score: 42 }), false);
  assert.equal(validQualityReport({ ...report, status: 'reviewed' }), false);
  assert.equal(validQualityReport({ ...report, generator: report.reviewer }), false);
  await learning.replaceState(exported);
  assert.equal(service.inspect('lesson', 'p1').reports[0].id, report.id);
});

test('score-only normalization maps presentation to real source text but never fuzzy-matches numbers, code or separate quiz fields', () => {
  const c=course(); c.blocks[0].content.text='必须**先配置**身份。\n\n原值为10，不可改成20。\n\n```js\nx =  1\n```';
  const snapshot=qualitySnapshot(state(),'lesson','p1',{blockCourse:c}), value=judgment(snapshot);
  const item={unitId:'reading-1',severity:'critical',kind:'fact',quote:'必须先配置身份。',reason:'需要核对适用条件。',suggestion:'保留正确的适用条件。'};
  value.issues=[item,{...item,quote:'原值为20，不可改成10。'},{...item,quote:'原值为10，可以改成20。'},{...item,quote:'x = 1'},
    {...item,unitId:'quiz-1',quote:'身份配置写在哪个步骤？\n提交前'}, {...item,kind:'missing',quote:''}];
  const before=JSON.stringify(value), normalized=normalizeQualityScoreJudgment(value,snapshot);
  assert.equal(normalized.judgment.issues.length,2); assert.equal(normalized.judgment.issues[0].quote,'必须**先配置**身份。');
  assert.equal(normalized.judgment.issues[1].quote,''); assert.equal(normalized.unverifiedIssues.length,4);
  assert.ok(normalized.unverifiedIssues.every(i=>i.origin==='ai')); assert.equal(JSON.stringify(value),before);
  assert.equal(validQualityJudgment(value,snapshot),false,'legacy revision checks remain strict');
  assert.equal(validQualityJudgment(normalized.judgment,snapshot),true);
  assert.throws(()=>makeQualityReport(snapshot,value,reviewerStatus,generator),/格式无效/);
});

test('regression: seven dimensions and six blind solutions remain usable when two of seven auxiliary quotes are unlocated', () => {
  const q=i=>({prompt:`情境${i}应如何判断？`,options:['核对条件','忽略条件','猜测','跳过'],answer:0,explanation:'依据已讲条件判断。'});
  const c={intro:'判断会议问题指向的条件。',blocks:[
    {id:'r1',type:'reading',title:'指向性',objective:'判断对象',content:{text:'人名、语境与问句共同帮助确定指向。'}},
    {id:'e1',type:'example',title:'案例',objective:'说明线索',content:{text:'模拟案例需结合前后问句判断。'}},
    {id:'r2',type:'reading',title:'语境',objective:'结合语境',content:{text:'没有明确指向时，需要结合语境确认。'}},
    {id:'e2',type:'example',title:'对照',objective:'比较情境',content:{text:'提到人名不一定是在向此人提问。'}},
    {id:'p1',type:'practice',title:'实践',objective:'独立判断',content:{text:'依据对话材料判断对象，标出线索。'}},
    {id:'q1',type:'quiz',title:'首次练习',objective:'检验判断',content:{questions:[1,2,3,4].map(q)}},
    {id:'s1',type:'summary',title:'总结',objective:'回顾方法',content:{text:'先确认问句，再结合称呼与语境判断。'}},
    {id:'q2',type:'quiz',title:'追加练习',objective:'继续检验',content:{questions:[5,6].map(q)}}
  ]};
  const snapshot=qualitySnapshot(state(),'lesson','p1',{blockCourse:c}), value=judgment(snapshot);
  const item=(unitId,quote)=>({unitId,severity:'minor',kind:'clarity',quote,reason:'建议核对条件与例子。',suggestion:'明确判断依据。'});
  value.issues=[item('p1',c.blocks[4].content.text),item('r1','人名、语境与问句'),item('r1','任何含人名的句子都只向此人提问。'),
    item('r2',c.blocks[2].content.text),item('q1',c.blocks[5].content.questions[0].prompt),item('q2','被模型改写、正文中不存在的题干。'),item('s1',c.blocks[6].content.text)];
  assert.equal(value.dimensions.length,7);assert.equal(value.solutions.length,6);
  const before=JSON.stringify(c), normalized=normalizeQualityScoreJudgment(value,snapshot), report=makeQualityReport(snapshot,normalized.judgment,reviewerStatus,generator);
  report.unverifiedIssues=normalized.unverifiedIssues;
  assert.equal(report.issues.length,5);assert.equal(report.unverifiedIssues.length,2);assert.equal(validQualityReport(report),true);
  assert.equal(report.score,100);assert.equal(report.verification,'unverified');assert.equal(JSON.stringify(c),before);
});

test('unlocated auxiliary opinions persist separately without promoting an unverified critical claim or changing course records', async t => {
  const {learning,reopen}=await database(t), snapshot=qualitySnapshot(learning.overview(),'lesson','p1',learning.getLesson('p1'));
  const result=judgment(snapshot), reading=snapshot.units.find(u=>u.type==='reading'), quiz=snapshot.units.find(u=>u.type==='quiz');
  const item={unitId:reading.id,severity:'critical',kind:'fact',quote:'原文不存在的断言。',reason:'模型提出的疑点尚待核实。',suggestion:'请核对原文。'};
  result.issues=[item,{...item,unitId:quiz.id,kind:'quiz',quote:'模型改写的题干，不是原句。'}];
  let calls=0; const before=JSON.stringify(learning.getLesson('p1'));
  const service=createQualityService({learning,getGenerator:()=>generator,getReviewer:()=>({status:()=>reviewerStatus,generate:async(_instruction,_input,validate)=>{calls++;assert.equal(validate(result),true);return result;}})});
  const report=(await service.evaluate('lesson','p1',qualityFingerprint(snapshot))).reports[0];
  assert.equal(calls,1);assert.equal(report.score,100);assert.equal(report.status,'reviewed');assert.deepEqual(report.issues,[]);
  assert.equal(report.unverifiedIssues.length,2);assert.equal(report.unverifiedIssues[0].quote,item.quote);assert.equal(report.verification,'unverified');
  assert.equal(JSON.stringify(learning.getLesson('p1')),before);
  const exported=learning.exportState();assert.equal(validState(exported),true);
  await learning.replaceState(exported);assert.deepEqual(learning.qualityReports('lesson','p1')[0].unverifiedIssues,report.unverifiedIssues);
  const reopened=await reopen();assert.deepEqual(reopened.qualityReports('lesson','p1')[0].unverifiedIssues,report.unverifiedIssues);
  assert.equal(validQualityReport({...report,unverifiedIssues:null}),false);
  assert.equal(validQualityReport({...report,unverifiedIssues:[{...report.unverifiedIssues[0],origin:'rule'}]}),false);
  assert.equal(validQualityReport({...report,status:'needs_revision'}),false,'unverified severity does not act as a confirmed issue');
});

test('invalid score dimensions, fields and blind solutions still fail with specific errors, keeping old reports without retry', async t => {
  const {learning}=await database(t), snapshot=qualitySnapshot(learning.overview(),'lesson','p1',learning.getLesson('p1'));
  let output=judgment(snapshot),calls=0;
  const service=createQualityService({learning,getGenerator:()=>generator,getReviewer:()=>({status:()=>reviewerStatus,generate:async(_instruction,_input,validate)=>{calls++;validate(output);return output;}})});
  const fingerprint=qualityFingerprint(snapshot), original=(await service.evaluate('lesson','p1',fingerprint)).reports[0],before=JSON.stringify(learning.getLesson('p1'));
  const cases=[
    [v=>v.dimensions.pop(),/dimensions应有/],
    [v=>{v.dimensions[0].rating=4.5;},/dimensions\[0\]\.rating必须是0–4的整数/],
    [v=>{v.solutions=[];},/solutions应覆盖1道题，实际返回0项/],
    [v=>{v.solutions[0].questionIndex=99;},/solutions\[0\]未对应/],
    [v=>{v.solutions[0].answer='A';},/solutions\[0\]\.answer必须/],
    [v=>{v.issues=[null];},/issues\[0\]必须是问题对象/],
    [v=>{v.issues=[{unitId:'unknown',severity:'minor',kind:'fact',quote:'引用',reason:'理由',suggestion:'建议'}];},/issues\[0\]\.unitId/],
    [v=>{v.issues=[{unitId:snapshot.units[0].id,severity:'minor',kind:'fact',quote:'',reason:'理由',suggestion:'建议'}];},/issues\[0\]\.quote缺失/]
  ];
  for(const [mutate,error]of cases){output=judgment(snapshot);mutate(output);const count=calls;await assert.rejects(service.evaluate('lesson','p1',fingerprint),error);assert.equal(calls,count+1);assert.equal(service.inspect('lesson','p1').reports[0].id,original.id);}
  assert.equal(JSON.stringify(learning.getLesson('p1')),before);
  assert.ok(qualityJudgmentProblems(output,snapshot,{allowUnverifiedQuotes:true}).some(problem=>problem.includes('.quote')));
  output=judgment(snapshot);assert.equal((await service.evaluate('lesson','p1',fingerprint)).reports.length,2,'failed attempts release their lock');
});

test('cancelling a score with unlocated quotes never saves a partial report or accepts a late result', async t => {
  const {learning}=await database(t), snapshot=qualitySnapshot(learning.overview(),'lesson','p1',learning.getLesson('p1'));
  let finish;const wait=new Promise(resolve=>{finish=resolve;}),controller=new AbortController();
  const service=createQualityService({learning,getGenerator:()=>generator,getReviewer:()=>({status:()=>reviewerStatus,generate:async(_instruction,_input,validate)=>{await wait;const value=judgment(snapshot);validate(value);return value;}})});
  const work=withGenerationSignal(controller.signal,()=>service.evaluate('lesson','p1',qualityFingerprint(snapshot)));
  const stopped=assert.rejects(work,isGenerationCancelled);controller.abort();await stopped;finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(learning.qualityReports('lesson','p1').length,0);
});

test('content changes invalidate reports; stale and concurrent requests never create duplicate model calls', async t => {
  const { learning, saved } = await database(t);
  let finish, calls = 0;
  const service = createQualityService({ learning, getGenerator: () => generator, getReviewer: () => ({ status: () => reviewerStatus, generate: async (instruction, input) => { calls++; await new Promise(resolve => { finish = resolve; }); return judgment(qualitySnapshot(learning.overview(), 'lesson', 'p1', learning.getLesson('p1'))); } }) });
  const initial = service.inspect('lesson', 'p1');
  await assert.rejects(service.evaluate('lesson', 'p1', 'bad-hash'), /已变化/); assert.equal(calls, 0);
  const pending = service.evaluate('lesson', 'p1', initial.fingerprint);
  await assert.rejects(service.evaluate('lesson', 'p1', initial.fingerprint), /正在评价/);
  finish(); await pending; assert.equal(calls, 1);
  learning.reviseBlock('p1', saved.blocks[0].id, { text: '首次提交前还需要核对当前目录。' }, course().blocks[0].content.text);
  const updated = service.inspect('lesson', 'p1'); assert.equal(updated.currentReportId, null);
  assert.equal(updated.reports.length, 1); assert.notEqual(updated.fingerprint, updated.reports[0].fingerprint);
});

test('missing or conflicting evaluator makes no model request, and provider failure leaves old reports intact', async t => {
  const { learning } = await database(t);
  let status = { ...generator }, calls = 0;
  const reviewer = { status: () => status, generate: async () => { calls++; throw new Error('模型暂时不可用。'); } };
  const service = createQualityService({ learning, getReviewer: () => reviewer, getGenerator: () => generator });
  const view = service.inspect('lesson', 'p1');
  await assert.rejects(service.evaluate('lesson', 'p1', view.fingerprint), /必须不同/);
  status = { mode: 'demo' }; await assert.rejects(service.evaluate('lesson', 'p1', view.fingerprint), /先配置/); assert.equal(calls, 0);
  status = reviewerStatus;
  const priorService = createQualityService({ learning, getGenerator: () => generator, getReviewer: () => ({ status: () => reviewerStatus, generate: async () => judgment(qualitySnapshot(learning.overview(), 'lesson', 'p1', learning.getLesson('p1'))) }) });
  const prior = await priorService.evaluate('lesson', 'p1', view.fingerprint);
  await assert.rejects(service.evaluate('lesson', 'p1', view.fingerprint), /暂时不可用/); assert.equal(calls, 1);
  assert.equal(service.inspect('lesson', 'p1').reports[0].id, prior.reports[0].id);
});

test('a course updated during evaluation keeps its new content and saves the returned report as historical', async t => {
  const { learning, saved } = await database(t);
  const snapshot = qualitySnapshot(learning.overview(), 'lesson', 'p1', learning.getLesson('p1'));
  let finish;
  const service = createQualityService({ learning, getGenerator: () => generator, getReviewer: () => ({ status: () => reviewerStatus, generate: async () => { await new Promise(resolve => { finish = resolve; }); return judgment(snapshot); } }) });
  const pending = service.evaluate('lesson', 'p1', qualityFingerprint(snapshot));
  const nextText = '提交前不仅配置身份，还需核对暂存内容。';
  learning.reviseBlock('p1', saved.blocks[0].id, { text: nextText }, course().blocks[0].content.text);
  finish(); const view = await pending;
  assert.equal(view.currentReportId, null); assert.equal(view.reports.length, 1);
  assert.equal(view.reports[0].fingerprint, qualityFingerprint(snapshot));
  assert.equal(learning.getLesson('p1').blockCourse.blocks[0].content.text, nextText);
});

test('reports persist across reopen and retain only ten recent reviews; weak core dimensions override high averages', async t => {
  const { learning, reopen } = await database(t);
  const snapshot = qualitySnapshot(learning.overview(), 'lesson', 'p1', learning.getLesson('p1'));
  const value = judgment(snapshot); value.dimensions.find(d => d.id === 'quiz').rating = 2;
  const service = createQualityService({ learning, getGenerator: () => generator, getReviewer: () => ({ status: () => reviewerStatus, generate: async () => value }) });
  const report = (await service.evaluate('lesson', 'p1', qualityFingerprint(snapshot))).reports[0];
  assert.ok(report.score >= 85); assert.equal(report.status, 'needs_revision');
  for (let i = 1; i <= 12; i++) learning.saveQualityReport({ ...report, id: `history-${i}`, created: report.created + i });
  assert.equal(service.inspect('lesson', 'p1').reports.length, 10);
  assert.equal(service.inspect('lesson', 'p1').reports[0].id, 'history-12');
  const reopened = await reopen();
  assert.equal(reopened.qualityReports('lesson', 'p1').length, 10);
  assert.equal(validState(reopened.exportState()), true);
});

test('route deletion removes evaluation reports and their owned historical backups', async t => {
  const { learning } = await database(t);
  const snapshot = qualitySnapshot(learning.overview(), 'route', demoPlan.id);
  const service = createQualityService({ learning, getGenerator: () => generator, getReviewer: () => ({ status: () => reviewerStatus, generate: async () => judgment(snapshot) }) });
  await service.evaluate('route', demoPlan.id, service.inspect('route', demoPlan.id).fingerprint);
  const other = structuredClone(demoPlan); other.id = 'other-plan'; other.lessons = other.lessons.map((l, i) => ({ ...l, id: `other-${i}` }));
  learning.savePlan(other);
  await learning.deletePlan(demoPlan.id);
  assert.equal((learning.exportState().qualityReports || []).length, 0);
});
