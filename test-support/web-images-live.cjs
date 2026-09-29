// Explicit one-request diagnostic. Not part of the automated test suite.
const { app, safeStorage, session, nativeImage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
app.setName('Learnflow');
app.setPath('userData', path.join(root, '.desktop-dev'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let posts = 0;
  try {
    const checkOnly = process.argv.includes('--check-only');
    if (!checkOnly && !process.argv.includes('--confirm-paid')) throw new Error('未明确确认真实计费测试。');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥解密不可用。');
    const { createLocalStore } = await import(pathToFileURL(path.join(root, 'desktop', 'local-store.mjs')));
    const { createWebImageSearch } = await import(pathToFileURL(path.join(root, 'web-images.mjs')));
    const store = createLocalStore(path.join(root, '.desktop-dev', 'data'), { decrypt: async value => safeStorage.decryptString(Buffer.from(value, 'base64')), encrypt: async () => { throw new Error('真实搜索测试不会写模型配置。'); } });
    await store.initialize();
    if (store.getSettings().error) throw new Error(store.getSettings().error);
    const config = store.getModelConfig();
    const network = session.fromPartition('learnflow-web-images-paid-diagnostic');
    if (checkOnly) {
      const { resolveConfig } = await import(pathToFileURL(path.join(root, 'llm.mjs')));
      const resolved = resolveConfig(config, {});
      const response = await network.fetch(resolved.baseUrl + '/models', { method: 'GET', headers: { Authorization: `Bearer ${resolved.apiKey}` }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
      console.log('WEB_IMAGE_CATALOG_CHECK', JSON.stringify({ status: response.status, posts: 0 }));
      await response.body?.cancel(); return;
    }
    const service = createWebImageSearch({ getConfig: () => ({ ...config, enabled: true }), fetchImpl: async (url, options) => {
      if (options.method !== 'POST' || ++posts > 1) throw new Error('本次最多 1 次 Responses 请求。');
      console.log('WEB_IMAGE_LIVE_REQUEST', JSON.stringify({ endpoint: url, model: config.model, posts, tool: 'web_search_image' }));
      const response = await network.fetch(url, { ...options, credentials: 'omit' });
      console.log('WEB_IMAGE_RESPONSE_HEADERS', JSON.stringify({ status: response.status, contentType: response.headers.get('content-type') }));
      return response;
    }, preview: bytes => {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('图片无法解码。');
      return image.resize({ width: 320 }).toDataURL();
    } });
    const result = await service.search('寻找适合零基础学习的心脏结构教学示意图，最好标明心房与心室，用于理解血液循环。');
    console.log('WEB_IMAGE_LIVE_RESULT', JSON.stringify({ ok: true, posts, candidates: result.results.length, previews: result.results.filter(item => item.preview).length, results: result.results.slice(0, 5).map(item => ({ title: item.title, host: new URL(item.imageUrl).hostname, hasSourcePage: !!item.sourceUrl, preview: !!item.preview, previewError: item.previewError || '' })), hasRecommendation: !!result.recommendation, warning: result.warning || '', retried: false }));
  } catch (error) { console.log('WEB_IMAGE_LIVE_RESULT', JSON.stringify({ ok: false, posts, message: error.message, retried: false })); process.exitCode = 1; }
  finally { app.exit(process.exitCode || 0); }
});
