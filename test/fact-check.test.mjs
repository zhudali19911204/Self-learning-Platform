import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFactCheckService, validFactJudgment, normalizeFactJudgment, normalizeFactQuotes, normalizeFactEvidence, factJudgmentProblems, factReviewInstructionFor } from '../course-fact-check.mjs';
import { factContent, sameFactContent, validFactCheck } from '../public/fact-check.js';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { createFactCheckSettings } from '../desktop/fact-check-settings.mjs';
import { validState } from '../desktop/local-store.mjs';
import { withGenerationSignal, isGenerationCancelled } from '../generation-cancellation.mjs';

const quote = '标准大气压下，水的沸点为100°C。';
const original = () => ({ text: '水的沸点为90°C。[S1E1]', grounding: { version: 1, citations: [{ excerptId: 'S1E1', url: 'https://docs.example.org/water', title: '沸点说明', publisher: 'docs.example.org', retrievedAt: 1000, quote, claim: '水的沸点为90°C。' }] } });
const corrected = () => ({ text: quote + '[S1E1]' });
const clean = () => ({ summary: '在已提供材料范围内未发现明显问题。', issues: [], solutions: [] });
const error = () => ({ summary: '发现一处有资料支持的错误。', issues: [{ certainty: 'error', kind: 'fact', quote: '水的沸点为90°C。', reason: '给定资料表明标准大气压下应为100°C，并需要注明条件。', suggestion: '按给定资料修正沸点，并补充标准大气压条件。', evidence: [{ id: 'R1', quote }] }], solutions: [] });
async function setup(t, { judgments = [clean()], correction = corrected(), type = 'reading', reviewerModel = 'reviewer', generatorFailure } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'learnflow-facts-'));
  let store; t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = await createSqliteStore(directory);
  const outline = store.saveOutline('p1', { intro: '公开课程导语', blocks: [{ type, title: '水的沸点', objective: '说明条件与沸点' }, { type: 'reading', title: '其他讲解', objective: '解释其他条件' }, { type: 'quiz', title: '测验', objective: '应用判断' }] });
  let reviewerConfig = { provider: 'test', model: reviewerModel, baseUrl: 'https://review.example.org/v1' };
  const sent = [], generated = [], stages = [];
  const generator = { status: () => ({ mode: 'ai', provider: 'test', model: 'generator' }), generate: async (instruction, input, validate) => {
    generated.push({ instruction, input }); if (generatorFailure) throw new Error(generatorFailure);
    const value = structuredClone(correction); if (!validate(value)) throw new Error('invalid correction'); return value;
  } };
  const checker = createFactCheckService({ learning: store, getGenerator: () => generator, getGeneratorConfig: () => ({ baseUrl: 'https://generate.example.org/v1' }), getReviewerConfig: () => reviewerConfig,
    getReviewer: () => ({ status: () => ({ mode: 'ai', ...reviewerConfig }), generate: async (instruction, input, validate) => {
      sent.push({ instruction, input }); const value = await judgments.shift(); if (value instanceof Error) throw value;
      if (!validate(value)) throw new Error('invalid review'); return value;
    } }) });
  return { store, checker, generator, directory, blockId: outline.blocks[0].id, sent, generated, stages,
    run: content => checker.process('p1', outline.blocks[0].id, content, { notify: stage => stages.push(stage) }), changeReviewer: config => { reviewerConfig = { ...reviewerConfig, ...config }; } };
}

