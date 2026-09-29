import { randomUUID } from 'node:crypto';

// Signed provider URLs live only in the main process, never in course JSON,
// the renderer, logs or backups. Restarting the app clears this bounded cache.
export function createPendingImageDownloads({ now = Date.now, ttlMs = 30 * 60 * 1000, max = 20 } = {}) {
  if (!Number.isInteger(max) || max < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('待下载缓存参数无效。');
  const records = new Map();
  function prune() { for (const [key, record] of records) if (record.expiresAt <= now()) records.delete(key); }
  return {
    put(key, value) {
      prune(); records.delete(key);
      while (records.size >= max) records.delete(records.keys().next().value);
      const record = { ...value, id: randomUUID(), expiresAt: now() + ttlMs };
      records.set(key, record); return record;
    },
    get(key, id) { prune(); const record = records.get(key); return record && (!id || record.id === id) ? record : null; },
    drop(key, id) { const record = records.get(key); if (record && (!id || record.id === id)) records.delete(key); },
    dropLessons(lessonIds) { const ids = new Set(lessonIds); for (const key of records.keys()) if (ids.has(key.split('/')[0])) records.delete(key); },
    public(record) {
      return { pendingDownload: { id: record.id, host: record.host || new URL(record.url).hostname, expiresAt: record.expiresAt }, prompt: record.prompt, caption: record.caption, error: record.error };
    }
  };
}
