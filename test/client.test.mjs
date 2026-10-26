import test from 'node:test';
import { createGenerationProgress } from '../public/generation-progress.js';
import { generationCancelled, isGenerationCancelled } from '../public/task-cancellation.js';
import { factCheckLabels, sameFactContent } from '../public/fact-check.js';
import { masteredQuizQuestions, quizRecordAfterChange, quizQuestionKey, quizInitialCount, quizBatchLimit, quizQuestionLimit } from '../public/quiz-progress.js';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { demoPlan, demoLessons } from '../public/demo.js';
import { lessonFromBlocks, validOutline, validBlockContent, validBlockSpec, blockGenerationContext, revisedContent, restoredContent, assistedBlockTypes } from '../public/blocks.js';
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer } from '../public/markdown.js';
import { validQuestionnaire, validClarification, learningBriefFrom } from '../public/planning.js';
import { questionnaire, clarification } from '../test-support/planning.mjs';
import { validIllustration, validImageProposal } from '../public/illustrations.js';
import { speechDefaults, speechVoices, listeningText, speechTurns, speechRequest, validAudioId } from '../public/speech.js';
import { validKnowledgeSource, validKnowledgeDraft, localKnowledgeDraft, knowledgeTags, knowledgeConditions } from '../public/knowledge-draft.js';
import { validAnnotations, personalNotesForSource, personalNotesMarkdown } from '../public/annotations.js';
import { knowledgeCatalog, knowledgeDomain, knowledgeDomainColors, knowledgeTopic, retrieveKnowledge, validKnowledgeOrganization } from '../public/knowledge-index.js';
import { courseKnowledgeTree, knowledgeTree, knowledgeGraph, filterKnowledgeGraph } from '../public/knowledge-views.js';
import { createGraphMotion, stepGraphMotion } from '../public/graph-motion.js';
import { qualityRubric, qualityLabels, qualityModelId } from '../public/course-quality.js';
import { teachingContextNotice } from '../public/teaching-context.js';
import { officialSource, validSourceSearch, courseReferences } from '../public/course-sources.js';
import { revisionTypes, revisionStatuses, revisionCheckLabels, revisionContent, revisionText, revisionDiff } from '../public/course-revision.js';
const DOMPurify = createDOMPurify(new JSDOM('').window);
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .* from '\.\/[^']+';$/gm, '');

test('sidebar uses the local company wordmark on every page and keeps its home navigation accessible', () => {
  const app = harness();
  for (const page of ['home', 'routes', 'study', 'practice', 'wiki', 'settings']) {
    app.run(`navigate('${page}')`);
    const doc = new JSDOM(app.node('#app').innerHTML).window.document;
    const brand = doc.querySelector('.sidebar .brand');
    assert.ok(brand.classList.contains('company-brand'));
    assert.equal(brand.dataset.page, 'home');
    assert.equal(brand.getAttribute('aria-label'), '贝内克长顺 · 返回首页');
    assert.equal(brand.querySelector('img').getAttribute('src'), '/benecke-changshun-logo.png');
    assert.equal(brand.querySelector('img').getAttribute('alt'), '贝内克长顺 BENECKE CHANGSHUN');
    assert.equal(brand.querySelector('img').getAttribute('width'), '1069');
    assert.equal(brand.querySelector('img').getAttribute('height'), '380');
    assert.equal(brand.querySelector('span'), null, 'old application wordmark is not shown beside the company logo');
  }
});

test('desktop settings keep four model roles on one expandable page with direct keys and grouped data actions', async () => {
  const app = harness(null, null, { load: async () => ({ settings: { provider: 'ollama', hasApiKey: true }, status: { mode: 'demo' }, imageSettings: { hasApiKey: true }, speechSettings: { hasApiKey: true } }) });
  await Promise.resolve(); app.run("navigate('settings')");
  const doc = new JSDOM(app.node('#app').innerHTML).window.document;
  assert.equal(doc.querySelectorAll('.model-settings-grid > .model-settings-card').length, 4);
  assert.equal(doc.querySelector('#settings-generator').open, true);
  for (const id of ['reviewer', 'images', 'speech']) assert.equal(doc.querySelector('#settings-' + id).open, false);
  for (const id of ['desktop-settings-form', 'quality-settings-form', 'image-settings-form', 'speech-settings-form']) {
    const form = doc.getElementById(id);
    assert.ok(form.closest('.model-settings-grid'));
    assert.equal(form.querySelector('[name=apiKey]').value, '');
    assert.match(form.querySelector('[name=apiKey]').placeholder, /留空保留|没有可留空/);
    assert.equal(form.querySelector('select[name=keyAction]'), null);
    assert.equal(form.querySelector('[name=keyAction]').type, 'hidden');
    assert.equal(form.querySelector('.model-advanced').open, false);
    if (id !== 'quality-settings-form') assert.ok(form.querySelector('[data-action=clear-model-key]'));
    assert.equal(form.querySelector('[data-model-check]').type, 'button');
  }
  assert.ok(doc.querySelector('.settings-data-panel'));
  assert.equal(doc.querySelector('.model-settings-grid .settings-data-panel'), null);
  assert.ok(doc.querySelector('#web-search-settings-form').closest('#settings-images'));
  assert.equal(doc.querySelectorAll('.settings-data-groups > section').length, 3);
  assert.equal(doc.querySelectorAll('.settings-section-nav button').length, 2);
  assert.match(doc.querySelector('#settings-data').textContent, /不含模型配置、密钥和朗读音频/);
});

test('direct API key entry automatically replaces keys for every model; blank preserves and explicit clear deletes', async () => {
  const saves = [];
  const safe = input => { saves.push(input); const { apiKey, keyAction, ...cfg } = input; return cfg; };
  const app = harness(null, null, { load: async () => ({ settings: {}, status: { mode: 'demo' } }),
    saveSettings: async input => ({ settings: safe(input), status: { mode: 'demo' } }), saveImageSettings: async input => safe(input), saveSpeechSettings: async input => safe(input) });
  await Promise.resolve();
  for (const form of ['desktop-settings-form', 'image-settings-form', 'speech-settings-form']) {
    const fields = { model: 'test', baseUrl: 'http://localhost:8000/v1', timeout: '180', rate: '1', maxTokens: '8192' };
    await app.submit(form, { ...fields, apiKey: 'local-test-only' });
    assert.equal(saves.at(-1).keyAction, 'replace');
    assert.equal(saves.at(-1).apiKey, 'local-test-only');
    await app.submit(form, { ...fields, apiKey: '' });
    assert.equal(saves.at(-1).keyAction, 'keep');
    await app.submit(form, { ...fields, apiKey: '', keyAction: 'clear' });
    assert.equal(saves.at(-1).keyAction, 'clear');
    await app.submit(form, { ...fields, apiKey: 'new-test-key', keyAction: 'clear' });
    assert.equal(saves.at(-1).keyAction, 'replace');
  }
  assert.ok(!app.node('#app').innerHTML.includes('local-test-only'));
  assert.equal(app.storage.size, 0);
});

test('settings expansions persist only layout booleans, keep drafts across folding and navigation and never contact models', async t => {
  const layoutSaves = [];
  const cfg = { provider: 'ollama', model: 'generator', baseUrl: '', localOnly: true, jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192 };
  const app = realSettingsHarness({ load: async () => ({ settings: cfg, status: { mode: 'ai', model: cfg.model }, settingsLayout: { generator: false, reviewer: true, images: false, speech: true } }),
    saveSettingsLayout: async value => { layoutSaves.push(value); }, request: async () => { throw new Error('Opening settings must not contact models'); } });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  const doc = app.document;
  assert.equal(doc.querySelector('#settings-generator').open, false);
  assert.equal(doc.querySelector('#settings-reviewer').open, true);
  const field = doc.querySelector('#model-key'); field.value = 'unsaved-layout-test-key'; await app.fire('input', field);
  await app.fire('click', doc.querySelector('#settings-generator > summary'));
  assert.equal(doc.querySelector('#settings-generator').open, true);
  app.run("navigate('wiki'); navigate('settings')");
  assert.equal(doc.querySelector('#settings-generator').open, true);
  assert.equal(doc.querySelector('#settings-reviewer').open, true);
  assert.equal(doc.querySelector('#model-key').value, 'unsaved-layout-test-key');
  assert.match(doc.querySelector('#settings-state-desktop-settings-form').textContent, /修改未保存/);
  assert.equal(layoutSaves.length, 1);
  assert.deepEqual(Object.keys(layoutSaves[0]).sort(), ['generator', 'images', 'reviewer', 'speech']);
  assert.ok(Object.values(layoutSaves[0]).every(value => typeof value === 'boolean'));
  assert.ok(!JSON.stringify(layoutSaves).includes('unsaved-layout-test-key'));
});

test('saved is not verified; explicit connection checks update status, dirty drafts block testing and saves reset checks', async t => {
  const cfg = { provider: 'ollama', model: 'generator', baseUrl: '', localOnly: true, jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192 };
  let calls = 0;
  const app = realSettingsHarness({ load: async () => ({ settings: cfg, status: { mode: 'ai', model: cfg.model } }),
    request: async () => { if (++calls === 2) throw new Error('模拟鉴权失败'); return { provider: 'ollama', model: cfg.model, latencyMs: 100 }; },
    saveSettings: async value => { const { apiKey, keyAction, ...settings } = value; return { settings, status: { mode: 'ai', model: settings.model } }; } });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  const doc = app.document;
  assert.match(doc.querySelector('#settings-state-desktop-settings-form').textContent, /已保存/);
  assert.match(doc.querySelector('#settings-check-desktop-settings-form').textContent, /未验证/);
  assert.equal(calls, 0);
  await app.fire('click', doc.querySelector('[data-action=test-connection]'));
  assert.equal(calls, 1); assert.match(doc.querySelector('#settings-check-desktop-settings-form').textContent, /最近检查通过/);
  const model = doc.querySelector('#model-name'); model.value = 'new-generator'; await app.fire('input', model);
  assert.equal(doc.querySelector('[data-action=test-connection]').disabled, true);
  await app.fire('click', doc.querySelector('[data-action=test-connection]')); assert.equal(calls, 1);
  await app.fire('submit', doc.querySelector('#desktop-settings-form'));
  assert.match(doc.querySelector('#settings-state-desktop-settings-form').textContent, /已保存/);
  assert.match(doc.querySelector('#settings-check-desktop-settings-form').textContent, /未验证/);
  assert.equal(doc.querySelector('[data-action=test-connection]').disabled, false);
  assert.equal(calls, 1, 'Saving must not automatically test');
  await app.fire('click', doc.querySelector('[data-action=test-connection]'));
  assert.match(doc.querySelector('#settings-check-desktop-settings-form').textContent, /检查失败/);
  assert.match(doc.querySelector('#connection-result').textContent, /模拟鉴权失败/);
});

test('late connection results cannot validate a changed saved configuration, and in-flight saves lock only their own fields', async t => {
  const cfg = { provider: 'ollama', model: 'generator', baseUrl: '', localOnly: true, jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192 };
  let finishCheck, finishSave;
  const app = realSettingsHarness({ load: async () => ({ settings: cfg, status: { mode: 'ai', model: cfg.model } }),
    request: () => new Promise(resolve => { finishCheck = resolve; }),
    saveSettings: value => new Promise(resolve => { finishSave = () => { const { apiKey, keyAction, ...settings } = value; resolve({ settings, status: { mode: 'ai', model: settings.model } }); }; }) });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  const doc = app.document;
  const checking = app.fire('click', doc.querySelector('[data-action=test-connection]'));
  await Promise.resolve();
  const field = doc.querySelector('#model-name'); field.value = 'changed'; await app.fire('input', field);
  const saving = app.fire('submit', doc.querySelector('#desktop-settings-form'));
  await Promise.resolve();
  assert.equal(field.disabled, true); assert.equal(doc.querySelector('#image-model-name').disabled, false);
  finishSave(); await saving;
  finishCheck({ provider: 'ollama', model: 'generator', latencyMs: 100 }); await checking;
  assert.match(doc.querySelector('#settings-check-desktop-settings-form').textContent, /未验证/);
  assert.match(doc.querySelector('#connection-result').textContent, /配置已保存/);
  assert.equal(doc.querySelector('#model-name').disabled, false);
});

test('settings warn before closing unsaved drafts, preserve stored configuration and point dependent tools to expanded settings', async t => {
  const cfg = { provider: 'ollama', model: 'generator', baseUrl: '', localOnly: true, jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192 };
  const app = realSettingsHarness({ load: async () => ({ settings: cfg, status: { mode: 'ai', model: cfg.model }, qualitySettings: { ...cfg, model: 'reviewer' } }),
    saveSettings: async value => { const { apiKey, keyAction, ...settings } = value; return { settings, status: { mode: 'ai', model: settings.model } }; } });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  assert.equal(app.run("window.dispatchEvent(new window.Event('beforeunload', {cancelable:true}))"), true);
  const field = app.document.querySelector('#model-name'); field.value = ' REVIEWER:latest '; await app.fire('input', field);
  assert.match(app.document.querySelector('#model-conflict').textContent, /另一角色/);
  assert.equal(app.run("window.dispatchEvent(new window.Event('beforeunload', {cancelable:true}))"), false);
  assert.equal(app.run('desktopSettings.model'), 'generator');
  field.value = 'new-generator'; await app.fire('input', field); await app.fire('submit', app.document.querySelector('#desktop-settings-form'));
  assert.equal(app.run("window.dispatchEvent(new window.Event('beforeunload', {cancelable:true}))"), true);
  app.document.querySelector('.web-search-settings-panel').scrollIntoView = () => {};
  await app.run("action('quality-settings', {dataset:{}})");
  assert.equal(app.document.querySelector('#settings-reviewer').open, true);
  app.document.querySelector('#illustration-dialog')?.close?.();
  app.run("jumpToSettings('images')");
  assert.equal(app.document.querySelector('#settings-images').open, true);
  app.document.querySelector('#web-search-settings-form [name=enabled]').checked = true;
  await app.fire('change', app.document.querySelector('#web-search-settings-form [name=enabled]'));
  assert.match(app.document.querySelector('#settings-web-state').textContent, /修改未保存/);
  assert.equal(app.run('imageSettings?.enabled || false'), false);
});

test('visiting a saved provider without editing its parameters does not leave a phantom unsaved-service warning after save', async t => {
  const cfg = { provider: 'ollama', model: 'generator', baseUrl: '', localOnly: true, jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192, hasApiKey: false };
  const cloud = { ...cfg, provider: 'qwen', model: 'cloud-generator', baseUrl: 'https://example.org/v1', localOnly: false };
  const saved = { ...cfg, profiles: { ollama: cfg, qwen: cloud } };
  const app = realSettingsHarness({ load: async () => ({ settings: saved, status: { mode: 'ai', model: cfg.model } }),
    saveSettings: async () => ({ settings: saved, status: { mode: 'ai', model: cfg.model } }) });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  const select = app.document.querySelector('#model-provider');
  select.value = 'qwen'; await app.fire('change', select);
  select.value = 'ollama'; await app.fire('change', select);
  await app.fire('submit', app.document.querySelector('#desktop-settings-form'));
  assert.equal(app.run('hasUnsavedModelSettings()'), false);
  assert.equal(app.document.querySelector('#settings-unsaved-note').hidden, true);
});

test('custom model thinking mode survives profile switching, navigation and saving for generation and review', async t => {
  const custom = { provider: 'compatible', model: 'qwen-27b', baseUrl: 'http://localhost:8000/v1', localOnly: true, jsonMode: 'auto', thinkingMode: 'off', timeoutMs: 120000, maxTokens: 10000 };
  const local = { ...custom, provider: 'ollama', model: 'other-local-model', baseUrl: 'http://localhost:11434', thinkingMode: 'auto' };
  const saves = [], checks = [];
  const app = realSettingsHarness({ load: async () => ({ settings: { ...custom, profiles: { compatible: custom, ollama: local } }, qualitySettings: { ...custom, model: 'review-model' }, status: { mode: 'ai' }, qualityStatus: { mode: 'ai' } }),
    saveSettings: async value => { saves.push(value); return { settings: value, status: { mode: 'ai' } }; },
    saveQualitySettings: async value => { saves.push(value); return { settings: value, status: { mode: 'ai' } }; },
    request: async path => { checks.push(path); return { provider: 'custom', model: 'qwen-27b', latencyMs: 10 }; }
  });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  const doc = app.document;
  assert.equal(doc.querySelector('#model-thinking').value, 'off');
  assert.equal(doc.querySelector('#quality-thinking').value, 'off');
  const form = doc.querySelector('#desktop-settings-form'), provider = form.elements.namedItem('provider');
  provider.value = 'ollama'; await app.fire('change', provider);
  assert.equal(doc.querySelector('#model-thinking').value, 'auto');
  provider.value = 'compatible'; await app.fire('change', provider);
  assert.equal(doc.querySelector('#model-thinking').value, 'off');
  const thinking = doc.querySelector('#model-thinking'); thinking.value = 'auto'; await app.fire('change', thinking);
  assert.equal(doc.querySelector('[data-action="test-connection"]').disabled, true);
  app.run("navigate('wiki'); navigate('settings')");
  assert.equal(doc.querySelector('#model-thinking').value, 'auto');
  const restored = doc.querySelector('#model-thinking'); restored.value = 'off'; await app.fire('change', restored);
  await app.fire('submit', doc.querySelector('#desktop-settings-form'));
  assert.equal(saves[0].thinkingMode, 'off'); assert.equal(saves[0].maxTokens, 10000);
  await app.fire('click', doc.querySelector('[data-action="test-connection"]'));
  assert.deepEqual(checks, ['test-connection']);
  assert.match(doc.querySelector('#connection-result').textContent, /连接成功/);
  await app.fire('submit', doc.querySelector('#quality-settings-form'));
  assert.equal(saves[1].thinkingMode, 'off'); assert.equal(saves[1].model, 'review-model');
});

test('configuration saves cannot race across the three model cards', async () => {
  let finish, calls = 0;
  const app = harness(null, null, { load: async () => ({ settings: {}, status: { mode: 'demo' } }),
    saveSettings: async () => { calls++; await new Promise(resolve => { finish = resolve; }); return { settings: {}, status: { mode: 'demo' } }; },
    saveImageSettings: async () => { calls++; return {}; } });
  await Promise.resolve();
  const first = app.submit('desktop-settings-form', { apiKey: '', timeout: '120', maxTokens: '8192' });
  await app.submit('image-settings-form', { apiKey: '', timeout: '180' });
  assert.equal(calls, 1);
  finish(); await first;
  await app.submit('image-settings-form', { apiKey: '', timeout: '180' });
  assert.equal(calls, 2);
});

test('independent reviewer saves only its role and preserves generator drafts; rejected mutual model keeps the key draft', async t => {
  const generation = { provider: 'ollama', model: 'generator-a', baseUrl: '', localOnly: true, jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192, hasApiKey: false };
  let reviewer = { ...generation, model: 'reviewer-b' }, reviews = 0, saves = [];
  const app = realSettingsHarness({ load: async () => ({ settings: generation, status: { mode: 'ai', model: generation.model }, qualitySettings: reviewer, qualityStatus: { mode: 'ai', model: reviewer.model } }),
    evaluateQuality: async () => { reviews++; },
    saveQualitySettings: async value => {
      saves.push(value);
      if (value.model === generation.model) throw new Error('生成与评审模型必须不同。');
      const { apiKey, keyAction, ...cfg } = value; reviewer = { ...cfg, hasApiKey: !!apiKey };
      return { settings: reviewer, status: { mode: 'ai', model: reviewer.model } };
    } });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  let form = app.document.querySelector('#quality-settings-form');
  assert.equal(form.elements.namedItem('apiKey').value, '');
  assert.equal(form.querySelector('select[name=keyAction]'), null);
  const generatorField = app.document.querySelector('#model-name');
  generatorField.value = 'pending-generation-draft'; await app.fire('input', generatorField);
  form.elements.namedItem('apiKey').value = 'review-only-test-key';
  await app.fire('input', form.elements.namedItem('apiKey')); await app.fire('submit', form);
  assert.equal(saves.length, 1); assert.equal(saves[0].keyAction, 'replace');
  assert.equal(saves[0].apiKey, 'review-only-test-key');
  assert.equal(app.document.querySelector('#model-name').value, 'pending-generation-draft');
  assert.equal(app.run('desktopSettings.model'), generation.model); assert.equal(reviews, 0);
  form = app.document.querySelector('#quality-settings-form');
  form.elements.namedItem('model').value = generation.model;
  form.elements.namedItem('apiKey').value = 'keep-rejected-draft';
  await app.fire('input', form.elements.namedItem('model')); await app.fire('submit', form);
  assert.match(app.document.querySelector('#quality-settings-error').textContent, /必须不同/);
  assert.equal(form.elements.namedItem('apiKey').value, 'keep-rejected-draft');
  assert.equal(app.run('qualitySettings.model'), 'reviewer-b'); assert.equal(reviews, 0);
});

