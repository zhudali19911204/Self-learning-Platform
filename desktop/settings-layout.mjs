import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const panelIds = ['generator', 'reviewer', 'images', 'speech'];
const validPanels = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === panelIds.length && panelIds.every(id => Object.hasOwn(value, id) && typeof value[id] === 'boolean');

// Only layout booleans live here. Model parameters, drafts and keys never enter it.
export function createSettingsLayoutStore(directory) {
  const filename = path.join(directory, 'settings-layout.json');
  let panels = null, queue = Promise.resolve();
  return {
    async initialize() {
      try {
        const saved = JSON.parse(await readFile(filename, 'utf8'));
        if (saved.version === 1 && validPanels(saved.panels)) panels = { ...saved.panels };
      } catch { /* An unavailable layout preference must not block the application. */ }
    },
    get() { return panels && { ...panels }; },
    save(value) {
      if (!validPanels(value)) return Promise.reject(new Error('设置布局偏好格式不正确。'));
      const next = Object.fromEntries(panelIds.map(id => [id, value[id]]));
      const operation = queue.then(async () => {
        await writeFile(filename + '.tmp', JSON.stringify({ version: 1, panels: next }), 'utf8');
        await rename(filename + '.tmp', filename);
        panels = next;
        return { ...panels };
      });
      queue = operation.catch(() => {});
      return operation;
    },
    flush() { return queue; }
  };
}
