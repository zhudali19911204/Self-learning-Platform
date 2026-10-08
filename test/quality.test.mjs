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
import { qualitySnapshot, qualityFingerprint, qualityRules, applicableQualityRubric, qualityReviewerInput, validQualityJudgment, createQualityService } from '../course-quality.mjs';

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
