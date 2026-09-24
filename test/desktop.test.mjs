import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalStore, normalizeSettings, validState, defaults } from '../desktop/local-store.mjs';
import { demoPlan, demoLessons } from '../public/demo.js';

const fakeSecrets = { encrypt: async value => 'encrypted:' + Buffer.from(value).toString('base64'), decrypt: async value => Buffer.from(value.slice(10), 'base64').toString() };
const initial = () => ({ version: 1, plans: [structuredClone(demoPlan)], active: demoPlan.id, lessons: {}, progress: {}, notes: [], reflections: {} });
async function setup(t, secrets = fakeSecrets) {
  const directory = await mkdtemp(path.join(tmpdir(), 'learnflow-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createLocalStore(directory, secrets);
  await store.initialize();
  return { store, directory };
}
test('desktop defaults are local-only and independent of shell environment', async t => {
  const { store } = await setup(t);
  assert.equal(store.getSettings().localOnly, true);
  assert.equal(store.getSettings().hasApiKey, false);
  assert.deepEqual(store.getModelConfig().env, {});
  assert.equal(await store.loadState(), null);
  const saved = await store.saveSettings({ ...defaults, model: 'installed-model', keyAction: 'clear' });
  assert.equal(saved.model, 'installed-model');
  assert.equal(store.getModelConfig().baseUrl, undefined, 'empty field must select preset');
});
test('local-only settings block cloud and LAN endpoints; opt-out allows configured remote service', () => {
  for (const url of ['https://api.deepseek.com', 'http://192.168.1.2:11434', 'https://example.test']) {
    assert.throws(() => normalizeSettings({ ...defaults, model: 'test', baseUrl: url, keyAction: 'clear' }), error => error.code === 'LOCAL_ONLY_CONFLICT' && error.message.includes('仅使用本机模型'));
  }
  for (const url of ['http://127.0.0.1:11434', 'http://localhost:1234/v1', 'http://[::1]:8000/v1']) {
    assert.equal(normalizeSettings({ ...defaults, model: 'test', baseUrl: url, keyAction: 'clear' }).baseUrl, url);
  }
  assert.equal(normalizeSettings({ ...defaults, localOnly: false, provider: 'deepseek', model: 'test', keyAction: 'replace', apiKey: 'secret' }).apiKey, 'secret');
});
test('settings persist encrypted keys, never expose them, and do not forward keys to new endpoints', async t => {
  const { store, directory } = await setup(t);
  const cloud = { ...defaults, localOnly: false, provider: 'deepseek', model: 'cloud-model', keyAction: 'replace', apiKey: 'private-credential' };
  const result = await store.saveSettings(cloud);
  assert.equal(result.hasApiKey, true);
  assert.equal(result.apiKey, undefined);
  const bytes = await readFile(path.join(directory, 'settings.json'), 'utf8');
  assert.ok(!bytes.includes('private-credential'));
  const second = createLocalStore(directory, fakeSecrets); await second.initialize();
  assert.equal(second.getModelConfig().apiKey, 'private-credential');
  await second.saveSettings({ ...cloud, model: 'new-model', keyAction: 'keep', apiKey: '' });
  assert.equal(second.getModelConfig().apiKey, 'private-credential');
  await assert.rejects(second.saveSettings({ ...cloud, baseUrl: 'https://different.example', keyAction: 'keep', apiKey: '' }), /API_KEY/);
  assert.equal(second.getModelConfig().model, 'new-model');
  await second.saveSettings({ ...defaults, model: 'local', keyAction: 'keep' });
  assert.equal(second.getSettings().hasApiKey, false);
  assert.equal(second.getModelConfig().apiKey, '');
});
test('unavailable encryption does not write a plaintext key or apply partial configuration', async t => {
  const { store, directory } = await setup(t, { ...fakeSecrets, encrypt: async () => { throw new Error('系统加密不可用'); } });
  await assert.rejects(store.saveSettings({ ...defaults, model: 'local', keyAction: 'replace', apiKey: 'secret' }), /加密/);
  assert.equal(store.getSettings().model, '');
  await assert.rejects(readFile(path.join(directory, 'settings.json')), { code: 'ENOENT' });
});
test('learning snapshots are serialized, survive restart and retain previous backup', async t => {
  const { store, directory } = await setup(t);
  const first = initial();
  await store.saveState(first);
  const second = initial(); second.reflections.p1 = '我的第一份笔记'; second.lessons.p1 = demoLessons.p1;
  const third = structuredClone(second); third.reflections.p1 = '我的第二份笔记';
  await Promise.all([store.saveState(second), store.saveState(third)]);
  assert.equal((await store.loadState()).reflections.p1, '我的第二份笔记');
  const backup = JSON.parse(await readFile(path.join(directory, 'learning.json.bak'), 'utf8'));
  assert.equal(backup.reflections.p1, '我的第一份笔记');
  const reopened = createLocalStore(directory, fakeSecrets); await reopened.initialize();
  assert.equal((await reopened.loadState()).reflections.p1, '我的第二份笔记');
});
test('corrupt learning or settings files are preserved and never silently overwritten', async t => {
  const { directory } = await setup(t);
  await writeFile(path.join(directory, 'learning.json'), '{broken');
  await writeFile(path.join(directory, 'settings.json'), '{broken');
  const store = createLocalStore(directory, fakeSecrets);
  const settings = await store.initialize(); assert.match(settings.error, /原文件已保留/);
  await assert.rejects(store.loadState(), /不会覆盖/);
  await assert.rejects(store.saveState(initial()), /不会覆盖/);
  await assert.rejects(store.saveSettings({ ...defaults, keyAction: 'clear' }), /原文件已保留/);
  assert.equal(await readFile(path.join(directory, 'learning.json'), 'utf8'), '{broken');
  assert.equal(await readFile(path.join(directory, 'settings.json'), 'utf8'), '{broken');
});
test('backup validation rejects unsafe IDs, incomplete records and duplicate relationships', () => {
  assert.ok(validState(initial()));
  const unsafe = initial(); unsafe.plans[0].id = '" onclick="alert(1)'; assert.equal(validState(unsafe), false);
  const bad = initial(); bad.progress.p1 = { completed: true }; assert.equal(validState(bad), false);
  const duplicated = initial(); duplicated.plans.push(structuredClone(demoPlan)); assert.equal(validState(duplicated), false);
  const polluted = initial(); polluted.reflections = JSON.parse('{"__proto__":"bad"}'); assert.equal(validState(polluted), false);
  const note = initial(); note.notes = [{ id: 'n', lessonId: 'missing' }]; assert.equal(validState(note), false);
});
