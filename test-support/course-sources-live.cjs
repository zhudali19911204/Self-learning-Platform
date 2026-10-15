// Explicit paid diagnostic, never loaded by automated tests or the application.
// One search API request and one generation at most. No writes to course data.
const { app, safeStorage, session } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
app.setName('Learnflow');
app.setPath('userData', path.join(root, '.desktop-test', 'course-sources-live'));
app.disableHardwareAcceleration();
const counts = { searches: 0, generations: 0, documentReads: 0 };
const log = (stage, data = {}) => console.log('COURSE_SOURCES_LIVE', JSON.stringify({ stage, ...data, counts }));
app.whenReady().then(async () => {
  let server, secret = '', stage = 'setup', exitCode = 1;
  const imported = file => import(pathToFileURL(path.join(root, file)));
  const safeMessage = error => String(error?.message || error || '').split(secret || '\u0000').join('[redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
  try {
    if (!process.argv.includes('--confirm-paid')) throw new Error('Explicit --confirm-paid is required.');
    const lessonId = process.argv.find(arg => arg.startsWith('--lesson='))?.slice(9);
    if (!lessonId || !/^[a-zA-Z0-9_-]{1,160}$/.test(lessonId)) throw new Error('An explicit lesson ID is required.');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('System key decryption unavailable.');
    const { createLocalStore } = await imported('desktop/local-store.mjs');
    const { createLLM, resolveConfig } = await imported('llm.mjs');
    const { createApp } = await imported('server.mjs');
    const { createCourseSources, readOfficialDocument } = await imported('course-sources.mjs');
    const { blockGenerationContext } = await imported('public/blocks.js');
    const { createCourseClaimMatcher } = await imported('course-claim-matching.mjs');
    const { validGrounding } = await imported('public/course-sources.js');
    const store = createLocalStore(path.join(root, '.desktop-dev', 'data'), {
      decrypt: async value => safeStorage.decryptString(Buffer.from(value, 'base64')),
      encrypt: async () => { throw new Error('Diagnostic must not save model settings.'); },
    });
    await store.initialize();
    if (store.getSettings().error) throw new Error(store.getSettings().error);
    const config = store.getModelConfig(), resolved = resolveConfig(config, {});
    secret = resolved.apiKey;
    if (resolved.error || !secret || config.localOnly) throw new Error('Saved cloud model configuration unavailable.');
    let request;
    const db = new DatabaseSync(path.join(root, '.desktop-dev', 'data', 'learning.sqlite'), { readOnly: true });
    try {
      const lesson = db.prepare('SELECT * FROM lessons WHERE id=?').get(lessonId);
      if (!lesson) throw new Error('Lesson not found.');
      const plan = db.prepare('SELECT * FROM plans WHERE id=?').get(lesson.plan_id);
      const outline = db.prepare('SELECT intro FROM lesson_outlines WHERE lesson_id=?').get(lessonId);
      const blocks = db.prepare('SELECT id,type,title,objective,content_json FROM lesson_blocks WHERE lesson_id=? ORDER BY position').all(lessonId)
        .map(({ content_json, ...block }) => ({ ...block, content: content_json ? JSON.parse(content_json) : null }));
      const block = blocks.find(item => item.type === 'reading');
      if (!outline || !block) throw new Error('No reading block available.');
      const brief = db.prepare('SELECT value FROM meta WHERE key=?').get(`plan_brief:${plan.id}`);
      request = { lessonId, goal: plan.goal, level: plan.level, title: lesson.title, objective: lesson.objective, minutes: lesson.minutes,
        intro: outline.intro, block: { type: block.type, title: block.title, objective: block.objective },
        ...blockGenerationContext({ intro: outline.intro, blocks }, block.id),
        ...(brief ? { learningBrief: JSON.parse(brief.value) } : {}), sourceSearch: { enabled: true, revision: 1 } };
    } finally { db.close(); }
    const network = session.fromPartition('course-sources-paid-diagnostic');
    const paidFetch = async (url, options) => {
      const kind = url === resolved.baseUrl + '/responses' ? 'searches' : url === resolved.baseUrl + '/chat/completions' ? 'generations' : null;
      if (!kind || options.method !== 'POST' || counts[kind] >= 1) throw new Error('Paid request budget exceeded or unexpected endpoint.');
      counts[kind]++; stage = kind;
      log('request', { kind, model: resolved.model, host: new URL(url).hostname });
      const response = await network.fetch(url, { ...options, credentials: 'omit' });
      log('response_headers', { kind, status: response.status });
      return response;
    };
    const sources = createCourseSources({ getConfig: () => config, fetchImpl: paidFetch, read: async url => {
      counts.documentReads++; stage = 'document_read';
      try {
        const doc = await readOfficialDocument(url);
        log('document_read', { url: doc.url, characters: doc.text.length }); return doc;
      } catch (error) { log('document_failed', { url, error: safeMessage(error) }); throw error; }
    } });
    const llm = createLLM({ ...config, fetchImpl: paidFetch });
    const instrumented = { ...llm, generate: (instruction, input, validate) => llm.generate(instruction, input, value => {
      const match = createCourseClaimMatcher(), body = value?.text || '';
      log('citation_check', { characters: body.length, claims: Array.isArray(value?.citations) ? value.citations.map(c => ({ length: c.claim?.length, exact: typeof c.claim === 'string' && body.includes(c.claim), matched: !!match(body, c.claim) })) : [], sourceInsufficient: value?.sourceInsufficient === true });
      return validate(value);
    }) };
    server = createApp({ getLLM: () => instrumented, courseSources: sources });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    log('start', { lessonId, blockType: request.block.type, readOnly: true });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      signal: AbortSignal.timeout(resolved.timeoutMs * 2 + 120000),
    });
    const result = await response.json();
    const ok = response.ok && validGrounding(result.grounding) && result.grounding.citations.every(c => result.text.includes(c.claim));
    log('result', { ok, status: response.status, characters: result.text?.length || 0, citations: result.grounding?.citations.length || 0,
      urls: [...new Set(result.grounding?.citations.map(c => c.url) || [])], ...(ok ? {} : { error: safeMessage(result.error || 'Invalid grounding') }), saved: false, retried: false });
    exitCode = ok ? 0 : 1;
  } catch (error) { log('failed', { at: stage, error: safeMessage(error), saved: false, retried: false }); }
  finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } app.exit(exitCode); }
});