test('cancelling an independent review discards the draft and report instead of saving a failed review', async t => {
  let finish; const judgment = new Promise(resolve => { finish = resolve; });
  const f = await setup(t, { judgments: [judgment] }), controller = new AbortController();
  const work = withGenerationSignal(controller.signal, () => f.run(original()));
  const rejected = assert.rejects(work, isGenerationCancelled); controller.abort(); await rejected;
  assert.equal(f.checker.isBusy('p1'), false); assert.equal(f.store.getLesson('p1').blockCourse.blocks[0].content, null);
  assert.equal(f.store.getLesson('p1').factChecks.length, 0); assert.equal(f.generated.length, 0);
  finish(clean()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.getLesson('p1').factChecks.length, 0);
});
test('one supported error leads to exactly one correction and one independent recheck, preserving source provenance', async t => {
  const f = await setup(t, { judgments: [error(), clean()] }), value = await f.run(original());
  assert.equal(value.record.status, 'corrected'); assert.equal(validFactCheck(value.record), true);
  assert.equal(f.sent.length, 2); assert.equal(f.generated.length, 1);
  assert.deepEqual(f.stages, ['fact_checking', 'fact_correcting', 'fact_rechecking']);
  assert.equal(value.content.text, corrected().text); assert.equal(value.content.grounding.citations[0].quote, quote);
  assert.equal(value.content.grounding.citations[0].url, original().grounding.citations[0].url);
  assert.deepEqual(value.record.beforeContent, original());
  assert.equal(f.sent[0].input.sources[0].quote, quote);
  const saved = f.store.saveFactCheckedBlock('p1', f.blockId, value.content, value.record, null);
  assert.equal(saved.content.text, corrected().text);
  assert.equal(validState(f.store.exportState()), true);
  const cached = await f.run(saved.content); assert.equal(cached.cached, true); assert.equal(f.sent.length, 2);
  const restored = f.store.restoreFactCheck('p1', f.blockId, value.record.id);
  assert.equal(restored.content.text, original().text);
  assert.ok(!sameFactContent(restored.content, value.record.content));
  assert.throws(() => f.store.restoreFactCheck('p1', f.blockId, value.record.id), /内容已变化/);
});

test('without documentary evidence, allegations are only uncertainty and never cause automatic rewriting', async t => {
  const judgment = error(); judgment.issues[0].evidence = [];
  const f = await setup(t, { judgments: [judgment] });
  const value = await f.run({ text: original().text });
  assert.equal(value.record.status, 'uncertain'); assert.equal(value.record.issues[0].certainty, 'uncertain');
  assert.equal(value.content.text, original().text); assert.equal(f.generated.length, 0); assert.equal(f.sent.length, 1);
});

test('real-model regression: omitted inapplicable solutions preserve non-quiz findings without another paid request', async t => {
  for (const type of ['reading', 'example', 'practice', 'summary']) {
    const judgment = error(); judgment.issues[0].evidence = []; delete judgment.solutions;
    const snapshot = structuredClone(judgment);
    const f = await setup(t, { type, judgments: [judgment] });
    const result = await f.run({ text: original().text });
    assert.equal(result.record.status, 'uncertain'); assert.equal(result.record.issues.length, 1);
    assert.equal(result.record.issues[0].quote, judgment.issues[0].quote);
    assert.equal(result.content.text, original().text); assert.equal(result.record.error, '');
    assert.equal(f.sent.length, 1); assert.equal(f.generated.length, 0);
    assert.deepEqual(judgment, snapshot); // Normalization must not mutate the upstream object.
    assert.equal(validFactCheck(result.record), true);
    f.store.saveFactCheckedBlock('p1', f.blockId, result.content, result.record, null);
    assert.equal((await f.run(result.content)).cached, true); assert.equal(f.sent.length, 1);
  }
  const { solutions, ...noQuestions } = clean();
  assert.deepEqual(normalizeFactJudgment(noQuestions, 'reading'), clean());
});

