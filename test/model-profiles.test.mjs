import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalStore, defaults } from '../desktop/local-store.mjs';
import { createImageStore } from '../desktop/image-store.mjs';
import { imageDefaults } from '../image-model.mjs';

const secrets = { encrypt: async key => Buffer.from(key).toString('base64'), decrypt: async encrypted => Buffer.from(encrypted, 'base64').toString() };
const qwen = { ...defaults, provider: 'qwen', model: 'qwen-test', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', localOnly: false, jsonMode: 'off', timeoutMs: 90000, maxTokens: 4096 };
const deepseek = { ...defaults, provider: 'deepseek', model: 'deepseek-test', baseUrl: 'https://api.deepseek.com', localOnly: false };
const native = { ...imageDefaults, protocol: 'dashscope', enabled: true, model: 'wan2.7-image-pro', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', localOnly: false, size: '2K', timeoutMs: 240000, downloadHosts: 'cdn.example.org' };
const compatible = { ...imageDefaults, enabled: true, model: 'local-image', baseUrl: 'http://localhost:8001/v1', size: '768x768', responseFormat: 'b64_json' };
async function directory(t) {
  const target = await mkdtemp(path.join(tmpdir(), 'learnflow-profiles-'));
  assert.ok(path.resolve(target).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(target, { recursive: true, force: true })); return target;
}

test('LLM services retain independent parameters and encrypted keys across saves and reopening', async t => {
  const target = await directory(t), store = createLocalStore(target, secrets); await store.initialize();
  await store.saveSettings({ ...qwen, keyAction: 'replace', apiKey: 'qwen-private-key' });
  await store.saveSettings({ ...deepseek, keyAction: 'replace', apiKey: 'deepseek-private-key' });
  await store.saveSettings({ ...defaults, model: 'local-qwen', keyAction: 'keep' });
  assert.equal(store.getModelConfig().apiKey, '');
  const reopened = createLocalStore(target, secrets); await reopened.initialize();
  const safe = reopened.getSettings();
  assert.equal(safe.profiles.qwen.timeoutMs, 90000); assert.equal(safe.profiles.qwen.maxTokens, 4096);
  assert.equal(safe.profiles.deepseek.model, 'deepseek-test');
  assert.equal(safe.profiles.qwen.hasApiKey, true);
  assert.ok(!JSON.stringify(safe).includes('private-key')); assert.ok(!JSON.stringify(safe).includes('encryptedApiKey'));
  await reopened.saveSettings({ ...safe.profiles.qwen, keyAction: 'keep', apiKey: '' });
  assert.equal(reopened.getModelConfig().apiKey, 'qwen-private-key');
  await reopened.saveSettings({ ...safe.profiles.deepseek, keyAction: 'keep', apiKey: '' });
  assert.equal(reopened.getModelConfig().apiKey, 'deepseek-private-key');
  const disk = await readFile(path.join(target, 'settings.json'), 'utf8');
  assert.ok(!disk.includes('qwen-private-key')); assert.ok(!disk.includes('deepseek-private-key'));
  assert.ok(JSON.parse(disk).profiles.qwen.encryptedApiKey);
});

test('profile keys stay bound to their endpoint and clearing one profile preserves other services', async t => {
  const target = await directory(t), store = createLocalStore(target, secrets); await store.initialize();
  await store.saveSettings({ ...qwen, keyAction: 'replace', apiKey: 'qwen-key' });
  await store.saveSettings({ ...deepseek, keyAction: 'replace', apiKey: 'deepseek-key' });
  await assert.rejects(store.saveSettings({ ...qwen, baseUrl: 'https://other.example.org/v1', keyAction: 'keep' }), /API_KEY/);
  assert.equal(store.getModelConfig().provider, 'deepseek');
  await store.saveSettings({ ...qwen, model: '', keyAction: 'clear' });
  assert.equal(store.getSettings().profiles.qwen.hasApiKey, false);
  assert.equal(store.getSettings().profiles.deepseek.hasApiKey, true);
  await store.saveSettings({ ...deepseek, keyAction: 'keep' });
  assert.equal(store.getModelConfig().apiKey, 'deepseek-key');
});

test('legacy settings become profiles without rewriting their bytes and survive switching to a new service', async t => {
  const target = await directory(t);
  const legacy = JSON.stringify({ version: 1, ...qwen, encryptedApiKey: await secrets.encrypt('legacy-key') }, null, 2);
  await writeFile(path.join(target, 'settings.json'), legacy);
  const store = createLocalStore(target, secrets); await store.initialize();
  assert.equal(store.getSettings().profiles.qwen.hasApiKey, true);
  assert.equal(await readFile(path.join(target, 'settings.json'), 'utf8'), legacy);
  await store.saveSettings({ ...defaults, model: 'local', keyAction: 'clear' });
  assert.equal(await readFile(path.join(target, 'settings.json.bak'), 'utf8'), legacy);
  const reopened = createLocalStore(target, secrets); await reopened.initialize();
  await reopened.saveSettings({ ...reopened.getSettings().profiles.qwen, keyAction: 'keep' });
  assert.equal(reopened.getModelConfig().apiKey, 'legacy-key');
});

test('image protocols independently retain keys, size, format, timeout and download domains', async t => {
  const target = await directory(t), store = createImageStore(target, secrets); await store.initialize();
  await store.saveSettings({ ...native, keyAction: 'replace', apiKey: 'native-private-key' });
  await store.saveSettings({ ...compatible, keyAction: 'replace', apiKey: 'local-private-key' });
  const reopened = createImageStore(target, secrets); await reopened.initialize();
  const safe = reopened.getSettings();
  assert.equal(safe.profiles.dashscope.size, '2K'); assert.equal(safe.profiles.dashscope.downloadHosts, 'cdn.example.org');
  assert.equal(safe.profiles.compatible.responseFormat, 'b64_json');
  await reopened.saveSettings({ ...safe.profiles.dashscope, keyAction: 'keep' });
  assert.equal(reopened.getConfig().apiKey, 'native-private-key');
  await assert.rejects(reopened.saveSettings({ ...safe.profiles.dashscope, baseUrl: 'https://other.example.org/api/v1', keyAction: 'keep' }), /API Key/);
  await reopened.saveSettings({ ...safe.profiles.compatible, keyAction: 'keep' });
  assert.equal(reopened.getConfig().apiKey, 'local-private-key');
  const disk = await readFile(path.join(target, 'image-settings.json'), 'utf8');
  assert.ok(!disk.includes('private-key')); assert.ok(!JSON.stringify(safe).includes('encryptedApiKey'));
});

test('failed encryption and corrupt profile collections preserve saved files and active settings', async t => {
  const target = await directory(t), store = createLocalStore(target, secrets); await store.initialize();
  await store.saveSettings({ ...qwen, keyAction: 'replace', apiKey: 'first-key' });
  const before = await readFile(path.join(target, 'settings.json'), 'utf8');
  const failing = createLocalStore(target, { ...secrets, encrypt: async () => { throw new Error('encryption unavailable'); } }); await failing.initialize();
  await assert.rejects(failing.saveSettings({ ...deepseek, keyAction: 'replace', apiKey: 'second-key' }));
  assert.equal(await readFile(path.join(target, 'settings.json'), 'utf8'), before);
  assert.equal(failing.getSettings().profiles.deepseek, undefined); assert.equal(failing.getModelConfig().provider, 'qwen');
  const value = JSON.parse(before); value.profiles.qwen.provider = 'deepseek';
  const corrupt = JSON.stringify(value); await writeFile(path.join(target, 'settings.json'), corrupt);
  const blocked = createLocalStore(target, secrets); assert.match((await blocked.initialize()).error, /原文件已保留/);
  await assert.rejects(blocked.saveSettings({ ...defaults, keyAction: 'clear' }));
  assert.equal(await readFile(path.join(target, 'settings.json'), 'utf8'), corrupt);
});