test('course scores clearly label unlocated opinions, collapse details and escape model text without restoring revision tools', async t => {
  const report={id:'score-current',scope:'lesson',targetId:'p1',fingerprint:'current',created:Date.now(),reviewer:{model:'reviewer-b'},partial:false,score:100,status:'reviewed',summary:'评分不代表事实已经核验。',dimensions:qualityRubric.map(r=>({id:r.id,rating:4,reason:'模型维度评估。'})),issues:[],
    unverifiedIssues:[{unitId:'section-0',severity:'critical',kind:'fact',origin:'ai',quote:'<img src=x onerror=alert(1)>',reason:'<script>not executable</script>',suggestion:'核对原文后判断。'}]};
  const old={...report,id:'score-old',unverifiedIssues:undefined};
  const view={scope:'lesson',targetId:'p1',title:'测试课程',objective:'解释方法',fingerprint:'current',rules:{ready:1,total:1,partial:false,issues:[]},units:[{id:'section-0',title:'讲解',pending:false}],reports:[report,old],currentReportId:report.id};
  let calls=0;
  const app=realSettingsHarness({load:async()=>({status:{mode:'ai'},qualityStatus:{mode:'ai'}}),inspectQuality:async()=>view,evaluateQuality:async()=>{calls++;throw new Error('Opening must not evaluate');}});
  t.after(()=>app.close());await app.ready();const before=app.run('JSON.stringify(state.lessons)');
  await app.run("openQuality('lesson','p1')");
  const dialog=app.document.querySelector('#quality-dialog'),notice=dialog.querySelector('.quality-unverified-notice');
  assert.match(dialog.textContent,/100/);assert.match(notice.textContent,/有 1 条辅助意见/);assert.match(notice.textContent,/不作为已确认错误/);
  assert.equal(dialog.querySelector('.quality-score').nextElementSibling,notice,'the unverified boundary appears directly beneath the score');
  assert.match(notice.textContent,/保留模型原评估/);assert.equal(notice.querySelector('details').open,false);
  assert.equal(notice.querySelector('img,script'),null);assert.match(notice.textContent,/<script>not executable<\/script>/);
  assert.equal(dialog.querySelector('[data-action=quality-locate],.quality-legacy-tools,[name=revision-issue]'),null);
  app.run("qualityView.selectedReportId='score-old';renderQualityDialog()");
  assert.equal(app.document.querySelector('.quality-unverified-notice'),null);
  assert.equal(calls,0);assert.equal(app.run('JSON.stringify(state.lessons)'),before);
});
test('opening quality reports never evaluates automatically, and failures preserve existing reports and course data', async t => {
  const report = { id: 'review-old', scope: 'lesson', targetId: 'p1', fingerprint: 'old-content', created: Date.now(), reviewer: { model: 'reviewer-b' }, generator: { model: 'generator-a' }, rubricVersion: 'course-quality-v1', partial: true, score: 75, status: 'needs_revision', summary: '旧内容的审查建议。', dimensions: qualityRubric.map(r => ({ id: r.id, rating: 3, reason: '需要更多可验证的例子。' })), issues: [{ unitId: 'section-0', severity: 'minor', origin: 'ai', quote: '<script>not executable</script>', reason: '解释应更具体。', suggestion: '补充例子。' }] };
  const view = { scope: 'lesson', targetId: 'p1', title: '测试课程', objective: '验证学习目标', fingerprint: 'current-content', rules: { ready: 1, total: 2, partial: true, issues: [] }, units: [{ id: 'section-0', title: '讲解', objective: '目标', pending: false }], reports: [report], currentReportId: null };
  let inspections = 0, reviews = 0;
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai', model: 'generator-a' }, qualityStatus: { mode: 'ai', model: 'reviewer-b' } }), inspectQuality: async () => { inspections++; return view; }, evaluateQuality: async () => { reviews++; throw new Error('评审模型暂时不可用。'); } });
  t.after(() => app.close()); await app.ready();
  const courseBefore = app.run('JSON.stringify(state.lessons)');
  await app.run("openQuality('lesson','p1')");
  const dialog = app.document.querySelector('#quality-dialog');
  assert.equal(dialog.open, true); assert.equal(inspections, 1); assert.equal(reviews, 0);
  assert.match(dialog.textContent, /旧内容版本/); assert.match(dialog.textContent, /未经人工校准/);
  assert.equal(dialog.querySelector('script'), null);
  assert.equal(dialog.querySelector('[data-action=quality-locate]'), null);
  assert.equal(dialog.querySelector('[name=revision-issue]'), null);
  await app.run('evaluateQuality()');
  assert.equal(reviews, 1); assert.equal(dialog.open, true);
  assert.match(dialog.textContent, /评审模型暂时不可用/);
  assert.equal(app.run('qualityView.reports[0].id'), report.id);
  assert.equal(app.run('JSON.stringify(state.lessons)'), courseBefore);
});

test('course scoring is read-only and exposes only scores, reasons and history, even with legacy revision records', async t => {
  const report = { id: 'score-1', scope: 'lesson', targetId: 'p1', fingerprint: 'current', score: 75, status: 'needs_revision', partial: false,
    summary: '例子与目标仍有提升空间。', created: Date.now(), reviewer: { model: 'reviewer-b' }, generator: { model: 'generator-a' },
    dimensions: qualityRubric.map(r => ({ id: r.id, rating: 3, reason: '补充解释有助于理解。' })),
    issues: [{ unitId: 'reading-1', severity: 'major', kind: 'clarity', reason: '旧问题', quote: '原文', suggestion: '旧建议', origin: 'ai' }] };
  const view = { scope: 'lesson', targetId: 'p1', title: '测试课', objective: '理解提交', fingerprint: 'current',
    units: [{ id: 'reading-1', type: 'reading', title: '讲解', objective: '理解', text: '原文' }],
    rules: { ready: 1, total: 2, partial: true, issues: report.issues }, reports: [report], currentReportId: report.id,
    jobs: [{ id: 'old-job', status: 'draft', updated: Date.now() }], dispositions: [{ status: 'verify' }] };
  let paid = 0, revisions = 0;
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' }, qualityStatus: { mode: 'ai' } }),
    inspectQuality: async () => structuredClone(view),
    evaluateQuality: async () => { paid++; return { ...view, reports: [{ ...report, id: 'score-2', score: 90, status: 'reviewed' }, report] }; },
    createRevision: async () => { revisions++; }, saveQualityDisposition: async () => { revisions++; } });
  t.after(() => app.close()); await app.ready(); app.run("navigate('routes')");
  const doc = app.document;
  assert.equal(doc.querySelector('[data-action=open-quality]').textContent, '课程评分');
  assert.equal(doc.querySelector('.quality-legacy-tools'), null);
  const before = app.run('JSON.stringify(state.lessons)');
  await app.run("openQuality('lesson','p1')");
  const dialog = doc.querySelector('#quality-dialog');
  assert.equal(doc.querySelector('#quality-title').textContent, '课程评分');
  assert.match(dialog.querySelector('.quality-score').textContent, /75/);
  assert.equal(dialog.querySelectorAll('.quality-dimensions details').length, 7);
  assert.equal(dialog.querySelectorAll('input, textarea, .quality-issue, .quality-objectives, .quality-revision-entry').length, 0);
  assert.deepEqual(Array.from(dialog.querySelectorAll('[data-action]'), n => n.dataset.action).sort(), ['close-quality', 'evaluate-quality']);
  assert.equal(doc.querySelector('#quality-revision-dialog'), null);
  assert.equal(paid, 0); assert.equal(revisions, 0);
  await app.run('evaluateQuality()');
  assert.equal(paid, 1); assert.equal(revisions, 0);
  assert.match(dialog.querySelector('.quality-score').textContent, /90/);
  const history = doc.querySelector('#quality-report-select'); history.value = report.id; await app.fire('change', history);
  assert.match(dialog.querySelector('.quality-score').textContent, /75/);
  assert.equal(paid, 1); assert.equal(app.run('JSON.stringify(state.lessons)'), before);
});

test('web search consent uses a real keyless DOM form, persists checked and unchecked values and reloads', async t => {
  let saved = { enabled: false, error: '' }, saves = 0;
  const bridge = { load: async () => ({ settings: {}, status: { mode: 'demo' }, webSearchSettings: saved }),
    saveWebSearchSettings: async value => { saves++; assert.deepEqual(Object.keys(value), ['enabled']); saved = { enabled: value.enabled, error: '' }; return saved; } };
  const app = realSettingsHarness(bridge); t.after(() => app.close());
  await app.ready(); app.run("navigate('settings')");
  const connection = app.document.querySelector('#connection-result').textContent;
  let form = app.document.querySelector('#web-search-settings-form');
  assert.equal(form.elements.namedItem('apiKey'), null);
  form.elements.namedItem('enabled').checked = true;
  await app.fire('input', form.elements.namedItem('enabled'));
  await app.fire('change', form.elements.namedItem('enabled'));
  assert.equal(app.document.querySelector('#connection-result').textContent, connection);
  // An unrelated model save/render must not lose pending consent or read a missing key.
  app.run('render()'); form = app.document.querySelector('#web-search-settings-form');
  assert.equal(form.elements.namedItem('enabled').checked, true);
  await app.fire('submit', form);
  assert.equal(saves, 1); assert.equal(saved.enabled, true);
  assert.equal(app.run('modelSettingsSaving'), false);
  assert.equal(app.document.querySelector('#web-search-settings-form [name=enabled]').checked, true);
  assert.match(app.document.querySelector('#web-search-settings-result').textContent, /已启用并保存/);
  const reloaded = realSettingsHarness(bridge); t.after(() => reloaded.close());
  await reloaded.ready(); reloaded.run("navigate('settings')");
  form = reloaded.document.querySelector('#web-search-settings-form');
  assert.equal(form.elements.namedItem('enabled').checked, true);
  form.elements.namedItem('enabled').checked = false;
  await reloaded.fire('change', form.elements.namedItem('enabled'));
  await reloaded.fire('submit', form);
  assert.equal(saves, 2); assert.equal(saved.enabled, false);
  assert.equal(reloaded.document.querySelector('#web-search-settings-form [name=enabled]').checked, false);
  assert.match(reloaded.document.querySelector('#web-search-settings-result').textContent, /已关闭并保存/);
});

test('web search save failures remain on the same form and preserve the consent draft for retry', async t => {
  let calls = 0;
  const app = realSettingsHarness({ load: async () => ({ settings: {}, status: { mode: 'demo' }, webSearchSettings: { enabled: false } }),
    saveWebSearchSettings: async value => { if (++calls === 1) throw new Error('测试保存失败'); return { enabled: value.enabled }; } });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  const form = app.document.querySelector('#web-search-settings-form');
  form.elements.namedItem('enabled').checked = true;
  await app.fire('change', form.elements.namedItem('enabled'));
  await app.fire('submit', form);
  assert.match(app.document.querySelector('#web-search-settings-error').textContent, /测试保存失败/);
  assert.equal(form.elements.namedItem('enabled').checked, true);
  assert.equal(form.querySelector('[type=submit]').disabled, false);
  assert.equal(app.run('modelSettingsSaving'), false);
  assert.equal(app.run('webSearchSettings.enabled'), false);
  await app.fire('submit', form);
  assert.equal(app.run('webSearchSettings.enabled'), true); assert.equal(calls, 2);
});

test('LLM provider selection restores saved parameters and drafts without changing the backend or exposing stored keys', async t => {
  const local = { provider: 'ollama', model: 'local-model', baseUrl: 'http://localhost:11434', localOnly: true, jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192, hasApiKey: false };
  const cloud = { provider: 'qwen', model: 'qwen-test', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', localOnly: false, jsonMode: 'off', timeoutMs: 90000, maxTokens: 4096, hasApiKey: true };
  let calls = 0, input;
  const app = realSettingsHarness({ load: async () => ({ settings: { ...local, profiles: { ollama: local, qwen: cloud } }, status: { mode: 'ai', provider: 'ollama' } }),
    saveSettings: async value => { calls++; input = value; return { settings: { ...cloud, profiles: { ollama: local, qwen: cloud } }, status: { mode: 'ai', provider: 'qwen' } }; } });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  const doc = app.document;
  doc.querySelector('#model-name').value = 'local-draft'; doc.querySelector('#model-key').value = 'local-draft-key';
  doc.querySelector('#model-provider').value = 'qwen'; await app.fire('input', doc.querySelector('#model-provider')); await app.fire('change', doc.querySelector('#model-provider'));
  assert.equal(doc.querySelector('#model-name').value, cloud.model); assert.equal(doc.querySelector('#model-url').value, cloud.baseUrl);
  assert.equal(doc.querySelector('#model-timeout').value, '90'); assert.equal(doc.querySelector('#model-tokens').value, '4096');
  assert.equal(doc.querySelector('#json-mode').value, 'off'); assert.equal(doc.querySelector('#desktop-settings-form [name=localOnly]').checked, false);
  assert.equal(doc.querySelector('#model-key').value, ''); assert.match(doc.querySelector('#model-key').placeholder, /已保存/);
  assert.equal(calls, 0); assert.equal(app.run('desktopSettings.provider'), 'ollama');
  doc.querySelector('#model-provider').value = 'ollama'; await app.fire('change', doc.querySelector('#model-provider'));
  assert.equal(doc.querySelector('#model-name').value, 'local-draft'); assert.equal(doc.querySelector('#model-key').value, 'local-draft-key');
  doc.querySelector('#model-provider').value = 'qwen'; await app.fire('change', doc.querySelector('#model-provider'));
  app.run('render()'); assert.equal(doc.querySelector('#model-key').value, ''); assert.match(doc.querySelector('#model-key').placeholder, /已保存/);
  await app.fire('submit', doc.querySelector('#desktop-settings-form'));
  assert.equal(calls, 1); assert.equal(input.provider, 'qwen'); assert.equal(input.keyAction, 'keep'); assert.equal(input.apiKey, '');
  assert.equal(doc.querySelector('#model-key').value, ''); assert.ok(!doc.querySelector('#app').innerHTML.includes('local-draft-key'));
  doc.querySelector('#model-provider').value = 'ollama'; await app.fire('change', doc.querySelector('#model-provider'));
  assert.equal(doc.querySelector('#model-key').value, 'local-draft-key');
});

test('AI speech previews do not synthesize; confirmation preserves the course and cached playback never calls a model', async () => {
  let posts = 0, plays = 0, pauses = 0;
  const text = 'Sarah: Hello, Mark.\nMark: Good morning.';
  const preview = { turns: [{ speaker: 'Sarah', text: 'Hello, Mark.', voice: 'longanlingxin', id: null }, { speaker: 'Mark', text: 'Good morning.', voice: 'longanlufeng', id: null }], newCount: 2, cachedCount: 0, pendingCount: 0, characters: 26 };
  const app = harness(null, null, { load: async () => ({ status: { mode: 'demo' }, settings: {}, speechSettings: { ...speechDefaults, enabled: true } }),
    prepareSpeech: async () => preview, generateSpeech: async value => { posts++; assert.equal(value.confirmed, true); assert.equal(value.mode, 'generate'); return { ...preview, newCount: 0, cachedCount: 2, turns: preview.turns.map(turn => ({ ...turn, id: 'a'.repeat(64) })) }; } });
  await Promise.resolve();
  app.run(`state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'听力',objective:'练习',content:{text:${JSON.stringify('中文讲解\n```text\n' + text + '\n```')}}}]}}; activeLesson='p1';page='study';render()`);
  await app.run("action('open-speech',{dataset:{id:'p1',block:'b1'}})");
  assert.equal(posts, 0); assert.equal(app.run('speechDraft.text'), text); assert.equal(app.node('#speech-dialog').open, true);
  assert.match(app.node('#speech-dialog').innerHTML, /确认生成 2 段/);
  app.node('#speech-material').value = text;
  await app.submit('speech-generate-form', {});
  assert.equal(posts, 1); assert.ok(app.run('state.blockCourses.p1.blocks[0].content.text').includes('中文讲解'));
  app.node('#speech-player').play = async () => { plays++; }; app.node('#speech-player').pause = () => { pauses++; };
  app.node('#speech-play-rate').value = '0.75';
  await app.run("action('play-speech-all',{dataset:{}})");
  assert.equal(plays, 1); assert.equal(app.node('#speech-player').src, '/course-audio/' + 'a'.repeat(64)); assert.equal(app.node('#speech-player').playbackRate, 0.75);
  await app.node('#speech-player').onended(); await Promise.resolve(); assert.equal(plays, 2); assert.equal(posts, 1);
  app.change('speech-play-rate', '1.25'); assert.equal(app.node('#speech-player').playbackRate, 1.25);
  await app.run("action('close-speech',{dataset:{}})"); assert.ok(pauses); assert.equal(app.node('#speech-dialog').open, false);
});
test('speech confirmation is single-flight; edits invalidate previews and failures keep partial cached segments', async () => {
  let posts = 0, finish;
  const preview = { turns: [{ speaker: '', text: 'Hello.', voice: 'longanlingxin', id: null }], newCount: 1, cachedCount: 0, pendingCount: 0, characters: 6 };
  const app = harness(null, null, { load: async () => ({ status: { mode: 'demo' }, settings: {}, speechSettings: { ...speechDefaults, enabled: true } }),
    prepareSpeech: async () => preview, generateSpeech: async () => { posts++; await new Promise(resolve => { finish = resolve; }); return { ...preview, pendingCount: 1, newCount: 0, error: '<script>下载失败</script>', turns: preview.turns.map(turn => ({ ...turn, pending: true, host: 'cdn.example' })) }; } });
  await Promise.resolve();
  await app.run("speechDraft={text:'Hello.',assignments:{},plan:null};renderSpeechDialog();document.querySelector('#speech-dialog').showModal()");
  await app.submit('speech-preview-form', { text: 'Hello.' }); app.node('#speech-material').value = 'Hello.';
  const first = app.submit('speech-generate-form', {}); await app.submit('speech-generate-form', {});
  await app.run("action('close-speech',{dataset:{}})"); assert.equal(app.node('#speech-dialog').open, true); assert.equal(posts, 1);
  finish(); await first;
  assert.match(app.node('#speech-dialog').innerHTML, /仅重试下载（不合成新片段）/); assert.ok(!app.node('#speech-dialog').innerHTML.includes('<script>'));
  app.input('speech-material', 'Changed.'); assert.equal(app.run('speechDraft.plan'), null);
  await app.submit('speech-generate-form', {}); assert.equal(posts, 1); assert.match(app.node('#speech-dialog').innerHTML, /重新预览/);
});
test('speech settings submit a separate key and keep save failures visible without replacing the prior configuration', async () => {
  const saves = [], old = { ...speechDefaults, enabled: false };
  const app = harness(null, null, { load: async () => ({ settings: {}, status: { mode: 'demo' }, speechSettings: old }), saveSpeechSettings: async value => { saves.push(value); if (saves.length === 1) throw new Error('仅本机冲突'); const { apiKey, keyAction, ...safe } = value; return { ...safe, hasApiKey: true, baseUrl: speechDefaults.baseUrl }; } });
  await Promise.resolve();
  const values = { enabled: 'on', model: speechDefaults.model, baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', voice: 'longanlingxin', otherVoice: 'longanlufeng', language: 'en', rate: '1', timeout: '180', downloadHosts: '', keyAction: 'replace', apiKey: 'speech-secret' };
  await app.submit('speech-settings-form', { ...values, localOnly: 'on' });
  assert.match(app.node('#speech-settings-error').textContent, /仅本机冲突/); assert.equal(app.run('speechSettings.enabled'), false);
  await app.submit('speech-settings-form', values);
  assert.equal(saves[1].apiKey, 'speech-secret'); assert.equal(saves[1].model, 'qwen-audio-3.0-tts-plus');
  assert.ok(!app.run('speechSettingsPanel()').includes('speech-secret')); assert.match(app.run('speechConnectionResult'), /同域名/);
});

test('desktop image suggestions never generate without confirmation; failed generation keeps text, prompt and current image', async () => {
  let generationCalls = 0;
  const image = {id:'a'.repeat(64),prompt:'旧图',caption:'旧图注',model:'image-test',created:1};
  const bridge = {
    load: async () => ({state:null,settings:{},status:{mode:'ai'},dataDirectory:'test',imageSettings:{enabled:true}}),
    generateIllustration: async value => {
      generationCalls++;
      if (generationCalls === 1) throw new Error('模拟生成失败');
      return {text:value.expectedText,illustration:{...image,id:'b'.repeat(64),prompt:value.prompt,caption:value.caption}};
    }
  };
  const app = harness(null, null, bridge); await Promise.resolve();
  app.run(`state.blockCourses = {p1:{intro:'测试',blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文',illustration:${JSON.stringify(image)}}},{id:'b2',type:'quiz',title:'测验',objective:'理解',content:null}]}}; activeLesson='p1';page='study';lessonTab='read';render()`);
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  assert.equal(generationCalls,0);
  assert.equal(app.node('#illustration-dialog').open,true);
  assert.match(app.node('#illustration-dialog').innerHTML,/可能计费/);
  await app.submit('illustration-form',{prompt:'新的配图',caption:'新的图注'});
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.illustration.id'),image.id);
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.text'),'原正文');
  assert.match(app.node('#illustration-error').textContent,/模拟生成失败/);
  assert.equal(app.run('illustrationDraft.prompt'),'新的配图');
  assert.equal(app.run('illustrationBusy'),false);
  await app.submit('illustration-form',{prompt:'新的配图',caption:'<script>caption</script>'});
  assert.equal(generationCalls,2);
  assert.equal(app.node('#illustration-dialog').open,false);
  assert.match(app.node('#app').innerHTML,/src="\/course-images\/b{64}"/);
  assert.ok(!app.node('#app').innerHTML.includes('<script>caption</script>'));
});
test('online image search is explicit, shows source and license, and only downloads after confirmation', async () => {
  let searches = 0, downloads = 0;
  const candidate = { pageId: 42, title: '<script>Heart</script>', author: 'Example Author', license: 'CC BY-SA 4.0', pageUrl: 'https://commons.wikimedia.org/wiki/File:Heart.png', preview: 'data:image/png;base64,AAAA' };
  const illustration = { id: 'c'.repeat(64), source: 'commons', title: 'Heart', author: 'Example Author', license: candidate.license, licenseUrl: '', sourceUrl: candidate.pageUrl, caption: '心脏结构', created: 1 };
  const bridge = { load: async () => ({ settings: {}, status: { mode: 'demo' }, imageSettings: { enabled: false } }),
    searchCommonsImages: async query => { searches++; assert.equal(query, '心脏'); return [candidate]; },
    useCommonsImage: async value => { downloads++; assert.equal(value.pageId, 42); assert.equal(value.expectedLicense, candidate.license); return { text: '正文', illustration }; } };
  const app = harness(null, null, bridge); await Promise.resolve();
  app.run("state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'心脏',objective:'理解',content:{text:'正文'}}]}}; activeLesson='p1'; page='study'");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  assert.equal(searches, 0); assert.equal(downloads, 0);
  assert.match(app.node('#illustration-dialog').innerHTML, /在线找图/);
  await app.run("action('image-search-provider',{dataset:{provider:'commons'}})");
  await app.submit('commons-search-form', { query: '心脏' });
  assert.equal(searches, 1); assert.equal(downloads, 0);
  assert.match(app.node('#illustration-dialog').innerHTML, /CC BY-SA 4.0/);
  assert.ok(!app.node('#illustration-dialog').innerHTML.includes('<script>Heart</script>'));
  await app.submit('commons-select-form', { pageId: '42', caption: '心脏结构' });
  assert.equal(downloads, 0);
  await app.submit('commons-select-form', { pageId: '42', caption: '心脏结构', rightsConfirmed: 'on' });
  assert.equal(downloads, 1);
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.illustration.source'), 'commons');
  assert.equal(app.node('#illustration-dialog').open, false);
});

test('AI image search suggests keywords and searches only after a click, without generating an image', async () => {
  let calls = 0;
  const app = harness(null, null, { load: async () => ({ settings: {}, status: { mode: 'ai' }, imageSettings: { enabled: false } }),
    autoSearchCommonsImages: async () => { calls++; return { query: 'heart anatomy', results: [] }; } });
  await Promise.resolve();
  app.run("state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'心脏',objective:'理解',content:{text:'正文'}}]}}");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  assert.equal(calls, 0);
  await app.run("action('image-search-provider',{dataset:{provider:'commons'}})");
  await app.run("action('auto-search-commons',{dataset:{}})");
  assert.equal(calls, 1);
  assert.equal(app.run('illustrationDraft.query'), 'heart anatomy');
});
test('Bailian web search reuses the LLM account, displays real candidates and downloads only a confirmed token', async () => {
  let searches = 0, downloads = 0;
  const result = { candidateId: 'candidate-token', title: '心脏结构', provider: '百炼文搜图', sourceUrl: '', imageUrl: 'https://images.example.org/heart.png', license: '授权未确认', preview: '' };
  const app = harness(null, null, { load: async () => ({ settings: {}, status: { mode: 'ai' }, imageSettings: { enabled: false }, webSearchSettings: { enabled: true } }),
    autoSearchWebImages: async () => { searches++; return { query: '心脏结构', results: [result], recommendation: '适合说明**心房**。', warning: '已保留工具返回的图片候选，不会重新搜索。' }; },
    useWebImage: async value => { downloads++; assert.equal(value.candidateId, 'candidate-token'); assert.equal(value.rightsConfirmed, true); return { text: '正文', illustration: { id: 'd'.repeat(64), source: 'web', title: '心脏结构', caption: '图注', author: '作者未确认', license: '授权未确认；用户确认使用', licenseUrl: '', sourceUrl: result.imageUrl, created: 1, retrieved: 1 } }; } });
  await Promise.resolve(); app.run("state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'心脏',objective:'理解',content:{text:'正文'}}]}};activeLesson='p1';page='study'");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})"); assert.equal(searches, 0);
  await app.run("action('auto-search-commons',{dataset:{}})"); assert.equal(searches, 1);
  assert.match(app.node('#illustration-dialog').innerHTML, /来源页面未提供/);
  assert.match(app.node('#illustration-dialog').innerHTML, /<strong>心房<\/strong>/);
  assert.match(app.node('#illustration-dialog').innerHTML, /已保留工具返回的图片候选/);
  await app.submit('commons-select-form', { pageId: 'candidate-token', caption: '图注', rightsConfirmed: 'on' });
  assert.equal(downloads, 1); assert.equal(searches, 1); assert.equal(app.run('state.blockCourses.p1.blocks[0].content.illustration.source'), 'web');
});
test('repeated image confirmation cannot clear the busy state or start another paid request', async () => {
  let calls=0,finish;
  const image={id:'a'.repeat(64),prompt:'示意',caption:'图注',model:'image',created:1};
  const bridge={load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:true}}),generateIllustration:async value=>{calls++;await new Promise(resolve=>{finish=resolve;});return {text:value.expectedText,illustration:image};}};
  const app=harness(null,null,bridge);await Promise.resolve();
  app.run(`state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文',imageProposal:{prompt:'示意',caption:'图注'}}}]}}`);
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  const pending=app.submit('illustration-form',{prompt:'示意',caption:'图注'});
  await app.submit('illustration-form',{prompt:'示意',caption:'图注'});
  assert.equal(calls,1);assert.equal(app.run('illustrationBusy'),true);
  finish();await pending;assert.equal(app.run('illustrationBusy'),false);
});