test('normalization never fills missing quiz solutions, findings or invalid arrays, nor trusts invented quotations', async t => {
  const quiz = { questions: [{ prompt: '哪项成立？', options: ['甲', '乙', '丙', '丁'], answer: 0, explanation: '按条件判断。' }] };
  const missing = { summary: '未发现问题。', issues: [] };
  const f = await setup(t, { type: 'quiz', judgments: [missing] });
  const result = await f.run(quiz);
  assert.equal(result.record.status, 'failed'); assert.match(result.record.error, /solutions 缺失/);
  assert.deepEqual(result.content, quiz); assert.equal(f.sent.length, 1); assert.equal(f.generated.length, 0);
  assert.equal(normalizeFactJudgment(missing, 'quiz'), missing);
  for (const raw of [null, [], { summary: '缺少问题数组。' }, { ...clean(), solutions: null }, { ...clean(), solutions: {} }, { ...clean(), solutions: [{ answer: 0 }] }]) {
    assert.equal(validFactJudgment(normalizeFactJudgment(raw, 'reading'), 'reading', original(), []), false);
  }
  for (const field of ['quote', 'evidence']) {
    const judgment = error(); delete judgment.solutions;
    if (field === 'quote') judgment.issues[0].quote = '模型改写但正文不存在的句子';
    else judgment.issues[0].evidence[0].quote = '资料中不存在的内容';
    const f = await setup(t, { judgments: [judgment] });
    const result = await f.run(original());
    if (field === 'quote') { assert.equal(result.record.status, 'uncertain'); assert.equal(result.record.error, ''); assert.equal(result.record.issues[0].unlocated, true); assert.deepEqual(result.record.issues[0].evidence, []); }
    else { assert.equal(result.record.status, 'uncertain'); assert.equal(result.record.issues[0].certainty, 'uncertain'); assert.deepEqual(result.record.issues[0].evidence, []); assert.match(result.record.issues[0].reason, /引用待核实/); }
    assert.equal(result.content.text, original().text); assert.equal(f.sent.length, 1); assert.equal(f.generated.length, 0);
  }
});

test('fact-check prompts specify only the applicable solution schema and errors identify fields without echoing course text', () => {
  assert.ok(!factReviewInstructionFor('reading').includes('questionIndex'));
  assert.match(factReviewInstructionFor('reading'), /"solutions":\[\]/);
  assert.match(factReviewInstructionFor('quiz'), /questionIndex/);
  const judgment = error(); judgment.issues[0].quote = 'private-text-not-in-body';
  const problems = factJudgmentProblems(judgment, 'reading', original(), [{ id: 'R1', quote }]);
  assert.match(problems.join(' '), /issues\[0\]\.quote/);
  assert.ok(!problems.join(' ').includes(judgment.issues[0].quote));
});

test('Markdown-only quote differences resolve to exact source text without an additional review call', async t => {
  const content = { ...original(), text: '**水的沸点**为90°C。[S1E1]' };
  const f = await setup(t, { judgments: [error(), clean()] });
  const result = await f.run(content);
  assert.equal(result.record.status, 'corrected');
  assert.equal(result.record.issues[0].quote, '**水的沸点**为90°C。');
  assert.equal(result.record.beforeContent.text, content.text);
  assert.equal(f.sent.length, 2); assert.equal(f.generated.length, 1);
});

test('one unlocatable quote preserves every finding as a partial review, never clear or automatic rewriting', async t => {
  const judgment = error();
  judgment.issues.push({ ...structuredClone(judgment.issues[0]), kind: 'scope', quote: '已知条件需要核对。', evidence: [] });
  judgment.issues.push({ ...structuredClone(judgment.issues[0]), quote: '模型重新概括的疑点，不是正文原句。' });
  const snapshot = structuredClone(judgment), content = { ...original(), text: original().text + '\n\n**已知条件**需要核对。' };
  const f = await setup(t, { judgments: [judgment, clean()] });
  const result = await f.run(content);
  assert.equal(result.record.status, 'uncertain'); assert.equal(result.record.error, '');
  assert.equal(result.record.issues.length, 3);
  assert.equal(result.record.issues[0].certainty, 'error');
  assert.equal(result.record.issues[1].quote, '**已知条件**需要核对。');
  const unresolved = result.record.issues[2];
  assert.equal(unresolved.unlocated, true); assert.equal(unresolved.certainty, 'uncertain');
  assert.equal(unresolved.quote, judgment.issues[2].quote); assert.deepEqual(unresolved.evidence, []);
  assert.match(unresolved.reason, /原句待定位/); assert.match(result.record.summary, /原句未能定位/);
  assert.deepEqual(result.content, content); assert.deepEqual(judgment, snapshot);
  assert.equal(f.sent.length, 1); assert.equal(f.generated.length, 0);
  assert.ok(validFactCheck(result.record));
  f.store.saveFactCheckedBlock('p1', f.blockId, result.content, result.record, null);
  const backup = f.store.exportState(); assert.ok(validState(backup)); f.store.replaceState(backup);
  assert.equal(f.store.getLesson('p1').factChecks[0].issues[2].unlocated, true);
  const retry = await f.run(content);
  assert.equal(retry.cached, false, 'an explicit retry must not reuse unlocated findings');
  assert.equal(f.sent.length, 2); assert.equal(f.generated.length, 0);
});

