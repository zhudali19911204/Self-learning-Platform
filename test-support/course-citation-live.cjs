// Explicit paid diagnostic for a single saved module. Never run by tests/app.
// Across a run directory: at most 2 generations and 1 citation-only completion.
// Original course and settings are read-only; no searches, grades or notes.
const { app, safeStorage, session } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const { readFile, writeFile, mkdir, open, unlink } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const run = arg('run'), lessonId = arg('lesson'), blockId = arg('block');
if (!process.argv.includes('--confirm-paid') || ![run, lessonId, blockId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(v))) throw new Error('Explicit paid confirmation, run, lesson and block are required.');
const directory = path.join(root, '.desktop-test', run);
app.setName('Learnflow');
// Match the existing encryption context; networking remains a separate
// non-persistent session, and the course database below is strictly read-only.
app.setPath('userData', path.join(root, '.desktop-dev'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let server, lock, secret = '', code = 1, phase = 'setup';
  const imported = file => import(pathToFileURL(path.join(root, file)));
  const safe = value => String(value).split(secret || '\u0000').join('[redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
  const log = (stage, value = {}) => console.log('COURSE_CITATION_LIVE', safe(JSON.stringify({ stage, ...value })));
  try {
    await mkdir(directory, { recursive: true });
    lock = await open(path.join(directory, 'running.lock'), 'wx');
    const budgetPath = path.join(directory, 'budget.json');
    let budget = { generations: 0, completions: 0 };
    try { budget = JSON.parse(await readFile(budgetPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (![budget.generations, budget.completions].every(Number.isInteger) || budget.generations < 0 || budget.completions < 0 || budget.generations >= 2 || budget.completions > 1) throw new Error('Diagnostic budget exhausted/invalid.');
    const { createLocalStore } = await imported('desktop/local-store.mjs');
    const { resolveConfig, createLLM } = await imported('src/models/llm.mjs');
    const { createApp } = await imported('src/server.mjs');
    const { blockGenerationContext } = await imported('public/blocks.js');
    const { validGrounding } = await imported('public/course-sources.js');
    const store = createLocalStore(path.join(root, '.desktop-dev', 'data'), {
      decrypt: async value => safeStorage.decryptString(Buffer.from(value, 'base64')),
      encrypt: async () => { throw new Error('Diagnostic cannot save settings'); }
    });
    await store.initialize();
    if (store.getSettings().error) throw new Error(store.getSettings().error);
    let config = store.getModelConfig();
    if (arg('provider')) {
      if (arg('provider') !== 'qwen') throw new Error('Only explicitly approved qwen profile supported.');
      const saved = JSON.parse(await readFile(path.join(root, '.desktop-dev', 'data', 'settings.json'), 'utf8'));
      const profile = saved.provider === 'qwen' ? saved : saved.profiles?.qwen;
      if (!profile?.encryptedApiKey) throw new Error('Approved paid profile unavailable.');
      config = { ...profile, apiKey: safeStorage.decryptString(Buffer.from(profile.encryptedApiKey, 'base64')), env: {} };
    }
    const resolved = resolveConfig(config, {});
    secret = resolved.apiKey;
    if (resolved.error || !secret || config.localOnly || new URL(resolved.baseUrl).protocol !== 'https:') throw new Error('Saved cloud model unavailable.');
    if (arg('provider') && (new URL(resolved.baseUrl).hostname !== 'token-plan.cn-beijing.maas.aliyuncs.com' || resolved.model !== 'qwen3.8-max')) throw new Error('Saved profile does not match the approved destination/model.');
    let request, materials, course, search;
    const db = new DatabaseSync(path.join(root, '.desktop-dev', 'data', 'learning.sqlite'), { readOnly: true });
    try {
      const lesson = db.prepare('SELECT * FROM lessons WHERE id=?').get(lessonId);
      if (!lesson) throw new Error('Lesson missing');
      const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(lesson.plan_id);
      const intro = db.prepare('SELECT intro FROM lesson_outlines WHERE lesson_id=?').get(lessonId)?.intro;
      const blocks = db.prepare('SELECT id,type,title,objective,content_json FROM lesson_blocks WHERE lesson_id=? ORDER BY position').all(lessonId).map(({ content_json, ...block }) => ({ ...block, content: content_json ? JSON.parse(content_json) : null }));
      const block = blocks.find(b => b.id === blockId);
      if (!block || typeof intro !== 'string') throw new Error('Target module missing');
      course = { intro, blocks };
      const meta = key => { const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; };
      materials = meta(`plan_materials:${plan.id}`);
      if (!materials?.length) throw new Error('This diagnostic requires saved imported materials; no search permitted.');
      search = meta(`sourceSearch:${lessonId}`) || { enabled: false, revision: 0 };
      const learningBrief = meta(`plan_brief:${plan.id}`);
      request = { lessonId, goal: plan.goal, level: plan.level, title: lesson.title, objective: lesson.objective, minutes: lesson.minutes,
        block: { type: block.type, title: block.title, objective: block.objective }, intro,
        ...blockGenerationContext(course, blockId), ...(learningBrief ? { learningBrief } : {}), sourceSearch: search };
    } finally { db.close(); }
    const network = session.fromPartition('citation-live-diagnostic');
    let kind, currentNumber;
    const llm = createLLM({ ...config, fetchImpl: async (url, options) => {
      if (url !== resolved.baseUrl + '/chat/completions' || options.method !== 'POST') throw new Error('Unexpected paid endpoint');
      const limit = kind === 'generations' ? 2 : kind === 'completions' ? 1 : 0;
      if (!limit || budget[kind] >= limit) throw Object.assign(new Error('付费诊断预算已用完，没有继续请求。'), { status: 422 });
      budget[kind]++; currentNumber = budget.generations + budget.completions;
      await writeFile(budgetPath, JSON.stringify(budget), { mode: 0o600 });
      log('paid_request', { kind, number: currentNumber, model: resolved.model, host: new URL(url).hostname, budget });
      const response = await network.fetch(url, { ...options, credentials: 'omit' });
      log('paid_response', { status: response.status, number: currentNumber });
      return response;
    } });
    const instrumented = { ...llm, generate: async (instruction, input, validate) => {
      kind = input.task === 'complete-course-citations' ? 'completions' : 'generations'; phase = kind;
      const next = budget.generations + budget.completions + 1;
      await writeFile(path.join(directory, `input-${next}.json`), safe(JSON.stringify({ instruction, input }, null, 2)), { mode: 0o600 });
      return llm.generate(instruction, input, value => {
        // Local diagnostic only. No key, HTTP headers, notes or chat retained.
        require('node:fs').writeFileSync(path.join(directory, `output-${currentNumber}.json`), safe(JSON.stringify(value, null, 2)), { mode: 0o600 });
        try { const valid = validate(value); log('validation', { number: currentNumber, valid, characters: value?.text?.length || 0 }); return valid; }
        catch (error) { log('validation_failed', { number: currentNumber, error: safe(error.message), characters: value?.text?.length || 0 }); throw error; }
      });
    } };
    server = createApp({ getLLM: () => instrumented, getCourseMaterials: () => materials, getCourseBlockCourse: () => course, getCourseSourceSearch: () => search,
      courseSources: { prepare: async () => { throw new Error('Diagnostic must never search'); } } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    log('start', { lessonId, blockId, materials: materials.length, readOnly: true, model: resolved.model, host: new URL(resolved.baseUrl).hostname, budget });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(resolved.timeoutMs * 2 + 30000) });
    const value = await response.json(), ok = response.ok && validGrounding(value.grounding) && value.grounding.citations.every(c => value.text.includes(c.claim));
    await writeFile(path.join(directory, `result-${budget.generations}.json`), safe(JSON.stringify(value, null, 2)), { mode: 0o600 });
    log('result', { ok, status: response.status, characters: value.text?.length || 0, citations: value.grounding?.citations?.length || 0, error: value.error, budget, saved: false, searches: 0 });
    code = ok ? 0 : 1;
  } catch (error) { log('failed', { phase, error: safe(error.message), saved: false }); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (lock) { await lock.close(); await unlink(path.join(directory, 'running.lock')); }
    app.exit(code);
  }
});