test('pending image downloads preserve the old image and reopen as download-only, with no repeated generation or analysis', async () => {
  let generationCalls=0,downloadCalls=0,analysisCalls=0,retained=null;
  const old={id:'a'.repeat(64),prompt:'旧图',caption:'旧图注',model:'image',created:1};
  const pending={pendingDownload:{id:'download-token',host:'cdn.example',expiresAt:9999},prompt:'新图',caption:'新图注',error:'图片下载地址不在允许范围内。下载域名：cdn.example。'};
  const bridge={load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:true}}),getPendingIllustration:async()=>retained,
    suggestIllustration:async()=>{analysisCalls++;throw new Error('must not analyse again');},
    generateIllustration:async()=>{generationCalls++;retained=pending;return pending;},
    retryIllustrationDownload:async value=>{downloadCalls++;assert.equal(value.pendingId,'download-token');return downloadCalls===1 ? {...pending,error:'仍未允许下载域名'} : {text:'原正文',illustration:{...old,id:'b'.repeat(64),prompt:pending.prompt,caption:pending.caption}};}
  };
  const app=harness(null,null,bridge);await Promise.resolve();
  app.run(`state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文',illustration:${JSON.stringify(old)}}}]}}`);
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  await app.submit('illustration-form',{prompt:'新图',caption:'新图注'});
  assert.equal(generationCalls,1);assert.equal(app.run('state.blockCourses.p1.blocks[0].content.illustration.id'),old.id);
  assert.equal(app.node('#illustration-dialog').open,true);assert.match(app.node('#illustration-dialog').innerHTML,/仅重试下载（不重新生成）/);
  assert.match(app.node('#illustration-dialog').innerHTML,/readonly/);assert.match(app.node('#illustration-dialog').innerHTML,/cdn.example/);
  await app.run("action('close-illustration',{dataset:{}})");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  assert.equal(analysisCalls,0);assert.equal(app.run('illustrationDraft.prompt'),'新图');
  await app.submit('illustration-form',{prompt:'新图',caption:'新图注'});
  assert.equal(generationCalls,1);assert.equal(downloadCalls,1);
  assert.match(app.node('#illustration-dialog').innerHTML,/仍未允许下载域名/);
  await app.submit('illustration-form',{prompt:'新图',caption:'新图注'});
  assert.equal(generationCalls,1);assert.equal(downloadCalls,2);assert.equal(app.node('#illustration-dialog').open,false);
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.illustration.id'),'b'.repeat(64));
});

test('download-only confirmation is single-flight and errors cannot turn into a new paid generation', async () => {
  let downloads=0,finish,generations=0;
  const pending={pendingDownload:{id:'download-token',host:'cdn.example',expiresAt:9999},prompt:'教学图',caption:'图注',error:'下载失败'};
  const app=harness(null,null,{load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:true}}),getPendingIllustration:async()=>pending,
    generateIllustration:async()=>{generations++;throw new Error('must not generate');},
    retryIllustrationDownload:async()=>{downloads++;await new Promise(resolve=>{finish=resolve;});throw new Error('待下载结果已过期，未重新生成');}});await Promise.resolve();
  app.run("state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文'}}]}}");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  const inFlight=app.submit('illustration-form',{prompt:'教学图',caption:'图注'});
  await app.submit('illustration-form',{prompt:'教学图',caption:'图注'});
  assert.equal(downloads,1);assert.equal(app.run('illustrationBusy'),true);
  finish();await inFlight;assert.equal(generations,0);assert.equal(app.run('illustrationBusy'),false);
  assert.match(app.node('#illustration-error').textContent,/过期/);
});

test('discarding a pending download needs confirmation and never generates until the next explicit form submission', async () => {
  let discarded=0,generations=0;
  const pending={pendingDownload:{id:'download-token',host:'cdn.example',expiresAt:9999},prompt:'教学图',caption:'图注',error:'下载失败'};
  const app=harness(null,null,{load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:true}}),getPendingIllustration:async()=>pending,
    discardIllustrationDownload:async()=>{discarded++;},generateIllustration:async()=>{generations++;throw new Error('模拟生成失败');}});await Promise.resolve();
  app.run("state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文'}}]}}");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  app.run('window.confirm=()=>false');await app.run("action('discard-illustration-download',{dataset:{}})");assert.equal(discarded,0);
  app.run('window.confirm=()=>true');await app.run("action('discard-illustration-download',{dataset:{}})");
  assert.equal(discarded,1);assert.equal(generations,0);assert.equal(app.run('illustrationDraft.pendingDownload'),undefined);
  assert.match(app.node('#illustration-dialog').innerHTML,/确认生成图片（可能计费）/);
  await app.submit('illustration-form',{prompt:'教学图',caption:'图注'});assert.equal(generations,1);
});

test('native image settings submit the protocol and automatic format while keeping keys out of the rendered form', async () => {
  const saves=[];
  const bridge={load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:false}}),saveImageSettings:async input=>{saves.push(input);const {apiKey,keyAction,...safe}=input;return {...safe,hasApiKey:true};}};
  const app=harness(null,null,bridge);await Promise.resolve();
  await app.submit('image-settings-form',{enabled:'on',protocol:'dashscope',model:'wan2.7-image-pro',baseUrl:'https://dashscope.aliyuncs.com/api/v1',keyAction:'replace',apiKey:'secret-image-key',size:'1024x1024',timeout:'180',downloadHosts:''});
  assert.equal(saves.length,1);assert.equal(saves[0].protocol,'dashscope');assert.equal(saves[0].responseFormat,'auto');
  assert.equal(saves[0].localOnly,false);assert.equal(saves[0].apiKey,'secret-image-key');
  const html=app.run('imageSettingsPanel()');
  assert.match(html,/value="dashscope" selected/);assert.match(html,/id="image-response-format"[^>]+disabled/);
  assert.match(html,/Token Plan/);assert.ok(!html.includes('secret-image-key'));
});

test('changing image protocol restores saved parameters and preserves separate unsaved drafts without sharing keys', async t => {
  const native = { enabled: true, protocol: 'dashscope', model: 'wan2.7-image-pro', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', size: '2K', responseFormat: 'auto', timeoutMs: 240000, localOnly: false, downloadHosts: 'cdn.example.org', hasApiKey: true };
  const app = realSettingsHarness({ load: async () => ({ settings: {}, status: { mode: 'ai' }, imageSettings: { enabled: false, protocol: 'compatible', model: 'local-image', baseUrl: 'http://localhost:8001/v1', size: '768x768', responseFormat: 'b64_json', timeoutMs: 180000, localOnly: true, downloadHosts: '', profiles: { dashscope: native } } }) });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  const doc = app.document;
  doc.querySelector('#image-model-name').value = 'local-draft'; doc.querySelector('#image-model-key').value = 'local-draft-key';
  doc.querySelector('#image-protocol').value = 'dashscope'; await app.fire('change', doc.querySelector('#image-protocol'));
  assert.equal(doc.querySelector('#image-model-name').value, native.model); assert.equal(doc.querySelector('#image-model-key').value, '');
  assert.equal(doc.querySelector('#image-size').value, '2K'); assert.equal(doc.querySelector('#image-timeout').value, '240');
  assert.equal(doc.querySelector('#image-response-format').disabled, true); assert.equal(doc.querySelector('#image-response-format').value, 'auto');
  assert.equal(doc.querySelector('#image-settings-form [name=localOnly]').checked, false);
  assert.ok(doc.querySelector('#image-settings-form [data-action=clear-model-key]'));
  assert.equal(app.run('imageSettings.protocol'), 'compatible', 'selection must not activate the backend');
  doc.querySelector('#image-protocol').value = 'compatible'; await app.fire('change', doc.querySelector('#image-protocol'));
  assert.equal(doc.querySelector('#image-model-name').value, 'local-draft'); assert.equal(doc.querySelector('#image-model-key').value, 'local-draft-key');
  assert.equal(doc.querySelector('#image-response-format').disabled, false); assert.equal(doc.querySelector('#image-response-format').value, 'b64_json');
  app.run('render()'); assert.equal(doc.querySelector('#image-model-key').value, 'local-draft-key');
  assert.equal(doc.querySelector('[data-action=check-image-connection]').disabled, true);
});

test('saving an aliased native image root explains the same-provider adjustment rather than forbidding Token Plan', async () => {
  const saves=[],bridge={load:async()=>({settings:{},status:{mode:'ai'}}),saveImageSettings:async input=>{
    saves.push(input);const {apiKey,keyAction,...safe}=input;return {...safe,baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1',hasApiKey:true};
  }};
  const app=harness(null,null,bridge);await Promise.resolve();
  await app.submit('image-settings-form',{enabled:'on',protocol:'dashscope',model:'wan2.7-image-pro',baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',keyAction:'replace',apiKey:'sk-sp-test-only',size:'1024x1024',timeout:'180',downloadHosts:''});
  assert.equal(saves.length,1);assert.equal(saves[0].apiKey,'sk-sp-test-only');
  assert.match(app.run('imageConnectionResult'),/已保存.*同域名.*未更换服务商或密钥/);
  const html=app.run('imageSettingsPanel()');assert.match(html,/此提醒不阻止保存/);assert.match(html,/token-plan.cn-beijing.maas.aliyuncs.com\/api\/v1/);
  assert.ok(!html.includes('sk-sp-test-only'));
});

test('image settings save failures expose the cause in both notices and preserve the previous configuration and draft', async () => {
  const safe={enabled:true,protocol:'compatible',model:'old-model',baseUrl:'http://localhost/v1',size:'1024x1024',responseFormat:'auto',timeoutMs:180000,localOnly:true,downloadHosts:''};
  const app=harness(null,null,{load:async()=>({settings:{},status:{mode:'ai'},imageSettings:safe}),saveImageSettings:async()=>{throw new Error('云端须关闭仅本机选项');}});await Promise.resolve();
  app.node('#image-model-key').value='draft-key';
  await app.submit('image-settings-form',{enabled:'on',protocol:'dashscope',model:'wan2.7-image-pro',baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',localOnly:'on',keyAction:'replace',apiKey:'draft-key',size:'1024x1024',timeout:'180',downloadHosts:''});
  assert.match(app.node('#image-settings-error').textContent,/仅本机/);
  assert.match(app.node('#image-connection-result').textContent,/保存失败.*仅本机/);
  assert.equal(app.node('[data-action="check-image-connection"]').disabled,true);
  assert.equal(app.run('imageSettings.model'),'old-model');assert.equal(app.node('#image-model-key').value,'draft-key');
});

// This harness checks application state transitions, not browser rendering.
test('course search has one independent persistent switch; generation locks it and references stay at the end', async t => {
  let preference = { enabled: false, revision: 0 }, requests = 0, finish, openedSource;
  const course = { intro: 'Git 课程', blocks: [{ id: 'b1', type: 'reading', title: '提交身份', objective: '区分认证', content: null }, { id: 'q1', type: 'quiz', title: '练习', objective: '检查', content: null }] };
  const grounding = { version: 1, citations: [{ excerptId: 'S1E1', claim: '提交身份不是密码。', quote: 'The author is not authentication.', url: 'https://git-scm.com/docs/git-config', title: 'Git config <script>unsafe</script>', publisher: 'Git', retrievedAt: 1000 }] };
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' }, settings: {} }),
    getLesson: async () => ({ blockCourse: structuredClone(course), sourceSearch: preference, chats: [] }),
    setCourseSourceSearch: async (_id, enabled) => preference = { enabled, revision: preference.revision + 1 },
    openCourseSource: async url => { openedSource = url; },
    request: async (_path, input) => { requests++; assert.equal(input.sourceSearch.enabled, true); return new Promise(resolve => { finish = resolve; }); },
    saveBlock: async (_id, blockId, content) => { course.blocks.find(b => b.id === blockId).content = content; },
  });
  t.after(() => app.close()); await app.ready(); await app.run("openLesson('p1')");
  const doc = app.document;
  assert.equal(doc.querySelectorAll('[data-action=toggle-course-search]').length, 1); assert.equal(doc.querySelector('[data-action=toggle-course-search]').getAttribute('aria-checked'), 'false');
  await app.fire('click', doc.querySelector('[data-action=toggle-course-search]'));
  assert.equal(preference.enabled, true); assert.equal(requests, 0, 'toggling alone never searches');
  const pending = app.run("action('generate-block',{dataset:{id:'p1',block:'b1'}})"); await Promise.resolve();
  assert.equal(doc.querySelector('[role=switch]').disabled, true);
  await assert.rejects(app.run("action('toggle-course-search',{dataset:{id:'p1'}})"), /等待/);
  await assert.rejects(app.run("action('generate-block',{dataset:{id:'p1',block:'b1'}})"), /正在生成/);
  finish({ text: '提交身份不是密码。[S1E1]', grounding }); await pending;
  assert.equal(requests, 1); assert.equal(doc.querySelectorAll('.course-references').length, 1); assert.equal(doc.querySelector('.course-references script'), null);
  assert.equal(doc.querySelector('.block-sequence').lastElementChild.className, 'course-references');
  const sourceLink = doc.querySelector('.block-text .course-inline-citation');
  assert.equal(sourceLink.textContent, '[S1E1]');
  await app.fire('click', sourceLink);
  assert.equal(openedSource, grounding.citations[0].url);
  assert.equal(doc.querySelector('.course-references').open, false);
  await app.fire('click', doc.querySelector('[data-action=toggle-course-search]'));
  assert.equal(preference.enabled, false); assert.ok(doc.querySelector('.course-references'));
  await app.run("openLesson('p1')");
  assert.equal(doc.querySelector('[role=switch]').getAttribute('aria-checked'), 'false'); assert.ok(doc.querySelector('.course-references')); assert.equal(requests, 1);
});

test('quiz progress describes prior teaching reuse instead of a new search even with the search switch on', async t => {
  let finish;
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' } }),
    generateCourseBlock: async (value, id) => { assert.equal(value.request.block.type, 'quiz'); assert.equal(value.request.sourceSearch.enabled, true); assert.match(id, /^generation-/); return new Promise(resolve => { finish = resolve; }); } });
  t.after(() => app.close()); await app.ready();
  app.run("state.plans[0].source='ai'; state.lessons={}; state.blockCourses={p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:{text:'已讲定义和条件。'}},{id:'q1',type:'quiz',title:'条件练习',objective:'应用',content:null}]}}; state.sourceSearch={p1:{enabled:true,revision:1}}; activeLesson='p1'; page='study'; render()");
  assert.match(app.document.querySelector('[data-block-id=q1]').textContent, /不重新联网搜索/);
  const pending = app.run("action('generate-block',{dataset:{id:'p1',block:'q1'}})");
  assert.match(app.document.querySelector('.course-source-controls').textContent, /依据已讲内容生成练习/);
  assert.doesNotMatch(app.document.querySelector('.course-source-controls').textContent, /正在查找网页/);
  assert.match(app.document.querySelector('#generation-progress').textContent, /生成随堂练习/);
  const content = { questions: ['定义是什么？', '条件变化时如何判断？'].map(prompt => ({ prompt, options: ['甲','乙','丙','丁'], answer: 0, explanation: '按已讲条件判断。' })) };
  finish({ content, factChecks: [] }); await pending;
  assert.match(app.document.querySelector('.course-source-controls').textContent, /未添加外部引用/);
  assert.match(app.document.querySelector('.course-source-controls').textContent, /未重新联网搜索/);
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.questions.length'), 2);
});

// Keyless-form regressions need real elements.namedItem() and actual FormData.
function realSettingsHarness(bridge) {
  const dom = new JSDOM('<div id="app"></div><div id="toast"></div><aside id="generation-progress" popover="manual" hidden></aside><button id="annotation-quick-add" data-action="add-annotation" hidden></button><dialog id="annotation-dialog"></dialog><dialog id="knowledge-draft-dialog"></dialog><dialog id="knowledge-organize-dialog"></dialog><dialog id="quality-dialog"></dialog>', { url: 'http://localhost' });
  const document = dom.window.document, listeners = new Map();
  document.querySelector('#knowledge-organize-dialog').showModal = function () { this.open = true; };
  document.querySelector('#knowledge-organize-dialog').close = function () { this.open = false; };
  for (const id of ['annotation-dialog', 'knowledge-draft-dialog', 'quality-dialog']) {
    document.querySelector(`#${id}`).showModal = function () { this.open = true; };
    document.querySelector(`#${id}`).close = function () { this.open = false; };
  }
  document.addEventListener = (name, listener) => { const group = listeners.get(name) || []; group.push(listener); listeners.set(name, group); };
  dom.window.learnflowDesktop = bridge; dom.window.scrollTo = () => {};
  const context = vm.createContext({ generationCancelled, isGenerationCancelled, masteredQuizQuestions, quizRecordAfterChange, quizQuestionKey, quizInitialCount, quizBatchLimit, quizQuestionLimit, createGenerationProgress, factCheckLabels, sameFactContent, officialSource, validSourceSearch, courseReferences, teachingContextNotice, qualityRubric, qualityLabels, qualityModelId, revisionTypes, revisionStatuses, revisionCheckLabels, revisionContent, revisionText, revisionDiff,
    demoPlan, demoLessons, lessonFromBlocks, validOutline, validBlockContent, validBlockSpec, blockGenerationContext, revisedContent, restoredContent, assistedBlockTypes, Marked, DOMPurify, createMarkdownRenderer, validQuestionnaire, validClarification, learningBriefFrom, validIllustration, validImageProposal, speechDefaults, speechVoices, listeningText, speechTurns, speechRequest, validAudioId, validKnowledgeSource, validKnowledgeDraft, localKnowledgeDraft, knowledgeTags, knowledgeConditions, validAnnotations, personalNotesForSource, personalNotesMarkdown, knowledgeCatalog, knowledgeDomain, knowledgeDomainColors, knowledgeTopic, retrieveKnowledge, validKnowledgeOrganization, courseKnowledgeTree, knowledgeTree, knowledgeGraph, filterKnowledgeGraph, createGraphMotion, stepGraphMotion, structuredClone, crypto: webcrypto, AbortSignal,
    document, window: dom.window, FormData: dom.window.FormData, setTimeout: () => 1, clearTimeout() {}
  });
  vm.runInContext(source, context);
  return { document, run: code => vm.runInContext(code, context), close: () => dom.window.close(),
    ready: async () => { await Promise.resolve(); },
    fire: async (name, target, extras = {}) => { for (const listener of listeners.get(name) || []) await listener({ target, ...extras, preventDefault() {} }); }
  };
}

function harness(saved, fetchImpl, desktopBridge) {
  const nodes = new Map(), listeners = new Map(), storage = new Map(saved ? [['learnflow.v1', saved]] : []);
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', open: false, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, classList: { add() {}, remove() {} }, scrollIntoView() {}, focus() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(selector);
  };
  const context = vm.createContext({ generationCancelled, isGenerationCancelled, masteredQuizQuestions, quizRecordAfterChange, quizQuestionKey, quizInitialCount, quizBatchLimit, quizQuestionLimit, createGenerationProgress, factCheckLabels, sameFactContent, officialSource, validSourceSearch, courseReferences, teachingContextNotice, qualityRubric, qualityLabels, qualityModelId, revisionTypes, revisionStatuses, revisionCheckLabels, revisionContent, revisionText, revisionDiff,
    demoPlan, demoLessons, lessonFromBlocks, validOutline, validBlockContent, validBlockSpec, blockGenerationContext, revisedContent, restoredContent, assistedBlockTypes, Marked, DOMPurify, createMarkdownRenderer, validQuestionnaire, validClarification, learningBriefFrom, validIllustration, validImageProposal, speechDefaults, speechVoices, listeningText, speechTurns, speechRequest, validAudioId, validKnowledgeSource, validKnowledgeDraft, localKnowledgeDraft, knowledgeTags, knowledgeConditions, validAnnotations, personalNotesForSource, personalNotesMarkdown, knowledgeCatalog, knowledgeDomain, knowledgeDomainColors, knowledgeTopic, retrieveKnowledge, validKnowledgeOrganization, courseKnowledgeTree, knowledgeTree, knowledgeGraph, filterKnowledgeGraph, createGraphMotion, stepGraphMotion, structuredClone, crypto: webcrypto, AbortSignal,
    document: { querySelector: node, addEventListener(name, listener) { const group = listeners.get(name) || []; group.push(listener); listeners.set(name, group); } },
    localStorage: { get length() { return storage.size; }, key: index => [...storage.keys()][index] ?? null, getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { learnflowDesktop: desktopBridge, scrollY: 0, scrollTo({ top }) { this.scrollY = top; }, confirm: () => true }, setTimeout: () => 1, clearTimeout() {},
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ mode: 'demo', model: null }) })),
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } getAll(key) { const value = this.values[key]; return value === undefined ? [] : Array.isArray(value) ? value : [value]; } }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  async function submit(id, values, lessonId, blockId) {
    const button = { innerHTML: 'Submit', disabled: false, isConnected: false };
    for (const listener of listeners.get('submit')) await listener({ preventDefault() {}, target: { id, values, dataset: { id: lessonId, block: blockId }, querySelector: () => button } });
  }
  const input = (id, value, dataset = {}) => {
    node('#' + id).value = value;
    for (const listener of listeners.get('input')) listener({ target: { id, value, dataset } });
  };
  const change = (id,value) => { node('#' + id).value = value; for (const listener of listeners.get('change')) listener({target:{id,value}}); };
  return { run, submit, input, change, node, storage };
}
test('learning loop: incorrect answers, retry, completion, Wiki creation, edit and persistence', async () => {
  const app = harness();
  app.run("openLesson('p1', 'quiz')");
  await app.submit('quiz-form', { q0: '0', q1: '0' }, 'p1');
  assert.equal(app.run('state.progress.p1.completed'), false);
  assert.equal(app.run('state.progress.p1.lastScore'), 0);
  assert.equal(app.run('state.progress.p1.attempts'), 1);
  await app.run("createNote('p1', '', '0')");
  assert.equal(app.run('state.notes.length'), 0, 'draft must not save before confirmation');
  await app.submit('knowledge-draft-form', { title: '输入输出基础', summary: '理解输出', content: '## 输出\n\nprint 显示内容。', tags: 'Python，输入输出', useWhen: '显示结果', avoidWhen: '' });
  assert.equal(app.run('state.notes.length'), 1, 'cards can be saved before passing the quiz');
  await app.submit('quiz-form', { q0: '1', q1: '1' }, 'p1');
  assert.equal(app.run('state.progress.p1.completed'), true);
  assert.equal(app.run('state.progress.p1.bestScore'), 100);
  await app.run("createNote('p1')");
  assert.equal(app.run('state.notes.length'), 1);
  await app.submit('knowledge-draft-form', { title: '整课要点', summary: '课程要点', content: '## 本课\n\n学习输入输出。', tags: 'Python', useWhen: '', avoidWhen: '' });
  assert.equal(app.run('state.notes.length'), 2, 'one lesson can contain multiple cards');
  const id = app.run('state.notes[0].id');
  await app.submit('note-form', { title: '我的输入输出笔记', summary: '用自己的话理解 print', content: 'print 会显示内容，字符串原样显示。', tags: 'Python，输入输出，Python' }, id);
  assert.equal(app.run('state.notes[0].title'), '我的输入输出笔记');
  assert.equal(app.run('state.notes[0].tags.length'), 2);
  const restored = harness(app.storage.get('learnflow.v1'));
  assert.equal(restored.run('state.progress.p1.completed'), true);
  assert.equal(restored.run('state.notes[0].title'), '我的输入输出笔记');
  await app.submit('quiz-form', { q0: '0', q1: '0' }, 'p1');
  assert.equal(app.run('state.progress.p1.completed'), true, 'review mistakes do not delete prior mastery');
  assert.equal(app.run('state.progress.p1.bestScore'), 100);
  assert.equal(app.run('state.progress.p1.lastScore'), 100, 'passed questions cannot be resubmitted as wrong answers');
});
test('quiz mastery skips passed questions and missing pending answers cannot silently become option A', async () => {
  const app = harness();
  app.run("activeLesson='p1'; page='study'; lessonTab='quiz'; render()");
  await app.submit('quiz-form', { q0: '1', q1: '0' }, 'p1');
  let dom = new JSDOM(app.node('#app').innerHTML);
  assert.equal(dom.window.document.querySelectorAll('.quiz-mastered').length, 1);
  assert.equal(dom.window.document.querySelector('[name=q0]'), null);
  assert.ok(dom.window.document.querySelector('[name=q1]'));
  assert.match(dom.window.document.querySelector('.quiz-mastered').textContent, /正确答案/); dom.window.close();
  await app.submit('quiz-form', {}, 'p1');
  assert.equal(app.run('state.progress.p1.attempts'), 1);
  await app.submit('quiz-form', { q1: '1', q0: '0' }, 'p1');
  assert.equal(app.run('state.progress.p1.lastScore'), 100);
  assert.deepEqual(Array.from(app.run('state.progress.p1.lastAnswers')), [1, 1], 'passed answers are synthesized, never replaced by form values');
  dom = new JSDOM(app.node('#app').innerHTML);
  assert.equal(dom.window.document.querySelector('#quiz-form input'), null);
  assert.equal(dom.window.document.querySelector('#quiz-form button[type=submit]'), null); dom.window.close();
});