test('quote normalization tolerates only presentation, never changes numbers, negation, code, ellipses or teaching scope', () => {
  const normalize = (body, quote) => {
    const raw = error(); raw.issues[0].quote = quote;
    const snapshot = structuredClone(raw), result = normalizeFactQuotes(raw, 'reading', { text: body });
    assert.deepEqual(raw, snapshot);
    assert.deepEqual(normalizeFactQuotes(result, 'reading', { text: body }), result, 'normalization is idempotent');
    return result;
  };
  for (const [body, quote] of [['**定义**与 *边界*。', '定义与 边界。'], ['使用 `git config` 核对。', '使用 git config 核对。'], ['先核对\n条件，再生成。', '先核对 条件，再生成。']]) {
    const result = normalize(body, quote);
    assert.equal(result.issues[0].quote, body); assert.equal(result.issues[0].unlocated, undefined);
  }
  for (const [body, quote] of [['最多3次。', '最多5次。'], ['并不是事实保证。', '并是事实保证。'], ['`x != y`', 'x = y'], ['`print("a  b")`', 'print("a b")'], ['原文甲。\n\n原文乙。', '原文甲。…原文乙。'], ['只有目标正文。', '来自其他模块或资料的句子。']]) {
    const result = normalize(body, quote);
    assert.equal(result.issues[0].quote, quote); assert.equal(result.issues[0].unlocated, true);
    assert.equal(result.issues[0].certainty, 'uncertain'); assert.deepEqual(result.issues[0].evidence, []);
    assert.equal(validFactJudgment(result, 'reading', { text: body }, []), true);
  }
  const fabricatedFlag = error(); fabricatedFlag.issues[0].unlocated = true;
  assert.equal(normalizeFactQuotes(fabricatedFlag, 'reading', original()).issues[0].unlocated, undefined, 'the location flag is computed locally, not trusted from the model');
  const invalid = error(); invalid.issues[0].quote = '';
  assert.equal(validFactJudgment(normalizeFactQuotes(invalid, 'reading', original()), 'reading', original(), []), false);
});

test('quiz quote matching stays within individual supplied fields and keeps independent answers mandatory', async t => {
  const content = { questions: [{ prompt: '选择正确条件。', options: ['**条件甲**适用。', '条件乙', '条件丙', '条件丁'], answer: 0, explanation: '按题目条件逐一核对。' }] };
  const judgment = { ...error(), solutions: [{ questionIndex: 0, answer: 0, ambiguous: false, reason: '按条件判断。' }] };
  judgment.issues[0].quote = '条件甲适用。'; judgment.issues[0].evidence = [];
  judgment.issues.push({ ...structuredClone(judgment.issues[0]), quote: '条件甲适用。\n条件乙' });
  const f = await setup(t, { type: 'quiz', judgments: [judgment] }), result = await f.run(content);
  assert.equal(result.record.status, 'uncertain'); assert.equal(result.record.error, '');
  assert.equal(result.record.issues[0].quote, '**条件甲**适用。');
  assert.equal(result.record.issues[1].unlocated, true, 'adjacent answer fields cannot supply a stitched quote');
  assert.equal(f.sent.length, 1); assert.equal(f.generated.length, 0);
  assert.equal(f.sent[0].input.target.questions[0].answer, undefined);
});

