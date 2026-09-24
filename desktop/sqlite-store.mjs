import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { demoPlan, demoLessons } from '../public/demo.js';
import { validLesson } from '../server.mjs';
import { validState } from './local-store.mjs';

const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;
const fromJSON = value => JSON.parse(value);
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
    CREATE TABLE notes (id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, course_title TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL, source TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE INDEX notes_by_updated ON notes(updated DESC);
    PRAGMA user_version = 1;
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
    db.exec('DELETE FROM chat_messages; DELETE FROM notes; DELETE FROM reflections; DELETE FROM progress; DELETE FROM lessons; DELETE FROM plans; DELETE FROM meta;');
    const planStatement = db.prepare('INSERT INTO plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const lessonStatement = db.prepare('INSERT INTO lessons VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const progressStatement = db.prepare('INSERT INTO progress VALUES (?, ?, ?, ?, ?, ?, ?)');
    const reflectionStatement = db.prepare('INSERT INTO reflections VALUES (?, ?)');
    const chatStatement = db.prepare('INSERT INTO chat_messages (lesson_id, role, content) VALUES (?, ?, ?)');
    const noteStatement = db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [position, plan] of state.plans.entries()) {
      planStatement.run(plan.id, position, plan.title, plan.description, plan.goal, plan.level, plan.daily, plan.days, plan.source);
      for (const [lessonPosition, lesson] of plan.lessons.entries()) {
        const content = state.lessons[lesson.id] || (plan.source === 'demo' ? demoLessons[lesson.id] : null);
        lessonStatement.run(lesson.id, plan.id, lessonPosition, lesson.title, lesson.objective, lesson.phase, lesson.minutes, JSON.stringify(lesson.tags), content ? JSON.stringify(content) : null);
      }
    }
    for (const [lessonId, progress] of Object.entries(state.progress)) progressStatement.run(lessonId, Number(progress.completed), progress.attempts, progress.lastScore, progress.bestScore, JSON.stringify(progress.lastAnswers), progress.updated ?? null);
    for (const [lessonId, reflection] of Object.entries(state.reflections)) reflectionStatement.run(lessonId, reflection);
    for (const [lessonId, messages] of Object.entries(state.chats || {})) for (const message of messages) chatStatement.run(lessonId, message.role, message.content);
    for (const note of state.notes) noteStatement.run(note.id, note.lessonId, note.courseTitle, note.title, note.summary, note.content, JSON.stringify(note.tags), note.source, note.updated);
    db.prepare('INSERT INTO meta VALUES (?, ?)').run('active_plan', state.active);
  });
}

function checkDatabase(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('学习数据库版本不受支持，原文件已保留。');
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('学习数据库校验失败，原文件已保留。');
}

function readOverview(db) {
  const plans = db.prepare('SELECT * FROM plans ORDER BY position').all().map(row => ({ id: row.id, title: row.title, description: row.description, goal: row.goal, level: row.level, daily: row.daily, days: row.days, source: row.source, lessons: [] }));
  const byId = new Map(plans.map(plan => [plan.id, plan]));
  for (const row of db.prepare('SELECT id, plan_id, title, objective, phase, minutes, tags_json FROM lessons ORDER BY plan_id, position').all()) byId.get(row.plan_id).lessons.push({ id: row.id, title: row.title, objective: row.objective, phase: row.phase, minutes: row.minutes, tags: fromJSON(row.tags_json) });
  const progress = {};
  for (const row of db.prepare('SELECT * FROM progress').all()) progress[row.lesson_id] = { completed: !!row.completed, attempts: row.attempts, lastScore: row.last_score, bestScore: row.best_score, lastAnswers: fromJSON(row.last_answers_json), ...(row.updated === null ? {} : { updated: row.updated }) };
  const notes = db.prepare('SELECT * FROM notes ORDER BY rowid').all().map(row => ({ id: row.id, lessonId: row.lesson_id, courseTitle: row.course_title, title: row.title, summary: row.summary, content: row.content, tags: fromJSON(row.tags_json), source: row.source, updated: row.updated }));
  return { version: 1, plans, active: db.prepare("SELECT value FROM meta WHERE key = 'active_plan'").get()?.value || plans[0]?.id, lessons: {}, progress, notes, reflections: {}, chats: {} };
}