test('pending first quizzes display the fixed four-question rule without rewriting old objectives or saved quizzes', () => {
  const app=harness();
  app.run("state.blockCourses={p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:{text:'已讲内容。'}},{id:'q1',type:'quiz',title:'练习',objective:'完成5道选择题，检验判断。',content:null}]}}; activeLesson='p1';page='study';lessonTab='read';render()");
  assert.match(app.node('#app').innerHTML,/首次固定生成4题/);
  assert.equal(app.run('state.blockCourses.p1.blocks[1].objective'),'完成5道选择题，检验判断。');
  app.run("state.blockCourses.p1.blocks[1].content={questions:[{prompt:'原有题目？',options:['甲','乙','丙','丁'],answer:0,explanation:'已有解析。'}]};render()");
  assert.doesNotMatch(app.node('#app').innerHTML,/首次固定生成4题/);
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.questions.length'),1);
});
test('additional quiz batches preserve passes across submission and reload; failed additions retry the same pending block', async () => {
  const requests = []; let fail = false;
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    const input = JSON.parse(options.body); requests.push(input);
    const questions = Array.from({ length: input.questionCount }, (_, i) => ({ prompt: `新增第${requests.length}组第${i + 1}题？`, options: ['正确', '错误甲', '错误乙', '错误丙'], answer: 0, explanation: '依据已讲内容判断。' }));
    return { ok: !fail, json: async () => fail ? { error: '新增题目测试失败' } : { questions } };
  });
  await Promise.resolve();
  const questions = [0, 1].map((answer, i) => ({ prompt: `原题${i + 1}？`, options: ['甲', '乙', '丙', '丁'], answer, explanation: '原题解析。' }));
  app.run(`state.plans[0].source='ai'; state.lessons={}; state.blockCourses={p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:{text:'实际已讲正文。'}},{id:'q1',type:'quiz',title:'初始练习',objective:'判断',content:{questions:${JSON.stringify(questions)}}}]}}; status={mode:'ai'}; activeLesson='p1'; page='study'; lessonTab='quiz'; render()`);
  await app.submit('quiz-form', { q0: '0', q1: '0' }, 'p1');
  await app.submit('more-quiz-form', { count: '3' }, 'p1');
  assert.equal(requests.length, 1); assert.equal(requests[0].questionCount, 3); assert.equal(requests[0].existingQuestions.length, 2);
  assert.equal(app.run('contentFor("p1").questions.length'), 5);
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.questions[0].prompt'), questions[0].prompt);
  let dom = new JSDOM(app.node('#app').innerHTML);
  assert.equal(dom.window.document.querySelectorAll('.quiz-mastered').length, 1);
  assert.equal(dom.window.document.querySelector('[name=q0]'), null); assert.ok(dom.window.document.querySelector('[name=q4]')); dom.window.close();
  await app.submit('quiz-form', { q1: '1', q2: '0', q3: '0', q4: '0' }, 'p1');
  assert.equal(app.run('state.progress.p1.lastScore'), 100);
  assert.equal(app.run('state.quizRecords.p1.currentFingerprint === state.quizRecords.p1.progressFingerprint'), true);
  const restored = harness(app.storage.get('learnflow.v1'));
  restored.run("activeLesson='p1'; page='study'; lessonTab='quiz'; render()");
  dom = new JSDOM(restored.node('#app').innerHTML);
  assert.equal(dom.window.document.querySelectorAll('.quiz-mastered').length, 5); dom.window.close();
  const before = app.run('JSON.stringify(contentFor("p1").questions)'), oldProgress = app.run('JSON.stringify(state.progress.p1)');
  fail = true; await app.submit('more-quiz-form', { count: '2' }, 'p1');
  assert.equal(requests.length, 2); assert.equal(app.run('JSON.stringify(contentFor("p1").questions)'), before);
  assert.equal(app.run('JSON.stringify(state.progress.p1)'), oldProgress);
  const blocks = app.run('state.blockCourses.p1.blocks.length');
  assert.match(app.node('#app').innerHTML, /原题和成绩已保留/);
  fail = false; await app.submit('more-quiz-form', { count: '2' }, 'p1');
  assert.equal(requests.length, 3); assert.equal(app.run('state.blockCourses.p1.blocks.length'), blocks, 'retry reuses the failed pending batch');
  assert.equal(app.run('contentFor("p1").questions.length'), 7);
  dom = new JSDOM(app.node('#app').innerHTML);
  assert.equal(dom.window.document.querySelectorAll('.quiz-mastered').length, 5);
  assert.ok(dom.window.document.querySelector('[name=q5]')); assert.ok(dom.window.document.querySelector('[name=q6]')); dom.window.close();
});

test('cancelling a new web quiz batch removes its placeholder and preserves old questions and scores', async () => {
  let signal, requests = 0;
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    requests++; signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  });
  await Promise.resolve();
  app.run("state.blockCourses={p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:{text:'已讲材料。'}},{id:'q1',type:'quiz',title:'原题',objective:'判断',content:{questions:[{prompt:'原题？',options:['甲','乙','丙','丁'],answer:0,explanation:'原解析。'}]}}]}}; state.progress.p1={attempts:1,completed:true,lastScore:100,bestScore:100,lastAnswers:[0]}; status={mode:'ai'}; activeLesson='p1'; page='study'; lessonTab='quiz'; render()");
  const before = app.run('JSON.stringify(state.blockCourses.p1)'), scores = app.run('JSON.stringify(state.progress.p1)');
  const work = app.run("appendQuizQuestions('p1',2)"), rejected = assert.rejects(work, isGenerationCancelled);
  for (let n = 0; !signal && n < 15; n++) await Promise.resolve();
  assert.equal(requests, 1);
  const taskId = app.node('#generation-progress').innerHTML.match(/data-action="cancel-generation-task" data-id="([^"]+)"/)[1];
  await app.run(`generationProgress.cancel('${taskId}')`); await rejected;
  assert.equal(signal.aborted, true); assert.equal(app.run('JSON.stringify(state.blockCourses.p1)'), before);
  assert.equal(app.run('JSON.stringify(state.progress.p1)'), scores);
  assert.equal(app.run('quizAdditionBusy.has("p1") || courseGenerationBusy.has("p1")'), false);
  assert.equal(JSON.parse(app.storage.get('learnflow.v1')).blockCourses.p1.blocks.length, 2);
});
test('failed desktop grading never marks unsaved answers as passed', async t => {
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }), saveProgress: async () => { throw new Error('练习成绩保存失败'); } });
  t.after(() => app.close()); await app.ready();
  app.run("activeLesson='p1'; page='study'; lessonTab='quiz'; render()");
  for (const name of ['q0', 'q1']) app.document.querySelector(`input[name=${name}][value="1"]`).checked = true;
  await app.fire('submit', app.document.querySelector('#quiz-form'));
  assert.equal(app.run('state.progress.p1'), undefined);
  assert.equal(app.document.querySelector('.quiz-mastered'), null);
  assert.match(app.document.querySelector('#toast').textContent, /成绩保存失败/);
});

test('concurrent additional-quiz submissions create at most one pending batch and one generation request', async () => {
  let release, requests = 0;
  const app = harness(null, async (url) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    requests++; return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ questions: [{ prompt: '新增情境题？', options: ['甲', '乙', '丙', '丁'], answer: 0, explanation: '按已讲条件判断。' }] }) }); });
  });
  await Promise.resolve();
  app.run("state.blockCourses={p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:{text:'已讲材料。'}},{id:'q1',type:'quiz',title:'原题',objective:'判断',content:{questions:[{prompt:'原题？',options:['甲','乙','丙','丁'],answer:0,explanation:'原解析。'}]}}]}}; status={mode:'ai'}; activeLesson='p1'; page='study'; lessonTab='quiz'; render()");
  const pending = app.run("appendQuizQuestions('p1',1)");
  await assert.rejects(app.run("appendQuizQuestions('p1',1)"), /正在生成/);
  for (let i = 0; !release && i < 10; i++) await Promise.resolve();
  assert.equal(typeof release, 'function'); release(); await pending;
  assert.equal(requests, 1); assert.equal(app.run('state.blockCourses.p1.blocks.length'), 3);
});

test('study card drafting is scoped, editable and does not save when desktop persistence fails', async () => {
  let writes = 0;
  const app = harness(null, null, { load: async () => ({ status: { mode: 'demo' } }), saveNote: async () => { writes++; throw new Error('磁盘写入失败'); } });
  await Promise.resolve();
  await app.run("createNote('p1', '', '0')");
  assert.equal(app.run('knowledgeDraft.source.sourceTitle'), demoLessons.p1.sections[0].heading);
  assert.equal(app.run('state.notes.length'), 0);
  assert.match(app.node('#knowledge-draft-dialog').innerHTML, /确认保存卡片/);
  await app.submit('knowledge-draft-form', { title: '输出', summary: '解释输出', content: '## 具体解释\n\nprint 显示内容。', tags: 'Python', useWhen: '显示结果', avoidWhen: '' });
  assert.equal(writes, 1);
  assert.equal(app.run('state.notes.length'), 0);
  assert.equal(app.node('#knowledge-draft-dialog').open, true);
  assert.match(app.node('#knowledge-draft-dialog').innerHTML, /磁盘写入失败/);
});

test('editing an existing desktop card does not claim a topic move succeeded when writing fails', async () => {
  const app = harness(null, null, { load: async () => ({ status: { mode: 'demo' } }), saveNote: async () => { throw new Error('主题目录写入失败'); } });
  await Promise.resolve();
  app.run("state.notes = [{id:'note-1',lessonId:'p1',courseTitle:'Python',title:'原标题',summary:'摘要',content:'原正文',tags:['Python'],source:'demo',topic:'编程/Python',updated:1}]; activeNote='note-1'; page='wiki'; render()");
  await app.submit('note-form', { title: '新标题', summary: '摘要', content: '新正文', tags: 'Python', topic: '开发工具/Git', useWhen: '', avoidWhen: '' }, 'note-1');
  assert.equal(app.run('state.notes[0].title'), '原标题');
  assert.equal(app.run('state.notes[0].topic'), '编程/Python');
  assert.match(app.node('#toast').textContent, /主题目录写入失败/);
});

test('card deletion keeps the desktop state on cancel or failure, then removes only the confirmed card', async () => {
  let calls = 0;
  const app = harness(null, null, { load: async () => ({ status: { mode: 'demo' } }), deleteNote: async id => {
    assert.equal(id, 'note-1'); calls++;
    if (calls === 1) return null;
    if (calls === 2) throw new Error('文件校验失败');
    return { id };
  } });
  await Promise.resolve();
  app.run("state.notes = [{id:'note-1',lessonId:'p1',courseTitle:'Python',title:'待删卡片',summary:'摘要',content:'正文',tags:['Python'],source:'demo',updated:1},{id:'note-2',lessonId:'p1',courseTitle:'Python',title:'保留卡片',summary:'摘要',content:'正文',tags:['Python'],source:'demo',updated:2}]; activeNote='note-1'; page='wiki'; render()");
  assert.match(app.node('#app').innerHTML, /删除这张卡片/);
  await app.run("action('delete-note', {dataset:{id:'note-1'}})");
  assert.equal(app.run('state.notes.length'), 2);
  await assert.rejects(app.run("action('delete-note', {dataset:{id:'note-1'}})"), /文件校验失败/);
  assert.equal(app.run('state.notes.length'), 2);
  await app.run("action('delete-note', {dataset:{id:'note-1'}})");
  assert.deepEqual(Array.from(app.run('state.notes.map(note => note.id)')), ['note-2']);
  assert.equal(app.run('activeNote'), null);
  assert.equal(app.run('state.plans.length'), 1);
});

test('web card deletion confirms and persists a state without the selected card', async () => {
  const app = harness();
  app.run("state.notes = [{id:'note-1',lessonId:'p1',courseTitle:'Python',title:'待删卡片',summary:'摘要',content:'正文',tags:['Python'],source:'demo',updated:1}]; activeNote='note-1'; page='wiki'; save(); render()");
  await app.run("action('delete-note', {dataset:{id:'note-1'}})");
  assert.equal(app.run('state.notes.length'), 0);
  assert.equal(JSON.parse(app.storage.get('learnflow.v1')).notes.length, 0);
  assert.equal(app.run('state.plans.length'), 1);
});

test('reading UI exposes section card actions and saves only after reviewing the dialog', async t => {
  const saved = [];
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }), saveNote: async note => { saved.push(note); } });
  t.after(() => app.close()); await app.ready();
  const dialog = app.document.getElementById('knowledge-draft-dialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  app.run("activeLesson='p1'; page='study'; lessonTab='read'; render()");
  const sectionButton = app.document.querySelector('.reading-section [data-action="create-note"]');
  assert.ok(sectionButton);
  assert.ok(app.document.querySelector('.knowledge-entry-toolbar [data-action="create-note"]'));
  await app.fire('click', sectionButton);
  assert.equal(saved.length, 0);
  assert.equal(dialog.open, true);
  const form = app.document.getElementById('knowledge-draft-form');
  assert.ok(form);
  form.elements.namedItem('title').value = '我的第一张卡片';
  form.elements.namedItem('topic').value = '编程/Python';
  form.elements.namedItem('useWhen').value = '需要解释本节概念时';
  await app.fire('submit', form);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, '我的第一张卡片');
  assert.equal(saved[0].topic, '编程/Python');
  assert.deepEqual(saved[0].useWhen, ['需要解释本节概念时']);
  assert.equal(app.run('state.notes.length'), 1);
});

test('home restores the hero, statistics and two-panel layout without changing learning data or actions', () => {
  const app = harness();
  const original = app.run('JSON.stringify(state)');
  const doc = new JSDOM(app.node('#app').innerHTML).window.document;
  assert.ok(doc.querySelector('main.page-home'));
  assert.equal(doc.querySelector('.home-priority'), null);
  assert.equal(doc.querySelector('.hero').nextElementSibling.className, 'stats');
  assert.equal(doc.querySelector('.stats').nextElementSibling.className, 'dashboard-columns');
  assert.equal(doc.querySelector('.dashboard-columns').firstElementChild.className, 'home-continue');
  assert.equal(doc.querySelector('.dashboard-columns').lastElementChild.className, 'home-knowledge');
  assert.equal(doc.querySelector('.hero [data-action="routes"]').textContent.trim(), '探索我的学习路线');
  assert.ok(doc.querySelector('.home-knowledge .seed-illustration'));
  assert.ok(doc.querySelector('.home-knowledge [data-page="wiki"]'));
  const resume = doc.querySelector('.home-continue [data-action="open-lesson"]');
  assert.equal(resume.dataset.id, app.run('nextLesson().id'));
  assert.equal(resume.textContent.trim(), '进入课程');
  assert.equal(doc.querySelectorAll('.home-continue [data-action="open-lesson"]').length, 1);
  assert.equal(doc.querySelector('.home-continue h3').textContent, demoPlan.title);
  assert.equal(doc.querySelector('.course-icon').textContent, '', 'course icon is not hard-coded to Python');
  assert.equal(doc.querySelectorAll('.hero .float-card').length, 3, 'existing decorative animation is retained');
  const progress = doc.querySelector('[role="progressbar"]');
  assert.equal(progress.getAttribute('aria-valuenow'), '0');
  assert.equal(progress.getAttribute('aria-valuemax'), String(demoPlan.lessons.length));
  assert.equal(app.run('JSON.stringify(state)'), original);
  app.run("state.blockCourses.p1={intro:'导语',blocks:[]}; render()");
  const started = new JSDOM(app.node('#app').innerHTML).window.document;
  assert.equal(started.querySelector('.home-continue [data-action="open-lesson"]').textContent.trim(), '继续学习');
  app.run('state.plans[0].lessons.forEach(l=>state.progress[l.id]={completed:true}); render()');
  const complete = new JSDOM(app.node('#app').innerHTML).window.document;
  assert.equal(complete.querySelector('.home-continue [data-action="open-lesson"]').textContent.trim(), '复习课程');
});

test('legacy and block lessons share a title/tab toolbar while settings, annotations and quiz notices stay outside it', async t => {
  const app = realSettingsHarness({ load: async () => ({ status:{mode:'demo'} }), inspectQuality:async()=>({}), getLesson:async()=>({}) });
  t.after(() => app.close()); await app.ready();
  app.run("activeLesson='p1'; page='study'; lessonTab='read'; render()");
  const doc = app.document;
  const assertToolbar = () => {
    assert.ok(doc.querySelector('main.page-study'));
    assert.equal(doc.querySelectorAll('.lesson-toolbar').length, 1);
    assert.equal(doc.querySelector('.lesson-toolbar h1').textContent, demoPlan.lessons[0].title);
    assert.equal(doc.querySelector('.lesson-toolbar h1').getAttribute('title'), demoPlan.lessons[0].title);
    assert.deepEqual([...doc.querySelectorAll('.lesson-toolbar [role="tab"]')].map(tab=>tab.dataset.tab), ['read','quiz','chat']);
    assert.equal(Boolean(doc.querySelector('.knowledge-entry-toolbar')?.closest('.lesson-toolbar')), false);
    assert.equal(Boolean(doc.querySelector('.quality-entry')?.closest('.lesson-toolbar')), false);
    assert.equal(Boolean(doc.querySelector('.course-source-controls')?.closest('.lesson-toolbar')), false);
  };
  assertToolbar();
  const oldState = app.run('JSON.stringify(state)');
  await app.fire('click', doc.querySelector('[data-action="lesson-tab"][data-tab="chat"]'));
  assert.equal(doc.querySelector('[data-tab="chat"]').getAttribute('aria-selected'), 'true');
  assert.equal(app.run('JSON.stringify(state)'), oldState);
  app.run("state.blockCourses.p1={intro:'导语',blocks:[{id:'read-ui',type:'reading',title:'讲解',objective:'理解',content:{text:'讲解正文'}},{id:'task-ui',type:'practice',title:'实践',objective:'应用',content:{text:'实践正文'}}]}; lessonTab='read'; render()");
  assertToolbar();
  assert.equal(doc.querySelector('.teaching-reading .revision-actions>[data-action="request-revision"]').textContent, '换个讲法');
  assert.equal(doc.querySelector('[data-block-id="task-ui"] .revision-actions>[data-action="request-revision"]').textContent, '换个任务');
  assert.equal(doc.querySelector('.teaching-reading .block-title-row>[data-action="toggle-block-collapse"]').textContent, '收起');
  app.run("state.quizRecords={p1:{currentFingerprint:'current',progressFingerprint:'previous',history:[]}}; lessonTab='quiz'; render()");
  assert.equal(doc.querySelector('.quiz-version-notice').closest('.lesson-toolbar'), null);
  assert.equal(doc.querySelector('[data-tab="quiz"]').getAttribute('aria-selected'), 'true');
});