test('evidence ID aliases resolve only to the exact supplied source, retaining valid findings without an extra call', async t => {
  const judgment = error(); judgment.issues[0].evidence[0].id = '[S1E1]';
  const snapshot = structuredClone(judgment);
  const sources = [{ id: 'R1', excerptId: 'S1E1', quote }];
  const normalized = normalizeFactEvidence(judgment, sources);
  assert.equal(normalized.issues[0].evidence[0].id, 'R1'); assert.deepEqual(judgment, snapshot);
  assert.equal(validFactJudgment(normalized, 'reading', original(), sources), true);
  const f = await setup(t, { judgments: [judgment, clean()] });
  const result = await f.run(original());
  assert.equal(result.record.status, 'corrected'); assert.equal(f.sent.length, 2); assert.equal(f.generated.length, 1);
  assert.equal(result.record.issues[0].evidence[0].id, 'R1'); assert.equal(validFactCheck(result.record), true);
});

test('mismatched references preserve every finding as uncertainty without trusting fabricated evidence or automatically correcting', async t => {
  const judgment = error();
  judgment.issues[0].evidence = [{ id: 'R999', quote }, { id: 'R1', quote: '这是一段改写或虚构的资料原文。' }];
  judgment.issues.push({ ...structuredClone(judgment.issues[0]), kind: 'scope', reason: '适用条件有疑问。' });
  const f = await setup(t, { judgments: [judgment] });
  const result = await f.run(original());
  assert.equal(result.record.status, 'uncertain'); assert.equal(result.record.error, ''); assert.equal(result.record.issues.length, 2);
  assert.ok(result.record.issues.every(i => i.certainty === 'uncertain' && i.evidence.length === 0 && i.reason.includes('引用待核实')));
  assert.equal(result.content.text, original().text); assert.equal(f.sent.length, 1); assert.equal(f.generated.length, 0);
  assert.equal(validFactCheck(result.record), true);
  assert.match(result.record.summary, /有 2 项疑点的引用未能核实/);
  f.store.saveFactCheckedBlock('p1', f.blockId, result.content, result.record, null);
  assert.equal(validState(f.store.exportState()), true);
});

test('empty evidence input, ambiguous aliases and partially matching evidence cannot produce trusted errors', async t => {
  const judgment = error();
  for (const sources of [[], [{ id: 'R1', excerptId: 'S1E1', quote }, { id: 'R2', excerptId: 'S1E1', quote }]]) {
    const value = structuredClone(judgment); value.issues[0].evidence[0].id = 'S1E1';
    const normalized = normalizeFactEvidence(value, sources);
    assert.equal(normalized.issues[0].certainty, 'uncertain'); assert.deepEqual(normalized.issues[0].evidence, []);
    assert.deepEqual(normalizeFactEvidence(normalized, sources), normalized);
  }
  const value = error(); value.issues[0].evidence.push({ id: 'R2', quote: '虚构资料' });
  const normalized = normalizeFactEvidence(value, [{ id: 'R1', quote }]);
  assert.deepEqual(normalized.issues[0].evidence, [], 'one valid quotation cannot conceal a fabricated second quotation');
  const malformed = error(); malformed.issues[0].evidence = null;
  const f = await setup(t, { judgments: [malformed] });
  assert.equal((await f.run(original())).record.status, 'failed'); assert.equal(f.generated.length, 0);
});

test('repeated concerns after repair stop after one round and keep the original generated content', async t => {
  const second = error(); second.issues[0].quote = quote;
  const f = await setup(t, { judgments: [error(), second] });
  const value = await f.run(original());
  assert.equal(value.record.status, 'uncertain'); assert.equal(value.content.text, original().text);
  assert.match(value.record.summary, /保留原文/); assert.equal(f.sent.length, 2); assert.equal(f.generated.length, 1);
});

