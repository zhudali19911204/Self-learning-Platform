import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import yaml from 'js-yaml';
import { knowledgeCatalog } from '../public/knowledge-index.js';

const cardId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const string = (value, max) => typeof value === 'string' && value.length <= max;
const list = (value, check, max) => Array.isArray(value) && value.length <= max && value.every(check);
const known = new Set(['schema', 'id', 'title', 'description', 'topic', 'knowledge_category', 'use_when', 'avoid_when', 'aliases', 'tags', 'source_course', 'source_lesson', 'source_lessons', 'related_cards', 'prerequisites', 'contrasts', 'status', 'created', 'updated', 'source']);
const rootFor = directory => path.join(directory, 'knowledge');
const cardsFor = directory => path.join(rootFor(directory), 'cards');
const markerFor = directory => path.join(rootFor(directory), 'generation.json');
const catalogFor = directory => path.join(rootFor(directory), 'catalog.json');
export function recoverKnowledgeCardSwap(directory) {
  const root = rootFor(directory), cards = cardsFor(directory);
  try { requireDirectory(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try { requireDirectory(cards); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const candidates = readdirSync(root, { withFileTypes: true }).filter(entry => /^\.cards-[a-f0-9-]+\.previous$/.test(entry.name));
  if (!candidates.length) return;
  if (candidates.length !== 1 || !candidates[0].isDirectory()) throw new Error('知识卡片目录恢复状态不明确，原文件已保留，请人工检查。');
  const previous = path.join(root, candidates[0].name);
  requireDirectory(previous);
  renameSync(previous, cards);
}
function topicParts(topic) {
  const parts = String(topic || '未分类').split(/[\\/]/).map(value => value.trim()).filter(Boolean);
  const bounded = parts.length > 3 ? [...parts.slice(0, 2), parts.slice(2).join('-')] : parts;
  return (bounded.length ? bounded : ['未分类']).map(value => {
    const readable = value.normalize('NFKC').replace(/[<>:"|?*\x00-\x1f. ]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || '主题';
    return `${readable}-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
  });
}
export function cardPathFor(directory, note) {
  const normalized = normalizeKnowledgeCard(note);
  return path.join(cardsFor(directory), ...topicParts(normalized.topic), `${normalized.id}.md`);
}
function requireDirectory(folder) {
  const info = lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('知识卡片目录必须是普通文件夹。');
}

function safeExtra(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('知识卡片附加属性格式不正确。');
  if (Object.keys(value).some(key => known.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error('知识卡片附加属性与标准字段冲突。');
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw new Error('知识卡片附加属性不能包含循环引用。'); }
  if (!encoded || encoded.length > 8000) throw new Error('知识卡片附加属性过长。');
  return JSON.parse(encoded);
}

function linkId(value) {
  if (typeof value !== 'string') return null;
  const id = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(value)?.[1] || value;
  return cardId(id) ? id : null;
}

export function normalizeKnowledgeCard(input) {
  if (!input || !cardId(input.id) || !cardId(input.lessonId) || !string(input.courseTitle, 160) || !string(input.title, 160) || !string(input.summary, 500) || !string(input.content, 20000) || !['ai', 'demo'].includes(input.source) || !Number.isFinite(input.updated) || !list(input.tags, tag => string(tag, 200), 6)) throw new Error('知识卡片格式不正确。');
  const topic = input.topic ?? '未分类';
  const category = input.category == null || input.category === '' ? undefined : input.category;
  const useWhen = input.useWhen ?? [];
  const avoidWhen = input.avoidWhen ?? [];
  const aliases = input.aliases ?? [];
  const sourceLessons = input.sourceLessons ?? [input.lessonId];
  const related = input.related ?? [];
  const prerequisites = input.prerequisites ?? [];
  const contrasts = input.contrasts ?? [];
  const status = input.status ?? 'draft';
  const created = input.created ?? input.updated;
  if (!string(topic, 160) || !topic.trim() || (category !== undefined && (!string(category, 80) || !category.trim())) || !list(useWhen, item => string(item, 500), 12) || !list(avoidWhen, item => string(item, 500), 12) || !list(aliases, item => string(item, 160), 20) || !list(sourceLessons, cardId, 30) || !sourceLessons.includes(input.lessonId) || !list(related, cardId, 100) || !list(prerequisites, cardId, 100) || !list(contrasts, cardId, 100) || !['draft', 'reviewed'].includes(status) || !Number.isFinite(created) || !Number.isFinite(new Date(created).getTime()) || !Number.isFinite(new Date(input.updated).getTime())) throw new Error('知识卡片元数据格式不正确。');
  return { id: input.id, lessonId: input.lessonId, courseTitle: input.courseTitle, title: input.title, summary: input.summary, content: input.content, tags: [...input.tags], source: input.source, updated: input.updated, topic, ...(category ? { category: category.trim() } : {}), useWhen: [...useWhen], avoidWhen: [...avoidWhen], aliases: [...aliases], sourceLessons: [...sourceLessons], related: [...related], prerequisites: [...prerequisites], contrasts: [...contrasts], status, created, ...(input.yamlExtra ? { yamlExtra: safeExtra(input.yamlExtra) } : {}) };
}

export function cardMetadata(note) {
  const n = normalizeKnowledgeCard(note);
  const links = values => values.map(id => `[[${id}]]`);
  return {
    schema: 1, id: n.id, title: n.title, description: n.summary, topic: n.topic,
    ...(n.category ? { knowledge_category: n.category } : {}),
    use_when: n.useWhen, avoid_when: n.avoidWhen, aliases: n.aliases, tags: n.tags,
    source_course: n.courseTitle, source_lesson: n.lessonId, source_lessons: n.sourceLessons,
    related_cards: links(n.related), prerequisites: links(n.prerequisites), contrasts: links(n.contrasts),
    status: n.status, created: new Date(n.created).toISOString(), updated: new Date(n.updated).toISOString(), source: n.source,
    ...safeExtra(n.yamlExtra)
  };
}

export function serializeKnowledgeCard(note) {
  const n = normalizeKnowledgeCard(note);
  return `---\n${yaml.dump(cardMetadata(n), { lineWidth: -1, noRefs: true })}---\n${n.content}\n`;
}

export function parseKnowledgeCard(source, filename = '') {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 512 * 1024) throw new Error('知识卡片文件过大。');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source.replace(/^\uFEFF/, ''));
  if (!match) throw new Error('知识卡片缺少 YAML 头部。');
  let meta;
  try { meta = yaml.load(match[1]); } catch (error) { throw new Error(`知识卡片 YAML 无法解析：${error.message}`); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || meta.schema !== 1) throw new Error('知识卡片 YAML 版本不受支持。');
  const links = value => Array.isArray(value) ? value.map(linkId) : value;
  const stamp = value => value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value;
  const extra = Object.fromEntries(Object.entries(meta).filter(([key]) => !known.has(key)));
  const note = normalizeKnowledgeCard({
    id: meta.id, lessonId: meta.source_lesson, courseTitle: meta.source_course, title: meta.title, summary: meta.description,
    content: match[2].endsWith('\n') ? match[2].slice(0, -1) : match[2], tags: meta.tags, source: meta.source, updated: stamp(meta.updated),
    topic: meta.topic, category: meta.knowledge_category, useWhen: meta.use_when, avoidWhen: meta.avoid_when, aliases: meta.aliases,
    sourceLessons: meta.source_lessons, related: links(meta.related_cards), prerequisites: links(meta.prerequisites), contrasts: links(meta.contrasts),
    status: meta.status, created: stamp(meta.created), ...(Object.keys(extra).length ? { yamlExtra: extra } : {})
  });
  if (filename && filename !== `${note.id}.md`) throw new Error('知识卡片文件名与固定 ID 不一致。');
  return note;
}

function atomicWrite(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { renameSync(temporary, target); } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

export function refreshKnowledgeCatalog(directory) {
  const notes = [...readKnowledgeCards(directory).values()].map(({ note }) => note);
  const catalog = knowledgeCatalog(notes);
  try { atomicWrite(catalogFor(directory), JSON.stringify(catalog, null, 2)); }
  catch (error) {
    // The directory is derived data. Never undo a successfully saved card because its cache cannot be written.
    try { unlinkSync(catalogFor(directory)); } catch {}
    console.warn('知识目录缓存未能更新，下次启动将重建：' + error.message);
  }
  return catalog;
}

function updateKnowledgeCatalog(directory, upsert = null, removed = []) {
  let current;
  try { current = JSON.parse(readFileSync(catalogFor(directory), 'utf8')); }
  catch { refreshKnowledgeCatalog(directory); return; }
  if (current?.schema !== 1 || !Array.isArray(current.cards)) { refreshKnowledgeCatalog(directory); return; }
  const entries = current.cards.filter(card => card?.id !== upsert?.id && !removed.includes(card?.id));
  if (upsert) entries.push(upsert);
  const next = knowledgeCatalog(entries);
  try { atomicWrite(catalogFor(directory), JSON.stringify(next, null, 2)); }
  catch (error) {
    try { unlinkSync(catalogFor(directory)); } catch {}
    console.warn('知识目录缓存未能更新，下次启动将重建：' + error.message);
  }
}

function safeRemoveFolder(root, target) {
  if (!path.resolve(target).startsWith(path.resolve(root) + path.sep)) throw new Error('知识卡片临时目录路径无效。');
  rmSync(target, { recursive: true, force: true });
}

export function knowledgeGeneration(directory) {
  try {
    const marker = JSON.parse(readFileSync(markerFor(directory), 'utf8'));
    return marker?.schema === 1 && cardId(marker.generation) ? marker.generation : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function readKnowledgeCards(directory) {
  const folder = cardsFor(directory);
  requireDirectory(rootFor(directory)); requireDirectory(folder);
  const results = new Map();
  const visit = (current, depth) => {
    if (depth > 5) throw new Error('知识卡片目录层级过深。');
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const info = lstatSync(filename);
      if (info.isSymbolicLink()) throw new Error(`知识卡片目录包含链接：${entry.name}`);
      if (entry.isDirectory()) { visit(filename, depth + 1); continue; }
      if (!entry.name.endsWith('.md')) continue;
      if (!entry.isFile()) throw new Error(`知识卡片不是普通文件：${entry.name}`);
      try {
        const note = parseKnowledgeCard(readFileSync(filename, 'utf8'), entry.name);
        if (results.has(note.id)) throw new Error('知识卡片 ID 重复。');
        results.set(note.id, { note, filename });
      } catch (error) { throw new Error(`知识卡片 ${filename} 读取失败：${error.message}`); }
    }
  };
  visit(folder, 0);
  return results;
}

export function knowledgeLayoutCurrent(directory) {
  const files = readKnowledgeCards(directory);
  return [...files.values()].every(({ note, filename }) => path.resolve(filename) === path.resolve(cardPathFor(directory, note)));
}

function pathForId(directory, id, topicHint = '') {
  if (!cardId(id)) throw new Error('知识卡片 ID 无效。');
  if (topicHint) {
    const hinted = path.join(cardsFor(directory), ...topicParts(topicHint), `${id}.md`);
    try { if (lstatSync(hinted).isFile()) return hinted; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return readKnowledgeCards(directory).get(id)?.filename || null;
}
function removeEmptyTopicFolders(directory, filename) {
  const root = path.resolve(cardsFor(directory));
  let folder = path.dirname(path.resolve(filename));
  while (folder !== root && folder.startsWith(root + path.sep)) {
    if (readdirSync(folder).length) break;
    rmdirSync(folder);
    folder = path.dirname(folder);
  }
}

export function readKnowledgeCard(directory, id, topicHint = '') {
  if (!cardId(id)) throw new Error('知识卡片 ID 无效。');
  requireDirectory(rootFor(directory)); requireDirectory(cardsFor(directory));
  const target = pathForId(directory, id, topicHint);
  if (!target) return null;
  try {
    if (!lstatSync(target).isFile()) throw new Error('知识卡片不是普通文件。');
    return parseKnowledgeCard(readFileSync(target, 'utf8'), `${id}.md`);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function knowledgeCardMarkdown(directory, id) {
  if (!cardId(id)) throw new Error('知识卡片 ID 无效。');
  requireDirectory(rootFor(directory)); requireDirectory(cardsFor(directory));
  const target = pathForId(directory, id);
  if (!target) throw new Error('知识卡片不存在。');
  if (!lstatSync(target).isFile()) throw new Error('知识卡片不是普通文件。');
  const source = readFileSync(target, 'utf8');
  parseKnowledgeCard(source, `${id}.md`);
  return source;
}

export function saveKnowledgeCard(directory, note, persistIndex, previousTopic = '') {
  const normalized = normalizeKnowledgeCard(note);
  requireDirectory(rootFor(directory)); requireDirectory(cardsFor(directory));
  const target = cardPathFor(directory, normalized);
  const oldTarget = pathForId(directory, normalized.id, previousTopic);
  let previous = null;
  if (oldTarget) previous = readFileSync(oldTarget, 'utf8');
  atomicWrite(target, serializeKnowledgeCard(normalized));
  try { persistIndex(normalized); }
  catch (error) {
    try { if (oldTarget !== target) unlinkSync(target); else if (previous === null) unlinkSync(target); else atomicWrite(target, previous); } catch {}
    throw error;
  }
  if (oldTarget && oldTarget !== target) { unlinkSync(oldTarget); removeEmptyTopicFolders(directory, oldTarget); }
  updateKnowledgeCatalog(directory, normalized);
  return normalized;
}

export function removeKnowledgeCards(directory, ids, generation, remainingCount) {
  if (!cardId(generation) || !Number.isInteger(remainingCount) || remainingCount < 0) throw new Error('知识卡片目录版本无效。');
  requireDirectory(rootFor(directory)); requireDirectory(cardsFor(directory));
  const files = readKnowledgeCards(directory);
  for (const id of ids) {
    if (!cardId(id)) throw new Error('知识卡片 ID 无效。');
    try { if (files.get(id)) { unlinkSync(files.get(id).filename); removeEmptyTopicFolders(directory, files.get(id).filename); } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  atomicWrite(markerFor(directory), JSON.stringify({ schema: 1, generation, count: remainingCount }, null, 2));
  updateKnowledgeCatalog(directory, null, ids);
}

export function replaceKnowledgeCards(directory, notes, generation) {
  if (!cardId(generation)) throw new Error('知识卡片目录版本无效。');
  const root = rootFor(directory), cards = cardsFor(directory);
  mkdirSync(root, { recursive: true });
  requireDirectory(root);
  const staging = path.join(root, `.cards-${randomUUID()}.staging`);
  const previous = path.join(root, `.cards-${randomUUID()}.previous`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const note of notes) {
      const normalized = normalizeKnowledgeCard(note);
      const bytes = serializeKnowledgeCard(normalized);
      if (JSON.stringify(parseKnowledgeCard(bytes, `${normalized.id}.md`)) !== JSON.stringify(normalized)) throw new Error('知识卡片写入回读校验失败。');
      const target = path.join(staging, ...topicParts(normalized.topic), `${normalized.id}.md`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    let hadCards = false;
    try { statSync(cards); requireDirectory(cards); hadCards = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (hadCards) renameSync(cards, previous);
    try { renameSync(staging, cards); }
    catch (error) { if (hadCards) renameSync(previous, cards); throw error; }
    try { atomicWrite(markerFor(directory), JSON.stringify({ schema: 1, generation, count: notes.length }, null, 2)); }
    catch (error) {
      const failed = path.join(root, `.cards-${randomUUID()}.failed`);
      renameSync(cards, failed);
      if (hadCards) renameSync(previous, cards);
      safeRemoveFolder(root, failed);
      throw error;
    }
    if (hadCards) safeRemoveFolder(root, previous);
    refreshKnowledgeCatalog(directory);
  } finally { safeRemoveFolder(root, staging); }
}
