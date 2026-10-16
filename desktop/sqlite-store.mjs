import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { demoPlan, demoLessons } from '../public/demo.js';
import { validLesson } from '../server.mjs';
import { validState } from './local-store.mjs';
import { instantiateCoursePackage } from './course-sharing.mjs';
import { validOutline, validBlockSpec, validBlockContent, revisedContent, restoredContent, assistedBlockTypes } from '../public/blocks.js';
import { referencedImages } from '../public/illustrations.js';
import { removePlanFromBackups } from './course-backups.mjs';
import { validAnnotations } from '../public/annotations.js';
import { validQualityReport } from '../public/course-quality.js';
import { validRevisionJob, validQualityDisposition, revisionContent, revisionSnapshot } from '../public/course-revision.js';
import { qualitySnapshot, qualityFingerprint } from '../course-quality.mjs';
import { knowledgeCardMarkdown, knowledgeGeneration, knowledgeLayoutCurrent, normalizeKnowledgeCard, readKnowledgeCard, readKnowledgeCards, recoverKnowledgeCardSwap, refreshKnowledgeCatalog, removeKnowledgeCards, replaceKnowledgeCards, saveKnowledgeCard } from './knowledge-cards.mjs';

const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const fromJSON = value => JSON.parse(value);
const noteExtras = note => Object.fromEntries(['topic', 'category', 'useWhen', 'avoidWhen', 'aliases', 'sourceLessons', 'related', 'prerequisites', 'contrasts', 'status', 'created', 'yamlExtra'].filter(key => note[key] !== undefined).map(key => [key, note[key]]));
const noteFromRow = row => normalizeKnowledgeCard({ id: row.id, lessonId: row.lesson_id, courseTitle: row.course_title, title: row.title, summary: row.summary, content: row.content, tags: fromJSON(row.tags_json), source: row.source, updated: row.updated, ...fromJSON(row.metadata_json) });
const insertNote = (db, note) => {
  const n = normalizeKnowledgeCard(note);
  db.prepare('INSERT INTO notes (id, lesson_id, course_title, title, summary, content, tags_json, source, updated, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET lesson_id=excluded.lesson_id, course_title=excluded.course_title, title=excluded.title, summary=excluded.summary, content=excluded.content, tags_json=excluded.tags_json, source=excluded.source, updated=excluded.updated, metadata_json=excluded.metadata_json').run(n.id, n.lessonId, n.courseTitle, n.title, n.summary, n.content, JSON.stringify(n.tags), n.source, n.updated, JSON.stringify(noteExtras(n)));
};
const fresh = () => ({ version: 1, plans: [structuredClone(demoPlan)], active: demoPlan.id, lessons: {}, progress: {}, notes: [], reflections: {}, chats: {} });

function configure(db) {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
}

