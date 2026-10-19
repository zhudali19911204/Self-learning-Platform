import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFactCorrectionService } from '../course-fact-correction.mjs';
import { createFactCheckService } from '../course-fact-check.mjs';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { validState } from '../desktop/local-store.mjs';
import { sameFactContent, validFactCheck } from '../public/fact-check.js';

const content = () => ({ text: '开头保持不变。\n2 + 2 = 5。\n中间不变。\n3 + 3 = 7。\n结尾保持不变。' });
const issue = quote => ({ kind: 'fact', certainty: 'uncertain', quote, reason: '计算结果可能有误。', suggestion: '重新计算并修正文案。', evidence: [] });
async function setup(t, { type = 'reading', original = content(), issues = [issue('2 + 2 = 5。'), issue('3 + 3 = 7。')], response } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'learnflow-selected-facts-'));
  const store = await createSqliteStore(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const outline = store.saveOutline('p1', { intro: '公开教学导语', blocks: [{ type, title: '计算条件', objective: '准确计算' }, { type: 'reading', title: '后续', objective: '理解' }, { type: 'quiz', title: '测验', objective: '检验' }] });
  const blockId = outline.blocks[0].id;
  store.saveBlock('p1', blockId, original);
  let reviewCalls = 0, responseValue = response, calls = [];
  const reviewer = { status: () => ({ mode: 'ai', provider: 'test', model: 'reviewer' }), generate: async (_instruction, _input, validate) => {
    reviewCalls++;
    const judgment = { summary: '有待核实项。', issues: structuredClone(issues), solutions: type === 'quiz' ? original.questions.map((q, questionIndex) => ({ questionIndex, answer: q.answer, ambiguous: false, reason: '按原条件求解。' })) : [] };
    assert.ok(validate(judgment)); return judgment;
  } };
  const generator = { status: () => ({ mode: 'ai', provider: 'test', model: 'writer' }), generate: async (instruction, input, validate) => {
    calls.push({ instruction, input });
    if (responseValue instanceof Error) throw responseValue;
    const value = typeof responseValue === 'function' ? await responseValue(input) : responseValue || { replacements: input.targets.map(t => ({ id: t.id, text: t.text.replace('2 + 2 = 5。', '2 + 2 = 4。').replace(/\[S1E1\]/g, '') })) };
    assert.ok(validate(value)); return value;
  } };
  const checker = createFactCheckService({ learning: store, getReviewer: () => reviewer, getGenerator: () => generator });
  const reviewed = await checker.process('p1', blockId, original);
  store.saveFactCheckedBlock('p1', blockId, reviewed.content, reviewed.record, original);
  assert.equal(reviewed.record.status, 'uncertain');
  const service = createFactCorrectionService({ learning: store, getGenerator: () => generator });
  return { store, checker, service, blockId, record: reviewed.record, calls, reviews: () => reviewCalls,
    respond: value => { responseValue = value; },
    run: (indices = [0], options = {}) => service.correct('p1', blockId, reviewed.record.id, indices, { confirmed: true, ...options }) };
}

test('confirmed source-free selection updates only the selected passage with one call and preserves a restorable original', async t => {
  const f = await setup(t), before = f.store.getLesson('p1');
  const stages = [], result = await f.run([0], { notify: stage => stages.push(stage) });
  assert.equal(result.content.text, content().text.replace('2 + 2 = 5。', '2 + 2 = 4。'));
  assert.equal(f.calls.length, 1); assert.equal(f.reviews(), 1); assert.deepEqual(stages, ['fact_correcting']);
  const record = result.factChecks.at(-1);
  assert.equal(record.status, 'edited'); assert.equal(record.issues.length, 1); assert.equal(record.issues[0].quote, '3 + 3 = 7。');
  assert.ok(validFactCheck(record)); assert.equal(record.sourceRecordId, f.record.id); assert.deepEqual(record.beforeContent, content());
  assert.match(record.summary, /尚未重新核查或联网验证/);
  assert.equal(f.calls[0].input.selectedIssues.length, 1); assert.equal(f.calls[0].input.selectedIssues[0].quote, '2 + 2 = 5。');
  assert.ok(validState(f.store.exportState()));
  f.store.replaceState(f.store.exportState());
  assert.equal(f.store.getLesson('p1').factChecks.at(-1).status, 'edited');
  assert.ok(sameFactContent(f.store.restoreFactCheck('p1', f.blockId, record.id).content, before.blockCourse.blocks[0].content));
  assert.equal(f.calls.length, 1);
});

test('missing consent, empty or duplicate selections, wrong reports and stale content cost no calls', async t => {
  const f = await setup(t);
  for (const indices of [[], [0, 0], [-1], [2], ['0'], null]) await assert.rejects(f.run(indices), /选择|疑点/);
  await assert.rejects(f.run([0], { confirmed: false }), /确认/);
  await assert.rejects(f.service.correct('p1', f.blockId, 'missing', [0], { confirmed: true }), /变化/);
  f.store.reviseBlock('p1', f.blockId, { text: '用户的新文案。' }, content().text);
  await assert.rejects(f.run(), /变化/); assert.equal(f.calls.length, 0);
});

