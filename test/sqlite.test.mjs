import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { demoPlan, demoLessons } from '../public/demo.js';

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'learnflow-sqlite-test-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const legacy = () => ({
  version: 1, plans: [structuredClone(demoPlan)], active: demoPlan.id,
  lessons: { p1: { ...structuredClone(demoLessons.p1), intro: '保留我的课程正文' } },
  progress: { p1: { completed: true, attempts: 2, lastScore: 100, bestScore: 100, lastAnswers: [1, 1], updated: 1234 } },
  notes: [{ id: 'note-1', lessonId: 'p1', courseTitle: demoPlan.title, title: '我的卡片', summary: '摘要', content: '我记录的知识', tags: ['Python'], source: 'demo', updated: 1234 }],
  reflections: { p1: '我的原始心得' },
  chats: { p1: [{ role: 'user', content: '什么是输出？' }, { role: 'assistant', content: '显示内容。' }] }
});

test('legacy JSON migrates without modifying its bytes; lessons load individually', async t => {
  const directory = await temporary(t), original = legacy();
  const source = JSON.stringify(original, null, 2);
  await writeFile(path.join(directory, 'learning.json'), source);
  const store = await createSqliteStore(directory);
  try {
    const overview = store.overview();
    assert.equal(overview.plans.length, 1);
    assert.deepEqual(overview.lessons, {}, 'startup does not load every course body');
    assert.deepEqual(overview.reflections, {});
    assert.deepEqual(overview.chats, {});
    assert.equal(store.getLesson('p1').lesson.intro, '保留我的课程正文');
    assert.equal(store.getLesson('p1').reflection, '我的原始心得');
    assert.equal(store.getLesson('p1').chats.length, 2);
    assert.equal(store.getLesson('p2').lesson.intro, demoLessons.p2.intro);
    const exported = store.exportState();
    assert.deepEqual(exported.plans, original.plans);
    assert.deepEqual(exported.progress, original.progress);
    assert.deepEqual(exported.notes, original.notes);
    assert.deepEqual(exported.reflections, original.reflections);
    assert.deepEqual(exported.chats, original.chats);
    assert.equal(exported.lessons.p1.intro, original.lessons.p1.intro);
    assert.equal(await readFile(path.join(directory, 'learning.json'), 'utf8'), source);
    store.saveLesson('p1', { ...demoLessons.p1, intro: '只更新这一门课' });
    assert.equal(store.getLesson('p2').lesson.intro, demoLessons.p2.intro);
    assert.equal(await readFile(path.join(directory, 'learning.json'), 'utf8'), source);
  } finally { store.close(); }
  const reopened = await createSqliteStore(directory);
  try { assert.equal(reopened.getLesson('p1').lesson.intro, '只更新这一门课'); }
  finally { reopened.close(); }
});

test('v1 SQLite upgrades with a verified snapshot and keeps existing course content', async t => {
  const directory = await temporary(t);
  const initial = await createSqliteStore(directory);
  initial.saveLesson('p1', { ...demoLessons.p1, intro: '迁移前的课程' });
  initial.close();
  const db = new DatabaseSync(path.join(directory, 'learning.sqlite'));
  db.exec('DROP TABLE lesson_blocks; DROP TABLE lesson_outlines; PRAGMA user_version = 1');
  db.close();
  const upgraded = await createSqliteStore(directory);
  try {
    assert.equal(upgraded.getLesson('p1').lesson.intro, '迁移前的课程');
    const files = await import('node:fs/promises').then(fs => fs.readdir(path.join(directory, 'backups')));
    assert.equal(files.filter(file => file.startsWith('before-schema-v2-') && file.endsWith('.sqlite')).length, 1);
    const snapshot = new DatabaseSync(path.join(directory, 'backups', files[0]), { readOnly: true });
    try { assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 1); }
    finally { snapshot.close(); }
  } finally { upgraded.close(); }
});