function schema(db) {
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE plans (id TEXT PRIMARY KEY, position INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, goal TEXT NOT NULL, level TEXT NOT NULL, daily INTEGER NOT NULL, days INTEGER NOT NULL, source TEXT NOT NULL);
    CREATE TABLE lessons (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, position INTEGER NOT NULL, title TEXT NOT NULL, objective TEXT NOT NULL, phase TEXT NOT NULL, minutes INTEGER NOT NULL, tags_json TEXT NOT NULL, content_json TEXT);
    CREATE INDEX lessons_by_plan ON lessons(plan_id, position);
    CREATE TABLE progress (lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE, completed INTEGER NOT NULL, attempts INTEGER NOT NULL, last_score INTEGER NOT NULL, best_score INTEGER NOT NULL, last_answers_json TEXT NOT NULL, updated INTEGER);
    CREATE TABLE reflections (lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE, content TEXT NOT NULL);
    CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL);
    CREATE INDEX chat_by_lesson ON chat_messages(lesson_id, id);
    CREATE TABLE notes (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, course_title TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL, source TEXT NOT NULL, updated INTEGER NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX notes_by_updated ON notes(updated DESC);
    CREATE TABLE lesson_outlines (lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE, intro TEXT NOT NULL);
    CREATE TABLE lesson_blocks (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, position INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, objective TEXT NOT NULL, content_json TEXT);
    CREATE INDEX blocks_by_lesson ON lesson_blocks(lesson_id, position);
    PRAGMA user_version = 3;
  `);
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function replaceAll(db, state) {
  if (!validState(state)) throw new Error('学习备份格式不正确，未修改现有数据。');
  transaction(db, () => {
    db.exec('DELETE FROM chat_messages; DELETE FROM notes; DELETE FROM reflections; DELETE FROM progress; DELETE FROM lesson_blocks; DELETE FROM lesson_outlines; DELETE FROM lessons; DELETE FROM plans; DELETE FROM meta;');
    const planStatement = db.prepare('INSERT INTO plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const lessonStatement = db.prepare('INSERT INTO lessons VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const progressStatement = db.prepare('INSERT INTO progress VALUES (?, ?, ?, ?, ?, ?, ?)');
    const reflectionStatement = db.prepare('INSERT INTO reflections VALUES (?, ?)');
    const chatStatement = db.prepare('INSERT INTO chat_messages (lesson_id, role, content) VALUES (?, ?, ?)');
    for (const [position, plan] of state.plans.entries()) {
      planStatement.run(plan.id, position, plan.title, plan.description, plan.goal, plan.level, plan.daily, plan.days, plan.source);
      if (plan.learningBrief) db.prepare('INSERT INTO meta VALUES (?, ?)').run(`plan_brief:${plan.id}`, JSON.stringify(plan.learningBrief));
      for (const [lessonPosition, lesson] of plan.lessons.entries()) {
        const content = state.lessons[lesson.id] || (plan.source === 'demo' ? demoLessons[lesson.id] : null);
        lessonStatement.run(lesson.id, plan.id, lessonPosition, lesson.title, lesson.objective, lesson.phase, lesson.minutes, JSON.stringify(lesson.tags), content ? JSON.stringify(content) : null);
      }
    }
    for (const [lessonId, progress] of Object.entries(state.progress)) progressStatement.run(lessonId, Number(progress.completed), progress.attempts, progress.lastScore, progress.bestScore, JSON.stringify(progress.lastAnswers), progress.updated ?? null);
    for (const [lessonId, reflection] of Object.entries(state.reflections)) reflectionStatement.run(lessonId, reflection);
    for (const [lessonId, annotations] of Object.entries(state.annotations || {})) if (annotations.length) db.prepare('INSERT INTO meta VALUES (?, ?)').run(`annotations:${lessonId}`, JSON.stringify(annotations));
    for (const [lessonId, messages] of Object.entries(state.chats || {})) for (const message of messages) chatStatement.run(lessonId, message.role, message.content);
    for (const note of state.notes) insertNote(db, note);
    const outlineStatement = db.prepare('INSERT INTO lesson_outlines VALUES (?, ?)');
    const blockStatement = db.prepare('INSERT INTO lesson_blocks VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [lessonId, course] of Object.entries(state.blockCourses || {})) {
      outlineStatement.run(lessonId, course.intro);
      for (const [position, block] of course.blocks.entries()) blockStatement.run(block.id, lessonId, position, block.type, block.title, block.objective, block.content ? JSON.stringify(block.content) : null);
    }
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('active_plan', state.active);
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('knowledge_generation', randomUUID());
    for (const report of state.qualityReports || []) db.prepare('INSERT INTO meta VALUES (?, ?)').run(`quality:${report.id}`, JSON.stringify(report));
    for (const job of state.qualityJobs || []) db.prepare('INSERT INTO meta VALUES (?, ?)').run(`revision:${job.id}`, JSON.stringify(job));
    for (const d of state.qualityDispositions || []) db.prepare('INSERT INTO meta VALUES (?, ?)').run(`quality_note:${d.reportId}:${d.issueIndex}`, JSON.stringify(d));
    for (const field of ['quizRecords', 'revisionNotices', 'sourceSearch', 'sourceBundles']) for (const [lessonId, value] of Object.entries(state[field] || {})) db.prepare('INSERT INTO meta VALUES (?, ?)').run(`${field}:${lessonId}`, JSON.stringify(value));
  });
}

function checkDatabase(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 3) throw new Error('学习数据库版本不受支持，原文件已保留。');
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('学习数据库校验失败，原文件已保留。');
}

function readOverview(db) {
  const plans = db.prepare('SELECT * FROM plans ORDER BY position').all().map(row => ({ id: row.id, title: row.title, description: row.description, goal: row.goal, level: row.level, daily: row.daily, days: row.days, source: row.source, lessons: [] }));
  const byId = new Map(plans.map(plan => [plan.id, plan]));
  for (const row of db.prepare("SELECT key, value FROM meta WHERE key GLOB 'plan_brief:*'").all()) {
    const plan = byId.get(row.key.slice('plan_brief:'.length));
    if (plan) plan.learningBrief = fromJSON(row.value);
  }
  for (const row of db.prepare('SELECT id, plan_id, title, objective, phase, minutes, tags_json FROM lessons ORDER BY plan_id, position').all()) byId.get(row.plan_id).lessons.push({ id: row.id, title: row.title, objective: row.objective, phase: row.phase, minutes: row.minutes, tags: fromJSON(row.tags_json) });
  const progress = {};
  for (const row of db.prepare('SELECT * FROM progress').all()) progress[row.lesson_id] = { completed: !!row.completed, attempts: row.attempts, lastScore: row.last_score, bestScore: row.best_score, lastAnswers: fromJSON(row.last_answers_json), ...(row.updated === null ? {} : { updated: row.updated }) };
  const notes = db.prepare('SELECT * FROM notes ORDER BY rowid').all().map(noteFromRow);
  const reports = db.prepare("SELECT value FROM meta WHERE key GLOB 'quality:*'").all().map(row => fromJSON(row.value));
  const extras = {};
  for (const field of ['quizRecords', 'revisionNotices', 'sourceSearch']) {
    const rows = db.prepare('SELECT key, value FROM meta WHERE key GLOB ?').all(`${field}:*`);
    if (rows.length) extras[field] = Object.fromEntries(rows.map(r => [r.key.slice(field.length + 1), fromJSON(r.value)]));
  }
  return { version: 1, plans, active: db.prepare("SELECT value FROM meta WHERE key = 'active_plan'").get()?.value || plans[0]?.id, lessons: {}, progress, notes, reflections: {}, chats: {}, ...(reports.length ? { qualityReports: reports } : {}), ...extras };
}

function readExport(db) {
  const state = readOverview(db);
  for (const [field, prefix] of [['qualityJobs', 'revision'], ['qualityDispositions', 'quality_note']]) {
    const rows = db.prepare('SELECT value FROM meta WHERE key GLOB ?').all(`${prefix}:*`);
    if (rows.length) state[field] = rows.map(r => fromJSON(r.value));
  }
  const sourceRows = db.prepare("SELECT key, value FROM meta WHERE key GLOB 'sourceBundles:*'").all();
  if (sourceRows.length) state.sourceBundles = Object.fromEntries(sourceRows.map(row => [row.key.slice('sourceBundles:'.length), fromJSON(row.value)]));
  for (const row of db.prepare('SELECT id, content_json FROM lessons WHERE content_json IS NOT NULL').all()) state.lessons[row.id] = fromJSON(row.content_json);
  for (const row of db.prepare('SELECT lesson_id, content FROM reflections').all()) state.reflections[row.lesson_id] = row.content;
  for (const row of db.prepare("SELECT key, value FROM meta WHERE key GLOB 'annotations:*'").all()) (state.annotations ||= {})[row.key.slice('annotations:'.length)] = fromJSON(row.value);
  for (const row of db.prepare('SELECT lesson_id, role, content FROM chat_messages ORDER BY id').all()) (state.chats[row.lesson_id] ||= []).push({ role: row.role, content: row.content });
  for (const row of db.prepare('SELECT lesson_id, intro FROM lesson_outlines').all()) (state.blockCourses ||= {})[row.lesson_id] = { intro: row.intro, blocks: [] };
  for (const row of db.prepare('SELECT id, lesson_id, type, title, objective, content_json FROM lesson_blocks ORDER BY lesson_id, position').all()) state.blockCourses[row.lesson_id].blocks.push({ id: row.id, type: row.type, title: row.title, objective: row.objective, content: row.content_json ? fromJSON(row.content_json) : null });
  if (!validState(state)) throw new Error('学习数据库导出校验失败。');
  return state;
}

function syncKnowledgeIndex(db, directory) {
  const generation = db.prepare("SELECT value FROM meta WHERE key = 'knowledge_generation'").get()?.value;
  if (!generation) throw new Error('知识卡片目录尚未完成迁移。');
  if (knowledgeGeneration(directory) !== generation) {
    replaceKnowledgeCards(directory, readOverview(db).notes, generation);
    return;
  }
  const files = readKnowledgeCards(directory);
  transaction(db, () => {
    for (const row of db.prepare('SELECT id FROM notes').all()) if (!files.has(row.id)) db.prepare('DELETE FROM notes WHERE id = ?').run(row.id);
    for (const { note } of files.values()) insertNote(db, note);
  });
  readExport(db);
}

export async function createSqliteStore(directory) {
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'learning.sqlite');
  if (!(await exists(filename))) {
    let original;
    let sourceBytes;
    const sourcePath = path.join(directory, 'learning.json');
    try { sourceBytes = await readFile(sourcePath); original = JSON.parse(sourceBytes.toString('utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('旧学习数据无法解析，已保留原文件，未开始迁移。'); }
    const state = sourceBytes ? original : fresh();
    if (!validState(state)) throw new Error('旧学习数据校验失败，已保留原文件，未开始迁移。');
    const temporary = path.join(directory, `learning.${randomUUID()}.migrating`);
    const candidate = new DatabaseSync(temporary);
    try {
      configure(candidate); schema(candidate); replaceAll(candidate, state); checkDatabase(candidate);
      const restored = readExport(candidate);
      for (const key of Object.keys(restored.lessons)) if (!Object.hasOwn(state.lessons, key)) delete restored.lessons[key];
      const expected = { ...state, notes: state.notes.map(normalizeKnowledgeCard), chats: state.chats || {} };
      if (expected.annotations && !Object.keys(expected.annotations).length) delete expected.annotations;
      if (expected.blockCourses && !Object.keys(expected.blockCourses).length) delete expected.blockCourses;
      if (expected.qualityReports && !expected.qualityReports.length) delete expected.qualityReports;
      for (const field of ['qualityJobs', 'qualityDispositions']) if (expected[field] && !expected[field].length) delete expected[field];
      for (const field of ['quizRecords', 'revisionNotices', 'sourceSearch', 'sourceBundles']) if (expected[field] && !Object.keys(expected[field]).length) delete expected[field];
      if (!isDeepStrictEqual(restored, expected)) throw new Error('旧学习数据回读校验失败，原文件已保留。');
    } finally { candidate.close(); }
    if (sourceBytes && !(await readFile(sourcePath)).equals(sourceBytes)) throw new Error('迁移时旧学习数据发生变化，已保留原文件，请重启后重试。');
    await rename(temporary, filename);
  }
  const db = new DatabaseSync(filename);
  try {
    configure(db);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version === 1) {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('原学习数据库校验失败，未迁移。');
      const folder = path.join(directory, 'backups'); await mkdir(folder, { recursive: true });
      const target = path.join(folder, `before-schema-v2-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
      await backup(db, target);
      const copy = new DatabaseSync(target, { readOnly: true });
      try { if (copy.prepare('PRAGMA user_version').get().user_version !== 1 || copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('迁移前备份校验失败。'); }
      finally { copy.close(); }
      transaction(db, () => db.exec(`
        CREATE TABLE lesson_outlines (lesson_id TEXT PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE, intro TEXT NOT NULL);
        CREATE TABLE lesson_blocks (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, position INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, objective TEXT NOT NULL, content_json TEXT);
        CREATE INDEX blocks_by_lesson ON lesson_blocks(lesson_id, position);
        PRAGMA user_version = 2;
      `));
    }
    if (db.prepare('PRAGMA user_version').get().user_version === 2) {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('原学习数据库校验失败，未迁移。');
      const folder = path.join(directory, 'backups'); await mkdir(folder, { recursive: true });
      const target = path.join(folder, `before-schema-v3-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
      await backup(db, target);
      const copy = new DatabaseSync(target, { readOnly: true });
      try { if (copy.prepare('PRAGMA user_version').get().user_version !== 2 || copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('知识卡片迁移前备份校验失败。'); }
      finally { copy.close(); }
      transaction(db, () => {
        if (!db.prepare('PRAGMA table_info(notes)').all().some(column => column.name === 'metadata_json')) db.exec("ALTER TABLE notes ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
        db.exec('PRAGMA user_version = 3');
      });
    }
    checkDatabase(db);
    recoverKnowledgeCardSwap(directory);
    let generation = db.prepare("SELECT value FROM meta WHERE key = 'knowledge_generation'").get()?.value;
    if (!generation) {
      if (db.prepare('SELECT COUNT(*) AS count FROM notes').get().count) {
        const folder = path.join(directory, 'backups'); await mkdir(folder, { recursive: true });
        const target = path.join(folder, `before-knowledge-v1-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
        await backup(db, target);
        const copy = new DatabaseSync(target, { readOnly: true });
        try { checkDatabase(copy); } finally { copy.close(); }
      }
      generation = randomUUID();
      replaceKnowledgeCards(directory, readOverview(db).notes, generation);
      db.prepare("INSERT INTO meta (key, value) VALUES ('knowledge_generation', ?)").run(generation);
    } else if (knowledgeGeneration(directory) !== generation) {
      // An import or route deletion committed before the Markdown directory was refreshed.
      replaceKnowledgeCards(directory, readOverview(db).notes, generation);
    } else syncKnowledgeIndex(db, directory);
    if (!knowledgeLayoutCurrent(directory)) replaceKnowledgeCards(directory, readOverview(db).notes, generation);
    refreshKnowledgeCatalog(directory);
  }
  catch (error) { db.close(); throw error; }
  const lessonExists = db.prepare('SELECT 1 FROM lessons WHERE id = ?');
  const requireLesson = lessonId => { if (!id(lessonId) || !lessonExists.get(lessonId)) throw new Error('课程不存在。'); };
  const overview = () => readOverview(db);
  function getLesson(lessonId) {
    requireLesson(lessonId);
    const row = db.prepare('SELECT content_json FROM lessons WHERE id = ?').get(lessonId);
    const reflection = db.prepare('SELECT content FROM reflections WHERE lesson_id = ?').get(lessonId)?.content || '';
    const annotations = fromJSON(db.prepare('SELECT value FROM meta WHERE key = ?').get(`annotations:${lessonId}`)?.value || '[]');
    const chats = db.prepare('SELECT role, content FROM chat_messages WHERE lesson_id = ? ORDER BY id DESC LIMIT 20').all(lessonId).reverse();
    const outline = db.prepare('SELECT intro FROM lesson_outlines WHERE lesson_id = ?').get(lessonId);
    const blockCourse = outline ? { intro: outline.intro, blocks: db.prepare('SELECT id, type, title, objective, content_json FROM lesson_blocks WHERE lesson_id = ? ORDER BY position').all(lessonId).map(block => ({ id: block.id, type: block.type, title: block.title, objective: block.objective, content: block.content_json ? fromJSON(block.content_json) : null })) } : null;
    const quizRecord = db.prepare('SELECT value FROM meta WHERE key = ?').get(`quizRecords:${lessonId}`);
    const sourceSearch = fromJSON(db.prepare('SELECT value FROM meta WHERE key = ?').get(`sourceSearch:${lessonId}`)?.value || '{"enabled":false,"revision":0}');
    return { lesson: row.content_json ? fromJSON(row.content_json) : null, blockCourse, reflection, annotations, chats, sourceSearch, ...(quizRecord ? { quizRecord: fromJSON(quizRecord.value) } : {}) };
  }
  const metaSet = (key, value) => db.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  const metaRows = prefix => db.prepare('SELECT value FROM meta WHERE key GLOB ?').all(`${prefix}:*`).map(r => fromJSON(r.value));
  function insertReport(report) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`quality:${report.id}`, JSON.stringify(report));
    const history = metaRows('quality').filter(r => r.scope === report.scope && r.targetId === report.targetId).sort((a, b) => b.created - a.created);
    for (const old of history.slice(10)) db.prepare('DELETE FROM meta WHERE key = ?').run(`quality:${old.id}`);
  }
  const quizQuestions = detail => detail.blockCourse ? detail.blockCourse.blocks.filter(b => b.type === 'quiz' && b.content).flatMap(b => b.content.questions) : detail.lesson?.questions || [];
  const quizHash = questions => createHash('sha256').update(JSON.stringify(questions)).digest('hex');
  function trackQuizChange(lessonId, before, after) {
    const oldHash = quizHash(before), newHash = quizHash(after);
    if (oldHash === newHash) return;
    const old = fromJSON(db.prepare('SELECT value FROM meta WHERE key = ?').get(`quizRecords:${lessonId}`)?.value || 'null');
    const progress = overview().progress[lessonId];
    const record = old || { version: 1, currentFingerprint: oldHash, progressFingerprint: progress ? oldHash : null, history: [] };
    if (progress && record.progressFingerprint === oldHash) record.history = [...record.history.filter(h => h.fingerprint !== oldHash), { fingerprint: oldHash, questions: before, progress, updated: Date.now() }].slice(-50);
    record.currentFingerprint = newHash;
    // Restore a version's own saved progress, never grade old answers against new questions.
    const historical = record.history.find(h => h.fingerprint === newHash);
    if (historical) { writeProgress(lessonId, historical.progress); record.progressFingerprint = newHash; }
    metaSet(`quizRecords:${lessonId}`, record);
  }
  function writeProgress(lessonId, value) {
    db.prepare('INSERT INTO progress VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(lesson_id) DO UPDATE SET completed=excluded.completed, attempts=excluded.attempts, last_score=excluded.last_score, best_score=excluded.best_score, last_answers_json=excluded.last_answers_json, updated=excluded.updated').run(lessonId, Number(value.completed), value.attempts, value.lastScore, value.bestScore, JSON.stringify(value.lastAnswers), value.updated ?? null);
  }
  const exportState = () => { syncKnowledgeIndex(db, directory); return readExport(db); };
  function readPlanDeletionPreview(planId) {
    if (!id(planId)) throw new Error('学习路线不存在。');
    const plan = db.prepare('SELECT title FROM plans WHERE id = ?').get(planId);
    if (!plan) throw new Error('学习路线不存在。');
    if (db.prepare('SELECT COUNT(*) AS count FROM plans').get().count <= 1) throw new Error('至少保留一条学习路线，不能删除最后一条。');
    return {
      title: plan.title,
      lessons: db.prepare('SELECT COUNT(*) AS count FROM lessons WHERE plan_id = ?').get(planId).count,
      notes: db.prepare('SELECT COUNT(*) AS count FROM notes WHERE lesson_id IN (SELECT id FROM lessons WHERE plan_id = ?)').get(planId).count
    };
  }
  function planDeletionPreview(planId) { syncKnowledgeIndex(db, directory); return readPlanDeletionPreview(planId); }
  return {
    filename, overview, getLesson, exportState, planDeletionPreview,
    setSourceSearch(lessonId, enabled) {
      requireLesson(lessonId);
      if (typeof enabled !== 'boolean') throw new Error('联网搜索开关无效。');
      const previous = getLesson(lessonId).sourceSearch;
      const value = { enabled, revision: previous.revision + 1 };
      metaSet(`sourceSearch:${lessonId}`, value);
      return value;
    },
    revisionJobs(lessonId) { return metaRows('revision').filter(j => j.lessonId === lessonId).sort((a, b) => b.updated - a.updated); },
    revisionJob(jobId) { const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`revision:${jobId}`); return row ? fromJSON(row.value) : null; },
    saveRevisionJob(job, expectedRev) {
      if (!validRevisionJob(job) || qualityFingerprint(job.baseSnapshot) !== job.baseFingerprint) throw new Error('修订任务格式不正确。');
      requireLesson(job.lessonId);
      if (db.prepare('SELECT plan_id FROM lessons WHERE id = ?').get(job.lessonId).plan_id !== job.planId) throw new Error('修订课程归属无效。');
      transaction(db, () => {
        const previous = fromJSON(db.prepare('SELECT value FROM meta WHERE key = ?').get(`revision:${job.id}`)?.value || 'null');
        if ((previous?.rev || 0) !== expectedRev) throw new Error('修订任务已更新，未覆盖当前草稿。');
        if (!previous && (metaRows('revision').length >= 2000 || metaRows('revision').filter(j => j.lessonId === job.lessonId && ['draft', 'generating', 'reviewing'].includes(j.status)).length >= 10)) throw new Error('修订任务过多，请先处理已有草稿。');
        metaSet(`revision:${job.id}`, job);
        const closed = metaRows('revision').filter(j => j.lessonId === job.lessonId && ['applied', 'restored', 'discarded'].includes(j.status)).sort((a, b) => b.updated - a.updated);
        for (const old of closed.slice(10)) db.prepare('DELETE FROM meta WHERE key = ?').run(`revision:${old.id}`);
      });
    },
    qualityDispositions(lessonId) { return metaRows('quality_note').filter(d => d.lessonId === lessonId); },
    saveQualityDisposition(value) {
      if (!validQualityDisposition(value)) throw new Error('问题处理说明格式不正确。');
      requireLesson(value.lessonId); metaSet(`quality_note:${value.reportId}:${value.issueIndex}`, value);
    },
    applyRevisionJob(jobId, expectedRev, restore) {
      return transaction(db, () => {
        const job = fromJSON(db.prepare('SELECT value FROM meta WHERE key = ?').get(`revision:${jobId}`)?.value || 'null');
        if (!validRevisionJob(job) || job.rev !== expectedRev || (restore ? job.status !== 'applied' : job.status !== 'draft')) throw new Error('修订任务已更新或结束。');
        const detail = getLesson(job.lessonId), current = qualitySnapshot(overview(), 'lesson', job.lessonId, detail);
        const candidate = revisionSnapshot(job.baseSnapshot, job.changes), candidateHash = qualityFingerprint(candidate);
        if (qualityFingerprint(job.baseSnapshot) !== job.baseFingerprint || qualityFingerprint(current) !== (restore ? job.appliedFingerprint : job.baseFingerprint)) throw new Error('课程已变化，未覆盖新内容；请重新评价当前版本。');
        if (!job.review || job.review.fingerprint !== candidateHash || job.review.report.fingerprint !== candidateHash) throw new Error('当前草稿尚未复核。');
        const oldQuestions = quizQuestions(detail);
        for (const change of job.changes) {
          const unit = job.baseSnapshot.units.find(u => u.id === change.unitId);
          const value = restore ? { ...revisionContent(unit), ...(job.sourceGrounding?.[unit.id] ? { grounding: structuredClone(job.sourceGrounding[unit.id]) } : {}) } : change.content;
          if (detail.blockCourse) {
            const block = detail.blockCourse.blocks.find(b => b.id === change.unitId);
            if (!block || block.type !== unit.type) throw new Error('目标模块已变化。');
            const images = Object.fromEntries(['illustration', 'imageProposal'].filter(k => block.content[k]).map(k => [k, block.content[k]]));
            const next = block.type === 'quiz' ? structuredClone(value) : revisedContent(block.type, block.content, { ...value, ...images });
            db.prepare('UPDATE lesson_blocks SET content_json = ? WHERE lesson_id = ? AND id = ?').run(JSON.stringify(next), job.lessonId, block.id);
          } else {
            const lesson = detail.lesson;
            if (unit.id.startsWith('section-')) lesson.sections[Number(unit.id.slice(8))].body = value.text;
            else if (unit.id === 'legacy-example') lesson.example = value.text;
            else if (unit.id === 'legacy-practice') lesson.challenge = value.text;
            else if (unit.id === 'legacy-quiz') lesson.questions = structuredClone(value.questions);
            else throw new Error('旧课程模块不支持此修订。');
          }
        }
        if (!detail.blockCourse) db.prepare('UPDATE lessons SET content_json = ? WHERE id = ?').run(JSON.stringify(detail.lesson), job.lessonId);
        const nextSnapshot = qualitySnapshot(overview(), 'lesson', job.lessonId, getLesson(job.lessonId));
        if (qualityFingerprint(nextSnapshot) !== (restore ? job.baseFingerprint : candidateHash)) throw new Error('应用结果校验失败，已回滚。');
        trackQuizChange(job.lessonId, oldQuestions, quizQuestions(getLesson(job.lessonId)));
        if (!restore) insertReport(job.review.report);
        metaSet(`revision:${job.id}`, { ...job, rev: job.rev + 1, status: restore ? 'restored' : 'applied', appliedFingerprint: job.appliedFingerprint || candidateHash, appliedAt: job.appliedAt || Date.now(), updated: Date.now() });
        metaSet(`revisionNotices:${job.lessonId}`, { updated: Date.now(), jobId: job.id });
      });
    },
    qualityReports(scope, targetId) { return (overview().qualityReports || []).filter(r => r.scope === scope && r.targetId === targetId).sort((a, b) => b.created - a.created); },
    saveQualityReport(report) {
      if (!validQualityReport(report)) throw new Error('课程评价报告格式不正确。');
      const owner = db.prepare('SELECT 1 FROM plans WHERE id = ?').get(report.planId);
      if (!owner || (report.scope === 'route' ? report.targetId !== report.planId : !db.prepare('SELECT 1 FROM lessons WHERE id = ? AND plan_id = ?').get(report.targetId, report.planId))) throw new Error('被评价的课程已删除，未保存报告。');
      transaction(db, () => insertReport(report));
    },
    cardMarkdown(id) { if (!db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) throw new Error('知识卡片不存在。'); return knowledgeCardMarkdown(directory, id); },
    savePlan(plan) {
      if (!validState({ version: 1, plans: [plan], active: plan.id, lessons: {}, progress: {}, notes: [], reflections: {}, chats: {} })) throw new Error('学习路线格式不正确。');
      transaction(db, () => {
        db.prepare('INSERT INTO plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(plan.id, db.prepare('SELECT COUNT(*) AS count FROM plans').get().count, plan.title, plan.description, plan.goal, plan.level, plan.daily, plan.days, plan.source);
        if (plan.learningBrief) db.prepare('INSERT INTO meta VALUES (?, ?)').run(`plan_brief:${plan.id}`, JSON.stringify(plan.learningBrief));
        const statement = db.prepare('INSERT INTO lessons VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)');
        for (const [position, lesson] of plan.lessons.entries()) statement.run(lesson.id, plan.id, position, lesson.title, lesson.objective, lesson.phase, lesson.minutes, JSON.stringify(lesson.tags));
        db.prepare("UPDATE meta SET value = ? WHERE key = 'active_plan'").run(plan.id);
      });
    },
    importCoursePackage(value) {
      const imported = instantiateCoursePackage(value), plan = imported.plans[0];
      if (db.prepare('SELECT COUNT(*) AS count FROM plans').get().count >= 1000) throw new Error('课程数量已达上限。');
      // Append in one transaction; never replace existing lessons, notes or progress.
      transaction(db, () => {
        db.prepare('INSERT INTO plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(plan.id, db.prepare('SELECT COUNT(*) AS count FROM plans').get().count, plan.title, plan.description, plan.goal, plan.level, plan.daily, plan.days, plan.source);
        const lessonStatement = db.prepare('INSERT INTO lessons VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const blockStatement = db.prepare('INSERT INTO lesson_blocks VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const [position, lesson] of plan.lessons.entries()) {
          lessonStatement.run(lesson.id, plan.id, position, lesson.title, lesson.objective, lesson.phase, lesson.minutes, JSON.stringify(lesson.tags), imported.lessons[lesson.id] ? JSON.stringify(imported.lessons[lesson.id]) : null);
          const course = imported.blockCourses[lesson.id];
          if (course) {
            db.prepare('INSERT INTO lesson_outlines VALUES (?, ?)').run(lesson.id, course.intro);
            for (const [index, block] of course.blocks.entries()) blockStatement.run(block.id, lesson.id, index, block.type, block.title, block.objective, block.content ? JSON.stringify(block.content) : null);
          }
        }
        db.prepare("UPDATE meta SET value = ? WHERE key = 'active_plan'").run(plan.id);
      });
      return { planId: plan.id, state: overview() };
    },
    setActivePlan(planId) {
      if (!id(planId) || !db.prepare('SELECT 1 FROM plans WHERE id = ?').get(planId)) throw new Error('学习路线不存在。');
      db.prepare("UPDATE meta SET value = ? WHERE key = 'active_plan'").run(planId);
    },
    async deletePlan(planId) {
      planDeletionPreview(planId);
      const lessonIds = db.prepare('SELECT id FROM lessons WHERE plan_id = ?').all(planId).map(row => row.id);
      const noteIds = db.prepare('SELECT id FROM notes WHERE lesson_id IN (SELECT id FROM lessons WHERE plan_id = ?)').all(planId).map(row => row.id);
      const beforeImages = referencedImages(exportState());
      transaction(db, () => {
        readPlanDeletionPreview(planId);
        const current = db.prepare("SELECT value FROM meta WHERE key = 'active_plan'").get()?.value;
        const next = current === planId ? db.prepare('SELECT id FROM plans WHERE id <> ? ORDER BY position LIMIT 1').get(planId)?.id : current;
        db.prepare('DELETE FROM plans WHERE id = ?').run(planId);
        db.prepare('DELETE FROM meta WHERE key = ?').run(`plan_brief:${planId}`);
        for (const row of db.prepare("SELECT key, value FROM meta WHERE key GLOB 'quality:*'").all()) if (fromJSON(row.value).planId === planId) db.prepare('DELETE FROM meta WHERE key = ?').run(row.key);
        for (const prefix of ['revision', 'quality_note']) for (const row of db.prepare('SELECT key, value FROM meta WHERE key GLOB ?').all(`${prefix}:*`)) if (fromJSON(row.value).planId === planId) db.prepare('DELETE FROM meta WHERE key = ?').run(row.key);
        for (const lessonId of lessonIds) for (const field of ['quizRecords', 'revisionNotices', 'sourceSearch', 'sourceBundles']) db.prepare('DELETE FROM meta WHERE key = ?').run(`${field}:${lessonId}`);
        for (const lessonId of lessonIds) db.prepare('DELETE FROM meta WHERE key = ?').run(`annotations:${lessonId}`);
        db.prepare("UPDATE meta SET value = ? WHERE key = 'knowledge_generation'").run(randomUUID());
        db.prepare("UPDATE meta SET value = ? WHERE key = 'active_plan'").run(next);
        for (const [position, row] of db.prepare('SELECT id FROM plans ORDER BY position').all().entries()) db.prepare('UPDATE plans SET position = ? WHERE id = ?').run(position, row.id);
      });
      removeKnowledgeCards(directory, noteIds, db.prepare("SELECT value FROM meta WHERE key = 'knowledge_generation'").get().value, db.prepare('SELECT COUNT(*) AS count FROM notes').get().count);
      const remainingImages = new Set(referencedImages(exportState()));
      const imageIds = beforeImages.filter(imageId => !remainingImages.has(imageId));
      const backups = await removePlanFromBackups(directory, planId);
      return { state: overview(), lessonIds, imageIds, backups };
    },
    saveLesson(lessonId, content) {
      requireLesson(lessonId);
      if (!validLesson(content)) throw new Error('课程内容格式不正确。');
      transaction(db, () => {
        const before = quizQuestions(getLesson(lessonId)), tracked = !!db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`quizRecords:${lessonId}`);
        db.prepare('UPDATE lessons SET content_json = ? WHERE id = ?').run(JSON.stringify(content), lessonId);
        if (tracked) trackQuizChange(lessonId,before,quizQuestions(getLesson(lessonId)));
      });
    },
    saveOutline(lessonId, outline) {
      requireLesson(lessonId);
      if (!validOutline(outline)) throw new Error('课程大纲格式不正确。');
      return transaction(db, () => {
        if (db.prepare('SELECT 1 FROM lesson_outlines WHERE lesson_id = ?').get(lessonId)) throw new Error('课程大纲已存在。');
        db.prepare('INSERT INTO lesson_outlines VALUES (?, ?)').run(lessonId, outline.intro);
        const insert = db.prepare('INSERT INTO lesson_blocks VALUES (?, ?, ?, ?, ?, ?, NULL)');
        const blocks = outline.blocks.map((block, position) => { const id = randomUUID(); insert.run(id, lessonId, position, block.type, block.title, block.objective); return { id, ...block, content: null }; });
        return { intro: outline.intro, blocks };
      });
    },
    appendBlock(lessonId, spec) {
      requireLesson(lessonId);
      if (!validBlockSpec(spec)) throw new Error('内容块格式不正确。');
      return transaction(db, () => {
        if (!db.prepare('SELECT 1 FROM lesson_outlines WHERE lesson_id = ?').get(lessonId)) throw new Error('请先生成课程大纲。');
        const position = db.prepare('SELECT COUNT(*) AS count FROM lesson_blocks WHERE lesson_id = ?').get(lessonId).count;
        if (position >= 1000) throw new Error('本课内容块已达上限。');
        const block = { id: randomUUID(), type: spec.type, title: spec.title, objective: spec.objective, content: null };
        db.prepare('INSERT INTO lesson_blocks VALUES (?, ?, ?, ?, ?, ?, NULL)').run(block.id, lessonId, position, block.type, block.title, block.objective);
        return block;
      });
    },
    saveBlock(lessonId, blockId, content) {
      requireLesson(lessonId);
      if (!id(blockId)) throw new Error('内容块不存在。');
      const block = db.prepare('SELECT type, content_json FROM lesson_blocks WHERE lesson_id = ? AND id = ?').get(lessonId, blockId);
      if (!block) throw new Error('内容块不存在。');
      if (block.content_json !== null) throw new Error('内容块已生成。');
      if (!validBlockContent(block.type, content)) throw new Error('内容块正文格式不正确。');
      transaction(db, () => {
        const before = block.type === 'quiz' ? quizQuestions(getLesson(lessonId)) : [], tracked = !!db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`quizRecords:${lessonId}`);
        db.prepare('UPDATE lesson_blocks SET content_json = ? WHERE lesson_id = ? AND id = ? AND content_json IS NULL').run(JSON.stringify(content), lessonId, blockId);
        if (block.type === 'quiz') {
          if (tracked) trackQuizChange(lessonId,before,quizQuestions(getLesson(lessonId)));
          else db.prepare("UPDATE progress SET completed = 0, last_score = 0, last_answers_json = '[]' WHERE lesson_id = ?").run(lessonId);
        }
      });
    },
    attachIllustration(lessonId, blockId, illustration, expectedContent) {
      requireLesson(lessonId);
      if (!id(blockId)) throw new Error('内容块不存在。');
      return transaction(db, () => {
        const block = db.prepare('SELECT type, content_json FROM lesson_blocks WHERE lesson_id = ? AND id = ?').get(lessonId, blockId);
        if (!block?.content_json || !assistedBlockTypes.includes(block.type)) throw new Error('只能为已保存的讲解、案例或实践任务配图。');
        if (block.content_json !== expectedContent) throw new Error('内容已更新，图片未覆盖当前内容；图片文件已保留在本地。');
        const next = { ...fromJSON(block.content_json), illustration };
        if (!validBlockContent(block.type, next)) throw new Error('配图信息无效。');
        db.prepare('UPDATE lesson_blocks SET content_json = ? WHERE lesson_id = ? AND id = ?').run(JSON.stringify(next), lessonId, blockId);
        return next;
      });
    },
    reviseBlock(lessonId, blockId, content, expectedText) {
      requireLesson(lessonId);
      if (!id(blockId)) throw new Error('内容块不存在。');
      return transaction(db, () => {
        const block = db.prepare('SELECT type, content_json FROM lesson_blocks WHERE lesson_id = ? AND id = ?').get(lessonId, blockId);
        if (!block?.content_json) throw new Error('内容块尚未生成。');
        const previous = fromJSON(block.content_json);
        if (previous.text !== expectedText) throw new Error('内容已更新，请重新打开课程后重试。');
        const next = revisedContent(block.type, previous, content);
        db.prepare('UPDATE lesson_blocks SET content_json = ? WHERE lesson_id = ? AND id = ?').run(JSON.stringify(next), lessonId, blockId);
        return next;
      });
    },
    restoreBlock(lessonId, blockId, expectedText) {
      requireLesson(lessonId);
      if (!id(blockId)) throw new Error('内容块不存在。');
      return transaction(db, () => {
        const block = db.prepare('SELECT type, content_json FROM lesson_blocks WHERE lesson_id = ? AND id = ?').get(lessonId, blockId);
        if (!block?.content_json) throw new Error('内容块尚未生成。');
        const previous = fromJSON(block.content_json);
        if (previous.text !== expectedText) throw new Error('内容已更新，请重新打开课程后重试。');
        const next = restoredContent(block.type, previous);
        db.prepare('UPDATE lesson_blocks SET content_json = ? WHERE lesson_id = ? AND id = ?').run(JSON.stringify(next), lessonId, blockId);
        return next;
      });
    },
    saveProgress(lessonId, value) {
      requireLesson(lessonId);
      if (!value || typeof value.completed !== 'boolean' || !Number.isInteger(value.attempts) || value.attempts < 0 || ![value.lastScore, value.bestScore].every(n => Number.isInteger(n) && n >= 0 && n <= 100) || !Array.isArray(value.lastAnswers) || value.lastAnswers.length > 100 || !value.lastAnswers.every(n => Number.isInteger(n) && n >= 0 && n < 4)) throw new Error('练习成绩格式不正确。');
      const record = fromJSON(db.prepare('SELECT value FROM meta WHERE key = ?').get(`quizRecords:${lessonId}`)?.value || 'null');
      if (record) {
        if (value.quizFingerprint !== record.currentFingerprint || quizHash(quizQuestions(getLesson(lessonId))) !== record.currentFingerprint) throw new Error('题目版本已变化，请重新打开练习；成绩未覆盖。');
        transaction(db, () => { writeProgress(lessonId, value); metaSet(`quizRecords:${lessonId}`, { ...record, progressFingerprint: record.currentFingerprint }); });
      } else writeProgress(lessonId, value);
    },
    saveReflection(lessonId, value) {
      requireLesson(lessonId);
      if (!text(value, 5000)) throw new Error('学习心得过长。');
      db.prepare('INSERT INTO reflections VALUES (?, ?) ON CONFLICT(lesson_id) DO UPDATE SET content=excluded.content').run(lessonId, value);
    },
    saveAnnotations(lessonId, annotations) {
      requireLesson(lessonId);
      if (!validAnnotations(annotations)) throw new Error('原文批注格式不正确。');
      if (annotations.length) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`annotations:${lessonId}`, JSON.stringify(annotations));
      else db.prepare('DELETE FROM meta WHERE key = ?').run(`annotations:${lessonId}`);
    },
    appendChat(lessonId, question, answer) {
      requireLesson(lessonId);
      if (!text(question, 1000) || !question.trim() || !text(answer, 12000) || !answer.trim()) throw new Error('答疑内容格式不正确。');
      transaction(db, () => {
        const insert = db.prepare('INSERT INTO chat_messages (lesson_id, role, content) VALUES (?, ?, ?)');
        insert.run(lessonId, 'user', question); insert.run(lessonId, 'assistant', answer);
        db.prepare('DELETE FROM chat_messages WHERE lesson_id = ? AND id NOT IN (SELECT id FROM chat_messages WHERE lesson_id = ? ORDER BY id DESC LIMIT 20)').run(lessonId, lessonId);
      });
    },
    saveNote(note) {
      const normalized = normalizeKnowledgeCard(note);
      requireLesson(normalized.lessonId);
      const indexed = db.prepare('SELECT * FROM notes WHERE id = ?').get(normalized.id);
      const old = indexed ? noteFromRow(indexed) : null;
      const onDisk = readKnowledgeCard(directory, normalized.id, old?.topic);
      if ((indexed && !onDisk) || (!indexed && onDisk) || (indexed && onDisk && !isDeepStrictEqual(noteFromRow(indexed), onDisk))) throw new Error('知识卡片文件已在应用外修改，请重启应用后再编辑。');
      saveKnowledgeCard(directory, normalized, saved => insertNote(db, saved), old?.topic);
    },
    noteDeletionPreview(noteId) {
      if (!id(noteId)) throw new Error('知识卡片 ID 无效。');
      const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
      if (!row) throw new Error('知识卡片不存在。');
      const note = noteFromRow(row);
      const onDisk = readKnowledgeCard(directory, noteId, note.topic);
      if (!onDisk || !isDeepStrictEqual(note, onDisk)) throw new Error('知识卡片文件已在应用外修改，请重启应用核对后再删除。');
      return { id: note.id, title: note.title, updated: note.updated };
    },
    deleteNote(noteId, expectedUpdated) {
      const preview = this.noteDeletionPreview(noteId);
      if (preview.updated !== expectedUpdated) throw new Error('知识卡片已更新，请重新打开后再删除。');
      const note = noteFromRow(db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId));
      const generation = db.prepare("SELECT value FROM meta WHERE key = 'knowledge_generation'").get().value;
      const count = db.prepare('SELECT COUNT(*) AS count FROM notes').get().count;
      try {
        removeKnowledgeCards(directory, [noteId], generation, count - 1);
        const removed = db.prepare('DELETE FROM notes WHERE id = ? AND updated = ?').run(noteId, expectedUpdated);
        if (removed.changes !== 1) throw new Error('知识卡片已更新，请重新打开后再删除。');
      } catch (error) {
        try {
          if (!readKnowledgeCard(directory, noteId, note.topic)) saveKnowledgeCard(directory, note, saved => insertNote(db, saved), note.topic);
          removeKnowledgeCards(directory, [], generation, count);
        } catch (restoreError) { throw new Error(`卡片删除失败，自动恢复也未完成，请重启核对数据：${restoreError.message}`); }
        throw error;
      }
      return { id: noteId };
    },
    async backupBeforeImport() {
      syncKnowledgeIndex(db, directory);
      const folder = path.join(directory, 'backups'); await mkdir(folder, { recursive: true });
      const target = path.join(folder, `before-import-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
      await backup(db, target);
      const copy = new DatabaseSync(target, { readOnly: true });
      try { checkDatabase(copy); } finally { copy.close(); }
      return target;
    },
    replaceState(state) {
      replaceAll(db, state); checkDatabase(db);
      replaceKnowledgeCards(directory, readOverview(db).notes, db.prepare("SELECT value FROM meta WHERE key = 'knowledge_generation'").get().value);
      return overview();
    },
    close() { db.close(); }
  };
}