test('review, correction and recheck failures keep content and allow a later retry without hidden loops', async t => {
  for (const [judgments, generatorFailure] of [[[new Error('核查超时')], undefined], [[error()], '修正服务不可用'], [[error(), new Error('复核超时')], undefined]]) {
    const f = await setup(t, { judgments, generatorFailure });
    const value = await f.run(original());
    assert.equal(value.record.status, 'failed'); assert.equal(value.content.text, original().text);
    assert.ok(value.record.error); assert.ok(f.sent.length <= 2); assert.ok(f.generated.length <= 1);
    f.store.saveFactCheckedBlock('p1', f.blockId, value.content, value.record, null);
    assert.equal(f.store.getLesson('p1').blockCourse.blocks[0].content.text, original().text);
  }
});

test('cached results are invalidated by content or reviewer endpoint changes and same-role models never get called', async t => {
  const f = await setup(t, { judgments: [clean(), clean(), clean()] });
  const first = await f.run(original()); f.store.saveFactCheckedBlock('p1', f.blockId, first.content, first.record, null);
  assert.equal((await f.run(original())).cached, true); assert.equal(f.sent.length, 1);
  f.changeReviewer({ baseUrl: 'https://other-review.example.org/v1' });
  assert.equal((await f.run(original())).cached, false); assert.equal(f.sent.length, 2);
  await f.run({ ...original(), text: original().text + '边界说明。' }); assert.equal(f.sent.length, 3);
  const same = await setup(t, { reviewerModel: 'generator' });
  assert.equal((await same.run(original())).record.status, 'failed'); assert.equal(same.sent.length, 0); assert.equal(same.generated.length, 0);
});

test('reports reject invented quotations/evidence; valid source metadata is whitelisted before transmission', async t => {
  const value = original(); value.notes = 'private-note'; value.grounding.secret = 'private-key'; value.grounding.citations[0].chat = 'private-chat';
  const f = await setup(t); const checked = await f.run(value);
  assert.equal(checked.record.status, 'clear'); assert.ok(!JSON.stringify(f.sent).includes('private-'));
  assert.ok(!JSON.stringify(factContent(value)).includes('private-'));
  const sources = [{ id: 'R1', quote }];
  const invalid = error(); invalid.issues[0].evidence[0].quote = '不存在的资料';
  assert.equal(validFactJudgment(invalid, 'reading', original(), sources), false);
  invalid.issues[0].quote = '不存在的原文'; assert.equal(validFactJudgment(invalid, 'reading', original(), sources), false);
});

test('single-flight checks and atomic stale-write protection preserve newer edits', async t => {
  const f = await setup(t); let release;
  const learning = f.store;
  const checker = createFactCheckService({ learning, getGenerator: () => f.generator, getReviewer: () => ({ status: () => ({ mode: 'ai', model: 'reviewer' }), generate: async () => new Promise(resolve => { release = resolve; }) }) });
  const pending = checker.process('p1', f.blockId, original());
  await assert.rejects(checker.process('p1', f.blockId, original()), /正在核查/);
  release(clean()); const result = await pending;
  learning.saveBlock('p1', f.blockId, { text: '用户更新的内容' });
  assert.throws(() => learning.saveFactCheckedBlock('p1', f.blockId, result.content, result.record, null), /内容已变化/);
  assert.equal(learning.getLesson('p1').blockCourse.blocks[0].content.text, '用户更新的内容');
});

test('quiz answers are withheld from review and model answer disagreements become pending verification', async t => {
  const quiz = { questions: [{ prompt: '哪项成立？', options: ['甲', '乙', '丙', '丁'], answer: 0, explanation: '按所给条件判断。' }] };
  const judgment = { ...clean(), solutions: [{ questionIndex: 0, answer: 1, ambiguous: false, reason: '模型求解结果不同。' }] };
  const f = await setup(t, { type: 'quiz', judgments: [judgment] }); const result = await f.run(quiz);
  assert.equal(result.record.status, 'uncertain'); assert.equal(result.record.issues[0].kind, 'quiz');
  assert.equal(f.sent[0].input.target.questions[0].answer, undefined); assert.equal(f.generated.length, 0);
  assert.equal(result.content.questions[0].answer, 0);
});

