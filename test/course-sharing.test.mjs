import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCoursePackage, readCoursePackage, instantiateCoursePackage, coursePackageSummary } from '../desktop/course-sharing.mjs';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { createImageStore } from '../desktop/image-store.mjs';
import { demoPlan, demoLessons } from '../public/demo.js';
import { validState } from '../desktop/local-store.mjs';

const citation = { excerptId: 'S1E1', url: 'https://docs.python.org/3/tutorial/', title: 'Python Tutorial', publisher: 'Python', retrievedAt: 1, quote: 'Tutorial', claim: '课程参考文档' };
const blockCourse = () => ({ intro: '本节课程导语', blocks: [
  { id: 'reading-1', type: 'reading', title: '讲解', objective: '解释概念', content: { text: '正文 [S1E1]', grounding: { version: 1, citations: [citation] }, revisions: [{ text: 'private-history', updated: 1 }], imageProposal: { prompt: 'private-prompt', caption: 'private-caption' } } },
  { id: 'quiz-1', type: 'quiz', title: '练习', objective: '检验概念', content: { questions: [{ prompt: '如何判断？', options: ['一', '二', '三', '四'], answer: 1, explanation: '根据定义判断。' }] } },
  { id: 'summary-1', type: 'summary', title: '总结', objective: '归纳', content: null }
] });
function fixture() {
  const plan = structuredClone(demoPlan);
  plan.secret = 'private-plan-extra';
  const value = createCoursePackage(plan, id => id === plan.lessons[0].id ? { blockCourse: blockCourse(), reflection: 'private-reflection', chats: ['private-chat'], annotations: ['private-note'] } : { lesson: demoLessons[id] ?? null });
  return value;
}
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'learnflow-course-share-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}

test('course packages carry current teaching, answers and citations but no personal or historical fields', () => {
  const exported = fixture();
  assert.equal(exported.format, 'learnflow-course');
  assert.equal(exported.plan.lessons.length, demoPlan.lessons.length);
  assert.equal(exported.blockCourses['lesson-1'].blocks[0].content.text, '正文 [S1E1]');
  assert.deepEqual(exported.blockCourses['lesson-1'].blocks[0].content.grounding.citations, [citation]);
  assert.equal(exported.blockCourses['lesson-1'].blocks[1].content.questions[0].answer, 1);
  assert.equal(exported.blockCourses['lesson-1'].blocks[2].content, null);
  assert.ok(!JSON.stringify(exported).includes('private-'));
  for (const key of ['learningBrief', 'progress', 'chats', 'annotations', 'settings', 'apiKey', 'revisions']) assert.ok(!JSON.stringify(exported).includes(`"${key}"`));
  assert.match(coursePackageSummary(exported), /待生成 1 个模块/);
  assert.deepEqual(readCoursePackage(exported).lessons['lesson-2'], demoLessons[demoPlan.lessons[1].id]);
});

test('import strips unknown fields at all teaching levels and allocates fresh IDs every time', () => {
  const incoming = fixture();
  incoming.apiKey = 'private-key'; incoming.plan.extra = 'private-plan'; incoming.annotations = ['private-note'];
  incoming.blockCourses['lesson-1'].blocks[0].content.grounding.citations[0].extra = 'private-citation';
  incoming.blockCourses['lesson-1'].blocks[1].content.questions[0].extra = 'private-question';
  incoming.lessons['lesson-2'].sections[0].extra = 'private-section';
  const a = instantiateCoursePackage(incoming), b = instantiateCoursePackage(incoming);
  assert.equal(validState(a), true); assert.equal(validState(b), true);
  const ids = state => [state.active, ...state.plans[0].lessons.map(l => l.id), ...Object.values(state.blockCourses).flatMap(c => c.blocks.map(b => b.id))];
  assert.ok(ids(a).every(id => !ids(b).includes(id)));
  assert.ok(!JSON.stringify(a).includes('private-'));
  assert.deepEqual(a.progress, {}); assert.deepEqual(a.chats, {}); assert.deepEqual(a.notes, []);
});

