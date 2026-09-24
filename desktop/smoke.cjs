// Native Electron integration test. Invoked only by --smoke-test in an isolated profile.
const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
exports.run = async (window, store, directory) => {
  const evaluate = code => window.webContents.executeJavaScript(code).catch(error => { console.error('SMOKE_FAILED_STEP', code.slice(0, 220)); throw error; });
  const wait = expression => evaluate(`new Promise((resolve, reject) => { let attempts = 0; const timer = setInterval(() => { try { if (${expression}) { clearInterval(timer); resolve(true); } else if (++attempts > 150) { clearInterval(timer); reject(new Error('Desktop check timed out')); } } catch (error) { clearInterval(timer); reject(error); } }, 100); })`);
  await wait("document.querySelector('main h1')");
  assert.deepEqual(await evaluate("({ bridge: typeof window.learnflowDesktop?.saveSettings, node: typeof window.require })"), { bridge: 'function', node: 'undefined' });
  // Exercise settings through the real form and IPC bridge.
  await evaluate("document.querySelector('[data-page=settings]').click()");
  await wait("document.querySelector('#desktop-settings-form')");
  await evaluate("document.querySelector('#model-name').value = 'desktop-smoke-model'; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#connection-result')?.textContent.includes('配置已保存并生效')");
  const saved = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.equal(saved.model, 'desktop-smoke-model'); assert.equal(saved.localOnly, true);
  // Save a test-only local key, assert OS encryption, then clear it.
  await evaluate("document.querySelector('#key-action').value = 'replace'; document.querySelector('#model-key').value = 'smoke-only-not-a-real-key'; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#key-action')?.options[0].textContent.includes('保留') && document.querySelector('#model-key')?.value === ''");
  const encrypted = await readFile(path.join(directory, 'settings.json'), 'utf8');
  assert.ok(!encrypted.includes('smoke-only-not-a-real-key'));
  assert.ok(JSON.parse(encrypted).encryptedApiKey.length > 0);
  await evaluate("document.querySelector('#key-action').value = 'clear'; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#key-action')?.options[0].textContent.includes('不填写')");
  // Reproduce the reported conflict using a cloud preset, without making cloud requests.
  await evaluate("document.querySelector('#model-provider').value = 'deepseek'; document.querySelector('#model-provider').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#model-name').value = 'smoke-cloud-model'; document.querySelector('#model-key').value = 'smoke-cloud-key-not-real'; document.querySelector('#model-key').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#remote-permission')?.hidden === false");
  assert.match(await evaluate("document.querySelector('#settings-error').textContent"), /仅使用本机模型/);
  assert.equal(store.getSettings().provider, 'ollama', 'rejected draft must not change saved configuration');
  assert.equal(await evaluate("document.querySelector('[data-action=test-connection]').disabled"), true);
  await evaluate("document.querySelector('[data-action=allow-remote-save]').click()");
  await wait("document.querySelector('#connection-result')?.textContent.includes('配置已保存并生效')");
  assert.equal(store.getSettings().provider, 'deepseek');
  assert.equal(store.getSettings().localOnly, false);
  assert.equal(store.getSettings().hasApiKey, true);
  window.webContents.reload();
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('main h1')");
  const cloud = await evaluate('window.learnflowDesktop.load()');
  assert.equal(cloud.settings.provider, 'deepseek');
  assert.equal(cloud.settings.localOnly, false);
  assert.equal(cloud.settings.hasApiKey, true);
  await evaluate("document.querySelector('[data-page=settings]').click()");
  // Cover the same issue for self-hosted services on another LAN machine.
  await evaluate("document.querySelector('#model-provider').value = 'vllm'; document.querySelector('#model-provider').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#model-name').value = 'smoke-lan-model'; document.querySelector('#model-url').value = 'http://192.168.1.2:8000/v1'; document.querySelector('[name=localOnly]').checked = true; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#remote-permission')?.hidden === false");
  assert.equal(store.getSettings().provider, 'deepseek');
  await evaluate("document.querySelector('[data-action=allow-remote-save]').click()");
  await wait("document.querySelector('#connection-result')?.textContent.includes('配置已保存并生效')");
  assert.equal(store.getSettings().provider, 'vllm');
  assert.equal(store.getSettings().hasApiKey, false);
  // Return the isolated test profile to a local-only model for the learning checks.
  await evaluate("document.querySelector('#model-provider').value = 'ollama'; document.querySelector('#model-provider').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#model-name').value = 'desktop-smoke-model'; document.querySelector('[name=localOnly]').checked = true; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#connection-result')?.textContent.includes('配置已保存并生效')");
  // Complete a sample lesson, generate a Wiki card, and persist it on disk.
  await evaluate("document.querySelector('[data-page=routes]').click(); document.querySelector('[data-action=open-lesson][data-id=p1]').click(); document.querySelector('[data-tab=quiz]').click(); document.querySelector('[name=q0][value=\"1\"]').checked = true; document.querySelector('[name=q1][value=\"1\"]').checked = true; document.querySelector('#quiz-form').requestSubmit()");
  await wait("document.querySelector('.quiz-result.passed')");
  await evaluate("document.querySelector('[data-action=notes-tab]').click(); document.querySelector('#reflection').value = '桌面集成测试心得'; document.querySelector('#reflection').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('[data-action=create-note]').click()");
  await wait("document.querySelector('#note-form')");
  await store.flush();
  const state = await store.loadState();
  assert.equal(state.progress.p1.completed, true);
  assert.equal(state.reflections.p1, '桌面集成测试心得');
  assert.ok(state.notes.some(note => note.lessonId === 'p1'));
  // Reload the entire renderer, mimicking a new launch while preserving disk data.
  window.webContents.reload();
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('main h1')");
  const loaded = await evaluate('window.learnflowDesktop.load()');
  assert.equal(loaded.state.progress.p1.completed, true);
  assert.equal(loaded.settings.model, 'desktop-smoke-model');
  assert.equal(loaded.settings.apiKey, undefined);
  await evaluate("document.querySelector('[data-page=settings]').click()");
  await wait("document.querySelector('#desktop-settings-form')");
  const image = await window.webContents.capturePage();
  await writeFile(path.join(directory, '..', 'settings-smoke.png'), image.toPNG());
  console.log('DESKTOP_SMOKE', JSON.stringify({ passed: true, checks: ['window', 'sandbox', 'settings-save', 'os-encryption', 'cloud-save-confirmation', 'cloud-settings-reload', 'lan-save-confirmation', 'quiz', 'wiki', 'disk-persistence', 'reload'], screenshot: path.join(directory, '..', 'settings-smoke.png') }));
};
