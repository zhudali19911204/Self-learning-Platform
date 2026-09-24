import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveConfig } from '../llm.mjs';
import { validPlan, validLesson } from '../server.mjs';

export const defaults = { provider: 'ollama', model: '', baseUrl: '', jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192, localOnly: true };
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const string = (v, max = 20000) => typeof v === 'string' && v.length <= max;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const dict = (v, check) => object(v) && Object.entries(v).every(([key, value]) => id(key) && check(value));
export function validState(v) {
  if (!object(v) || v.version !== 1 || !Array.isArray(v.plans) || !v.plans.length || v.plans.length > 1000 || !id(v.active)) return false;
  if (!v.plans.every(p => validPlan(p) && id(p.id) && string(p.goal, 1000) && string(p.level, 80) && Number.isInteger(p.daily) && Number.isInteger(p.days) && ['ai', 'demo'].includes(p.source) && p.lessons.every(l => id(l.id)))) return false;
  const planIds = v.plans.map(p => p.id), lessonIds = v.plans.flatMap(p => p.lessons.map(l => l.id));
  if (new Set(planIds).size !== planIds.length || new Set(lessonIds).size !== lessonIds.length || !planIds.includes(v.active)) return false;
  if (!dict(v.lessons, validLesson) || !dict(v.reflections, s => string(s, 5000))) return false;
  if (!dict(v.progress, p => object(p) && typeof p.completed === 'boolean' && Number.isInteger(p.attempts) && p.attempts >= 0 && [p.lastScore, p.bestScore].every(n => Number.isInteger(n) && n >= 0 && n <= 100) && Array.isArray(p.lastAnswers) && p.lastAnswers.length <= 5 && p.lastAnswers.every(a => Number.isInteger(a) && a >= 0 && a < 4))) return false;
  if (!Array.isArray(v.notes) || !v.notes.every(n => object(n) && id(n.id) && id(n.lessonId) && lessonIds.includes(n.lessonId) && string(n.title, 160) && string(n.summary, 500) && string(n.content) && string(n.courseTitle, 160) && ['ai', 'demo'].includes(n.source) && Number.isFinite(n.updated) && Array.isArray(n.tags) && n.tags.length <= 6 && n.tags.every(t => string(t, 200)))) return false;
  return new Set(v.notes.map(n => n.id)).size === v.notes.length;
}
export function normalizeSettings(input, previous = defaults) {
  if (!object(input)) throw new Error('模型配置格式不正确。');
  const next = {};
  for (const key of ['provider', 'model', 'baseUrl', 'jsonMode']) {
    if (!string(input[key], key === 'baseUrl' ? 2000 : 200)) throw new Error('请完整填写模型配置。');
    next[key] = input[key].trim();
  }
  next.timeoutMs = input.timeoutMs;
  next.maxTokens = input.maxTokens;
  if (typeof input.localOnly !== 'boolean') throw new Error('请选择是否仅使用本机模型。');
  next.localOnly = input.localOnly;
  if (!['keep', 'replace', 'clear'].includes(input.keyAction)) throw new Error('密钥操作无效。');
  const sameTarget = next.provider === previous.provider && resolveConfig({ ...next, baseUrl: next.baseUrl || undefined }, {}).baseUrl === resolveConfig({ ...previous, baseUrl: previous.baseUrl || undefined }, {}).baseUrl;
  let apiKey = input.keyAction === 'keep' && sameTarget ? (previous.apiKey || '') : '';
  if (input.keyAction === 'replace') {
    if (!string(input.apiKey, 4096) || !input.apiKey.trim()) throw new Error('请输入新的 API Key。');
    apiKey = input.apiKey.trim();
  }
  const config = resolveConfig({ ...next, baseUrl: next.baseUrl || undefined, apiKey }, {});
  if (config.error) throw new Error(config.error);
  if (next.localOnly) {
    let hostname;
    try { hostname = new URL(config.baseUrl).hostname; } catch { throw new Error('本机模式需要有效的本地模型地址。'); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
      const error = new Error(`当前模型地址 ${hostname} 是远端地址，与“仅使用本机模型”冲突。允许远端连接后可保存；生成和问答时，相关课程或笔记会发送到该服务。`);
      error.code = 'LOCAL_ONLY_CONFLICT';
      throw error;
    }
  }
  return { ...next, apiKey };
}

export function createLocalStore(directory, secrets) {
  let queue = Promise.resolve();
  let settings = { ...defaults, apiKey: '' };
  let settingsError = '', stateError = '';
  const enqueue = task => { const operation = queue.then(task); queue = operation.catch(() => {}); return operation; };
  async function read(name) {
    try {
      const value = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (!object(value)) throw new Error('Invalid local data');
      return value;
    }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function atomic(name, value) {
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, name), temp = path.join(directory, `${name}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await copyFile(target, target + '.bak'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await rename(temp, target);
  }
  const safeSettings = () => ({ ...Object.fromEntries(Object.keys(defaults).map(key => [key, settings[key]])), hasApiKey: !!settings.apiKey, error: settingsError });
  return {
    async initialize() {
      try {
        const stored = await read('settings.json');
        if (stored) {
          if (stored.version !== 1) throw new Error();
          const apiKey = stored.encryptedApiKey ? await secrets.decrypt(stored.encryptedApiKey) : '';
          settings = normalizeSettings({ ...stored, apiKey, keyAction: apiKey ? 'replace' : 'clear' });
        }
      } catch { settingsError = '本地模型配置无法读取或密钥无法解密。原文件已保留，请检查 settings.json 及其 .bak 备份后重启应用。'; }
      return safeSettings();
    },
    getSettings: safeSettings,
    getModelConfig() {
      // Never fall back to shell environment or .env in the desktop app.
      return settingsError ? { env: {}, provider: 'invalid' } : { ...settings, baseUrl: settings.baseUrl || undefined, env: {} };
    },
    saveSettings(input) {
      return enqueue(async () => {
        if (settingsError) throw new Error(settingsError);
        const next = normalizeSettings(input, settings);
        const encryptedApiKey = next.apiKey ? await secrets.encrypt(next.apiKey) : '';
        const { apiKey, ...publicFields } = next;
        await atomic('settings.json', { version: 1, ...publicFields, encryptedApiKey });
        settings = next;
        return safeSettings();
      });
    },
    async loadState() {
      await queue;
      try { const value = await read('learning.json'); if (value && !validState(value)) throw new Error(); return value; }
      catch { stateError = '本地学习数据无法读取。原文件已保留，请检查 learning.json 及其 .bak 备份；本次会话不会覆盖旧文件。'; throw new Error(stateError); }
    },
    saveState(value) {
      if (!validState(value) || Buffer.byteLength(JSON.stringify(value), 'utf8') > 25 * 1024 * 1024) return Promise.reject(new Error('学习数据格式不正确或超过 25 MB。'));
      const snapshot = structuredClone(value);
      return enqueue(async () => { if (stateError) throw new Error(stateError); await atomic('learning.json', snapshot); });
    },
    flush: () => queue
  };
}
