import { mkdir, readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Store search consent only; reuse the existing LLM account in the main process.
export function createWebSearchStore(directory) {
  let enabled = false, error = '', queue = Promise.resolve();
  const target = path.join(directory, 'web-search-settings.json');
  const safe = () => ({ enabled, error });
  return {
    async initialize() {
      try {
        const value = JSON.parse(await readFile(target, 'utf8'));
        if (value.version !== 1 || typeof value.enabled !== 'boolean') throw new Error();
        enabled = value.enabled;
      } catch (caught) { if (caught.code !== 'ENOENT') error = '网页搜图配置无法读取，原文件已保留。'; }
      return safe();
    },
    getSettings: safe,
    getConfig: () => ({ enabled: !error && enabled }),
    saveSettings(input) {
      const operation = queue.then(async () => {
        if (error) throw new Error(error);
        if (!input || typeof input.enabled !== 'boolean') throw new Error('网页搜图配置无效。');
        const value = { version: 1, enabled: input.enabled };
        await mkdir(directory, { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
        try { await copyFile(target, target + '.bak'); } catch (caught) { if (caught.code !== 'ENOENT') throw caught; }
        await rename(temporary, target); enabled = input.enabled; return safe();
      });
      queue = operation.catch(() => {}); return operation;
    },
    flush: () => queue
  };
}
