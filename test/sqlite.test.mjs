import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, readdir, copyFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { demoPlan, demoLessons } from '../public/demo.js';
import { learningBriefFrom } from '../public/planning.js';
import { clarification } from '../test-support/planning.mjs';
import { cardPathFor, normalizeKnowledgeCard, parseKnowledgeCard, serializeKnowledgeCard } from '../desktop/knowledge-cards.mjs';

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
    assert.deepEqual(exported.notes, original.notes.map(normalizeKnowledgeCard));
    const file = await readFile(cardPathFor(directory, exported.notes[0]), 'utf8');
    assert.deepEqual(parseKnowledgeCard(file, 'note-1.md'), exported.notes[0]);
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
test('confirmed learning requirements survive save, reopen, export, import and deletion', async t => {
  const directory = await temporary(t);
  let store = await createSqliteStore(directory);
  const plan = {...structuredClone(demoPlan),id:'tailored-route',source:'ai',learningBrief:learningBriefFrom(clarification),lessons:demoPlan.lessons.map((lesson,index) => ({...lesson,id:`tailored-${index}`}))};
  try { store.savePlan(plan); assert.deepEqual(store.overview().plans.at(-1).learningBrief,plan.learningBrief); }
  finally { store.close(); }
  store = await createSqliteStore(directory);
  try {
    const exported = store.exportState();
    assert.deepEqual(exported.plans.at(-1).learningBrief,plan.learningBrief);
    const invalid = structuredClone(exported); invalid.plans.at(-1).learningBrief.answers = [];
    assert.throws(() => store.replaceState(invalid),/格式不正确/);
    store.replaceState(exported);
    assert.deepEqual(store.overview().plans.at(-1).learningBrief,plan.learningBrief);
    const backup = store.exportState();
    const deleted = await store.deletePlan(plan.id);
    assert.equal(deleted.state.plans.length,1);
    assert.equal(deleted.backupPath, undefined);
    assert.deepEqual(backup.plans.at(-1).learningBrief,plan.learningBrief);
    store.replaceState(backup);
    assert.deepEqual(store.overview().plans.at(-1).learningBrief,plan.learningBrief);
  } finally { store.close(); }
  const database = new DatabaseSync(path.join(directory,'learning.sqlite'),{readOnly:true});
  try { assert.equal(database.prepare('PRAGMA user_version').get().user_version,3); }
  finally { database.close(); }
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

test('v2 SQLite card rows migrate to verified YAML Markdown files without losing text', async t => {
  const directory = await temporary(t);
  const first = await createSqliteStore(directory);
  first.saveNote(legacy().notes[0]); first.close();
  const db = new DatabaseSync(path.join(directory, 'learning.sqlite'));
  db.exec("ALTER TABLE notes DROP COLUMN metadata_json; DELETE FROM meta WHERE key = 'knowledge_generation'; PRAGMA user_version = 2");
  db.close();
  const migrated = await createSqliteStore(directory);
  try {
    assert.equal(migrated.exportState().notes[0].content, '我记录的知识');
    const file = await readFile(cardPathFor(directory, migrated.exportState().notes[0]), 'utf8');
    const card = parseKnowledgeCard(file, 'note-1.md');
    assert.equal(card.summary, '摘要');
    assert.equal(card.topic, '未分类');
    assert.deepEqual(card.sourceLessons, ['p1']);
    const backups = await readdir(path.join(directory, 'backups'));
    assert.ok(backups.some(name => name.startsWith('before-schema-v3-') && name.endsWith('.sqlite')));
  } finally { migrated.close(); }
});

test('Markdown YAML metadata is canonical on reopen and invalid edits do not overwrite the database', async t => {
  const directory = await temporary(t), filename = cardPathFor(directory, legacy().notes[0]);
  let store = await createSqliteStore(directory);
  store.saveNote(legacy().notes[0]); store.close();
  const edited = { ...normalizeKnowledgeCard(legacy().notes[0]), topic: '编程/Python', useWhen: ['需要解释打印输出时'], avoidWhen: ['需要存储用户输入时'], aliases: ['输出'], related: ['another-card'], status: 'reviewed', content: '在外部 Markdown 编辑器中更新的正文' };
  await writeFile(filename, serializeKnowledgeCard(edited));
  store = await createSqliteStore(directory);
  try {
    const card = store.exportState().notes[0];
    assert.equal(card.content, edited.content);
    assert.deepEqual(card.useWhen, edited.useWhen);
    assert.deepEqual(card.avoidWhen, edited.avoidWhen);
    assert.deepEqual(card.related, edited.related);
    assert.equal(card.status, 'reviewed');
    assert.equal(card.topic, '编程/Python');
  } finally { store.close(); }
  const moved = cardPathFor(directory, edited);
  await writeFile(moved, '---\nid: note-1\nthis: [broken\n---\n正文');
  await assert.rejects(createSqliteStore(directory), /知识卡片.*读取失败/);
  const db = new DatabaseSync(path.join(directory, 'learning.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare("SELECT content FROM notes WHERE id = 'note-1'").get().content, edited.content); }
  finally { db.close(); }
  assert.match(await readFile(moved, 'utf8'), /this: \[broken/);
});

test('saving a card updates its Markdown and refuses to overwrite an external edit', async t => {
  const directory = await temporary(t), filename = cardPathFor(directory, legacy().notes[0]);
  const store = await createSqliteStore(directory);
  try {
    store.saveNote(legacy().notes[0]);
    const next = { ...store.overview().notes[0], title: '更新后的标题', content: '第二版正文', updated: 2345 };
    store.saveNote(next);
    assert.equal(parseKnowledgeCard(await readFile(filename, 'utf8'), 'note-1.md').content, '第二版正文');
    assert.equal(store.cardMarkdown('note-1'), await readFile(filename, 'utf8'));
    await writeFile(filename, serializeKnowledgeCard({ ...next, content: '外部编辑内容', updated: 3456 }));
    assert.throws(() => store.saveNote({ ...next, content: '应用中的旧草稿', updated: 4567 }), /应用外修改/);
    assert.equal(store.exportState().notes[0].content, '外部编辑内容');
  } finally { store.close(); }
});

test('manual knowledge category survives SQLite and YAML without moving the original topic file', async t => {
  const directory = await temporary(t), note = legacy().notes[0];
  const store = await createSqliteStore(directory);
  try {
    store.saveNote(note);
    const filename = cardPathFor(directory, note);
    store.saveNote({ ...store.overview().notes[0], category: '基础概念', updated: 2345 });
    assert.equal(cardPathFor(directory, store.overview().notes[0]), filename);
    assert.equal(store.overview().notes[0].category, '基础概念');
    const source = await readFile(filename, 'utf8');
    assert.match(source, /knowledge_category: 基础概念/);
    assert.equal(parseKnowledgeCard(source, 'note-1.md').category, '基础概念');
    assert.equal(store.exportState().notes[0].category, '基础概念');
  } finally { store.close(); }
});

test('deleting one card removes its Markdown, database row and catalog entry but keeps its lesson', async t => {
  const directory = await temporary(t);
  const store = await createSqliteStore(directory);
  const note = legacy().notes[0];
  try {
    store.saveNote(note);
    store.saveNote({ ...note, id: 'other-note', title: '另一张卡片' });
    const file = cardPathFor(directory, note);
    assert.deepEqual(store.noteDeletionPreview(note.id), { id: note.id, title: note.title, updated: note.updated });
    assert.throws(() => store.deleteNote(note.id, note.updated + 1), /已更新/);
    assert.ok(await stat(file));
    assert.deepEqual(store.deleteNote(note.id, note.updated), { id: note.id });
    await assert.rejects(stat(file), { code: 'ENOENT' });
    assert.deepEqual(store.overview().notes.map(card => card.id), ['other-note']);
    const catalog = JSON.parse(await readFile(path.join(directory, 'knowledge', 'catalog.json'), 'utf8'));
    assert.deepEqual(catalog.cards.map(card => card.id), ['other-note']);
    assert.ok(store.getLesson('p1').lesson);
    assert.throws(() => store.noteDeletionPreview(note.id), /不存在/);
  } finally { store.close(); }
  const reopened = await createSqliteStore(directory);
  try { assert.deepEqual(reopened.overview().notes.map(card => card.id), ['other-note']); }
  finally { reopened.close(); }
});

test('deletion refuses externally edited Markdown and leaves the card untouched', async t => {
  const directory = await temporary(t), note = legacy().notes[0];
  const store = await createSqliteStore(directory);
  try {
    store.saveNote(note);
    const file = cardPathFor(directory, note);
    await writeFile(file, serializeKnowledgeCard({ ...note, content: '应用外新内容', updated: 3456 }));
    assert.throws(() => store.noteDeletionPreview(note.id), /应用外修改/);
    assert.throws(() => store.deleteNote(note.id, note.updated), /应用外修改/);
    assert.ok(await stat(file));
    assert.equal(store.overview().notes.length, 1);
  } finally { store.close(); }
});

test('flat card files migrate into topic folders without losing externally edited YAML or Markdown', async t => {
  const directory = await temporary(t), note = legacy().notes[0];
  let store = await createSqliteStore(directory);
  store.saveNote(note); store.close();
  const nested = cardPathFor(directory, note), flat = path.join(directory, 'knowledge', 'cards', 'note-1.md');
  const edited = { ...normalizeKnowledgeCard(note), topic: '编程/Python', aliases: ['输出'], content: '## 外部修改\n\n保留原文。' };
  await writeFile(nested, serializeKnowledgeCard(edited));
  await rename(nested, flat);
  store = await createSqliteStore(directory);
  try {
    const migrated = store.overview().notes[0];
    assert.equal(migrated.topic, '编程/Python');
    assert.equal(migrated.content, edited.content);
    assert.deepEqual(migrated.aliases, ['输出']);
    assert.equal(parseKnowledgeCard(await readFile(cardPathFor(directory, migrated), 'utf8'), 'note-1.md').content, edited.content);
    const catalog = JSON.parse(await readFile(path.join(directory, 'knowledge', 'catalog.json'), 'utf8'));
    assert.equal(catalog.cards[0].id, 'note-1');
    assert.equal(catalog.topics.some(topic => topic.path === '编程/Python'), true);
    assert.equal(JSON.stringify(catalog).includes('保留原文'), false, 'the catalog stores metadata, not full card bodies');
    await assert.rejects(stat(flat), { code: 'ENOENT' });
    const moved = { ...migrated, topic: '开发工具/Git', updated: Date.now() };
    store.saveNote(moved);
    const movedCatalog = JSON.parse(await readFile(path.join(directory, 'knowledge', 'catalog.json'), 'utf8'));
    assert.equal(movedCatalog.cards[0].topic, '开发工具/Git');
    assert.equal((await readFile(cardPathFor(directory, moved), 'utf8')).includes('开发工具/Git'), true);
    await assert.rejects(stat(cardPathFor(directory, migrated)), { code: 'ENOENT' });
    assert.equal(store.exportState().notes[0].content, edited.content);
  } finally { store.close(); }
});

test('startup recovers the prior card directory after an interrupted topic-folder swap', async t => {
  const directory = await temporary(t);
  let store = await createSqliteStore(directory);
  store.saveNote(legacy().notes[0]); store.close();
  const cards = path.join(directory, 'knowledge', 'cards');
  const previous = path.join(directory, 'knowledge', '.cards-00000000-0000-0000-0000-000000000001.previous');
  await rename(cards, previous);
  store = await createSqliteStore(directory);
  try {
    assert.equal(store.overview().notes[0].content, '我记录的知识');
    assert.equal((await readFile(cardPathFor(directory, legacy().notes[0]), 'utf8')).includes('我记录的知识'), true);
    await assert.rejects(stat(previous), { code: 'ENOENT' });
  } finally { store.close(); }
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

test('block revisions persist per block, guard stale writes and preserve unrelated learning data', async t => {
  const directory = await temporary(t);
  let store = await createSqliteStore(directory);
  try {
    const course = store.saveOutline('p1', { intro: '课程', blocks: [
      {type:'reading', title:'概念', objective:'理解'},
      {type:'example', title:'案例', objective:'应用'},
      {type:'quiz', title:'练习', objective:'检验'}
    ] });
    const [reading, example, quiz] = course.blocks;
    store.saveBlock('p1', reading.id, {text:'原讲解'});
    store.saveBlock('p1', example.id, {text:'原案例'});
    store.saveBlock('p1', quiz.id, {questions: demoLessons.p1.questions});
    store.saveProgress('p1', legacy().progress.p1);
    store.saveReflection('p1', '我的心得');
    store.saveNote(legacy().notes[0]);
    const result = store.reviseBlock('p1', reading.id, {text:'清楚的新讲解'}, '原讲解');
    assert.equal(result.revisions[0].text, '原讲解');
    assert.throws(() => store.reviseBlock('p1', reading.id, {text:'过期写入'}, '原讲解'), /内容已更新/);
    assert.throws(() => store.reviseBlock('p1', example.id, {text:''}, '原案例'), /只能重新生成/);
    assert.throws(() => store.reviseBlock('p2', reading.id, {text:'越界'}, '清楚的新讲解'), /尚未生成/);
    assert.throws(() => store.reviseBlock('p1', quiz.id, {questions:demoLessons.p1.questions}), /只能重新生成/);
    assert.throws(() => store.restoreBlock('p1', reading.id, '过期内容'), /内容已更新/);
    const exported = store.exportState();
    assert.equal(exported.blockCourses.p1.blocks[1].content.text, '原案例');
    assert.deepEqual(exported.progress.p1, legacy().progress.p1);
    assert.equal(exported.notes[0].content, legacy().notes[0].content);
    assert.equal(exported.reflections.p1, '我的心得');
    store.replaceState(exported);
    store.close(); store = await createSqliteStore(directory);
    assert.deepEqual(store.getLesson('p1').blockCourse.blocks[0].content, result);
    assert.equal(store.restoreBlock('p1', reading.id, '清楚的新讲解').text, '原讲解');
    assert.throws(() => store.restoreBlock('p1', reading.id, '原讲解'), /没有可恢复/);
    const invalid = store.exportState();
    invalid.blockCourses.p1.blocks[0].content.revisions = [{text:'',updated:1}];
    assert.throws(() => store.replaceState(invalid), /格式不正确/);
    assert.equal(store.getLesson('p1').blockCourse.blocks[0].content.text, '原讲解');
  } finally { store.close(); }
});

test('practice images and revision history persist, export and restore without changing grades or other blocks', async t => {
  const directory = await temporary(t); let store = await createSqliteStore(directory);
  try {
    const course = store.saveOutline('p1', { intro: '任务', blocks: [
      { type: 'reading', title: '讲解', objective: '理解' }, { type: 'practice', title: '会议听力', objective: '记录进度' }, { type: 'quiz', title: '测验', objective: '检验' }
    ] });
    const [reading, practice, quiz] = course.blocks;
    store.saveBlock('p1', reading.id, { text: '原讲解' }); store.saveBlock('p1', practice.id, { text: '原任务' });
    store.saveBlock('p1', quiz.id, { questions: demoLessons.p1.questions }); store.saveProgress('p1', legacy().progress.p1);
    store.saveReflection('p1', '原心得'); store.saveNote(legacy().notes[0]);
    const image = { id: 'a'.repeat(64), prompt: '会议', caption: '听力任务场景', model: 'image-test', created: 1 };
    const withImage = store.attachIllustration('p1', practice.id, image, JSON.stringify({ text: '原任务' }));
    assert.equal(withImage.illustration.id, image.id);
    const revised = store.reviseBlock('p1', practice.id, { text: '降低难度的新任务' }, '原任务');
    assert.equal(revised.illustration, undefined); assert.deepEqual(revised.revisions[0].illustration, image);
    assert.throws(() => store.reviseBlock('p1', practice.id, { text: '过期任务' }, '原任务'), /内容已更新/);
    const exported = store.exportState(); store.replaceState(exported);
    store.close(); store = await createSqliteStore(directory);
    assert.deepEqual(store.getLesson('p1').blockCourse.blocks[1].content, revised);
    const restored = store.restoreBlock('p1', practice.id, revised.text);
    assert.equal(restored.text, '原任务'); assert.deepEqual(restored.illustration, image);
    const result = store.exportState(); assert.equal(result.blockCourses.p1.blocks[0].content.text, '原讲解');
    assert.deepEqual(result.progress.p1, legacy().progress.p1); assert.equal(result.reflections.p1, '原心得'); assert.equal(result.notes[0].content, legacy().notes[0].content);
    assert.throws(() => store.attachIllustration('p1', quiz.id, image, JSON.stringify({ questions: demoLessons.p1.questions })), /只能为已保存/);
  } finally { store.close(); }
});

test('deleting a route removes its related records and redacts existing backups', async t => {
  const directory = await temporary(t), store = await createSqliteStore(directory);
  try {
    const route = structuredClone(demoPlan);
    route.id = 'remove-this-route'; route.source = 'ai'; route.goal = '测试分类与删除';
    route.lessons = route.lessons.map((lesson, index) => ({ ...lesson, id: `remove-lesson-${index}` }));
    store.savePlan(route);
    const lessonId = route.lessons[0].id;
    store.saveLesson(lessonId, demoLessons.p1);
    store.saveProgress(lessonId, { completed: true, attempts: 1, lastScore: 100, bestScore: 100, lastAnswers: [1, 1] });
    store.saveReflection(lessonId, '需要保留在备份中的心得');
    store.appendChat(lessonId, '测试问题', '测试回答');
    store.saveNote({ ...legacy().notes[0], id: 'delete-note', lessonId, source: 'ai' });
    store.saveNote(legacy().notes[0]);
    const retainedCard = await readFile(cardPathFor(directory, legacy().notes[0]), 'utf8');
    assert.equal(store.planDeletionPreview(route.id).notes, 1);
    const backupFolder = path.join(directory, 'backups');
    await mkdir(backupFolder);
    const backupFile = path.join(backupFolder, 'before-delete-test.json');
    await writeFile(backupFile, JSON.stringify(store.exportState()));
    await writeFile(path.join(directory, 'learning.json.bak'), JSON.stringify(store.exportState()));
    const sqliteSnapshot = await store.backupBeforeImport();
    const schemaSnapshot = path.join(backupFolder, 'before-schema-v3-test.sqlite');
    const knowledgeSnapshot = path.join(backupFolder, 'before-knowledge-v1-test.sqlite');
    await copyFile(sqliteSnapshot, schemaSnapshot); await copyFile(sqliteSnapshot, knowledgeSnapshot);
    const deleted = await store.deletePlan(route.id);
    assert.equal(deleted.state.active, demoPlan.id);
    assert.equal(deleted.state.plans.length, 1);
    assert.equal(store.getLesson('p1').lesson.intro, demoLessons.p1.intro);
    assert.throws(() => store.getLesson(lessonId), /课程不存在/);
    const exported = store.exportState();
    assert.equal(exported.notes.length, 1);
    assert.equal(exported.notes[0].id, 'note-1');
    const afterDeleteCatalog = JSON.parse(await readFile(path.join(directory, 'knowledge', 'catalog.json'), 'utf8'));
    assert.equal(afterDeleteCatalog.count, 1);
    assert.deepEqual(afterDeleteCatalog.cards.map(card => card.id), ['note-1']);
    assert.equal(await readFile(cardPathFor(directory, legacy().notes[0]), 'utf8'), retainedCard);
    await assert.rejects(stat(cardPathFor(directory, { ...legacy().notes[0], id: 'delete-note' })), { code: 'ENOENT' });
    assert.equal(exported.progress[lessonId], undefined);
    await assert.rejects(store.deletePlan(demoPlan.id), /至少保留一条/);
    const backup = JSON.parse(await readFile(backupFile, 'utf8'));
    assert.equal(backup.plans.length, 1);
    assert.equal(backup.reflections[lessonId], undefined);
    assert.equal(backup.notes.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'learning.json.bak'), 'utf8')).plans.length, 1);
    await assert.rejects(stat(sqliteSnapshot), { code: 'ENOENT' });
    await assert.rejects(stat(schemaSnapshot), { code: 'ENOENT' });
    await assert.rejects(stat(knowledgeSnapshot), { code: 'ENOENT' });
    assert.deepEqual(deleted.backups.failures, []);
    assert.equal((await readdir(backupFolder)).filter(name => name.startsWith('before-delete-')).length, 1, 'no new deletion backup');
    await assert.rejects(store.deletePlan('missing'), /路线不存在/);
  } finally { store.close(); }
});

test('topic folder names stay inside the card root even for unsafe YAML topic text', async t => {
  const directory = await temporary(t);
  const target = cardPathFor(directory, { ...legacy().notes[0], topic: '../../CON:<bad>|name' });
  const root = path.resolve(directory, 'knowledge', 'cards');
  assert.equal(path.resolve(target).startsWith(root + path.sep), true);
  assert.equal(path.basename(target), 'note-1.md');
  assert.equal(target.includes('<bad>'), false);
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
