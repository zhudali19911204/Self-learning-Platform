import { mkdir, readFile, writeFile, rename, copyFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { imageDefaults, normalizeImageSettings, imageMime, MAX_IMAGE_BYTES } from '../image-model.mjs';
import { validImageId, referencedImages } from '../public/illustrations.js';
import { createModelProfiles } from './model-profiles.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function createImageStore(directory, secrets, validateBytes = () => {}) {
  let settings = { ...imageDefaults, apiKey: '' }, settingsError = '', queue = Promise.resolve();
  const profiles = createModelProfiles({ defaults: imageDefaults, selector: 'protocol', allowed: ['compatible', 'dashscope'], normalize: normalizeImageSettings, secrets });
  const enqueue = task => { const operation = queue.then(task); queue = operation.catch(() => {}); return operation; };
  const assetPath = id => { if (!validImageId(id)) throw new Error('图片标识无效。'); return path.join(directory, 'images', `${id}.img`); };
  const safe = () => ({ ...Object.fromEntries(Object.keys(imageDefaults).map(key => [key, settings[key]])), hasApiKey: !!settings.apiKey, profiles: profiles.safe(), error: settingsError });
  function validate(bytes) { imageMime(bytes); validateBytes(bytes); }
  async function readAsset(id) {
    const target = assetPath(id);
    if ((await stat(target)).size > MAX_IMAGE_BYTES) throw new Error('本地图片超过大小限制。');
    const bytes = await readFile(target); validate(bytes);
    if (digest(bytes) !== id) throw new Error('本地图片校验失败，请从完整备份恢复。');
    return { bytes, mime: imageMime(bytes) };
  }
  async function put(bytes) {
    validate(bytes); const id = digest(bytes), target = assetPath(id);
    await mkdir(path.dirname(target), { recursive: true });
    try { await readAsset(id); return id; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } finally { try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return id;
  }
  return {
    async initialize() {
      settings = await profiles.load(null);
      try {
        const value = JSON.parse(await readFile(path.join(directory, 'image-settings.json'), 'utf8'));
        if (value.version !== 1) throw new Error();
        settings = await profiles.load(value);
      } catch (error) { if (error.code !== 'ENOENT') settingsError = '图片配置无法读取或解密，原文件已保留。请检查 image-settings.json 及其 .bak 后重启。'; }
      return safe();
    },
    getSettings: safe,
    getConfig: () => settingsError ? { ...imageDefaults } : { ...settings },
    saveSettings: input => enqueue(async () => {
      if (settingsError) throw new Error(settingsError);
      const change = await profiles.prepare(input, settings);
      const value = { version: 1, ...change.value };
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, 'image-settings.json'), temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
      try { await copyFile(target, target + '.bak'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(temp, target); settings = change.next; change.commit(); return safe();
    }),
    put, readAsset,
    deleteAssets: ids => enqueue(async () => {
      for (const id of ids) {
        const target = assetPath(id);
        try { await unlink(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }),
    async withAssets(state) {
      const imageAssets = []; let total = Buffer.byteLength(JSON.stringify(state));
      if (total > 250 * 1024 * 1024) throw new Error('学习数据超过 JSON 备份大小限制，请在应用关闭后备份整个本地数据目录。');
      for (const id of referencedImages(state)) {
        const { bytes } = await readAsset(id), data = bytes.toString('base64');
        total += data.length + 128;
        if (total > 250 * 1024 * 1024) throw new Error('完整 JSON 备份超过 250 MB，请保留整个本地数据目录，勿仅复制数据库。');
        imageAssets.push({ id, data });
      }
      return imageAssets.length ? { ...state, imageAssets } : state;
    },
    async prepareImport(state) {
      const entries = state.imageAssets ?? [];
      if (!Array.isArray(entries) || entries.length > 5000) throw new Error('备份图片数据格式无效。');
      const assets = new Map();
      for (const entry of entries) {
        if (!validImageId(entry?.id) || typeof entry.data !== 'string' || entry.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(entry.data) || assets.has(entry.id)) throw new Error('备份图片数据无效或重复。');
        const bytes = Buffer.from(entry.data, 'base64'); validate(bytes);
        if (digest(bytes) !== entry.id) throw new Error('备份图片校验失败，未替换学习数据。');
        assets.set(entry.id, bytes);
      }
      const ids = referencedImages(state);
      for (const id of ids) if (!assets.has(id)) {
        try { await readAsset(id); } catch { throw new Error('备份缺少课程配图，请导入包含图片的完整备份，或先恢复 images 目录。'); }
      }
      // Validate everything first. Immutable assets can safely be staged before
      // SQLite replacement; an interrupted import leaves only unused files.
      return async () => { for (const id of ids) if (assets.has(id)) await put(assets.get(id)); };
    },
    flush: () => queue
  };
}
