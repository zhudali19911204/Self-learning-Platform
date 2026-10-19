import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function createFactCheckSettings(directory) {
  let enabled = false, error = '';
  const filename = path.join(directory, 'fact-check-settings.json');
  return {
    get: () => ({ enabled, error }),
    async initialize() {
      try {
        const value = JSON.parse(await readFile(filename, 'utf8'));
        if (value.version !== 1 || typeof value.enabled !== 'boolean') throw new Error();
        enabled = value.enabled;
      } catch (e) { if (e.code !== 'ENOENT') error = '自动事实核查设置无法读取，原文件已保留。'; }
      return this.get();
    },
    async save(value) {
      if (error) throw new Error(error);
      if (typeof value !== 'boolean') throw new Error('自动事实核查开关无效。');
      await mkdir(directory, { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, enabled: value }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename); enabled = value; return this.get();
    }
  };
}
