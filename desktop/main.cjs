const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const { readFile, writeFile, mkdir } = require('node:fs/promises');

app.setName('Learnflow');
const smoke = process.argv.includes('--smoke-test');
const development = process.argv.includes('--dev-profile');
if (smoke) app.setPath('userData', path.resolve('.desktop-test'));
else if (development) app.setPath('userData', path.resolve('.desktop-dev'));
let window, server, store, learning, base, shuttingDown = false;
const token = randomBytes(32).toString('hex');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(start).catch(error => { console.error('Desktop startup failed:', error.message); if (!smoke) dialog.showErrorBox('知行启动失败', error.message); app.exit(1); });
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== base + '/') return { ok: false, error: '不允许的应用请求。' };
    try { return { ok: true, value: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.code ? '本地文件操作失败，请检查目录权限和磁盘空间。' : error.message }; }
  });
}
async function start() {
  const { createApp } = await import(pathToFileURL(path.join(__dirname, '..', 'server.mjs')));
  const { createLLM } = await import(pathToFileURL(path.join(__dirname, '..', 'llm.mjs')));
  const { createLocalStore, validState } = await import(pathToFileURL(path.join(__dirname, 'local-store.mjs')));
  const { createSqliteStore } = await import(pathToFileURL(path.join(__dirname, 'sqlite-store.mjs')));
  const dataDirectory = path.join(app.getPath('userData'), 'data');
  await mkdir(dataDirectory, { recursive: true });
  const available = () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  store = createLocalStore(dataDirectory, {
    encrypt: async value => { if (!available()) throw new Error('系统安全存储不可用，无法保存密钥。可使用不需要密钥的本地模型。'); return safeStorage.encryptString(value).toString('base64'); },
    decrypt: async value => { if (!available()) throw new Error('系统安全存储不可用。'); return safeStorage.decryptString(Buffer.from(value, 'base64')); }
  });
  await store.initialize();
  learning = await createSqliteStore(dataDirectory);
  // A separate in-memory session keeps model traffic outside the renderer's
  // localhost-only webRequest policy and uses Chromium's OS trust/proxy setup.
  const modelSession = session.fromPartition('learnflow-model-network');
  modelSession.setPermissionRequestHandler((_, __, callback) => callback(false));
  modelSession.setPermissionCheckHandler(() => false);
  const modelFetch = (url, options) => modelSession.fetch(url, { ...options, credentials: 'omit' });
  let llm = createLLM({ ...store.getModelConfig(), fetchImpl: modelFetch });
  if (process.argv.includes('--verify-model')) {
    try {
      const result = await llm.testConnection();
      console.log('MODEL_CONNECTION_CHECK', JSON.stringify(result));
    } catch (error) {
      console.log('MODEL_CONNECTION_CHECK', JSON.stringify({ ok: false, status: error.status || 502, message: error.message }));
    }
    app.quit();
    return;
  }
  server = createApp({ getLLM: () => llm, apiToken: token });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  handle('learnflow:load', async () => {
    let state = null, stateError = '';
    try { state = learning.overview(); } catch (error) { stateError = error.message; }
    return { settings: store.getSettings(), state, stateError, status: llm.status(), dataDirectory, startPage: process.argv.includes('--settings') ? 'settings' : 'home' };
  });
  handle('learnflow:get-lesson', id => learning.getLesson(id));
  handle('learnflow:save-plan', value => learning.savePlan(value));
  handle('learnflow:set-active-plan', id => learning.setActivePlan(id));
  handle('learnflow:save-lesson', (id, value) => learning.saveLesson(id, value));
  handle('learnflow:save-progress', (id, value) => learning.saveProgress(id, value));
  handle('learnflow:save-reflection', (id, value) => learning.saveReflection(id, value));
  handle('learnflow:append-chat', (id, question, answer) => learning.appendChat(id, question, answer));
  handle('learnflow:save-note', value => learning.saveNote(value));
  handle('learnflow:save-settings', async value => {
    try {
      const settings = await store.saveSettings(value);
      llm = createLLM({ ...store.getModelConfig(), fetchImpl: modelFetch });
      return { settings, status: llm.status() };
    } catch (error) {
      if (error.code === 'LOCAL_ONLY_CONFLICT') return { requiresRemotePermission: true, error: error.message };
      throw error;
    }
  });
  handle('learnflow:request', async (endpoint, data) => {
    if (!['status', 'plan', 'lesson', 'lesson-ask', 'wiki', 'ask', 'test-connection'].includes(endpoint)) throw new Error('接口不存在。');
    const response = await fetch(`${base}/api/${endpoint}`, {
      method: endpoint === 'status' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Learnflow-Token': token },
      ...(endpoint === 'status' ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout((llm.status().timeoutMs || 120000) + 10000)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '请求失败。');
    return value;
  });
  handle('learnflow:export', async (name, content) => {
    if (typeof name !== 'string' || !/\.(json|md)$/.test(name) || typeof content !== 'string' || Buffer.byteLength(content) > 30 * 1024 * 1024) throw new Error('导出内容无效。');
    const filename = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
    const selected = await dialog.showSaveDialog(window, { title: '导出学习资料', defaultPath: filename, filters: [{ name: '学习资料', extensions: [name.endsWith('.json') ? 'json' : 'md'] }] });
    if (selected.canceled) return false;
    await writeFile(selected.filePath, content, 'utf8'); return true;
  });
  handle('learnflow:open-data', async () => { const error = await shell.openPath(dataDirectory); if (error) throw new Error('无法打开数据目录。'); });
  handle('learnflow:export-backup', async () => {
    const selected = await dialog.showSaveDialog(window, { title: '导出完整学习备份', defaultPath: 'learnflow-backup.json', filters: [{ name: 'Learnflow JSON 备份', extensions: ['json'] }] });
    if (selected.canceled) return false;
    await writeFile(selected.filePath, JSON.stringify(learning.exportState(), null, 2), 'utf8');
    return true;
  });
  handle('learnflow:import', async () => {
    const selected = await dialog.showOpenDialog(window, { title: '导入 Learnflow JSON 备份', properties: ['openFile'], filters: [{ name: 'Learnflow 备份', extensions: ['json'] }] });
    if (selected.canceled) return null;
    const bytes = await readFile(selected.filePaths[0]);
    if (bytes.length > 256 * 1024 * 1024) throw new Error('备份超过 256 MB。');
    let imported;
    try { imported = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('备份不是有效的 JSON 文件。'); }
    if (!validState(imported)) throw new Error('备份格式不正确，未修改现有数据。');
    const confirm = await dialog.showMessageBox(window, { type: 'question', buttons: ['取消', '导入并替换'], defaultId: 0, cancelId: 0, message: '用备份替换当前学习数据？', detail: '导入前会创建 SQLite 快照备份。模型配置和密钥不会被替换。' });
    if (confirm.response !== 1) return null;
    await learning.backupBeforeImport(); return learning.replaceState(imported);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '应用', submenu: [{ label: '退出', role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }
  ]));
  window = new BrowserWindow({ width: 1360, height: 920, minWidth: 760, minHeight: 620, title: '知行 Learnflow', show: false, backgroundColor: '#faf9fc',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (smoke) window.webContents.on('console-message', details => { if (details.level === 'error') console.error('SMOKE_RENDERER', details.message); });
  window.webContents.on('will-navigate', (event, url) => { if (url !== base + '/') event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  const rendererSession = window.webContents.session;
  rendererSession.setPermissionRequestHandler((_, __, callback) => callback(false));
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.webRequest.onBeforeRequest((details, callback) => { callback({ cancel: !details.url.startsWith(base + '/') }); });
  window.once('ready-to-show', () => { if (!smoke) window.show(); });
  await window.loadURL(base + '/');
  if (development) { window.setTitle('知行 Learnflow · 开发测试版'); console.log('DESKTOP_DEV_READY'); }
  if (smoke) {
    await require('./smoke.cjs').run(window, { ...store, loadState: async () => learning.exportState() }, dataDirectory);
    await store.flush(); app.quit();
  }
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault(); shuttingDown = true;
  Promise.resolve(store?.flush()).finally(() => { learning?.close(); server?.closeAllConnections(); server?.close(); app.quit(); });
});