test('rejects backups, future versions, malformed modules and foreign lesson payloads', () => {
  for (const value of [null, {}, { ...fixture(), version: 99 }, { ...fixture(), format: 'backup' }, { ...fixture(), plan: { lessons: [null] } }]) assert.throws(() => readCoursePackage(value), /课程包/);
  const bad = fixture(); bad.lessons.foreign = demoLessons.p1;
  assert.throws(() => readCoursePackage(bad), /格式无效/);
  const malformed = fixture(); malformed.blockCourses['lesson-1'].blocks[0].content = {};
  assert.throws(() => readCoursePackage(malformed), /格式无效/);
  const dangerous = fixture(); dangerous.plan.lessons[0].id = '__proto__';
  assert.throws(() => readCoursePackage(dangerous), /格式无效/);
  const malformedLegacy = fixture(); malformedLegacy.lessons['lesson-2'].sections = [null, null];
  assert.throws(() => readCoursePackage(malformedLegacy), /格式无效/);
});

test('append import preserves existing records, duplicates are independent, and invalid files change nothing', async t => {
  const store = await createSqliteStore(await directory(t));
  try {
  store.saveReflection('p1', '保留的学习心得');
  const before = store.exportState(), packed = fixture();
  const first = store.importCoursePackage(packed), second = store.importCoursePackage(packed);
  assert.notEqual(first.planId, second.planId);
  assert.equal(second.state.plans.length, before.plans.length + 2);
  assert.deepEqual(second.state.progress, before.progress);
  assert.deepEqual(second.state.notes, before.notes);
  assert.equal(store.getLesson('p1').reflection, '保留的学习心得');
  assert.deepEqual(store.exportState().plans[0], before.plans[0]);
  const firstPlan = second.state.plans.find(p => p.id === first.planId);
  const content = store.getLesson(firstPlan.lessons[0].id);
  assert.equal(content.blockCourse.blocks[0].content.text, '正文 [S1E1]');
  assert.deepEqual(content.annotations, []); assert.deepEqual(content.chats, []);
  const after = store.exportState();
  assert.throws(() => store.importCoursePackage({ ...packed, version: 0 }), /课程包/);
  assert.deepEqual(store.exportState(), after);
  const reexported = createCoursePackage(firstPlan, id => store.getLesson(id));
  assert.deepEqual(reexported.blockCourses, packed.blockCourses);
  } finally { store.close(); }
});

test('current images travel with the package; missing, unrelated and corrupted assets fail before import', async t => {
  const images = createImageStore(await directory(t), {});
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64');
  const id = await images.put(bytes);
  const course = blockCourse();
  course.blocks[0].content.illustration = { id, caption: '示意图', created: 1, prompt: 'private-original-prompt', model: 'example-model' };
  const packed = await images.withAssets(createCoursePackage(demoPlan, lessonId => lessonId === 'p1' ? { blockCourse: course } : {}));
  assert.ok(!JSON.stringify(packed).includes('private-'));
  assert.equal(packed.imageAssets.length, 1);
  const clean = readCoursePackage(packed), target = createImageStore(await directory(t), {});
  const stage = await target.prepareImport(clean);
  await assert.rejects(target.readAsset(id));
  await stage(); assert.deepEqual((await target.readAsset(id)).bytes, bytes);
  assert.throws(() => readCoursePackage({ ...packed, imageAssets: [] }), /配图缺失/);
  assert.throws(() => readCoursePackage({ ...fixture(), imageAssets: packed.imageAssets }), /无关文件/);
  const corrupt = structuredClone(packed); corrupt.imageAssets[0].data = Buffer.from('not an image').toString('base64');
  await assert.rejects(target.prepareImport(readCoursePackage(corrupt)));
});