test('directory toggle is a separate icon button next to Back and keeps its icons and state through repeated clicks', async t => {
  const app = realSettingsHarness({load:async()=>({status:{mode:'demo'}})});
  t.after(()=>app.close()); await app.ready();
  for (const blockCourse of [false,true]) {
    app.run(`state.blockCourses=${blockCourse?"{p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:{text:'正文'}}]}}":"{}"}; activeLesson='p1'; page='study'; lessonTab='read'; syllabusCollapsed=false; render()`);
    const doc = app.document, toggle=doc.querySelector('.study-top [data-action="toggle-syllabus"]');
    assert.ok(toggle.classList.contains('btn'));
    assert.equal(toggle.previousElementSibling.dataset.page,'routes');
    assert.equal(toggle.nextElementSibling.classList.contains('pill'),true);
    assert.equal(toggle.getAttribute('aria-controls'),'course-syllabus');
    const original=app.run('JSON.stringify(state)');
    for (const expanded of [true,false,true,false,true]) {
      assert.equal(toggle.getAttribute('aria-expanded'),String(expanded));
      assert.equal(toggle.querySelector('span').textContent,expanded?'收起课程目录':'展开课程目录');
      assert.equal(toggle.querySelectorAll('svg[aria-hidden="true"]').length,2);
      assert.ok(toggle.querySelector('.syllabus-toggle-arrow'));
      assert.equal(doc.querySelector('#course-syllabus').hidden,!expanded);
      assert.equal(doc.querySelector('.study-layout').classList.contains('syllabus-collapsed'),!expanded);
      await app.fire('click',toggle);
    }
    assert.equal(app.run('JSON.stringify(state)'),original);
  }
});

test('reading keeps explanation prominent, can collapse the syllabus, and saves selected-text notes into card drafts', async t => {
  const saved = [];
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }), saveAnnotations: async (id, items) => { saved.push({ id, items }); } });
  t.after(() => app.close()); await app.ready();
  app.run("state.lessons.p1 = structuredClone(demoLessons.p1); activeLesson = 'p1'; page = 'study'; lessonTab = 'read'; render()");
  const doc = app.document;
  assert.ok(doc.querySelector('[data-action="toggle-syllabus"]'));
  await app.fire('click', doc.querySelector('[data-action="toggle-syllabus"]'));
  assert.equal(doc.querySelector('#course-syllabus').hidden, true);
  const reading = doc.querySelector('.reading-section .annotatable');
  const original = reading.textContent;
  const range = doc.createRange(); range.setStart(reading.firstChild, 0); range.setEnd(reading.firstChild, 4);
  doc.defaultView.getSelection().removeAllRanges(); doc.defaultView.getSelection().addRange(range);
  app.run('showAnnotationShortcut()');
  assert.equal(doc.querySelector('#annotation-quick-add').hidden, false);
  await app.fire('click', doc.querySelector('#annotation-quick-add'));
  doc.querySelector('#annotation-text').value = '这是我的个人理解';
  await app.fire('submit', doc.querySelector('#annotation-form'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'p1');
  assert.equal(saved[0].items[0].text, '这是我的个人理解');
  assert.ok(doc.querySelector('.annotation-marker'));
  assert.equal(reading.textContent.replace('✎', ''), original, 'original lesson text remains unchanged');
  const source = app.run("knowledgeSource('p1', '', '0')");
  assert.equal(source.personalNotes[0].text, '这是我的个人理解');
  await app.run("createNote('p1', '', '0')");
  assert.match(app.run('knowledgeDraft.result.content'), /## 我的笔记[\s\S]*这是我的个人理解/);
});

test('block lessons omit the duplicate top tools and keep example revision visible', async t => {
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }) });
  t.after(() => app.close()); await app.ready();
  app.run("state.blockCourses.p1 = { intro:'课程导语', blocks:[{id:'reading-1',type:'reading',title:'讲解',objective:'理解',content:{text:'讲解正文'}},{id:'example-1',type:'example',title:'案例',objective:'应用',content:{text:'案例正文'}}] }; state.lessons={}; activeLesson='p1'; page='study'; lessonTab='read'; render()");
  const doc = app.document;
  assert.equal(doc.querySelector('.knowledge-entry-toolbar details'), null);
  const speechShortcut = doc.querySelector('.quick-ask-dock > .quick-speech-button');
  assert.ok(speechShortcut);
  assert.equal(speechShortcut.previousElementSibling.dataset.action, 'quick-ask');
  assert.equal(speechShortcut.dataset.action, 'open-speech');
  assert.equal(doc.querySelector('.more-learning-tools-menu [data-action="open-speech"]'), null);
  const readingRevision = doc.querySelector('.teaching-reading [data-action="request-revision"]');
  const exampleRevision = doc.querySelector('.teaching-example [data-action="request-revision"]');
  assert.equal(readingRevision.textContent.trim(), '换个讲法');
  assert.equal(exampleRevision.textContent.trim(), '换个例子');
  assert.equal(readingRevision.closest('details'), null);
  assert.equal(exampleRevision.closest('details'), null);
  assert.ok(doc.querySelector('.teaching-example details [data-action="create-note"]'));
  const readingToggle = doc.querySelector('.teaching-reading [data-action="toggle-block-collapse"]');
  const exampleToggle = doc.querySelector('.teaching-example [data-action="toggle-block-collapse"]');
  const readingBody = doc.getElementById(readingToggle.getAttribute('aria-controls'));
  const exampleBody = doc.getElementById(exampleToggle.getAttribute('aria-controls'));
  assert.equal(readingBody.hidden, false);
  assert.equal(exampleBody.hidden, false);
  await app.fire('click', readingToggle);
  assert.equal(readingBody.hidden, true);
  assert.equal(exampleBody.hidden, false, 'collapsing the explanation must not collapse its example');
  assert.equal(readingToggle.textContent, '展开');
  assert.equal(doc.querySelector('.teaching-reading .block-title').textContent, '讲解');
  assert.equal(doc.querySelector('.teaching-reading .block-objective').textContent, '理解');
  await app.fire('click', exampleToggle);
  assert.equal(exampleBody.hidden, true);
  await app.fire('click', readingToggle);
  assert.equal(readingBody.hidden, false);
  assert.equal(exampleBody.hidden, true);
  app.run('render()');
  assert.equal(doc.querySelector('.teaching-example .block-collapsible-body').hidden, true, 'the fold state survives a view rerender');
  const readingTools = doc.querySelector('.teaching-reading .more-learning-tools');
  const exampleTools = doc.querySelector('.teaching-example .more-learning-tools');
  readingTools.open = true;
  await app.fire('click', doc.body);
  assert.equal(readingTools.open, false, 'clicking outside closes the dropdown');
  readingTools.open = true; exampleTools.open = true;
  await app.fire('click', exampleTools.querySelector('summary'));
  assert.equal(readingTools.open, false, 'opening another dropdown closes the first');
  assert.equal(exampleTools.open, true);
  await app.fire('keydown', doc.body, { key: 'Escape' });
  assert.equal(exampleTools.open, false, 'Escape closes the dropdown');
});

test('practice and summary use independent reading-style collapse controls without changing course content', async t => {
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }) });
  t.after(() => app.close()); await app.ready();
  app.run("state.blockCourses.p1 = {intro:'课程导语',blocks:[{id:'practice-1',type:'practice',title:'实践任务',objective:'独立完成任务',content:{text:'## 操作步骤\\n\\n完成任务并核对结果。'}},{id:'summary-1',type:'summary',title:'本课总结',objective:'回顾核心方法',content:{text:'- 理解方法\\n- 核对结果'}},{id:'practice-pending',type:'practice',title:'待生成实践',objective:'扩展应用',content:null},{id:'summary-pending',type:'summary',title:'待生成总结',objective:'归纳方法',content:null},{id:'quiz-1',type:'quiz',title:'随堂练习',objective:'检验理解',content:{questions:[{prompt:'应先做什么？',options:['理解方法','跳过步骤','忽略结果','直接结束'],answer:0,explanation:'先理解方法。'}]}}]}; state.lessons={}; activeLesson='p1'; page='study'; lessonTab='read'; render()");
  const doc = app.document;
  const original = app.run('JSON.stringify(state.blockCourses.p1)');
  const section = id => doc.querySelector(`[data-block-id="${id}"]`);
  const toggle = id => section(id).querySelector('[data-action="toggle-block-collapse"]');
  const body = id => doc.getElementById(toggle(id).getAttribute('aria-controls'));
  const practiceToggle = toggle('practice-1'), summaryToggle = toggle('summary-1');
  assert.equal(doc.querySelectorAll('[data-action="toggle-block-collapse"]').length, 2);
  for (const control of [practiceToggle, summaryToggle]) {
    assert.equal(control.type, 'button');
    assert.equal(control.className, 'block-collapse-toggle');
    assert.equal(control.textContent, '收起');
    assert.equal(control.getAttribute('aria-expanded'), 'true');
  }
  assert.equal(body('practice-1').hidden, false);
  assert.equal(body('summary-1').hidden, false);
  await app.fire('click', practiceToggle);
  assert.equal(body('practice-1').hidden, true);
  assert.equal(body('summary-1').hidden, false, 'practice folds independently of summary');
  assert.equal(practiceToggle.textContent, '展开');
  assert.equal(practiceToggle.getAttribute('aria-expanded'), 'false');
  await app.fire('click', summaryToggle);
  assert.equal(body('summary-1').hidden, true);
  for (const [id, title, objective] of [['practice-1', '实践任务', '独立完成任务'], ['summary-1', '本课总结', '回顾核心方法']]) {
    assert.equal(section(id).querySelector('.block-title').textContent, title);
    assert.equal(section(id).querySelector('.block-objective').textContent, objective);
    assert.ok(section(id).querySelector('.more-learning-tools'));
    assert.equal(section(id).querySelector('.block-title').closest('[hidden]'), null);
    assert.equal(section(id).querySelector('.block-objective').closest('[hidden]'), null);
  }
  app.run('render()');
  for (const id of ['practice-1', 'summary-1']) {
    assert.equal(body(id).hidden, true, 'fold state survives rerender');
    assert.equal(toggle(id).getAttribute('aria-expanded'), 'false');
    await app.fire('click', toggle(id));
    assert.equal(body(id).hidden, false);
    assert.equal(toggle(id).textContent, '收起');
    assert.equal(toggle(id).getAttribute('aria-expanded'), 'true');
  }
  assert.match(body('practice-1').textContent, /完成任务并核对结果/);
  assert.match(body('summary-1').textContent, /理解方法/);
  for (const id of ['practice-pending', 'summary-pending']) {
    assert.equal(toggle(id), null, 'pending modules keep the generation action instead of a fold control');
    assert.ok(section(id).querySelector('[data-action="generate-block"]'));
  }
  assert.equal(toggle('quiz-1'), null);
  assert.ok(section('quiz-1').querySelector('[data-action="quiz"]'));
  assert.equal(app.run('JSON.stringify(state.blockCourses.p1)'), original, 'folding only changes view state');
});

test('block knowledge source uses the selected generated block and rejects pending blocks', () => {
  const app = harness();
  app.run("state.blockCourses.p1 = { intro: '导语', blocks: [{ id: 'one', type: 'reading', title: '变量', objective: '理解变量', content: { text: '## 定义\\n\\n变量保存值。' } }, { id: 'two', type: 'example', title: '案例', objective: '看懂案例' }] }; state.lessons = {};");
  assert.equal(app.run("knowledgeSource('p1', 'one').sourceTitle"), '变量');
  assert.match(app.run("knowledgeSource('p1', 'one').sourceText"), /变量保存值/);
  assert.throws(() => app.run("knowledgeSource('p1', 'two')"), /尚未生成/);
});
test('new learning clarifies before planning, preserves answers on failure, and persists the confirmed brief', async () => {
  const calls = [];
  let failPlan = true;
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok:true, json:async () => ({mode:'ai'}) };
    const data = JSON.parse(options.body); calls.push({url,data});
    if (url === '/api/plan-clarify') return {ok:true,json:async () => questionnaire};
    if (failPlan) return {ok:false,json:async () => ({error:'测试模型暂时不可用'})};
    return {ok:true,json:async () => ({...structuredClone(demoPlan),id:'new-route',source:'ai',goal:data.goal,learningBrief:learningBriefFrom(data.clarification),lessons:demoPlan.lessons.map((lesson,index) => ({...lesson,id:`new-${index}`}))})};
  });
  app.run("status = {mode:'ai'}; planner()");
  await app.submit('plan-form', {goal:'我想用 Python 提高效率',level:'零基础',daily:'25',days:'14'});
  assert.equal(app.run('plannerDraft.step'), 'questions');
  assert.equal(app.run('state.plans.length'), 1, 'no route exists before confirmation');
  assert.match(app.node('#planner').innerHTML, /type="checkbox"/);
  assert.match(app.node('#planner').innerHTML, /还不确定/);
  await app.submit('clarification-form', {q1:'o1'});
  assert.equal(app.run('plannerDraft.step'), 'questions');
  assert.match(app.node('#planner').innerHTML, /请回答每个问题/);
  await app.submit('clarification-form', {q1:'o1',q2:['o1','o2'],'detail-q1':'先预览，再执行'});
  assert.equal(app.run('plannerDraft.step'), 'review');
  assert.equal(calls.length, 1, 'review itself must not call the model');
  await app.submit('plan-confirm-form', {notes:'不学习网页开发'});
  assert.equal(app.run('plannerDraft.step'), 'review');
  assert.equal(app.run('plannerDraft.notes'), '不学习网页开发');
  assert.match(app.node('#planner').innerHTML, /测试模型暂时不可用/);
  assert.equal(app.run('plannerBusy'), false);
  failPlan = false;
  await app.submit('plan-confirm-form', {notes:'不学习网页开发'});
  assert.equal(app.run('page'), 'routes');
  assert.equal(app.node('#planner').open, false);
  assert.equal(app.run('state.plans.length'), 2);
  assert.equal(calls.at(-1).data.clarification.answers[0].detail, '先预览，再执行');
  const restored = harness(app.storage.get('learnflow.v1'));
  assert.equal(restored.run('plan().learningBrief.notes'), '不学习网页开发');
  assert.match(app.node('#app').innerHTML, /查看定制需求与回答/);
});

test('regenerating a questionnaire keeps the previous questions and answers if analysis fails', async () => {
  let calls = 0, fail = false;
  const app = harness(null, async (url) => {
    if (url === '/api/status') return {ok:true,json:async()=>({mode:'ai'})};
    calls++;
    return fail ? {ok:false,json:async()=>({error:'需求分析失败'})} : {ok:true,json:async()=>questionnaire};
  });
  app.run("status={mode:'ai'};planner()");
  await app.submit('plan-form',{goal:'学习 Python 文件整理',level:'零基础',daily:'25',days:'14'});
  assert.equal(calls,1);
  app.node('#clarification-form').values={q1:'o1',q2:'o2','detail-q1':'先学习安全预览'};
  fail=true;
  await app.run("action('planner-regenerate',{dataset:{}})");
  assert.equal(calls,2);
  assert.equal(app.run('plannerDraft.questionnaire.questions.length'),2);
  assert.equal(app.run('plannerDraft.answers[0].detail'),'先学习安全预览');
  assert.match(app.node('#planner').innerHTML,/需求分析失败/);
  fail=false;
  await app.run("action('planner-regenerate',{dataset:{}})");
  assert.equal(calls,3);
  assert.equal(app.run('plannerDraft.answers.length'),0);
});

test('a learner can request deeper clarification without editing the original goal', async () => {
  const requests=[];
  const deep={...questionnaire,questions:Array.from({length:5},(_,index)=>({...questionnaire.questions[index%2],id:`q${index+1}`,question:`深入问题 ${index+1}`}))};
  const app=harness(null,async(url,options)=>{
    if(url==='/api/status') return {ok:true,json:async()=>({mode:'ai'})};
    requests.push(JSON.parse(options.body));
    return {ok:true,json:async()=>requests.length===1?questionnaire:deep};
  });
  app.run("status={mode:'ai'};planner()");
  await app.submit('plan-form',{goal:'学习 SQL',level:'零基础',daily:'15',days:'30'});
  assert.match(app.node('#planner').innerHTML,/深入澄清（4–6 题）/);
  app.node('#clarification-form').values={};
  await app.run("action('planner-deepen',{dataset:{}})");
  assert.equal(requests[1].goal,'学习 SQL');
  assert.equal(requests[1].depth,'deep');
  assert.equal(app.run('plannerDraft.questionnaire.questions.length'),5);
  assert.doesNotMatch(app.node('#planner').innerHTML,/data-action="planner-deepen"/);
});
test('questionnaire retries keep the goal; returning to edit invalidates answers only when input changes', async () => {
  let calls = 0, failQuestionnaire = true;
  const app = harness(null, async (url) => {
    if (url === '/api/status') return {ok:true,json:async () => ({mode:'ai'})};
    calls++;
    return failQuestionnaire ? {ok:false,json:async () => ({error:'问卷生成失败'})} : {ok:true,json:async () => questionnaire};
  });
  app.run("status = {mode:'ai'}; planner()");
  const values = {goal:'我想学 Python',level:'零基础',daily:'25',days:'14'};
  await app.submit('plan-form', values);
  assert.equal(app.run('plannerDraft.goal'), values.goal);
  assert.equal(app.run('plannerDraft.step'), 'goal');
  failQuestionnaire = false;
  await app.submit('plan-form', values);
  app.node('#clarification-form').values = {q1:'o1',q2:'unsure'};
  await app.run("action('planner-back',{dataset:{}})");
  await app.submit('plan-form', values);
  assert.equal(calls, 2, 'unchanged inputs reuse the same questionnaire and answers');
  assert.equal(app.run('plannerDraft.answers[1].optionIds[0]'), 'unsure');
  await app.run("action('planner-back',{dataset:{}})");
  await app.submit('plan-form', {...values,goal:'我想学数据分析'});
  assert.equal(calls, 3);
  assert.equal(app.run('plannerDraft.answers.length'), 0);
});
test('in-flight clarification prevents duplicate requests and closing; model question text cannot inject controls', async () => {
  let resolveQuestionnaire, calls = 0;
  const app = harness(null, async url => {
    if (url === '/api/status') return {ok:true,json:async () => ({mode:'ai'})};
    calls++;
    return new Promise(resolve => { resolveQuestionnaire = resolve; });
  });
  app.run("status = {mode:'ai'}; planner()");
  const values = {goal:'想学自动化',level:'零基础',daily:'25',days:'14'};
  const pending = app.submit('plan-form',values);
  assert.equal(app.run('plannerBusy'),true);
  await app.submit('plan-form',values);
  await app.run("action('close-planner',{dataset:{}})");
  assert.equal(app.node('#planner').open,true);
  assert.equal(calls,1);
  const malicious=structuredClone(questionnaire);
  malicious.questions[0].question='<button data-action="delete-plan">点击删除</button>';
  resolveQuestionnaire({ok:true,json:async () => malicious});
  await pending;
  assert.equal(app.run('plannerBusy'),false);
  assert.doesNotMatch(app.node('#planner').innerHTML,/<button data-action="delete-plan">/);
  assert.match(app.node('#planner').innerHTML,/&lt;button/);
});
test('simplified fact-check settings and one-click generation expose status without duplicate saves or a revision workbench', async t => {
  const saved = [], cfg = { provider: 'ollama', model: 'reviewer', baseUrl: '', localOnly: true, jsonMode: 'auto', thinkingMode: 'auto', timeoutMs: 120000, maxTokens: 8192 };
  let generated = 0, restored = 0, enabled = true;
  const original = { text: '待核实的原文。' }, checked = { text: '修正后的正文。' };
  const record = { id: 'check-1', blockId: 'r1', status: 'corrected', summary: '已修正并复核。', content: checked, beforeContent: original, issues: [], sources: [] };
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai', model: 'generator' }, qualityStatus: { mode: 'ai' }, qualitySettings: cfg, factCheck: { enabled: true } }),
    saveQualitySettings: async value => { saved.push(value); return { settings: cfg, status: { mode: 'ai' }, factCheck: { enabled } }; },
    setFactCheckEnabled: async value => { enabled = value; return { enabled, error: '' }; },
    generateCourseBlock: async (value, progressId) => {
      generated++; assert.equal(value.lessonId, 'custom-1'); assert.equal(value.blockId, 'r1'); assert.match(progressId, /^generation-/);
      return { content: checked, factChecks: [record] };
    },
    saveBlock: async () => { throw new Error('Must not save the same generated block twice'); },
    checkBlockFacts: async () => ({ content: checked, factChecks: [record], cached: true }),
    restoreFactCheck: async (lessonId, blockId, id) => { restored++; assert.equal(id, 'check-1'); return { content: original, factChecks: [record] }; }
  });
  t.after(() => app.close()); await app.ready(); app.run("navigate('settings')");
  const doc = app.document;
  assert.match(doc.querySelector('#settings-reviewer').textContent, /事实核查模型/);
  assert.equal(doc.querySelector('[name="autoFactCheck"]'), null);
  await app.fire('submit', doc.querySelector('#quality-settings-form')); assert.equal(Object.hasOwn(saved[0], 'autoFactCheck'), false);
  assert.equal(enabled, true, 'saving model settings must not change the switch');
  app.run("state.plans[0].source='ai'; state.plans[0].lessons[0].id='custom-1'; state.lessons={}; state.blockCourses={'custom-1':{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:null},{id:'q1',type:'quiz',title:'测验',objective:'应用',content:null}]}}; activeLesson='custom-1'; page='study'; render()");
  const controls = doc.querySelector('.course-source-controls');
  assert.equal(controls.querySelectorAll('[role=switch]').length, 2);
  assert.ok(controls.children[0].querySelector('[data-action=toggle-course-search]'));
  assert.ok(controls.children[1].querySelector('[data-action=toggle-course-fact-check]'));
  assert.equal(doc.querySelector('[data-action=toggle-course-fact-check]').getAttribute('aria-checked'), 'true');
  await app.fire('click', doc.querySelector('[data-action=toggle-course-fact-check]'));
  assert.equal(enabled, false); assert.equal(generated, 0, 'toggling must not call the model');
  assert.equal(doc.querySelector('[data-action=toggle-course-fact-check]').getAttribute('aria-checked'), 'false');
  assert.equal(doc.querySelector('[data-action=toggle-course-search]').getAttribute('aria-checked'), 'false');
  await app.fire('click', doc.querySelector('[data-action=toggle-course-fact-check]'));
  assert.equal(enabled, true); assert.equal(generated, 0);
  await app.fire('click', doc.querySelector('[data-action="generate-block"][data-block="r1"]'));
  assert.equal(generated, 1); assert.ok(doc.querySelector('.fact-check-strip.is-corrected'));
  assert.match(doc.querySelector('.fact-check-strip summary').textContent, /已自动修正/);
  assert.equal(doc.querySelector('.fact-check-strip').open, false);
  assert.equal(doc.querySelector('#quality-revision-dialog'), null);
  const details = doc.querySelector('.fact-check-strip'); details.open = true;
  await app.fire('click', details.querySelector('[data-action="check-block-facts"]'));
  assert.match(doc.querySelector('#toast').textContent, /复用/);
  doc.querySelector('.fact-check-strip').open = true;
  await app.fire('click', doc.querySelector('[data-action="restore-fact-check"]'));
  assert.equal(restored, 1); assert.ok(doc.querySelector('.fact-check-strip.is-unchecked'));
  assert.match(doc.querySelector('.block-text').textContent, /待核实的原文/);
});

