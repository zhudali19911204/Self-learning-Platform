// Explicit paid diagnostic. Reads one specified module, never writes learning data/settings.
const { app, safeStorage, session } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
app.setName('Learnflow');
// Match the saved key's OS encryption context; do not open a renderer/session DB.
app.setPath('userData', path.join(root, '.desktop-dev'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let posts = 0, secret = '', exitCode = 1;
  const load = name => import(pathToFileURL(path.join(root, name)));
  const safe = value => String(value).split(secret || '\u0000').join('[redacted]').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
  const log = (stage, value = {}) => console.log('FACT_CHECK_LIVE', JSON.stringify({ stage, posts, ...value }, (_, v) => typeof v === 'string' ? safe(v) : v));
  try {
    if (!process.argv.includes('--confirm-paid')) throw new Error('Explicit --confirm-paid required.');
    const option = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
    const lessonId = option('lesson'), blockId = option('block');
    if (![lessonId, blockId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(v))) throw new Error('Explicit lesson/block IDs required.');
    const { createLocalStore } = await load('desktop/local-store.mjs');
    const { createLLM, resolveConfig } = await load('llm.mjs');
    const { createFactCheckService, validFactJudgment, normalizeFactJudgment, normalizeFactEvidence, factJudgmentProblems } = await load('course-fact-check.mjs');
    const { sameFactContent } = await load('public/fact-check.js');
    const store = createLocalStore(path.join(root, '.desktop-dev', 'data'), {
      decrypt: async value => safeStorage.decryptString(Buffer.from(value, 'base64')),
      encrypt: async () => { throw new Error('Settings writes forbidden.'); },
    }, { filename: 'quality-settings.json' });
    await store.initialize();
    if (store.getSettings().error) throw new Error(store.getSettings().error);
    const config = store.getModelConfig(), resolved = resolveConfig(config, {});
    secret = resolved.apiKey;
    if (!secret || resolved.error || config.localOnly) throw new Error('Saved paid reviewer unavailable.');
    let detail, plan;
    const db = new DatabaseSync(path.join(root, '.desktop-dev', 'data', 'learning.sqlite'), { readOnly: true });
    try {
      const lesson = db.prepare('SELECT id,title,objective,plan_id FROM lessons WHERE id=?').get(lessonId);
      if (!lesson) throw new Error('Lesson not found.');
      plan = db.prepare('SELECT id,level FROM plans WHERE id=?').get(lesson.plan_id);
      plan.lessons = [lesson];
      const outline = db.prepare('SELECT intro FROM lesson_outlines WHERE lesson_id=?').get(lessonId);
      const blocks = db.prepare('SELECT id,type,title,objective,content_json FROM lesson_blocks WHERE lesson_id=? ORDER BY position').all(lessonId)
        .map(({ content_json, ...block }) => ({ ...block, content: content_json ? JSON.parse(content_json) : null }));
      detail = { blockCourse: { intro: outline.intro, blocks }, factChecks: [] };
    } finally { db.close(); }
    const target = detail.blockCourse.blocks.find(b => b.id === blockId);
    if (!target?.content) throw new Error('Saved target content required.');
    const before = JSON.stringify(detail), network = session.fromPartition('fact-check-paid-diagnostic');
    const reviewer = createLLM({ ...config, fetchImpl: async (url, options) => {
      if (url !== resolved.baseUrl + '/chat/completions' || options.method !== 'POST' || posts >= 1) throw new Error('One-review paid budget exceeded.');
      posts++;
      log('request', { host: new URL(url).hostname, model: resolved.model });
      const response = await network.fetch(url, { ...options, credentials: 'omit' });
      if (response.ok) {
        const value = await response.clone().json();
        log('usage', { finishReason: value.choices?.[0]?.finish_reason, usage: value.usage });
      } else log('http', { status: response.status });
      return response;
    } });
    const instrumented = { ...reviewer, generate: (instruction, input, validate) => reviewer.generate(instruction, input, judgment => {
      const body = input.target.text || input.target.questions.map(q => [q.prompt, ...q.options, q.explanation].join('\n')).join('\n');
      const normalized = normalizeFactEvidence(normalizeFactJudgment(judgment, target.type), input.sources);
      log('validation', { rawValid: validFactJudgment(judgment, target.type, target.content, input.sources),
        valid: validFactJudgment(normalized, target.type, target.content, input.sources),
        problems: factJudgmentProblems(normalized, target.type, target.content, input.sources),
        fields: Object.keys(judgment || {}), summaryLength: judgment?.summary?.length,
        solutions: judgment?.solutions, issueCount: judgment?.issues?.length,
        issues: Array.isArray(judgment?.issues) ? judgment.issues.map(i => ({ fields: Object.keys(i || {}), kind: i?.kind, certainty: i?.certainty,
          quoteLength: i?.quote?.length, exactQuote: typeof i?.quote === 'string' && body.includes(i.quote),
          quotePreview: typeof i?.quote === 'string' ? i.quote.slice(0, 160) : undefined,
          reasonLength: i?.reason?.length, suggestionLength: i?.suggestion?.length,
          evidence: Array.isArray(i?.evidence) ? i.evidence.map(e => ({ id: e?.id, quoteLength: e?.quote?.length,
            exactQuote: input.sources.some(s => s.id === e?.id && typeof e?.quote === 'string' && s.quote.includes(e.quote)) })) : typeof i?.evidence })) : undefined });
      return validate(judgment);
    }) };
    const generator = { status: () => ({ mode: 'ai', provider: 'diagnostic', model: 'no-generation' }),
      generate: async () => { throw new Error('Correction requests forbidden in this one-review diagnostic.'); } };
    const checker = createFactCheckService({ learning: { getLesson: () => detail, overview: () => ({ plans: [plan] }) },
      getReviewer: () => instrumented, getGenerator: () => generator, getReviewerConfig: () => config });
    log('start', { lessonId, blockId, title: target.title, sourceCount: target.content.grounding?.citations?.length || 0, maxRequests: 1, readOnly: true });
    const result = await checker.process(lessonId, blockId, target.content);
    if (JSON.stringify(detail) !== before || !sameFactContent(target.content, result.content)) throw new Error('Diagnostic altered content.');
    log('result', { status: result.record.status, error: safe(result.record.error), issues: result.record.issues.length,
      contentPreserved: true, saved: false, retried: false });
    exitCode = result.record.status === 'failed' ? 1 : 0;
  } catch (e) { log('failed', { error: safe(e.message) }); }
  finally { app.exit(exitCode); }
});
