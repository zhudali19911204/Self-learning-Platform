import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { MATERIAL_PLANNING_CACHE_ENTRIES } from '../src/courses/course-material-planning.mjs';

const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
const cacheError = cause => Object.assign(new Error('资料索引缓存无法读写，未自动重新调用模型。请检查 material-planning-cache.sqlite、目录权限和磁盘空间；如缓存损坏，请关闭应用后移走该缓存文件再重试。', { cause }), { status: 503 });

export function createMaterialPlanningCache(directory) {
  let db;
  function database() {
    if (!db) {
      const opened = new DatabaseSync(path.join(directory, 'material-planning-cache.sqlite'));
      try {
        opened.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS material_indexes (cache_key TEXT PRIMARY KEY, index_json TEXT NOT NULL, touched INTEGER NOT NULL);');
        db = opened;
      } catch (error) { opened.close(); throw error; }
    }
    return db;
  }
  return {
    get(key) {
      try {
        if (!validKey(key)) throw new Error('Invalid material cache key');
        const db = database(), row = db.prepare('SELECT index_json FROM material_indexes WHERE cache_key=?').get(key);
        if (!row) return null;
        const value = JSON.parse(row.index_json);
        db.prepare('UPDATE material_indexes SET touched=? WHERE cache_key=?').run(Date.now(), key);
        return value;
      } catch (error) { throw cacheError(error); }
    },
    set(key, value) {
      try {
        if (!validKey(key)) throw new Error('Invalid material cache key');
        const json = JSON.stringify(value);
        if (!json || json.length > 16000) throw new Error('Material cache entry exceeds limit');
        const db = database();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT INTO material_indexes VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET index_json=excluded.index_json,touched=excluded.touched').run(key, json, Date.now());
          db.prepare('DELETE FROM material_indexes WHERE cache_key IN (SELECT cache_key FROM material_indexes ORDER BY touched DESC,rowid DESC LIMIT -1 OFFSET ?)').run(MATERIAL_PLANNING_CACHE_ENTRIES);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } catch (error) { throw cacheError(error); }
    },
    close() { db?.close(); db = undefined; }
  };
}
