import { lstat, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { validState } from './local-store.mjs';
import { referencedImages } from '../public/illustrations.js';

const missing = error => error.code === 'ENOENT';
const remove = async file => { try { await unlink(file); } catch (error) { if (!missing(error)) throw error; } };

function withoutPlan(state, planId) {
  const plan = state.plans.find(item => item.id === planId);
  if (!plan) return null;
  const lessonIds = new Set(plan.lessons.map(lesson => lesson.id));
  const next = { ...state, plans: state.plans.filter(item => item.id !== planId) };
  if (!next.plans.length) return next;
  if (next.active === planId) next.active = next.plans[0].id;
  for (const key of ['lessons', 'blockCourses', 'progress', 'reflections', 'chats']) {
    if (next[key]) next[key] = Object.fromEntries(Object.entries(next[key]).filter(([lessonId]) => !lessonIds.has(lessonId)));
  }
  next.notes = next.notes.filter(note => !lessonIds.has(note.lessonId));
  if (next.imageAssets) {
    const used = new Set(referencedImages(next));
    next.imageAssets = next.imageAssets.filter(asset => used.has(asset.id));
  }
  if (!validState(next)) throw new Error('历史备份清理后的数据校验失败。');
  return next;
}

async function cleanJson(file, planId) {
  const source = await readFile(file, 'utf8');
  if (!source.includes(planId)) return false;
  const state = JSON.parse(source);
  if (!state || !Array.isArray(state.plans)) throw new Error('历史备份格式无法识别。');
  const next = withoutPlan(state, planId);
  if (!next) return false;
  if (!next.plans.length) { await remove(file); return true; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await remove(temporary); }
  return true;
}

async function cleanSqlite(file, planId) {
  const db = new DatabaseSync(file, { readOnly: true });
  let found;
  try { found = !!db.prepare('SELECT 1 FROM plans WHERE id = ?').get(planId); }
  finally { db.close(); }
  if (!found) return false;
  // Migration/import snapshots contain multiple courses and may have an older
  // schema. Never rewrite them with the current schema or leave the deleted
  // course recoverable: discard the matching snapshot as a whole.
  await remove(file);
  for (const suffix of ['-wal', '-shm']) await remove(file + suffix);
  return true;
}

export async function removePlanFromBackups(directory, planId) {
  const candidates = [path.join(directory, 'learning.json'), path.join(directory, 'learning.json.bak')];
  const folder = path.join(directory, 'backups');
  let names = [];
  const failures = [];
  try {
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('备份目录不是普通目录，未访问其中的文件。');
    names = await readdir(folder);
  } catch (error) { if (!missing(error)) failures.push(`backups: ${error.message}`); }
  for (const name of names) if (/^before-(?:delete|import|schema-v2|schema-v3|knowledge-v1)-[^/\\]+\.(?:json|sqlite)$/.test(name)) candidates.push(path.join(folder, name));
  let cleaned = 0;
  for (const file of candidates) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      if (file.endsWith('.sqlite') ? await cleanSqlite(file, planId) : await cleanJson(file, planId)) cleaned++;
    } catch (error) { if (!missing(error)) failures.push(`${path.basename(file)}: ${error.message}`); }
  }
  return { cleaned, failures };
}
