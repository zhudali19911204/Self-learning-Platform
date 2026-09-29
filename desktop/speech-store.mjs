import { mkdir, readFile, writeFile, rename, copyFile, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { speechDefaults, validAudioId } from '../public/speech.js';
import { normalizeSpeechSettings, audioMime, MAX_AUDIO_BYTES } from '../speech-model.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function createSpeechStore(directory, secrets) {
  let settings = { ...speechDefaults, apiKey: '' }, error = '', cacheError = '', db, queue = Promise.resolve();
  const safe = () => ({ ...Object.fromEntries(Object.keys(speechDefaults).map(key => [key, settings[key]])), hasApiKey: !!settings.apiKey, error: error || cacheError });
  const requireCache = () => { if (cacheError || !db) throw new Error(cacheError || '语音缓存尚未初始化。'); };
  const enqueue = task => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
  const file = id => { if (!validAudioId(id)) throw new Error('音频标识无效。'); return path.join(directory, 'audio', id + '.wav'); };
  async function readAsset(id) {
    const target = file(id);
    if ((await stat(target)).size > MAX_AUDIO_BYTES) throw new Error('本地音频超过 20 MB。');
    const bytes = await readFile(target), mime = audioMime(bytes);
    if (hash(bytes) !== id) throw new Error('本地音频校验失败，请从目录备份恢复；不会自动重新计费合成。');
    return { bytes, mime };
  }
  return {
    async initialize() {
      await mkdir(directory, { recursive: true });
      try {
        const value = JSON.parse(await readFile(path.join(directory, 'speech-settings.json'), 'utf8'));
        if (value.version !== 1) throw new Error();
        const apiKey = value.encryptedApiKey ? await secrets.decrypt(value.encryptedApiKey) : '';
        settings = normalizeSpeechSettings({ ...value, apiKey, keyAction: apiKey ? 'replace' : 'clear' });
      } catch (e) { if (e.code !== 'ENOENT') error = '语音配置无法读取或解密，原文件已保留，请检查 speech-settings.json 及其备份。'; }
      try {
        db = new DatabaseSync(path.join(directory, 'speech-cache.sqlite'));
        db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS speech_cache (cache_key TEXT PRIMARY KEY, asset_id TEXT NOT NULL, created INTEGER NOT NULL);');
      } catch {
        try { db?.close(); } catch {} db = null;
        cacheError = '语音缓存无法读取，原文件已保留，请检查 speech-cache.sqlite 及其目录备份。课程仍可正常使用，不会自动重新计费合成。';
      }
      return safe();
    },
    getSettings: safe,
    getConfig: () => { if (error || cacheError) throw new Error(error || cacheError); return { ...settings }; },
    saveSettings: input => enqueue(async () => {
      if (error) throw new Error(error);
      const next = normalizeSpeechSettings(input, settings), { apiKey, ...fields } = next;
      const value = { version: 1, ...fields, encryptedApiKey: apiKey ? await secrets.encrypt(apiKey) : '' };
      const target = path.join(directory, 'speech-settings.json'), temp = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
        try { await copyFile(target, target + '.bak'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await rename(temp, target); settings = next; return safe();
      } finally { try { await unlink(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    }),
    async lookup(key) {
      requireCache();
      if (!validAudioId(key)) throw new Error('语音缓存标识无效。');
      const row = db.prepare('SELECT asset_id, created FROM speech_cache WHERE cache_key = ?').get(key);
      if (!row) return null;
      // Missing or damaged cached audio never silently turns into a paid request.
      await readAsset(row.asset_id); return { id: row.asset_id, created: row.created };
    },
    put: (key, bytes) => enqueue(async () => {
      requireCache();
      if (!validAudioId(key)) throw new Error('语音缓存标识无效。');
      audioMime(bytes); const id = hash(bytes), target = file(id);
      await mkdir(path.dirname(target), { recursive: true });
      let exists = false;
      try { await readAsset(id); exists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!exists) {
        const temp = target + '.' + randomUUID() + '.tmp';
        try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await rename(temp, target); }
        finally { try { await unlink(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      }
      db.prepare('INSERT INTO speech_cache(cache_key,asset_id,created) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET asset_id=excluded.asset_id,created=excluded.created').run(key, id, Date.now());
      return { id };
    }),
    readAsset,
    flush: () => queue,
    close: () => { db?.close(); db = null; }
  };
}
