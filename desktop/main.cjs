const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, session, nativeImage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');
const { readFile, writeFile, mkdir, stat } = require('node:fs/promises');

app.setName('Learnflow');
const smoke = process.argv.includes('--smoke-test');
const development = process.argv.includes('--dev-profile');
if (smoke) app.setPath('userData', path.resolve('.desktop-test'));
else if (development) app.setPath('userData', path.resolve('.desktop-dev'));
let window, server, store, imageStore, learning, base, shuttingDown = false;
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
  const { createApp, illustrationGuidance } = await import(pathToFileURL(path.join(__dirname, '..', 'server.mjs')));
  const { createLLM } = await import(pathToFileURL(path.join(__dirname, '..', 'llm.mjs')));
  const { createLocalStore, validState } = await import(pathToFileURL(path.join(__dirname, 'local-store.mjs')));
  const { createSqliteStore } = await import(pathToFileURL(path.join(__dirname, 'sqlite-store.mjs')));
  const { createImageStore } = await import(pathToFileURL(path.join(__dirname, 'image-store.mjs')));
  const { createImageModel } = await import(pathToFileURL(path.join(__dirname, '..', 'image-model.mjs')));
  const { validImageSuggestion, validImageProposal } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'illustrations.js')));
  const dataDirectory = path.join(app.getPath('userData'), 'data');
  await mkdir(dataDirectory, { recursive: true });
  const available = () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  const secrets = {
    encrypt: async value => { if (!available()) throw new Error('系统安全存储不可用，无法保存密钥。可使用不需要密钥的本地模型。'); return safeStorage.encryptString(value).toString('base64'); },
    decrypt: async value => { if (!available()) throw new Error('系统安全存储不可用。'); return safeStorage.decryptString(Buffer.from(value, 'base64')); }
  };
  store = createLocalStore(dataDirectory, secrets);
  await store.initialize();
  imageStore = createImageStore(dataDirectory, secrets, bytes => {
    const decoded = nativeImage.createFromBuffer(bytes), { width, height } = decoded.getSize();
    if (decoded.isEmpty() || width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error('图片无法解码或尺寸超过 4096，请调整图片模型尺寸。');
  });
  await imageStore.initialize();
  learning = await createSqliteStore(dataDirectory, { withAssets: state => imageStore.withAssets(state) });
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
  server = createApp({ getLLM: () => llm, apiToken: token, getImageSettings: () => imageStore.getSettings(), getImageAsset: async id => {
    try { return await imageStore.readAsset(id); } catch { return null; }
  } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  handle('learnflow:load', async () => {
    let state = null, stateError = '';
    try { state = learning.overview(); } catch (error) { stateError = error.message; }
    return { settings: store.getSettings(), imageSettings: imageStore.getSettings(), state, stateError, status: llm.status(), dataDirectory, startPage: process.argv.includes('--settings') ? 'settings' : 'home' };
  });
  handle('learnflow:get-lesson', id => learning.getLesson(id));
  handle('learnflow:save-plan', value => learning.savePlan(value));
  handle('learnflow:set-active-plan', id => learning.setActivePlan(id));
  handle('learnflow:delete-plan', async id => {
    const preview = learning.planDeletionPreview(id);
    const choice = await dialog.showMessageBox(window, {
      type: 'warning', title: '删除学习路线', message: `删除「${preview.title}」？`,
      detail: `这会同时移除 ${preview.lessons} 节课程、关联的练习进度与答疑记录，以及 ${preview.notes} 张 Wiki 卡片。删除前会在本地 backups 目录保存完整 JSON 备份。`,
      buttons: ['取消', '删除路线'], defaultId: 0, cancelId: 0, noLink: true
    });
    return choice.response === 1 ? learning.deletePlan(id) : null;
  });
  handle('learnflow:save-lesson', (id, value) => learning.saveLesson(id, value));
  handle('learnflow:save-outline', (id, value) => learning.saveOutline(id, value));
  handle('learnflow:append-block', (id, value) => learning.appendBlock(id, value));
  handle('learnflow:save-block', (id, blockId, value) => learning.saveBlock(id, blockId, value));
  handle('learnflow:revise-block', (id, blockId, value, expectedText) => learning.reviseBlock(id, blockId, value, expectedText));
  handle('learnflow:restore-block', (id, blockId, expectedText) => learning.restoreBlock(id, blockId, expectedText));
  handle('learnflow:save-progress', (id, value) => learning.saveProgress(id, value));
  handle('learnflow:save-reflection', (id, value) => learning.saveReflection(id, value));
  handle('learnflow:append-chat', (id, question, answer) => learning.appendChat(id, question, answer));
  handle('learnflow:save-note', value => learning.saveNote(value));
  const imageRequests = new Set();
  const { createPendingImageDownloads } = await import('./pending-images.mjs');
  const pendingImages = createPendingImageDownloads();
  function illustrationBlock(lessonId, blockId) {
    const block = learning.getLesson(lessonId).blockCourse?.blocks.find(item => item.id === blockId);
    if (!block?.content || !['reading', 'example'].includes(block.type)) throw new Error('只能为已保存的讲解或案例配图。');
    return block;
  }
  function pendingIllustration(lessonId, blockId, pendingId) {
    const key = `${lessonId}/${blockId}`, record = pendingImages.get(key, pendingId);
    if (!record) return null;
    const config = imageStore.getConfig();
    if (JSON.stringify(illustrationBlock(lessonId, blockId).content) !== record.expectedContent || config.baseUrl !== record.baseUrl || config.model !== record.model || config.protocol !== record.protocol) {
      pendingImages.drop(key, record.id); return null;
    }
    return record;
  }
  handle('learnflow:save-image-settings', value => imageStore.saveSettings(value));
  handle('learnflow:check-image-connection', () => createImageModel(imageStore.getConfig(), modelFetch).checkConnection());
  handle('learnflow:get-pending-illustration', (lessonId, blockId) => {
    const record = pendingIllustration(lessonId, blockId); return record ? pendingImages.public(record) : null;
  });
  handle('learnflow:discard-illustration-download', (lessonId, blockId, pendingId) => {
    if (typeof pendingId !== 'string' || !pendingId) throw new Error('待下载图片标识无效。');
    const key = `${lessonId}/${blockId}`;
    if (imageRequests.has(key)) throw new Error('正在下载配图，请等待完成后再放弃。');
    pendingImages.drop(key, pendingId);
  });
  handle('learnflow:retry-illustration-download', async value => {
    if (!value || typeof value.pendingId !== 'string' || !value.pendingId) throw new Error('待下载图片标识无效。');
    const key = `${value.lessonId}/${value.blockId}`;
    if (imageRequests.has(key)) throw new Error('正在下载配图，请勿重复提交。');
    const record = pendingIllustration(value.lessonId, value.blockId, value.pendingId);
    if (!record) throw new Error('待下载结果已过期、应用已重启，或课程／服务已更改。没有重新生成；请查看服务商记录或重新打开配图面板。');
    imageRequests.add(key);
    try {
      const bytes = await createImageModel(imageStore.getConfig(), modelFetch).download(record.url);
      const id = await imageStore.put(bytes);
      const content = learning.attachIllustration(value.lessonId, value.blockId, { id, prompt: record.prompt, caption: record.caption, model: record.model, created: Date.now() }, record.expectedContent);
      pendingImages.drop(key, record.id); return content;
    } catch (error) {
      record.error = error.code ? '本地图片保存失败，请检查目录权限和磁盘空间。' : error.message;
      return pendingImages.public(record);
    } finally { imageRequests.delete(key); }
  });
  handle('learnflow:suggest-illustration', async (lessonId, blockId) => {
    if (!imageStore.getConfig().enabled) throw new Error('请先启用图片模型。');
    const block = illustrationBlock(lessonId, blockId);
    const text = block.content.text;
    const result = await llm.generate(`${illustrationGuidance}返回 JSON：需要配图时 {"needed":true,"reason":"为什么有帮助","prompt":"图片提示词","caption":"图注"}；无需配图时 {"needed":false,"reason":"解释理由"}。`, { title: block.title, objective: block.objective, text }, validImageSuggestion);
    if (illustrationBlock(lessonId, blockId).content.text !== text) throw new Error('正文已更新，请重新分析配图。');
    return result;
  });
  handle('learnflow:generate-illustration', async value => {
    if (!value || !validImageProposal(value)) throw new Error('请填写有效的配图提示词和图注。');
    const block = illustrationBlock(value.lessonId, value.blockId);
    if (block.content.text !== value.expectedText || (block.content.illustration?.id || '') !== (value.expectedImageId || '')) throw new Error('课程或配图已更新，请重新打开配图面板。');
    const requestId = `${value.lessonId}/${value.blockId}`;
    if (imageRequests.has(requestId)) throw new Error('这个模块正在生成配图，请等待，不要重复提交。');
    const previousDownload = pendingIllustration(value.lessonId, value.blockId);
    if (previousDownload) return pendingImages.public(previousDownload); // Never silently charge again.
    imageRequests.add(requestId);
    const expectedContent = JSON.stringify(block.content), config = imageStore.getConfig();
    let downloadURL, downloadHost;
    try {
      const bytes = await createImageModel(config, modelFetch).generate(value.prompt, (url, host) => { downloadURL = url; downloadHost = host; });
      const id = await imageStore.put(bytes);
      return learning.attachIllustration(value.lessonId, value.blockId, { id, prompt: value.prompt, caption: value.caption, model: config.model, created: Date.now() }, expectedContent);
    } catch (error) {
      if (!downloadURL) throw error;
      const record = pendingImages.put(requestId, { url: downloadURL, host: downloadHost, expectedContent, baseUrl: config.baseUrl, protocol: config.protocol, model: config.model, prompt: value.prompt, caption: value.caption, error: error.code ? '本地图片保存失败，请检查目录权限和磁盘空间。' : error.message });
      return pendingImages.public(record);
    } finally { imageRequests.delete(requestId); }
  });
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
    if (!['status', 'plan-clarify', 'plan', 'lesson', 'lesson-outline', 'lesson-block', 'lesson-ask', 'wiki', 'ask', 'test-connection'].includes(endpoint)) throw new Error('接口不存在。');
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
    const snapshot = await imageStore.withAssets(learning.exportState());
    await writeFile(selected.filePath, JSON.stringify(snapshot), 'utf8');
    return true;
  });
  handle('learnflow:import', async () => {
    const selected = await dialog.showOpenDialog(window, { title: '导入 Learnflow JSON 备份', properties: ['openFile'], filters: [{ name: 'Learnflow 备份', extensions: ['json'] }] });
    if (selected.canceled) return null;
    if ((await stat(selected.filePaths[0])).size > 256 * 1024 * 1024) throw new Error('备份超过 256 MB。');
    const bytes = await readFile(selected.filePaths[0]);
    if (bytes.length > 256 * 1024 * 1024) throw new Error('备份超过 256 MB。');
    let imported;
    try { imported = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('备份不是有效的 JSON 文件。'); }
    if (!validState(imported)) throw new Error('备份格式不正确，未修改现有数据。');
    const stageImages = await imageStore.prepareImport(imported);
    const confirm = await dialog.showMessageBox(window, { type: 'question', buttons: ['取消', '导入并替换'], defaultId: 0, cancelId: 0, message: '用备份替换当前学习数据？', detail: '导入前会创建 SQLite 快照备份。模型配置和密钥不会被替换。' });
    if (confirm.response !== 1) return null;
    await learning.backupBeforeImport(); await stageImages(); return learning.replaceState(imported);
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
  await rendererSession.cookies.set({ url: base, name: 'learnflow-assets', value: token, httpOnly: true, sameSite: 'strict' });
  rendererSession.setPermissionRequestHandler((_, __, callback) => callback(false));
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.webRequest.onBeforeRequest((details, callback) => { callback({ cancel: !details.url.startsWith(base + '/') }); });
  window.once('ready-to-show', () => { if (!smoke) window.show(); });
  await window.loadURL(base + '/');
  // Some Windows GPU/session combinations never emit ready-to-show.
  if (!smoke && !window.isVisible()) window.show();
  if (!smoke) window.focus();
  if (development) { window.setTitle('知行 Learnflow · 开发测试版'); console.log('DESKTOP_DEV_READY'); }
  if (smoke) {
    await require('./smoke.cjs').run(window, { ...store, loadState: async () => learning.exportState() }, dataDirectory);
    await store.flush(); await imageStore.flush(); app.quit();
  }
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault(); shuttingDown = true;
  Promise.all([store?.flush(), imageStore?.flush()]).finally(() => { learning?.close(); server?.closeAllConnections(); server?.close(); app.quit(); });
});