test('selecting fact concerns requires confirmation, preserves choices on failure and directly updates restorable text', async t => {
  const original = { text: '第一处有疑点。第二处也有疑点。' }, corrected = { text: '第一处有疑点。第二处补充适用条件。' };
  const issues = ['第一处有疑点。', '第二处也有疑点。'].map(quote => ({ quote, reason: '缺少条件。', suggestion: '补充说明。', evidence: [] }));
  const source = { id: 'suspect-1', blockId: 'r1', status: 'uncertain', content: original, issues, sources: [], summary: '有两处待核实。' };
  const edited = { ...source, id: 'edited-1', status: 'edited', content: corrected, beforeContent: original, issues: [issues[0]], summary: '已按选择修正，尚未重新核查。' };
  let corrections = 0, fail = true;
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' }, qualityStatus: { mode: 'ai' } }), checkBlockFacts: async () => { throw new Error('Must not automatically recheck'); },
    correctFactIssues: async (value, progressId) => {
      corrections++; assert.equal(value.confirmed, true); assert.deepEqual(Array.from(value.issueIndexes), [1]); assert.equal(value.recordId, source.id); assert.match(progressId, /^generation-/);
      if (fail) throw new Error('修正模型暂时不可用');
      return { content: corrected, factChecks: [source, edited] };
    },
    restoreFactCheck: async () => ({ content: original, factChecks: [source, edited] }) });
  t.after(() => app.close()); await app.ready();
  app.run(`state.plans[0].source='ai'; state.lessons={}; state.blockCourses={p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:${JSON.stringify(original)}}]}}; state.factChecks={p1:[${JSON.stringify(source)}]}; activeLesson='p1'; page='study'; render()`);
  const doc = app.document;
  assert.equal(doc.querySelectorAll('[data-fact-selection]').length, 2);
  assert.equal(doc.querySelector('[data-action=correct-fact-issues]').disabled, true);
  const select = doc.querySelector('[data-fact-selection][data-issue="1"]'); select.checked = true; await app.fire('change', select);
  assert.equal(doc.querySelector('[data-action=correct-fact-issues]').disabled, false);
  assert.match(doc.querySelector('[data-action=correct-fact-issues]').textContent, /1/);
  app.run('window.confirm = () => false');
  await app.fire('click', doc.querySelector('[data-action=correct-fact-issues]')); assert.equal(corrections, 0);
  app.run('window.confirm = () => true'); doc.querySelector('.fact-check-strip').open = true;
  await assert.rejects(app.run("action('correct-fact-issues',document.querySelector('[data-action=correct-fact-issues]'))"), /暂时不可用/);
  assert.equal(corrections, 1); assert.match(doc.querySelector('.fact-check-details').textContent, /暂时不可用/);
  assert.equal(doc.querySelector('[data-fact-selection][data-issue="1"]').checked, true);
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.text'), original.text);
  fail = false;
  await app.fire('click', doc.querySelector('[data-action=correct-fact-issues]'));
  assert.equal(corrections, 2); assert.match(doc.querySelector('.block-text').textContent, /第二处补充适用条件/);
  assert.ok(doc.querySelector('.fact-check-strip.is-edited')); assert.equal(doc.querySelector('.fact-check-strip').open, true);
  assert.match(doc.querySelector('.fact-check-strip summary').textContent, /待重新核查/);
  assert.equal(doc.querySelectorAll('[data-fact-selection]').length, 1);
  await app.fire('click', doc.querySelector('[data-action=restore-fact-check]'));
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.text'), original.text); assert.equal(corrections, 2);
});

test('unlocated fact concerns remain visible without direct-correction checkboxes or false pass labels', async t => {
  const content = { text: '第一处有疑点。' };
  const issues = [{ kind: 'fact', certainty: 'uncertain', quote: content.text, reason: '需要核实。', suggestion: '核对条件。', evidence: [] },
    { kind: 'fact', certainty: 'uncertain', quote: '模型重新概括的描述。', unlocated: true, reason: '原句待定位。', suggestion: '核对原文。', evidence: [] }];
  const record = { id: 'unlocated-review', blockId: 'r1', status: 'uncertain', content, issues, sources: [], summary: '有待核实项。' };
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' } }), checkBlockFacts: async () => {}, correctFactIssues: async () => { throw new Error('Must not correct while rendering'); } });
  t.after(() => app.close()); await app.ready();
  app.run(`state.plans[0].source='ai'; state.lessons={}; state.blockCourses={p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:${JSON.stringify(content)}}]}}; state.factChecks={p1:[${JSON.stringify(record)}]}; activeLesson='p1'; page='study'; render()`);
  const doc = app.document;
  assert.ok(doc.querySelector('.fact-check-strip.is-uncertain'));
  assert.match(doc.querySelector('.fact-check-strip summary').textContent, /有 2 处待核实/);
  assert.equal(doc.querySelectorAll('[data-fact-selection]').length, 1);
  assert.equal(doc.querySelector('[data-fact-selection]').dataset.issue, '0');
  assert.match(doc.querySelectorAll('.fact-check-details article')[1].textContent, /原句待定位.*以下为模型描述/);
  assert.match(doc.querySelectorAll('.fact-check-details article')[1].textContent, /模型重新概括的描述/);
  app.run('state.factChecks.p1[0].issues.shift(); render()');
  assert.equal(doc.querySelector('[data-fact-selection]'), null);
  assert.equal(doc.querySelector('[data-action="correct-fact-issues"]'), null);
  assert.ok(doc.querySelector('[data-action="check-block-facts"]'));
  assert.ok(doc.querySelector('.fact-check-strip.is-uncertain'));
});

test('course quality switch preserves state on save failure and locks during generation and preference saves', async t => {
  let finish, saves = 0;
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' }, qualityStatus: { mode: 'ai' }, factCheck: { enabled: false } }),
    setFactCheckEnabled: async () => { saves++; return new Promise(resolve => { finish = resolve; }); } });
  t.after(() => app.close()); await app.ready();
  app.run("state.plans[0].source='ai'; state.lessons={}; state.blockCourses={p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:null}]}}; activeLesson='p1'; page='study'; render()");
  const doc = app.document;
  app.run("courseGenerationBusy.add('other-course'); decorateCourseSearch()");
  assert.equal(doc.querySelector('[data-action=toggle-course-fact-check]').disabled, true);
  await assert.rejects(app.run("action('toggle-course-fact-check',{dataset:{}})"), /等待/); assert.equal(saves, 0);
  app.run("courseGenerationBusy.clear(); decorateCourseSearch()");
  const saving = app.run("action('toggle-course-fact-check',{dataset:{}})");
  assert.equal(doc.querySelector('[data-action=toggle-course-fact-check]').disabled, true);
  assert.equal(doc.querySelector('[data-action=generate-block]').disabled, true);
  await app.run("action('toggle-course-fact-check',{dataset:{}})"); assert.equal(saves, 1);
  finish({ enabled: true, error: '' }); await saving;
  assert.equal(doc.querySelector('[data-action=toggle-course-fact-check]').getAttribute('aria-checked'), 'true');
  app.run("desktop.setFactCheckEnabled = async () => { throw new Error('设置保存失败'); }");
  await assert.rejects(app.run("action('toggle-course-fact-check',{dataset:{}})"), /设置保存失败/);
  assert.equal(doc.querySelector('[data-action=toggle-course-fact-check]').getAttribute('aria-checked'), 'true');
  assert.equal(doc.querySelector('[data-action=toggle-course-fact-check]').disabled, false);
  assert.match(doc.querySelector('.course-source-controls').textContent, /设置保存失败/);
  app.run('render()'); assert.equal(doc.querySelector('[data-action=toggle-course-fact-check]').getAttribute('aria-checked'), 'true');
});

test('an unconfigured quality switch offers a direct link to the independent model without calling an API', async t => {
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' }, qualityStatus: { mode: 'demo' }, factCheck: { enabled: false } }) });
  t.after(() => app.close()); await app.ready();
  app.run("state.plans[0].source='ai'; state.lessons={}; state.blockCourses={p1:{intro:'导语',blocks:[{id:'r1',type:'reading',title:'讲解',objective:'理解',content:null}]}}; activeLesson='p1'; page='study'; render()");
  const doc = app.document;
  assert.ok(doc.querySelector('[data-action=configure-fact-check]'));
  await app.fire('click', doc.querySelector('[data-action=configure-fact-check]'));
  assert.equal(doc.querySelector('#settings-reviewer').open, true);
  assert.equal(doc.querySelector('[name=autoFactCheck]'), null);
});

test('generation panel spans pages, receives actual desktop stages and finishes only after the request returns', async t => {
  let listener, resolveRequest, requestId;
  const outline = { intro: '课程目标', blocks: [{ type: 'reading', title: '讲解', objective: '理解' }, { type: 'example', title: '案例', objective: '应用' }, { type: 'quiz', title: '检验', objective: '判断' }] };
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' } }),
    onGenerationProgress: receive => { listener = receive; },
    request: async (path, data, id) => {
      assert.equal(path, 'lesson-outline'); assert.equal(data.title, demoPlan.lessons[0].title);
      requestId = id; return new Promise(resolve => { resolveRequest = resolve; });
    }, saveOutline: async (_id, value) => ({ ...value, blocks: value.blocks.map((b, i) => ({ ...b, id: `b-${i}`, content: null })) })
  });
  t.after(() => app.close()); await app.ready();
  app.run("state.plans[0].source='ai'; state.plans[0].lessons[0].id='custom-1'; state.lessons={}; activeLesson='custom-1'; page='study'; render()");
  const pending = app.fire('click', app.document.querySelector('[data-action="generate-lesson"]'));
  for (let i = 0; i < 10 && !resolveRequest; i++) await Promise.resolve();
  const panel = app.document.querySelector('#generation-progress');
  assert.equal(panel.hidden, false); assert.match(requestId, /^generation-[a-z0-9-]+$/);
  listener({ requestId, stage: 'generating' }); assert.match(panel.textContent, /模型正在生成内容/);
  listener({ requestId: 'old-request', stage: 'validating' }); assert.ok(!panel.textContent.includes('正在检查'));
  app.run("navigate('wiki')"); assert.equal(panel.hidden, false); assert.equal(panel.querySelectorAll('.is-running').length, 1);
  listener({ requestId, stage: 'validating' }); assert.match(panel.textContent, /正在检查生成内容与格式/);
  resolveRequest(outline); await pending;
  assert.equal(panel.querySelectorAll('.is-running').length, 0); assert.match(panel.textContent, /已收到生成结果/);
  await app.fire('click', panel.querySelector('[data-action="dismiss-generation-task"]')); assert.equal(panel.hidden, true);
});

test('desktop course sharing offers export/import without replacing cached learning data and cancellation is inert', async t => {
  let exportCalls = 0, importCalls = 0;
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }),
    exportCourse: async id => { assert.equal(id, demoPlan.id); exportCalls++; return exportCalls > 1; },
    importCourse: async () => {
      importCalls++;
      if (importCalls === 1) return null;
      if (importCalls === 2) throw new Error('课程包损坏');
      const plan = { ...structuredClone(demoPlan), id: 'shared-import', title: '收到的课程', source: 'ai', lessons: demoPlan.lessons.map((l, i) => ({ ...l, id: `import-${i}` })) };
      return { planId: plan.id, state: { plans: [demoPlan, plan] } };
    }
  });
  t.after(() => app.close()); await app.ready();
  app.run("state.reflections.p1='保留心得'; state.chats.p1=[{role:'user',content:'保留问题'}]; navigate('routes')");
  assert.ok(app.document.querySelector('[data-action="export-course"]'));
  assert.ok(app.document.querySelector('[data-action="import-course"]'));
  const before = app.run('JSON.stringify(state)');
  await app.fire('click', app.document.querySelector('[data-action="export-course"]'));
  assert.equal(app.run('JSON.stringify(state)'), before);
  await app.fire('click', app.document.querySelector('[data-action="export-course"]'));
  assert.match(app.document.querySelector('#toast').textContent, /课程包已导出/);
  await app.fire('click', app.document.querySelector('[data-action="import-course"]'));
  assert.equal(app.run('JSON.stringify(state)'), before);
  await app.fire('click', app.document.querySelector('[data-action="import-course"]'));
  assert.match(app.document.querySelector('#toast').textContent, /课程包损坏/);
  assert.equal(app.run('JSON.stringify(state)'), before);
  await app.fire('click', app.document.querySelector('[data-action="import-course"]'));
  assert.equal(app.run('state.plans.length'), 2);
  assert.equal(app.run('state.active'), 'shared-import');
  assert.equal(app.run('state.reflections.p1'), '保留心得');
  assert.equal(app.run('state.chats.p1[0].content'), '保留问题');
  assert.match(app.document.querySelector('#app').textContent, /收到的课程/);
});

test('AI course expands from outline to independently generated blocks', async () => {
  const outline = { intro: '循序学习', blocks: [{ type: 'reading', title: '概念', objective: '理解' }, { type: 'quiz', title: '练习', objective: '检验' }] };
  const calls = [], payloads = [];
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    calls.push(url); payloads.push(JSON.parse(options.body));
    return { ok: true, json: async () => url.endsWith('lesson-outline') ? outline : { text: '这一块的正文' } };
  });
  app.run("state.plans[0].source = 'ai'; state.plans[0].lessons[0].id = 'custom-1'; state.lessons = {}; activeLesson = 'custom-1'; page = 'study'; render()");
  app.run(`state.plans[0].learningBrief = ${JSON.stringify(learningBriefFrom(clarification))}`);
  await app.run("action('generate-lesson', {dataset:{id:'custom-1'}})");
  assert.equal(app.run('state.blockCourses["custom-1"].blocks.length'), 2);
  assert.match(app.node('#app').innerHTML, /生成这一块/);
  const blockId = app.run('state.blockCourses["custom-1"].blocks[0].id');
  await app.run(`action('generate-block', {dataset:{id:'custom-1', block:'${blockId}'}})`);
  assert.equal(app.run('state.blockCourses["custom-1"].blocks[0].content.text'), '这一块的正文');
  assert.deepEqual(calls, ['/api/lesson-outline', '/api/lesson-block']);
  assert.equal(payloads[0].route.length, demoPlan.lessons.length);
  assert.equal(payloads[0].lessonPosition, 1);
  assert.equal(payloads[1].sequence.position, 1);
  assert.equal(payloads[1].outline.length, 2);
  assert.deepEqual(payloads[0].learningBrief,learningBriefFrom(clarification));
  assert.deepEqual(payloads[1].learningBrief,payloads[0].learningBrief);
  assert.match(app.node('#app').innerHTML, /这一块的正文/);
});

test('outline repair shows progress, blocks duplicate clicks and retains draft across navigation for manual retry', async () => {
  const draft = { intro: '课程目标', blocks: [{ type: 'reading', title: '<案例标记>', objective: '理解' }, { type: 'quiz', title: '练习', objective: '检验' }] };
  const fixed = { ...draft, blocks: [draft.blocks[0], { type: 'example', title: '配套案例', objective: '应用' }, draft.blocks[1]] };
  let rejectRepair;
  const calls = [];
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) return { ok: true, json: async () => ({ status: 'needs_examples', draft }) };
    if (calls.length === 2) return new Promise((_resolve, reject) => { rejectRepair = reject; });
    return { ok: true, json: async () => fixed };
  });
  app.run("state.plans[0].source='ai'; state.plans[0].lessons[0].id='custom-1'; state.lessons={}; activeLesson='custom-1'; page='study'; render()");
  assert.match(app.node('#app').innerHTML, /可能增加模型调用费用/);
  const pending = app.run("action('generate-lesson', {dataset:{id:'custom-1'}})");
  for (let i = 0; i < 10 && !rejectRepair; i++) await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.match(app.node('#app').innerHTML, /正在补充配套案例/);
  assert.match(app.node('#app').innerHTML, /&lt;案例标记&gt;/);
  await app.run("action('generate-lesson', {dataset:{id:'custom-1'}})");
  assert.equal(calls.length, 2);
  const failed = assert.rejects(pending, /模拟补充失败/);
  rejectRepair(new Error('模拟补充失败')); await failed;
  assert.equal(app.run('state.blockCourses?.["custom-1"]'), undefined);
  app.run("navigate('routes'); navigate('study')");
  assert.match(app.node('#app').innerHTML, /重新补充/);
  assert.match(app.node('#app').innerHTML, /原大纲已保留/);
  assert.equal(calls.length, 2);
  await app.run("action('generate-lesson', {dataset:{id:'custom-1'}})");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], calls[1]);
  assert.deepEqual(calls[2].repairDraft, draft);
  assert.equal(app.run('state.blockCourses["custom-1"].blocks.length'), 3);
  assert.equal(app.run('outlineDrafts.has("custom-1")'), false);
});

test('desktop outline repair uses actual buttons and save failures retry storage without paying again', async t => {
  const draft = { intro: '课程目标', blocks: [{ type: 'reading', title: '讲解', objective: '理解' }, { type: 'quiz', title: '练习', objective: '检验' }] };
  const fixed = { ...draft, blocks: [draft.blocks[0], { type: 'example', title: '案例', objective: '应用' }, draft.blocks[1]] };
  let calls = 0, saves = 0;
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' } }),
    request: async (path, data) => {
      assert.equal(path, 'lesson-outline'); calls++;
      if (calls === 1) return { status: 'needs_examples', draft };
      assert.deepEqual(JSON.parse(JSON.stringify(data.repairDraft)), draft); return fixed;
    },
    saveOutline: async (_id, outline) => {
      saves++; if (saves === 1) throw new Error('模拟磁盘写入失败');
      return { intro: outline.intro, blocks: outline.blocks.map((b, i) => ({ ...b, id: `block-${i}`, content: null })) };
    }
  });
  t.after(() => app.close()); await app.ready();
  app.run("state.plans[0].source='ai'; state.plans[0].lessons[0].id='custom-1'; state.lessons={}; activeLesson='custom-1'; page='study'; render()");
  await app.fire('click', app.document.querySelector('[data-action="generate-lesson"]'));
  assert.equal(calls, 2); assert.equal(saves, 1);
  assert.equal(app.run('state.blockCourses?.["custom-1"]'), undefined);
  assert.match(app.document.querySelector('.empty-state [role="status"]').textContent, /保存失败/);
  assert.equal(app.document.querySelector('.empty-state details').open, false);
  const retry = app.document.querySelector('[data-action="generate-lesson"]');
  assert.match(retry.textContent, /重新保存/); assert.equal(retry.disabled, false);
  await app.fire('click', retry);
  assert.equal(calls, 2); assert.equal(saves, 2);
  assert.equal(app.run('state.blockCourses["custom-1"].blocks.length'), 3);
});

test('automatic outline repair succeeds once and does not generate block content', async () => {
  const draft = { intro: '课程目标', blocks: [{ type: 'reading', title: '讲解', objective: '理解' }, { type: 'quiz', title: '练习', objective: '检验' }] };
  const fixed = { ...draft, blocks: [draft.blocks[0], { type: 'example', title: '案例', objective: '应用' }, draft.blocks[1]] };
  const calls = [];
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => calls.length === 1 ? { status: 'needs_examples', draft } : fixed };
  });
  app.run("state.plans[0].source='ai'; state.plans[0].lessons[0].id='custom-1'; state.lessons={}; activeLesson='custom-1'; page='study'");
  await app.run("action('generate-lesson', {dataset:{id:'custom-1'}})");
  assert.equal(calls.length, 2); assert.deepEqual(calls[1].repairDraft, draft);
  assert.equal(app.run('state.blockCourses["custom-1"].blocks.every(b => b.content === null)'), true);
});

test('the persistent lesson Q&A shortcut opens the current course in both lesson formats', () => {
  const app = harness();
  app.run("openLesson('p1')");
  assert.match(app.node('#app').innerHTML, /data-action="quick-ask"/);
  assert.equal(app.run('lessonTab'), 'read');
  app.run("action('quick-ask', { dataset: {} })");
  assert.equal(app.run('lessonTab'), 'chat');
  assert.match(app.node('#app').innerHTML, /class="study-chat"/);
  assert.match(app.node('#app').innerHTML, /data-action="quick-ask"/);
  app.run("state.blockCourses.p1 = {intro:'分步课程',blocks:[{id:'reading-1',type:'reading',title:'讲解',objective:'理解',content:null},{id:'quiz-1',type:'quiz',title:'练习',objective:'检验',content:null}]}; openLesson('p1')");
  assert.match(app.node('#app').innerHTML, /data-action="quick-ask"/);
  app.run("action('quick-ask', { dataset: {} })");
  assert.equal(app.run('lessonTab'), 'chat');
  assert.match(app.node('#app').innerHTML, /当前课程的 AI 答疑/);
});
test('returning from Q&A restores the reading position for both lesson formats and tab entry', () => {
  const app = harness();
  app.run("openLesson('p1')");
  app.run('window.scrollY = 742');
  app.run("action('quick-ask', { dataset: {} })");
  assert.match(app.node('#app').innerHTML, /data-action="back-to-reading"/);
  app.run('window.scrollY = 0');
  app.run("action('back-to-reading', { dataset: {} })");
  assert.equal(app.run('lessonTab'), 'read');
  assert.equal(app.run('window.scrollY'), 742);

  app.run("state.blockCourses.p1 = {intro:'分步课程',blocks:[{id:'reading-1',type:'reading',title:'讲解',objective:'理解',content:null}]}; openLesson('p1')");
  assert.equal(app.run('readingReturn'), null, 'opening a lesson clears the previous return position');
  app.run('window.scrollY = 386');
  app.run("action('lesson-tab', { dataset: { tab: 'chat' } })");
  app.run('window.scrollY = 0');
  app.run("action('lesson-tab', { dataset: { tab: 'read' } })");
  assert.equal(app.run('window.scrollY'), 386);
});
test('block generation carries bounded nearby outline and prior teaching context', () => {
  const blocks = Array.from({ length: 45 }, (_, index) => ({ id: `block-${index}`, type: 'reading', title: `模块 ${index}`, objective: `目标 ${index}`, content: index < 30 ? { text: '概念解释'.repeat(400) } : null }));
  const context = blockGenerationContext({ intro: '课程导语'.repeat(800), blocks }, 'block-30');
  assert.equal(context.outline.length, 25);
  assert.equal(context.previous.length, 3);
  assert.ok(context.previous.every(item => item.excerpt.length <= 1000));
  assert.equal(context.intro.length, 2000);
  assert.deepEqual(context.sequence, { position: 31, total: 45 });
  assert.equal(context.outline[0].title, '模块 18');
  assert.equal(context.outline.at(-1).title, '模块 42');
});

test('lesson generation sends the time budget and does not pay for a quiz before any teaching exists',async t=>{
  const requests=[];
  const app=realSettingsHarness({load:async()=>({status:{mode:'ai',model:'test'}}),saveOutline:async(id,outline)=>({...outline,blocks:outline.blocks.map((b,i)=>({...b,id:`new-${i}`,content:null}))}),getLesson:async()=>({lesson:null,blockCourse:null,reflection:'',chats:[]}),request:async(endpoint,data)=>{requests.push({endpoint,data});return {intro:'单课',blocks:[{type:'reading',title:'讲解',objective:'解释具体方法'},{type:'example',title:'案例',objective:'推演方法结果'},{type:'quiz',title:'测验',objective:'判断适用条件'}]};}});
  t.after(()=>app.close());await app.ready();await app.run("action('generate-lesson',{dataset:{id:'p1'}})");app.run("activeLesson='p1';page='study';render()");
  assert.equal(requests.length,1);assert.equal(requests[0].endpoint,'lesson-outline');assert.equal(requests[0].data.minutes,demoPlan.lessons[0].minutes);
  assert.match(app.document.querySelector('[data-block-id="new-2"]').textContent,/请先生成前序讲解或案例/);
  await assert.rejects(app.run("action('generate-block',{dataset:{id:'p1',block:'new-2'}})"),/未调用模型/);assert.equal(requests.length,1);
  assert.match(app.document.querySelector('[data-block-id="new-1"]').textContent,/配套讲解尚未生成/);
});