test('fact check records survive full backup, restore and course deletion without leaking into other records', async t => {
  const f = await setup(t); const checked = await f.run(original());
  f.store.saveFactCheckedBlock('p1', f.blockId, checked.content, checked.record, null);
  const backup = f.store.exportState(); assert.equal(backup.factChecks.p1.length, 1); assert.equal(validState(backup), true);
  f.store.replaceState(backup); assert.equal(f.store.getLesson('p1').factChecks[0].id, checked.record.id);
  const invalid = structuredClone(backup); invalid.factChecks.p1[0].blockId = 'missing'; assert.equal(validState(invalid), false);
  const other = structuredClone(backup.plans[0]); other.id = 'other-course'; other.source = 'ai'; other.lessons = other.lessons.map((l, i) => ({ ...l, id: `other-lesson-${i}` }));
  f.store.savePlan(other); await f.store.deletePlan(backup.plans[0].id);
  assert.equal(f.store.exportState().factChecks?.p1, undefined);
  assert.throws(() => f.store.getLesson('p1'), /不存在/);
});

test('quiz corrections preserve old grades and restoring a checked version restores its own score', async t => {
  const oldQuiz = { questions: [{ prompt: '哪项成立？', options: ['甲', '乙', '丙', '丁'], answer: 0, explanation: '原解析' }] };
  const nextQuiz = { questions: [{ ...oldQuiz.questions[0], answer: 1, explanation: '新版本解析' }] };
  const f = await setup(t, { type: 'quiz', judgments: [{ ...clean(), solutions: [{ questionIndex: 0, answer: 0, ambiguous: false, reason: '按当前题目求解。' }] }] });
  f.store.saveBlock('p1', f.blockId, oldQuiz);
  f.store.saveProgress('p1', { completed: true, attempts: 1, lastScore: 100, bestScore: 100, lastAnswers: [0] });
  const initial = await f.run(oldQuiz);
  const record = { ...initial.record, status: 'corrected', content: nextQuiz, beforeContent: oldQuiz };
  f.store.saveFactCheckedBlock('p1', f.blockId, nextQuiz, record, oldQuiz);
  const tracked = f.store.getLesson('p1').quizRecord;
  assert.notEqual(tracked.currentFingerprint, tracked.progressFingerprint);
  assert.equal(tracked.history[0].progress.bestScore, 100); assert.equal(tracked.history[0].questions[0].answer, 0);
  f.store.restoreFactCheck('p1', f.blockId, record.id);
  const restored = f.store.getLesson('p1').quizRecord;
  assert.equal(restored.currentFingerprint, restored.progressFingerprint);
  assert.equal(f.store.overview().progress.p1.completed, true); assert.equal(f.store.overview().progress.p1.lastScore, 100);
});

test('automatic checking is opt-in and settings load does not rewrite corrupt or existing preferences', async t => {
  const f = await setup(t), settings = createFactCheckSettings(f.directory);
  assert.equal((await settings.initialize()).enabled, false);
  await settings.save(true);
  const before = await readFile(path.join(f.directory, 'fact-check-settings.json'), 'utf8');
  const reopened = createFactCheckSettings(f.directory); assert.equal((await reopened.initialize()).enabled, true);
  assert.equal(await readFile(path.join(f.directory, 'fact-check-settings.json'), 'utf8'), before);
  await assert.rejects(reopened.save('yes'), /开关无效/);
  await writeFile(path.join(f.directory, 'fact-check-settings.json'), 'invalid');
  const corrupt = createFactCheckSettings(f.directory); assert.ok((await corrupt.initialize()).error); await assert.rejects(corrupt.save(true));
});