test('outlines and blocks save independently and survive export/import', async t => {
  const store = await createSqliteStore(await temporary(t));
  try {
    const outline = store.saveOutline('p1', { intro: '先理解再练习', blocks: [
      { type: 'reading', title: '概念', objective: '理解核心概念' },
      { type: 'quiz', title: '自测', objective: '验证理解' }
    ] });
    assert.equal(outline.blocks.length, 2);
    assert.equal(store.getLesson('p1').blockCourse.blocks[0].content, null);
    store.saveBlock('p1', outline.blocks[0].id, { text: '逐步解释' });
    store.saveProgress('p1', { completed: true, attempts: 1, lastScore: 100, bestScore: 100, lastAnswers: [0] });
    store.saveBlock('p1', outline.blocks[1].id, { questions: [{ prompt: '概念是什么？', options: ['A', 'B', 'C', 'D'], answer: 0, explanation: 'A 是正确的。' }] });
    assert.equal(store.overview().progress.p1.completed, false, 'a newly generated quiz requires a new pass');
    const extra = store.appendBlock('p1', { type: 'example', title: '实际示例', objective: '举一反三' });
    store.saveBlock('p1', extra.id, { text: '一个具体示例' });
    assert.throws(() => store.saveBlock('p1', extra.id, { text: '覆盖' }), /已生成/);
    assert.equal(store.getLesson('p1').blockCourse.blocks[2].content.text, '一个具体示例');
    const exportData = store.exportState();
    assert.equal(exportData.blockCourses.p1.blocks.length, 3);
    store.replaceState(exportData);
    assert.deepEqual(store.exportState().blockCourses.p1, exportData.blockCourses.p1);
    assert.equal(store.getLesson('p2').blockCourse, null);
  } finally { store.close(); }
});

test('targeted progress, reflection, note and chat updates persist without whole-state replacement', async t => {
  const store = await createSqliteStore(await temporary(t));
  try {
    store.saveReflection('p1', '更新后的心得');
    store.saveProgress('p1', { completed: true, attempts: 1, lastScore: 100, bestScore: 100, lastAnswers: [1, 1], updated: 2026 });
    store.appendChat('p1', '跟我解释一下', '从示例开始。');
    store.saveNote(legacy().notes[0]);
    assert.equal(store.getLesson('p1').reflection, '更新后的心得');
    assert.equal(store.getLesson('p1').chats.length, 2);
    assert.equal(store.overview().progress.p1.completed, true);
    assert.equal(store.overview().notes[0].title, '我的卡片');
    assert.throws(() => store.saveLesson('missing', demoLessons.p1), /课程不存在/);
    assert.throws(() => store.appendChat('p1', '', 'answer'), /格式不正确/);
  } finally { store.close(); }
});

test('new learning routes save metadata first and load each generated lesson on demand', async t => {
  const store = await createSqliteStore(await temporary(t));
  try {
    const plan = structuredClone(demoPlan);
    plan.id = 'new-route'; plan.source = 'ai'; plan.goal = '学习新的主题';
    plan.lessons = plan.lessons.map((lesson, index) => ({ ...lesson, id: `new-lesson-${index}` }));
    store.savePlan(plan);
    assert.equal(store.overview().active, 'new-route');
    assert.deepEqual(store.overview().lessons, {});
    assert.equal(store.getLesson('new-lesson-0').lesson, null);
    store.saveLesson('new-lesson-0', demoLessons.p1);
    assert.equal(store.getLesson('new-lesson-0').lesson.intro, demoLessons.p1.intro);
    assert.equal(store.getLesson('new-lesson-1').lesson, null);
    store.setActivePlan(demoPlan.id);
    assert.equal(store.overview().active, demoPlan.id);
    assert.equal(store.exportState().lessons['new-lesson-0'].intro, demoLessons.p1.intro);
  } finally { store.close(); }
});

test('invalid legacy data is kept intact; imports are transactional and preceded by a verified SQLite snapshot', async t => {
  const directory = await temporary(t), legacyPath = path.join(directory, 'learning.json');
  await writeFile(legacyPath, '{broken');
  await assert.rejects(createSqliteStore(directory), /旧学习数据无法解析/);
  assert.equal(await readFile(legacyPath, 'utf8'), '{broken');
  await assert.rejects(stat(path.join(directory, 'learning.sqlite')), { code: 'ENOENT' });
  await writeFile(legacyPath, 'null');
  await assert.rejects(createSqliteStore(directory), /旧学习数据校验失败/);
  assert.equal(await readFile(legacyPath, 'utf8'), 'null');
  await assert.rejects(stat(path.join(directory, 'learning.sqlite')), { code: 'ENOENT' });
  const original = legacy(); await writeFile(legacyPath, JSON.stringify(original));
  const store = await createSqliteStore(directory);
  try {
    const backupPath = await store.backupBeforeImport();
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try { assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
    finally { backup.close(); }
    const replacement = legacy(); replacement.reflections.p1 = '导入后的心得';
    assert.equal(store.replaceState(replacement).reflections.p1, undefined, 'overview stays lightweight');
    assert.equal(store.getLesson('p1').reflection, '导入后的心得');
    await assert.rejects(Promise.resolve().then(() => store.replaceState({ ...replacement, active: 'missing' })), /格式不正确/);
    assert.equal(store.getLesson('p1').reflection, '导入后的心得');
    assert.equal(await readFile(legacyPath, 'utf8'), JSON.stringify(original));
  } finally { store.close(); }
});