test('teaching units pair adjacent examples and regenerate only the requested block with recoverable history', async () => {
  const payloads = [];
  let fail = false;
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    payloads.push(JSON.parse(options.body));
    return { ok: !fail, json: async () => fail ? { error: '模型暂时不可用' } : { text: '用收支表逐步解释后的正文' } };
  });
  app.run(`state.blockCourses = { p1: {intro: '课程导语', blocks: [
    {id: 'reading-1', type: 'reading', title: '理解现金流', objective: '理解概念', content: {text: '原始讲解'}},
    {id: 'example-1', type: 'example', title: '一张收支表', objective: '应用概念', content: {text: '原始案例'}},
    {id: 'quiz-1', type: 'quiz', title: '检验理解', objective: '独立回答', content: null}
  ]}}; state.progress.p1 = {completed:true}; state.notes = [{id:'note-1',lessonId:'p1',title:'现金流',content:'原Wiki',tags:[],updated:1}]; page = 'study'; activeLesson = 'p1'; status = {mode:'ai'}; render();`);
  const html = app.node('#app').innerHTML;
  assert.match(html, /<article class="teaching-unit"[^>]*>.*知识讲解.*原始讲解.*配套案例.*原始案例.*<\/article>/s);
  assert.equal((html.match(/class="teaching-unit"/g) || []).length, 1);
  assert.ok(html.indexOf('</article>') < html.indexOf('data-block-id="quiz-1"'));
  assert.match(html, /data-block-id="reading-1"[\s\S]*?换个讲法[\s\S]*?<summary>更多学习工具<\/summary>/);
  assert.match(html, /<summary>更多学习工具<\/summary>[\s\S]*?生成知识卡片/);
  await app.run("action('request-revision', {dataset:{id:'p1',block:'reading-1'}})");
  assert.equal(app.node('#revise-block-dialog').open, true);
  assert.match(app.node('#revise-block-dialog').innerHTML, /你的具体要求/);
  assert.match(app.node('#revise-block-dialog').innerHTML, /普通表格/);
  assert.doesNotMatch(app.node('#revise-block-dialog').innerHTML, /流程图|架构图|数据图|柱状图/);
  await app.run("action('markdown-revision-preset', {dataset:{}})");
  assert.match(app.node('#revision-request').value, /请仅优化.*Markdown/);
  await app.submit('revision-form', { request: '请用收支表一步步解释' }, 'p1', 'reading-1');
  assert.equal(payloads[0].revisionRequest, '请用收支表一步步解释');
  assert.equal(payloads[0].currentExcerpt, '原始讲解');
  assert.equal(payloads[0].related[0].excerpt, '原始案例');
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.text'), '用收支表逐步解释后的正文');
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.text'), '原始案例');
  assert.equal(app.run('state.progress.p1.completed'), true);
  assert.equal(app.run('state.notes[0].content'), '原Wiki');
  assert.equal(app.node('#revise-block-dialog').open, false);
  const restoredApp = harness(app.storage.get('learnflow.v1'));
  assert.equal(restoredApp.run('state.blockCourses.p1.blocks[0].content.revisions[0].text'), '原始讲解');
  await app.run("action('restore-block', {dataset:{id:'p1',block:'reading-1'}})");
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.text'), '原始讲解');
  fail = true;
  await app.run("action('request-revision', {dataset:{id:'p1',block:'example-1'}})");
  await app.submit('revision-form', { request: '改成家庭日常支出的案例' }, 'p1', 'example-1');
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.text'), '原始案例');
  assert.equal(app.node('#revise-block-dialog').open, true);
  assert.match(app.node('#revision-error').textContent, /模型暂时不可用/);
  assert.equal(app.run('revisionBusy'), false);
});

test('practice exposes speech, image suggestions and task revision with failure-safe history and restoration', async () => {
  let app, generationCalls = 0, speechCalls = 0, failed = true;
  const payloads = [], text = 'Sarah: Hello, Mark.\nMark: Good morning.';
  const original = '## 听力任务\n\n```text\n' + text + '\n```\n\n1. 听两遍并记录进度。';
  const image = { id: 'c'.repeat(64), prompt: '会议场景', caption: '示意记录进度', model: 'image-test', created: 1 };
  const bridge = {
    load: async () => ({ settings: {}, status: { mode: 'ai' }, imageSettings: { enabled: true }, speechSettings: { ...speechDefaults, enabled: true } }),
    request: async (_path, value) => { payloads.push(value); if (failed) throw new Error('任务生成失败'); return { text: '## 新任务\n\n1. 记录一个进度。' }; },
    prepareSpeech: async value => { speechCalls++; assert.equal(value.text, text); return { turns: [], newCount: 0, cachedCount: 0, pendingCount: 0, characters: 0 }; },
    suggestIllustration: async (_id, blockId) => { assert.equal(blockId, 'practice-1'); return { needed: true, reason: '会议情景有助理解任务', prompt: image.prompt, caption: image.caption }; },
    generateIllustration: async value => { generationCalls++; return { ...app.run('state.blockCourses.p1.blocks[1].content'), illustration: image }; },
    reviseBlock: async (_id, _blockId, content, expected) => { const previous = app.run('state.blockCourses.p1.blocks[1].content'); assert.equal(expected, previous.text); return revisedContent('practice', previous, content); },
    restoreBlock: async () => restoredContent('practice', app.run('state.blockCourses.p1.blocks[1].content'))
  };
  app = harness(null, null, bridge);
  await Promise.resolve();
  app.run(`state.blockCourses={p1:{intro:'课程',blocks:[{id:'reading-1',type:'reading',title:'讲解',objective:'理解',content:{text:'原讲解'}},{id:'practice-1',type:'practice',title:'会议听力',objective:'记录进度',content:{text:${JSON.stringify(original)}}},{id:'quiz-1',type:'quiz',title:'测验',objective:'检验',content:null}]}};state.progress.p1={completed:true};state.notes=[{id:'n1',lessonId:'p1',title:'卡片',content:'原Wiki',tags:[]}];state.reflections.p1='原心得';page='study';activeLesson='p1';render()`);
  const html = app.run("blockPart(state.blockCourses.p1.blocks[1],1,'p1')");
  for (const action of ['request-illustration', 'request-revision']) assert.match(html, new RegExp(`data-action="${action}"[^>]*data-block="practice-1"`));
  assert.doesNotMatch(html, /data-action="open-speech"/);
  assert.match(html, /换个任务/);
  const practiceDom = new JSDOM(html);
  const practiceDoc = practiceDom.window.document;
  const taskRevision = practiceDoc.querySelector('.revision-actions > [data-action="request-revision"]');
  assert.ok(taskRevision, 'task revision is visible beside the tools dropdown');
  assert.equal(taskRevision.textContent.trim(), '换个任务');
  assert.equal(taskRevision.className, 'btn secondary');
  assert.equal(taskRevision.nextElementSibling.className, 'more-learning-tools');
  assert.equal(practiceDoc.querySelectorAll('[data-action="request-revision"]').length, 1, 'do not duplicate the action in the dropdown');
  assert.equal(practiceDoc.querySelector('.more-learning-tools [data-action="request-revision"]'), null);
  assert.ok(practiceDoc.querySelector('.more-learning-tools [data-action="create-note"]'));
  assert.ok(practiceDoc.querySelector('.more-learning-tools [data-action="request-illustration"]'));
  practiceDom.window.close();
  for (const type of ['summary', 'quiz']) assert.doesNotMatch(app.run(`blockPart({id:'x',type:'${type}',title:'模块',objective:'目标',content:${type === 'quiz' ? '{questions:[]}' : "{text:'正文'}"}},2,'p1')`), /data-action="(?:open-speech|request-illustration|request-revision)"/);
  assert.doesNotMatch(app.run("blockPart({id:'x',type:'practice',title:'未生成任务',objective:'目标',content:null},2,'p1')"), /换个任务|AI 朗读|AI 配图建议/);
  await app.run("action('open-speech',{dataset:{id:'p1',block:'practice-1'}})");
  assert.equal(speechCalls, 1); assert.equal(app.run('speechDraft.text'), text); assert.equal(generationCalls, 0);
  await app.run("action('close-speech',{dataset:{}})");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'practice-1'}})");
  assert.equal(generationCalls, 0); assert.equal(app.node('#illustration-dialog').open, true);
  await app.submit('illustration-form', { prompt: image.prompt, caption: image.caption });
  assert.equal(generationCalls, 1); assert.equal(app.run('state.blockCourses.p1.blocks[1].content.illustration.id'), image.id);
  await app.run("action('request-revision',{dataset:{id:'p1',block:'practice-1'}})");
  assert.match(app.node('#revise-block-dialog').innerHTML, /调整实践任务/); assert.match(app.node('#revise-block-dialog').innerHTML, /场景、材料、步骤或难度/);
  await app.submit('revision-form', { request: '降低难度，保留任务目标' }, 'p1', 'practice-1');
  assert.match(app.node('#revision-error').textContent, /任务生成失败/); assert.equal(app.run('state.blockCourses.p1.blocks[1].content.text'), original);
  failed = false;
  await app.submit('revision-form', { request: '降低难度，保留任务目标' }, 'p1', 'practice-1');
  assert.equal(payloads.at(-1).block.type, 'practice'); assert.equal(payloads.at(-1).block.objective, '记录进度'); assert.equal(payloads.at(-1).currentExcerpt, original);
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.illustration'), undefined);
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.revisions[0].illustration.id'), image.id);
  await app.run("action('restore-block',{dataset:{id:'p1',block:'practice-1'}})");
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.text'), original); assert.equal(app.run('state.blockCourses.p1.blocks[1].content.illustration.id'), image.id);
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.text'), '原讲解'); assert.equal(app.run('state.progress.p1.completed'), true);
  assert.equal(app.run('state.reflections.p1'), '原心得'); assert.equal(app.run('state.notes[0].content'), '原Wiki');
});

test('revision history is bounded, validated and restored in order', () => {
  let content = { text: '初始正文' };
  for (let index = 1; index <= 12; index++) content = revisedContent('reading', content, { text: `第 ${index} 版` }, index);
  assert.equal(content.revisions.length, 10);
  assert.equal(content.revisions[0].text, '第 2 版');
  content = restoredContent('reading', content);
  assert.equal(content.text, '第 11 版');
  assert.equal(content.revisions.length, 9);
  assert.equal(restoredContent('reading', content).text, '第 10 版');
  assert.equal(validBlockContent('reading', { text: '正文', revisions: [{ text: '', updated: 1 }] }), false);
  assert.equal(validBlockContent('reading', { text: '正文', revisions: Array(11).fill({text:'旧版',updated:1}) }), false);
  const practice = revisedContent('practice', {text:'任务'}, {text:'新任务'});
  assert.equal(restoredContent('practice', practice).text, '任务');
  assert.throws(() => revisedContent('summary', {text:'总结'}, {text:'新总结'}), /只能重新生成/);
  assert.throws(() => restoredContent('reading', {text:'正文'}), /没有可恢复/);
});
test('existing routes are categorized locally; deletion removes only the selected route and can be restored', async () => {
  const app = harness();
  assert.equal(app.run("categoryFor({title:'GitHub 中文实践路线', goal:'', description:'', lessons:[]})"), '开发工具');
  assert.equal(app.run("categoryFor({title:'Power BI DAX 基础', goal:'', description:'', lessons:[]})"), '数据分析');
  assert.equal(app.run("categoryFor({title:'LLM 基本原理', goal:'', description:'', lessons:[]})"), 'AI 与大模型');
  app.run("const extra = structuredClone(demoPlan); extra.id = 'data-route'; extra.title = 'Power BI DAX 基础'; extra.source = 'ai'; extra.lessons.forEach((lesson, index) => { lesson.id = 'data-' + index }); state.plans.push(extra); state.active = extra.id; state.progress['data-0'] = {completed:true, attempts:1, lastScore:100, bestScore:100, lastAnswers:[0]}; page = 'routes'; render()");
  assert.match(app.node('#app').innerHTML, /数据分析/);
  assert.match(app.node('#app').innerHTML, /编程开发/);
  await app.run("action('delete-plan', {dataset:{id:'data-route'}})");
  assert.equal(app.run('state.plans.length'), 1);
  assert.equal(app.run('state.active'), demoPlan.id);
  assert.equal(app.run("state.progress['data-0']"), undefined);
  assert.ok([...app.storage.keys()].some(key => key.startsWith('learnflow.before-delete.')));
  await app.run("action('restore-deleted-plan', {dataset:{}})");
  assert.equal(app.run('state.plans.length'), 2);
  assert.equal(app.run("state.progress['data-0'].completed"), true);
});
test('all pages render with empty and populated state; untrusted content is escaped', async () => {
  const app = harness();
  for (const page of ['home', 'routes', 'study', 'practice', 'wiki', 'settings']) {
    app.run(`navigate('${page}')`); assert.ok(app.node('#app').innerHTML.length > 2000);
  }
  app.run("state.reflections.p1 = '<script>alert(1)</script>'; state.progress.p1 = { completed: true };");
  await app.run("createNote('p1')");
  await app.submit('knowledge-draft-form', { title: '测试', summary: '测试', content: '<script>alert(1)</script>', tags: 'Python', useWhen: '', avoidWhen: '' });
  assert.ok(!app.node('#app').innerHTML.includes('<script>'));
  assert.ok(app.node('#app').innerHTML.includes('&lt;script&gt;'));
  for (const page of ['home', 'routes', 'study', 'practice', 'wiki', 'settings']) app.run(`navigate('${page}')`);
});
test('corrupt saved data is preserved instead of silently overwritten', () => {
  const app = harness('{broken');
  app.run('save()');
  assert.equal(app.storage.get('learnflow.v1'), '{broken');
  assert.match(app.run('storageWarning'), /不会覆盖/);
});
test('offline Wiki retrieval finds relevant notes and labels results honestly', async () => {
  const app = harness();
  app.run("state.progress.p1 = { completed: true }; status = { mode: 'demo' };");
  await app.run("createNote('p1')");
  await app.submit('knowledge-draft-form', { title: '输出', summary: '输出', content: 'print 输出内容', tags: 'Python', useWhen: '', avoidWhen: '' });
  await app.submit('ask-form', { question: 'print' });
  assert.equal(app.run('answer.demo'), true);
  assert.equal(app.run('answer.citations.length'), 1);
  await app.submit('ask-form', { question: 'nonexistentkeyword' });
  assert.equal(app.run('answer.citations.length'), 0);
});

test('Wiki AI question selects an older relevant card through the catalog instead of the newest 30', async () => {
  const requests = [];
  const app = harness(null, async (url, init) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    requests.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ answer: '根据 Git 卡片配置身份。', citations: ['old-git'] }) };
  });
  const notes = [{ id: 'old-git', lessonId: 'p1', courseTitle: 'Git', title: 'Git 全局身份配置', summary: '设置 user.email', content: 'git config --global user.email', tags: ['Git'], topic: '开发工具/Git', source: 'demo', updated: 1 }, ...Array.from({ length: 35 }, (_, index) => ({ id: `later-${index}`, lessonId: 'p1', courseTitle: '其他', title: `其他卡片 ${index}`, summary: '其他内容', content: '无关正文', tags: ['其他'], topic: '其他', source: 'demo', updated: index + 2 }))];
  app.run(`state.notes = ${JSON.stringify(notes)}; status = { mode: 'ai' };`);
  await app.submit('ask-form', { question: 'Git user.email 怎么配置？' });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].notes.map(note => note.id), ['old-git']);
  assert.equal(app.run('answer.citations[0]'), 'old-git');
});

test('knowledge directory nests cards under broad domains, courses and shared themes', async t => {
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }) });
  t.after(() => app.close()); await app.ready();
  const plans = [
    { id: 'git-course', title: 'Windows Git 入门', lessons: [{ id: 'git-lesson', title: '安装与配置', tags: ['Git'] }] },
    { id: 'sql-course', title: 'SQL 查询入门', lessons: [{ id: 'sql-lesson', title: '查询', tags: ['SQL'] }] }
  ];
  const notes = [
    { id: 'git-install', lessonId: 'git-lesson', courseTitle: '旧 Git 标题', title: '安装 Git', summary: '安装', content: '安装步骤', tags: ['Git安装'], topic: 'Git安装', updated: 1 },
    { id: 'git-check', lessonId: 'git-lesson', courseTitle: '旧 Git 标题', title: '验证 Git', summary: '验证', content: 'git --version', tags: ['Git安装'], topic: '未分类', updated: 2 },
    { id: 'git-config', lessonId: 'git-lesson', courseTitle: '旧 Git 标题', title: '配置身份', summary: '身份', content: 'user.email', tags: ['Git'], topic: 'Git', updated: 3 },
    { id: 'sql', lessonId: 'sql-lesson', courseTitle: 'SQL 查询入门', title: 'SELECT', summary: '查询', content: 'SELECT *', tags: ['SQL'], topic: '查询语法', updated: 4 }
  ];
  app.run(`state.plans = ${JSON.stringify(plans)}; state.notes = ${JSON.stringify(notes)}; page = 'wiki'; render()`);
  assert.deepEqual([...app.document.querySelectorAll('.wiki-tree-domain>.wiki-tree-folder-heading>.wiki-tree-folder-toggle .wiki-tree-topic')].map(node => node.textContent), ['技术与开发', '数据与分析']);
  assert.equal(app.document.querySelectorAll('.wiki-tree-course').length, 2);
  assert.match(app.document.querySelector('.wiki-tree-course .wiki-tree-topic').textContent, /Windows Git 入门/);
  const git = app.document.querySelector('.wiki-tree-course');
  assert.deepEqual([...git.querySelectorAll('.wiki-tree-theme>.wiki-tree-folder-heading>.wiki-tree-folder-toggle .wiki-tree-topic')].map(node => node.textContent), ['Git安装', '课程要点']);
  assert.equal(git.querySelectorAll('.wiki-tree-card').length, 3);
  assert.equal(app.document.querySelector('.note-grid'), null, 'cards are not repeated in a flat grid');
  const theme = git.querySelector('.wiki-tree-theme>.wiki-tree-folder-heading>.wiki-tree-folder-toggle');
  assert.equal(theme.getAttribute('aria-expanded'), 'false');
  await app.fire('click', theme);
  assert.equal(theme.getAttribute('aria-expanded'), 'true');
  assert.equal(theme.closest('.wiki-tree-folder').querySelector('.wiki-tree-children').hidden, false);
  const search = app.document.querySelector('#wiki-search'); search.value = 'user.email';
  await app.fire('input', search);
  assert.equal(app.document.querySelectorAll('.wiki-tree-course').length, 1);
  assert.equal(app.document.querySelectorAll('.wiki-tree-card').length, 1);
  assert.match(app.document.querySelector('.wiki-tree-card').textContent, /配置身份/);
});

test('course theme manager stays available, previews paid AI changes, supports redo and undo', async t => {
  const requests = [], saves = [];
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'ai' } }), request: async (path, input) => {
    requests.push({ path, input }); return { groups: [{ name: 'Git 基础', ids: ['install', 'verify'] }] };
  }, saveNote: async note => { saves.push(note); } });
  t.after(() => app.close()); await app.ready();
  const plans = [{ id: 'git-course', title: 'Windows Git 入门', lessons: [{ id: 'git-lesson', title: '安装 Git' }] }];
  const notes = [
    { id: 'install', lessonId: 'git-lesson', courseTitle: 'Windows Git 入门', title: '安装 Git', summary: '安装步骤', content: '步骤', tags: ['Git'], topic: '安装', updated: 1 },
    { id: 'verify', lessonId: 'git-lesson', courseTitle: 'Windows Git 入门', title: '验证 Git', summary: '检查版本', content: 'git --version', tags: ['Git'], topic: '验证', updated: 2 }
  ];
  app.run(`state.plans = ${JSON.stringify(plans)}; state.notes = ${JSON.stringify(notes)}; page = 'wiki'; render()`);
  await app.fire('click', app.document.querySelector('[data-action="open-organize"]'));
  assert.equal(requests.length, 0);
  assert.equal(saves.length, 0);
  assert.ok(app.document.querySelector('#knowledge-organize-manual-form'));
  await app.fire('click', app.document.querySelector('[data-action="organize-tab"][data-mode="ai"]'));
  await app.fire('click', app.document.querySelector('[data-action="generate-organize"]'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, 'knowledge-organize');
  assert.deepEqual(requests[0].input.cards.map(card => Object.keys(card).sort()), [
    ['id', 'summary', 'tags', 'title'], ['id', 'summary', 'tags', 'title']
  ]);
  assert.equal(saves.length, 0);
  await app.fire('click', app.document.querySelector('[data-action="generate-organize"]'));
  assert.equal(requests.length, 2, 'regeneration is available and explicitly requested');
  assert.equal(saves.length, 0);
  const form = app.document.querySelector('#knowledge-organize-form');
  form.elements.namedItem('suggestion:verify').value = '安装与验证';
  await app.fire('submit', form);
  assert.equal(saves.length, 2);
  assert.deepEqual(saves.map(note => note.category), ['Git 基础', '安装与验证']);
  assert.deepEqual(saves.map(note => note.topic), ['安装', '验证'], 'original Markdown paths stay unchanged');
  assert.ok(app.document.querySelector('[data-action="open-organize"]'), 'management entry remains after all cards are categorized');
  await app.fire('click', app.document.querySelector('[data-action="open-organize"]'));
  assert.ok(app.document.querySelector('[data-action="undo-organize"]'));
  await app.fire('click', app.document.querySelector('[data-action="undo-organize"]'));
  assert.equal(saves.length, 4);
  assert.equal(app.run('state.notes.every(note => !note.category)'), true);
  assert.ok(app.document.querySelector('[data-action="open-organize"]'));
});