test('overlapping selected quotes merge into one replacement without rewriting surrounding prose', async t => {
  const original = { text: '前文。错误计算2 + 2 = 5。后文。' };
  const f = await setup(t, { original, issues: [issue('错误计算2 + 2 = 5。'), issue('2 + 2 = 5。')], response: input => {
    assert.equal(input.targets.length, 1); return { replacements: [{ id: 'T0', text: '正确计算2 + 2 = 4。' }] };
  } });
  const result = await f.run([0, 1]); assert.equal(result.content.text, '前文。正确计算2 + 2 = 4。后文。');
  assert.equal(result.factChecks.at(-1).status, 'edited'); assert.equal(f.calls.length, 1);
});

test('ambiguous duplicate quotes cannot silently replace the wrong occurrence', async t => {
  const f = await setup(t, { original: { text: '2 + 2 = 5。\n2 + 2 = 5。' }, issues: [issue('2 + 2 = 5。')] });
  await assert.rejects(f.run(), /出现多次/); assert.equal(f.calls.length, 0);
});

test('invalid, invented-citation, unchanged and failed model outputs never alter the saved text or report', async t => {
  const f = await setup(t), before = JSON.stringify(f.store.getLesson('p1'));
  for (const response of [new Error('模型调用失败'), { replacements: [] }, { replacements: [{ id: 'unknown', text: '修改' }] },
    { replacements: [{ id: 'T0', text: '2 + 2 = 4。[S9E9]' }] }, { replacements: [{ id: 'T0', text: '2 + 2 = 5。' }] }]) {
    f.respond(response); await assert.rejects(f.run()); assert.equal(JSON.stringify(f.store.getLesson('p1')), before);
  }
  assert.equal(f.calls.length, 5, 'exactly one call per explicit attempt, never retries');
});

test('concurrent corrections and newer user edits cannot be overwritten', async t => {
  const f = await setup(t); let release;
  f.respond(input => new Promise(resolve => { release = () => resolve({ replacements: [{ id: input.targets[0].id, text: '2 + 2 = 4。' }] }); }));
  const pending = f.run(); await assert.rejects(f.run(), /正在修正/);
  f.store.reviseBlock('p1', f.blockId, { text: '用户在等待时编辑的新正文。' }, content().text);
  release(); await assert.rejects(pending, /变化/);
  assert.equal(f.store.getLesson('p1').blockCourse.blocks[0].content.text, '用户在等待时编辑的新正文。');
  assert.equal(f.calls.length, 1);
});

test('changed source claims lose old evidence while untouched claims and references remain intact', async t => {
  const original = { text: '2 + 2 = 5。[S1E1]\n\n3 + 3 = 7。[S1E1]', grounding: { version: 1, citations: ['2 + 2 = 5。', '3 + 3 = 7。'].map(claim => ({ excerptId: 'S1E1', claim, quote: '一个示例资料片段。', url: 'https://docs.example.org/math', title: '资料', publisher: '示例', retrievedAt: 1000 })) } };
  const f = await setup(t, { original });
  const result = await f.run();
  assert.equal(result.content.text, '2 + 2 = 4。\n\n3 + 3 = 7。[S1E1]');
  assert.equal(result.content.grounding.citations.length, 1); assert.equal(result.content.grounding.citations[0].claim, '3 + 3 = 7。');
  assert.ok(validState(f.store.exportState()));
});

test('quiz corrections touch selected questions only and preserve versioned grades and restoration', async t => {
  const original = { questions: [0, 1].map(i => ({ prompt: `第${i + 1}题：2 + 2 等于几？`, options: ['5', '4', '3', '2'], answer: 0, explanation: '原解析。' })) };
  const f = await setup(t, { type: 'quiz', original, issues: [issue(original.questions[0].prompt)], response: input => ({ replacements: [{ id: input.targets[0].id, question: { ...original.questions[0], answer: 1, explanation: '2 + 2 = 4。' } }] }) });
  f.store.saveProgress('p1', { completed: true, attempts: 1, lastScore: 100, bestScore: 100, lastAnswers: [0, 0] });
  const result = await f.run(); assert.equal(result.content.questions[0].answer, 1); assert.deepEqual(result.content.questions[1], original.questions[1]);
  assert.notEqual(result.quizRecord.currentFingerprint, result.quizRecord.progressFingerprint);
  assert.equal(result.quizRecord.history[0].progress.bestScore, 100);
  const restored = f.store.restoreFactCheck('p1', f.blockId, result.factChecks.at(-1).id);
  assert.deepEqual(restored.content.questions, original.questions); assert.equal(restored.quizRecord.currentFingerprint, restored.quizRecord.progressFingerprint);
  assert.equal(f.calls.length, 1);
});

test('manually corrected versions are rechecked on demand, not treated as reviewed cache hits', async t => {
  const f = await setup(t), result = await f.run();
  await f.checker.process('p1', f.blockId, result.content);
  assert.equal(f.reviews(), 2); assert.equal(f.calls.length, 1);
});
