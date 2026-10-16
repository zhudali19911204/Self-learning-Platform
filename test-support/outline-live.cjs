// Explicit single paid request diagnostic. Never imported by the application.
const { app, safeStorage, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
app.setName('Learnflow');
// Electron safeStorage requires the same encryption context as the saved key.
// Networking below uses a separate non-persistent session; no course DB opens.
app.setPath('userData', path.join(root, '.desktop-dev'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let server, posts = 0, secret = '', exitCode = 1;
  const log = (stage, value) => console.log('OUTLINE_LIVE', JSON.stringify({ stage, posts, ...value }));
  const load = file => import(pathToFileURL(path.join(root, file)));
  const safe = message => String(message).split(secret || '\u0000').join('[redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
  try {
    if (!process.argv.includes('--confirm-paid')) throw new Error('Explicit --confirm-paid is required.');
    if (!process.argv.includes('--public-sample')) throw new Error('Only the public screenshot sample is supported.');
    const { createLocalStore } = await load('desktop/local-store.mjs');
    const { resolveConfig, createLLM } = await load('llm.mjs');
    const { createApp } = await load('server.mjs');
    const { validOutline, validBlockSpec } = await load('public/blocks.js');
    const { validGeneratedOutline } = await load('course-generation.mjs');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('System key decryption unavailable.');
    const store = createLocalStore(path.join(root, '.desktop-dev', 'data'), {
      decrypt: async value => safeStorage.decryptString(Buffer.from(value, 'base64')),
      encrypt: async () => { throw new Error('Diagnostic cannot save settings.'); },
    });
    await store.initialize();
    if (store.getSettings().error) throw new Error(store.getSettings().error);
    const settings = store.getModelConfig(), config = resolveConfig(settings, {});
    secret = config.apiKey;
    if (config.error || !secret || settings.localOnly || config.protocol === 'ollama') throw new Error('Saved paid cloud configuration unavailable.');
    // Public text supplied in the screenshot plus synthetic test parameters.
    // Never open the course database or read goals, profiles, notes or chats.
    const request = {
      goal: '了解撤离类游戏的规则、操作与地图基础，能判断搜刮或撤离。',
      level: '零基础', title: '危险行动规则与胜负条件解析', minutes: 25,
      objective: '本节结束后能用自己的话准确说明危险行动模式的核心目标（搜刮物资并撤离）、死亡惩罚机制（未撤离则丢失携带物品）以及单局时间限制，能判断当前局势应选择继续搜刮还是立即撤离。',
      lessonPosition: 1,
    };
    const network = session.fromPartition('outline-live-diagnostic');
    const llm = createLLM({ ...settings, fetchImpl: async (url, options) => {
      if (url !== config.baseUrl + '/chat/completions' || options.method !== 'POST' || posts >= 1) throw new Error('One-generation request budget exceeded.');
      posts++;
      log('paid_request', { host: new URL(url).hostname, model: config.model, maxTokens: config.maxTokens });
      const response = await network.fetch(url, { ...options, credentials: 'omit' });
      log('headers', { status: response.status });
      if (response.ok) {
        try { const value = await response.clone().json(); log('provider_result', { finishReason: value.choices?.[0]?.finish_reason, usage: value.usage }); } catch {}
      }
      return response;
    } });
    const instrumented = { ...llm, generate: (instruction, input, validate) => llm.generate(instruction, input, value => {
      const issues = [], blocks = Array.isArray(value?.blocks) ? value.blocks : [];
      if (!value || typeof value !== 'object' || Array.isArray(value)) issues.push('root_not_object');
      if (typeof value?.intro !== 'string' || !value.intro.trim() || value.intro.length > 20000) issues.push('intro_missing_invalid_or_long');
      if (!Array.isArray(value?.blocks)) issues.push('blocks_missing_or_not_array');
      if (blocks.length < 2 || blocks.length > 20) issues.push('block_count_outside_2_to_20');
      if (!blocks.some(b => b?.type === 'reading')) issues.push('no_reading');
      if (!blocks.some(b => b?.type === 'quiz')) issues.push('no_quiz');
      const titles = new Map(), objectives = new Map();
      blocks.forEach((b, index) => {
        const position = index + 1;
        if (!validBlockSpec(b)) issues.push(`block_${position}_invalid_fields`);
        const title = typeof b?.title === 'string' ? b.title.trim().toLowerCase() : undefined;
        const objective = typeof b?.objective === 'string' ? b.objective.trim() : undefined;
        if (title && titles.has(title)) issues.push(`block_${position}_duplicate_title_with_${titles.get(title)}`);
        if (objective && objectives.has(objective)) issues.push(`block_${position}_duplicate_objective_with_${objectives.get(objective)}`);
        if (title) titles.set(title, position);
        if (objective) objectives.set(objective, position);
        if (b?.type === 'reading' && blocks[index + 1]?.type !== 'example') issues.push(`block_${position}_reading_not_followed_by_example`);
        if (b?.type === 'quiz' && !blocks.slice(0, index).some(b => b?.type === 'reading')) issues.push(`block_${position}_quiz_before_reading`);
      });
      log('validation', { rootFields: Object.keys(value || {}), baseValid: validOutline(value), generationValid: validGeneratedOutline(value), issues,
        introLength: value?.intro?.length, blocks: blocks.map((b, index) => ({ position: index + 1, type: b?.type, title: typeof b?.title === 'string' ? b.title.slice(0, 160) : null, titleLength: b?.title?.length, objectiveLength: b?.objective?.length })) });
      return validate(value);
    }) };
    server = createApp({ getLLM: () => instrumented, courseSources: { prepare: () => { throw new Error('Search forbidden in this diagnostic.'); } } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    log('start', { title: request.title, lessonPosition: request.lessonPosition, publicSample: true, courseDatabaseRead: false, hasLearningBrief: false });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lesson-outline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(config.timeoutMs + 30000) });
    const result = await response.json();
    log('result', { status: response.status, ok: response.ok, ...(result.error ? { error: safe(result.error) } : {}), saved: false, retried: false });
    exitCode = 0;
  } catch (error) { log('failed', { error: safe(error.message), retried: false }); }
  finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } app.exit(exitCode); }
});