test('course theme manager permits manual editing offline and locks existing categories by default for AI', async t => {
  const requests = [], saves = [];
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }), request: async (path, input) => { requests.push(input); return { groups: [{ name: '共同主题', ids: input.cards.map(card => card.id) }] }; }, saveNote: async note => { saves.push(note); } });
  t.after(() => app.close()); await app.ready();
  const plans = [{ id: 'course', title: 'Git 基础', lessons: [{ id: 'lesson', title: '基础' }] }];
  const notes = [
    { id: 'a', lessonId: 'lesson', courseTitle: 'Git 基础', title: '安装', summary: '安装', content: '安装', tags: ['Git'], topic: '安装', category: '已有分类', updated: 1 },
    { id: 'b', lessonId: 'lesson', courseTitle: 'Git 基础', title: '配置', summary: '配置', content: '配置', tags: ['Git'], topic: '配置', updated: 2 }
  ];
  app.run(`state.plans = ${JSON.stringify(plans)}; state.notes = ${JSON.stringify(notes)}; page = 'wiki'; render()`);
  await app.fire('click', app.document.querySelector('[data-action="open-organize"]'));
  const manual = app.document.querySelector('#knowledge-organize-manual-form');
  manual.elements.namedItem('manual:b').value = '已有分类';
  await app.fire('submit', manual);
  assert.equal(requests.length, 0);
  assert.equal(saves.length, 1);
  app.run('status = { mode: "ai" }; render()');
  await app.fire('click', app.document.querySelector('[data-action="open-organize"]'));
  await app.fire('click', app.document.querySelector('[data-action="organize-tab"][data-mode="ai"]'));
  const scope = app.document.querySelector('#knowledge-organize-scope'); scope.value = 'all'; await app.fire('change', scope);
  assert.equal(app.document.querySelector('[data-action="generate-organize"]').disabled, true);
  const unlockA = app.document.querySelector('[name="include:a"]'); unlockA.checked = true; await app.fire('change', unlockA);
  const unlockB = app.document.querySelector('[name="include:b"]'); unlockB.checked = true; await app.fire('change', unlockB);
  assert.equal(app.document.querySelector('[data-action="generate-organize"]').disabled, false);
  await app.fire('click', app.document.querySelector('[data-action="generate-organize"]'));
  assert.deepEqual(requests[0].cards.map(card => card.id), ['a', 'b']);
  assert.equal(saves.length, 1, 'generating a proposal never saves');
  const preview = app.document.querySelector('#knowledge-organize-form');
  preview.elements.namedItem('apply:b').checked = false;
  await app.fire('submit', preview);
  assert.equal(saves.length, 2);
  assert.equal(app.run('state.notes.find(note => note.id === "a").category'), '共同主题');
  assert.equal(app.run('state.notes.find(note => note.id === "b").category'), '已有分类', 'unchecked card keeps its manual category');
});

test('failed multi-card theme save restores earlier cards and keeps the draft open', async t => {
  const writes = [];
  let failSecond = true;
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }), saveNote: async note => {
    writes.push({ id: note.id, category: note.category });
    if (note.id === 'b' && failSecond) { failSecond = false; throw new Error('第二张卡片写入失败'); }
  } });
  t.after(() => app.close()); await app.ready();
  const plans = [{ id: 'course', title: 'Git 基础', lessons: [{ id: 'lesson', title: '基础' }] }];
  const notes = [
    { id: 'a', lessonId: 'lesson', courseTitle: 'Git 基础', title: '安装', summary: '安装', content: '安装', tags: ['Git'], topic: '安装', updated: 1 },
    { id: 'b', lessonId: 'lesson', courseTitle: 'Git 基础', title: '配置', summary: '配置', content: '配置', tags: ['Git'], topic: '配置', updated: 2 }
  ];
  app.run(`state.plans = ${JSON.stringify(plans)}; state.notes = ${JSON.stringify(notes)}; page = 'wiki'; render()`);
  await app.fire('click', app.document.querySelector('[data-action="open-organize"]'));
  const form = app.document.querySelector('#knowledge-organize-manual-form');
  form.elements.namedItem('manual:a').value = '共同主题';
  form.elements.namedItem('manual:b').value = '共同主题';
  await app.fire('submit', form);
  assert.deepEqual(writes.map(write => write.id), ['a', 'b', 'a']);
  assert.equal(app.run('state.notes.every(note => !note.category)'), true);
  assert.match(app.document.querySelector('#knowledge-organize-dialog').textContent, /已恢复之前的归类/);
  assert.equal(app.document.querySelector('#knowledge-organize-dialog').open, true);
  const retry = app.document.querySelector('#knowledge-organize-manual-form');
  await app.fire('submit', retry);
  assert.equal(app.run('state.notes.every(note => note.category === "共同主题")'), true);
});

test('Wiki switches between nested tree and interactive relation graph without model calls', async t => {
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }) });
  t.after(() => app.close()); await app.ready();
  const notes = [
    { id: 'python', lessonId: 'p1', title: 'Python 输出', summary: '输出', content: 'print', tags: ['Python'], topic: '编程/Python/语法', related: ['git'], updated: 1 },
    { id: 'git', lessonId: 'p1', title: 'Git 身份', summary: '身份', content: 'user.email', tags: ['Git'], topic: '开发工具/Git', updated: 2 }
  ];
  app.run(`state.notes = ${JSON.stringify(notes)}; page = 'wiki'; render()`);
  assert.ok(app.document.querySelector('.wiki-tree-theme'));
  const folder = app.document.querySelector('.wiki-tree-course>.wiki-tree-folder-heading>.wiki-tree-folder-toggle');
  assert.equal(folder.getAttribute('aria-expanded'), 'true');
  await app.fire('click', folder);
  assert.equal(folder.getAttribute('aria-expanded'), 'false');
  assert.equal(folder.closest('.wiki-tree-folder').querySelector('.wiki-tree-children').hidden, true);
  await app.fire('click', app.document.querySelector('[data-action="switch-wiki-view"][data-view="graph"]'));
  assert.equal(app.document.querySelector('[data-view="graph"]').getAttribute('aria-selected'), 'true');
  assert.equal(app.document.querySelectorAll('.graph-node-card').length, 2);
  assert.ok(app.document.querySelector('.graph-edge-related'));
  await app.fire('click', app.document.querySelector('[data-action="select-graph-node"][data-id="card:python"]'));
  assert.match(app.document.querySelector('.graph-selection').textContent, /Python 输出/);
  assert.ok(app.document.querySelector('.graph-selection [data-action="open-note"][data-id="python"]'));
  const svg = app.document.querySelector('#knowledge-graph-svg');
  const before = svg.getAttribute('viewBox');
  await app.fire('click', app.document.querySelector('[data-action="graph-zoom-in"]'));
  assert.notEqual(svg.getAttribute('viewBox'), before);
  await app.fire('click', app.document.querySelector('[data-action="graph-pause"]'));
  assert.equal(app.document.querySelector('[data-action="graph-pause"]').textContent, '继续运动');
  const tag = app.document.querySelector('#graph-tag'); tag.value = 'Python';
  await app.fire('change', tag);
  assert.equal(app.document.querySelectorAll('.graph-node-card').length, 1);
  const resetTag = app.document.querySelector('#graph-tag'); resetTag.value = '';
  await app.fire('change', resetTag);
  assert.equal(app.document.querySelectorAll('.graph-node-card').length, 2);
  const type = app.document.querySelector('#graph-type'); type.value = 'topic';
  await app.fire('change', type);
  assert.equal(app.document.querySelectorAll('.graph-node-card').length, 0);
  assert.ok(app.document.querySelector('#graph-type'), 'graph controls remain available when no card nodes match');
  const resetType = app.document.querySelector('#graph-type'); resetType.value = 'all';
  await app.fire('change', resetType);
  assert.equal(app.document.querySelectorAll('.graph-node-card').length, 2);
  const graphSearch = app.document.querySelector('#graph-search'); graphSearch.value = '完全无关的词';
  await app.fire('input', graphSearch);
  assert.equal(app.document.querySelectorAll('.graph-node-card').length, 0);
  assert.ok(app.document.querySelector('#graph-search'), 'zero results keep the filter controls available');
  assert.match(app.document.querySelector('.graph-empty').textContent, /没有可显示/);
  const clearSearch = app.document.querySelector('#graph-search'); clearSearch.value = '';
  await app.fire('input', clearSearch);
  assert.equal(app.document.querySelectorAll('.graph-node-card').length, 2);
  await app.fire('click', app.document.querySelector('[data-action="graph-orphans"]'));
  assert.equal(app.document.querySelectorAll('.graph-node-card').length, 0);
  await app.fire('click', app.document.querySelector('[data-action="graph-orphans"]'));
  assert.equal(app.document.querySelectorAll('.graph-node-card').length, 2);
  await app.fire('click', app.document.querySelector('[data-action="switch-wiki-view"][data-view="tree"]'));
  assert.equal(app.document.querySelector('.wiki-tree-course>.wiki-tree-folder-heading>.wiki-tree-folder-toggle').getAttribute('aria-expanded'), 'false');
});

test('graph hover temporarily focuses direct relations and clicking the same node toggles persistent focus', async t => {
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }) });
  t.after(() => app.close()); await app.ready();
  const notes = [
    { id: 'a', title: 'Git 安装', topic: 'Git', related: ['c'] },
    { id: 'b', title: 'Git 配置', topic: 'Git' },
    { id: 'c', title: 'Python 环境', topic: 'Python' }
  ].map(note => ({ ...note, lessonId: 'p1', summary: note.title, content: note.title, tags: [], updated: 1 }));
  app.run(`state.notes = ${JSON.stringify(notes)}; page = 'wiki'; render()`);
  await app.fire('click', app.document.querySelector('[data-view="graph"]'));
  const node = id => app.document.querySelector(`#knowledge-graph-svg [data-id="card:${id}"]`);
  let svg = app.document.querySelector('#knowledge-graph-svg');
  await app.fire('pointerover', node('a'));
  assert.ok(svg.classList.contains('has-focus'));
  assert.ok(node('a').classList.contains('focused'));
  assert.ok(!node('c').classList.contains('dimmed'), 'explicitly related card stays visible');
  assert.ok(node('b').classList.contains('dimmed'), 'sibling under the same topic is not a direct relation');
  assert.ok(!svg.querySelector('.graph-edge-related').classList.contains('dimmed'));
  await app.fire('pointerout', node('a'));
  assert.ok(!svg.classList.contains('has-focus'));
  await app.fire('click', node('a'));
  svg = app.document.querySelector('#knowledge-graph-svg');
  assert.ok(svg.classList.contains('has-focus'));
  assert.ok(node('b').classList.contains('dimmed'));
  await app.fire('pointerover', node('c'));
  assert.ok(node('c').classList.contains('focused'), 'hover overrides clicked focus temporarily');
  await app.fire('pointerout', node('c'));
  assert.ok(node('a').classList.contains('focused'), 'leaving restores clicked focus');
  await app.fire('click', node('a'));
  svg = app.document.querySelector('#knowledge-graph-svg');
  assert.ok(!svg.classList.contains('has-focus'));
  assert.ok(!svg.querySelector('.graph-node.dimmed'));
  assert.equal(app.document.querySelector('.graph-selection [data-action="open-note"]'), null);
  await app.fire('pointerover', node('a'));
  assert.ok(!svg.classList.contains('has-focus'), 'second click keeps focus off until pointer leaves');
  await app.fire('pointerout', node('a'));
  await app.fire('pointerover', node('a'));
  assert.ok(svg.classList.contains('has-focus'), 'hover works again after re-entering');
});

test('graph uses one stable color per root directory, including cards with different YAML topics', async t => {
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }) });
  t.after(() => app.close()); await app.ready();
  const plans = [
    { id: 'git', title: 'Windows Git 入门', lessons: [{ id: 'git-lesson' }] },
    { id: 'ai', title: '人工智能入门', lessons: [{ id: 'ai-lesson' }] },
    { id: 'jp', title: '日语五十音学习', lessons: [{ id: 'jp-lesson' }] }
  ];
  const notes = [
    { id: 'install', lessonId: 'git-lesson', title: '安装 Git', topic: 'Git安装' },
    { id: 'verify', lessonId: 'git-lesson', title: '验证 Git', topic: '未分类' },
    { id: 'llm', lessonId: 'ai-lesson', title: '下一个词预测', topic: '下一个词预测' },
    { id: 'vowel', lessonId: 'jp-lesson', title: '日语元音', topic: '五十音图元音' }
  ].map(note => ({ ...note, summary: note.title, content: note.title, tags: [], updated: 1 }));
  app.run(`state.plans = ${JSON.stringify(plans)}; state.notes = ${JSON.stringify(notes)}; page = 'wiki'; render()`);
  assert.deepEqual([...app.document.querySelectorAll('.wiki-tree-domain > .wiki-tree-folder-heading > .wiki-tree-folder-toggle')].map(node => node.dataset.name), ['技术与开发', '人工智能', '语言与沟通']);
  await app.fire('click', app.document.querySelector('[data-view="graph"]'));
  const color = id => app.document.querySelector(`[data-id="card:${id}"]`).style.getPropertyValue('--node-color');
  assert.equal(color('install'), color('verify'));
  assert.equal(new Set(['install', 'llm', 'vowel'].map(color)).size, 3);
  assert.equal(app.document.querySelectorAll('.graph-node-card.graph-isolated').length, 0, 'isolated cards keep their root directory color');
  assert.equal(app.document.querySelector('[data-id="topic:未分类"]').style.getPropertyValue('--node-color'), color('verify'));
});

test('Wiki Q&A is left of the tree, without the banner, and keeps its answer when switching views', async t => {
  const app = realSettingsHarness({ load: async () => ({ status: { mode: 'demo' } }) });
  t.after(() => app.close()); await app.ready();
  app.run(`state.notes = [{ id: 'python', lessonId: 'p1', title: 'Python 输出', summary: '输出', content: 'print', tags: ['Python'], topic: '编程/Python', updated: 1 }]; page = 'wiki'; render()`);
  assert.deepEqual([...app.document.querySelectorAll('.wiki-view-switch [role="tab"]')].map(tab => tab.dataset.view), ['chat', 'tree', 'graph']);
  assert.equal(app.document.querySelector('.wiki-view-switch').nextElementSibling.className, 'wiki-toolbar');
  assert.equal(app.document.querySelector('[data-view="chat"]').textContent, '知识问答');
  assert.equal(app.document.querySelector('.wiki-banner'), null);
  assert.equal(app.document.querySelector('#ask-form'), null);
  await app.fire('click', app.document.querySelector('[data-view="chat"]'));
  assert.equal(app.document.querySelector('#note-results').getAttribute('aria-label'), '知识问答');
  assert.equal(app.document.querySelector('[data-view="chat"]').getAttribute('aria-selected'), 'true');
  assert.ok(app.document.querySelector('#ask-form'));
  assert.equal(app.document.querySelector('.wiki-directory'), null);
  app.run(`answer = { demo: true, answer: 'print 用于输出', citations: ['python'] }; refreshKnowledgeResults()`);
  assert.match(app.document.querySelector('#wiki-answer').textContent, /print 用于输出/);
  await app.fire('click', app.document.querySelector('[data-view="graph"]'));
  assert.equal(app.document.querySelector('#ask-form'), null);
  await app.fire('click', app.document.querySelector('[data-view="chat"]'));
  assert.match(app.document.querySelector('#wiki-answer').textContent, /print 用于输出/);
});

test('Wiki questions with no catalog match do not call the paid AI endpoint', async () => {
  let calls = 0;
  const app = harness(null, async url => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    calls++;
    return { ok: true, json: async () => ({ answer: 'unexpected', citations: [] }) };
  });
  app.run("state.notes = [{id:'git',lessonId:'p1',title:'Git 身份',summary:'user.email',content:'git config',tags:['Git'],topic:'开发工具/Git',updated:1}]; status = { mode: 'ai' }");
  await app.submit('ask-form', { question: 'quantum banana astronomy' });
  assert.equal(calls, 0);
  assert.equal(app.run('answer.demo'), true);
  assert.deepEqual([...app.run('answer.citations')], []);
});

test('lesson Q&A keeps per-lesson context across turns, persists locally and escapes answers', async () => {
  const requests = [];
  const app = harness(undefined, async (url, init) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai', timeoutMs: 120000 }) };
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ answer: requests.length === 1 ? '先看 print 的输入。' : '<script>bad</script> 再看输出。' }) };
  });
  app.run("status = { mode: 'ai' }; openLesson('p1', 'chat')");
  assert.match(app.node('#app').innerHTML, /AI 答疑/);
  await app.submit('lesson-ask-form', { question: 'print 是什么？' }, 'p1');
  await app.submit('lesson-ask-form', { question: '能再举个例子吗？' }, 'p1');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/api/lesson-ask');
  assert.equal(requests[0].body.lesson.intro, demoLessons.p1.intro);
  assert.equal(requests[1].body.history.length, 2);
  assert.equal(requests[1].body.history[1].content, '先看 print 的输入。');
  assert.equal(app.run('state.chats.p1.length'), 4);
  assert.ok(!app.node('#app').innerHTML.includes('<script>bad</script>'));
  const restored = harness(app.storage.get('learnflow.v1'));
  restored.run("openLesson('p1', 'chat')");
  assert.equal(restored.run('chatFor("p1").length'), 4);
  assert.equal(restored.run('chatFor("p2").length'), 0);
});

test('lesson Q&A and grounded Wiki answers render Markdown while preserving raw stored messages and citations', async () => {
  const response = '## 回答要点\n\n**先理解输入**，再看输出。\n\n1. 阅读代码\n2. 检查结果\n\n```python\nprint("你好")\n```';
  const app = harness(null, async (url) => ({ ok: true, json: async () => url === '/api/status' ? {mode:'ai'} : { answer:response, citations:['note-1'] } }));
  app.run("status={mode:'ai'}; openLesson('p1','chat')");
  await app.submit('lesson-ask-form', {question:'**print** 是什么？'}, 'p1');
  const chatDOM = new JSDOM(app.node('#app').innerHTML).window.document;
  assert.equal(chatDOM.querySelector('.from-ai .markdown-content h3').textContent, '回答要点');
  assert.equal(chatDOM.querySelector('.from-ai .markdown-content strong').textContent, '先理解输入');
  assert.equal(chatDOM.querySelectorAll('.from-ai ol > li').length, 2);
  assert.ok(chatDOM.querySelector('.from-ai pre code'));
  assert.equal(chatDOM.querySelector('.from-user .markdown-content strong').textContent, 'print');
  assert.equal(app.run('state.chats.p1[1].content'), response);
  app.run("state.notes=[{id:'note-1',lessonId:'p1',title:'输入输出',summary:'**重点摘要**',content:'## 概念\\n\\n正文',tags:['Python'],updated:1}]; page='wiki'; activeNote=null; render()");
  assert.match(app.node('#app').innerHTML, /<strong>重点摘要<\/strong>/);
  await app.submit('ask-form', {question:'输入是什么？'});
  const answerDOM = new JSDOM(app.node('#wiki-answer').innerHTML).window.document;
  assert.ok(answerDOM.querySelector('.answer-body h3'));
  assert.ok(answerDOM.querySelector('.citation[data-id="note-1"]'));
});

test('knowledge cards default to Markdown reading, preserve editing drafts and save source rather than rendered HTML', async () => {
  const app = harness();
  app.run("state.notes=[{id:'note-1',lessonId:'p1',courseTitle:'Python',title:'输入输出',summary:'**摘要重点**',content:'## 概念\\n\\n- 第一项\\n- 第二项',useWhen:['适用场景'],avoidWhen:['不适用场景'],tags:['Python'],source:'demo',updated:1}]; activeNote='note-1'; page='wiki'; render()");
  const initial = new JSDOM(app.node('#app').innerHTML).window.document;
  assert.equal(initial.querySelector('#note-source-view').hidden, true);
  assert.equal(initial.querySelector('#note-preview-content h3').textContent, '概念');
  assert.equal(initial.querySelectorAll('#note-preview-content ul li').length, 2);
  assert.equal(initial.querySelector('#note-preview-summary'), null);
  assert.equal(initial.querySelector('#note-preview-boundaries'), null);
  assert.equal(initial.querySelector('#note-use').value, '适用场景');
  assert.equal(initial.querySelector('#note-avoid').value, '不适用场景');
  await app.run("action('note-view',{dataset:{mode:'edit'}})");
  assert.equal(app.node('#note-source-view').hidden, false);
  assert.equal(app.node('#note-preview-view').hidden, true);
  const draft = '## 我自己的理解\n\n**记住区别**。\n\n<script>bad</script>';
  app.node('#note-title').value = '未保存的标题';
  app.node('#note-summary').value = '**未保存的摘要**';
  app.node('#note-use').value = '更新后的适用场景';
  app.node('#note-avoid').value = '更新后的不适用场景';
  app.node('#note-content').value = draft;
  await app.run("action('note-view',{dataset:{mode:'read'}})");
  assert.match(app.node('#note-preview-content').innerHTML, /<h3>我自己的理解<\/h3>/);
  assert.ok(!app.node('#note-preview-content').innerHTML.includes('<script>'));
  assert.equal(app.run('state.notes[0].title'), '输入输出');
  assert.equal(app.node('#note-save').hidden, true);
  await app.run("action('note-view',{dataset:{mode:'edit'}})");
  assert.equal(app.node('#note-content').value, draft);
  await app.submit('note-form', {title:'未保存的标题',summary:'**未保存的摘要**',content:draft,tags:'Python',useWhen:'更新后的适用场景',avoidWhen:'更新后的不适用场景'}, 'note-1');
  assert.equal(app.run('state.notes[0].content'), draft);
  assert.equal(app.run('state.notes[0].title'), '未保存的标题');
  assert.deepEqual(Array.from(app.run('state.notes[0].useWhen')), ['更新后的适用场景']);
  assert.deepEqual(Array.from(app.run('state.notes[0].avoidWhen')), ['更新后的不适用场景']);
  const restored = harness(app.storage.get('learnflow.v1'));
  assert.equal(restored.run('state.notes[0].content'), draft);
  assert.ok(restored.run('markdown(state.notes[0])').includes(draft));
});

test('learning-note tab is removed without deleting historical reflections or knowledge cards', () => {
  const app = harness();
  app.run("state.lessons.p1=structuredClone(demoLessons.p1); state.reflections.p1='旧心得'; openLesson('p1','notes')");
  assert.equal(app.run('lessonTab'), 'read');
  assert.doesNotMatch(app.node('#app').innerHTML, /data-tab="notes"|id="reflection"/);
  assert.equal(app.run('state.reflections.p1'), '旧心得');
  app.run("state.blockCourses={p1:{intro:'课程',blocks:[{id:'summary-1',type:'summary',title:'总结',objective:'记住',content:{text:'**内容块总结**'}}]}}; render()");
  assert.match(app.node('#app').innerHTML, /<strong>内容块总结<\/strong>/);
  assert.doesNotMatch(app.node('#app').innerHTML, /data-tab="notes"|id="reflection"/);
  assert.equal(app.run('state.reflections.p1'), '旧心得');
});

test('settings display cloud status, test connection and keep failures visible', async () => {
  let fail = false;
  const requests = [];
  const app = harness(undefined, async (url, init) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai', provider: 'qwen', providerLabel: '通义千问 / 百炼', model: 'configured-model', timeoutMs: 600000 }) };
    requests.push({ url, body: init.body });
    return { ok: !fail, json: async () => fail ? { error: '模型鉴权失败' } : { provider: '通义千问 / 百炼', model: 'configured-model', latencyMs: 1200 } };
  });
  await new Promise(resolve => setImmediate(resolve));
  app.run("navigate('settings')");
  assert.match(app.node('#app').innerHTML, /通义千问 \/ 百炼/);
  assert.match(app.node('#app').innerHTML, /测试模型连接/);
  assert.ok(!app.node('#app').innerHTML.includes('本地 AI 已配置'));
  await app.run("action('test-connection', { dataset: {} })");
  assert.match(app.node('#connection-result').textContent, /连接成功/);
  assert.equal(requests[0].url, '/api/test-connection');
  assert.equal(requests[0].body, '{}');
  fail = true;
  await app.run("action('test-connection', { dataset: {} })");
  assert.match(app.node('#connection-result').textContent, /鉴权失败/);
  app.run("status = { mode: 'error', configurationError: '缺少 API_KEY' }; navigate('settings');");
  assert.match(app.node('#app').innerHTML, /缺少 API_KEY/);
  assert.match(app.node('#app').innerHTML, /data-action="test-connection" disabled/);
});