function readExport(db) {
  const state = readOverview(db);
  for (const row of db.prepare('SELECT id, content_json FROM lessons WHERE content_json IS NOT NULL').all()) state.lessons[row.id] = fromJSON(row.content_json);
  for (const row of db.prepare('SELECT lesson_id, content FROM reflections').all()) state.reflections[row.lesson_id] = row.content;
  for (const row of db.prepare('SELECT lesson_id, role, content FROM chat_messages ORDER BY id').all()) (state.chats[row.lesson_id] ||= []).push({ role: row.role, content: row.content });
  if (!validState(state)) throw new Error('学习数据库导出校验失败。');
  return state;
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
      const expected = { ...state, chats: state.chats || {} };
      if (!isDeepStrictEqual(restored, expected)) throw new Error('旧学习数据回读校验失败，原文件已保留。');
    } finally { candidate.close(); }
    if (sourceBytes && !(await readFile(sourcePath)).equals(sourceBytes)) throw new Error('迁移时旧学习数据发生变化，已保留原文件，请重启后重试。');
    await rename(temporary, filename);
  }
  const db = new DatabaseSync(filename);
  try { configure(db); checkDatabase(db); }
  catch (error) { db.close(); throw error; }
  const lessonExists = db.prepare('SELECT 1 FROM lessons WHERE id = ?');
  const requireLesson = lessonId => { if (!id(lessonId) || !lessonExists.get(lessonId)) throw new Error('课程不存在。'); };
  const overview = () => readOverview(db);
  function getLesson(lessonId) {
    requireLesson(lessonId);
    const row = db.prepare('SELECT content_json FROM lessons WHERE id = ?').get(lessonId);
    const reflection = db.prepare('SELECT content FROM reflections WHERE lesson_id = ?').get(lessonId)?.content || '';
    const chats = db.prepare('SELECT role, content FROM chat_messages WHERE lesson_id = ? ORDER BY id DESC LIMIT 20').all(lessonId).reverse();
    return { lesson: row.content_json ? fromJSON(row.content_json) : null, reflection, chats };
  }
  const exportState = () => readExport(db);
  return {
    filename, overview, getLesson, exportState,
    savePlan(plan) {
      if (!validState({ version: 1, plans: [plan], active: plan.id, lessons: {}, progress: {}, notes: [], reflections: {}, chats: {} })) throw new Error('学习路线格式不正确。');
      transaction(db, () => {
        db.prepare('INSERT INTO plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(plan.id, db.prepare('SELECT COUNT(*) AS count FROM plans').get().count, plan.title, plan.description, plan.goal, plan.level, plan.daily, plan.days, plan.source);
        const statement = db.prepare('INSERT INTO lessons VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)');
        for (const [position, lesson] of plan.lessons.entries()) statement.run(lesson.id, plan.id, position, lesson.title, lesson.objective, lesson.phase, lesson.minutes, JSON.stringify(lesson.tags));
        db.prepare("UPDATE meta SET value = ? WHERE key = 'active_plan'").run(plan.id);
      });
    },
    setActivePlan(planId) {
      if (!id(planId) || !db.prepare('SELECT 1 FROM plans WHERE id = ?').get(planId)) throw new Error('学习路线不存在。');
      db.prepare("UPDATE meta SET value = ? WHERE key = 'active_plan'").run(planId);
    },
    saveLesson(lessonId, content) {
      requireLesson(lessonId);
      if (!validLesson(content)) throw new Error('课程内容格式不正确。');
      db.prepare('UPDATE lessons SET content_json = ? WHERE id = ?').run(JSON.stringify(content), lessonId);
    },
    saveProgress(lessonId, value) {
      requireLesson(lessonId);
      if (!value || typeof value.completed !== 'boolean' || !Number.isInteger(value.attempts) || value.attempts < 0 || ![value.lastScore, value.bestScore].every(n => Number.isInteger(n) && n >= 0 && n <= 100) || !Array.isArray(value.lastAnswers) || value.lastAnswers.length > 5 || !value.lastAnswers.every(n => Number.isInteger(n) && n >= 0 && n < 4)) throw new Error('练习成绩格式不正确。');
      db.prepare('INSERT INTO progress VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(lesson_id) DO UPDATE SET completed=excluded.completed, attempts=excluded.attempts, last_score=excluded.last_score, best_score=excluded.best_score, last_answers_json=excluded.last_answers_json, updated=excluded.updated').run(lessonId, Number(value.completed), value.attempts, value.lastScore, value.bestScore, JSON.stringify(value.lastAnswers), value.updated ?? null);
    },
    saveReflection(lessonId, value) {
      requireLesson(lessonId);
      if (!text(value, 5000)) throw new Error('学习心得过长。');
      db.prepare('INSERT INTO reflections VALUES (?, ?) ON CONFLICT(lesson_id) DO UPDATE SET content=excluded.content').run(lessonId, value);
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
      if (!note || !id(note.id) || !id(note.lessonId) || !text(note.title, 160) || !text(note.summary, 500) || !text(note.content, 20000) || !text(note.courseTitle, 160) || !['ai', 'demo'].includes(note.source) || !Number.isFinite(note.updated) || !Array.isArray(note.tags) || note.tags.length > 6 || !note.tags.every(tag => text(tag, 200))) throw new Error('知识卡片格式不正确。');
      requireLesson(note.lessonId);
      db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, summary=excluded.summary, content=excluded.content, tags_json=excluded.tags_json, updated=excluded.updated').run(note.id, note.lessonId, note.courseTitle, note.title, note.summary, note.content, JSON.stringify(note.tags), note.source, note.updated);
    },
    async backupBeforeImport() {
      const folder = path.join(directory, 'backups'); await mkdir(folder, { recursive: true });
      const target = path.join(folder, `before-import-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
      await backup(db, target);
      const copy = new DatabaseSync(target, { readOnly: true });
      try { checkDatabase(copy); } finally { copy.close(); }
      return target;
    },
    replaceState(state) { replaceAll(db, state); checkDatabase(db); return overview(); },
    close() { db.close(); }
  };
}
