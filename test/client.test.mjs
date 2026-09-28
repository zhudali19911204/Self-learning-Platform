import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { demoPlan, demoLessons } from '../public/demo.js';
import { lessonFromBlocks, validOutline, validBlockContent, validBlockSpec, blockGenerationContext, revisedContent, restoredContent } from '../public/blocks.js';
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer } from '../public/markdown.js';
const DOMPurify = createDOMPurify(new JSDOM('').window);

// This harness checks application state transitions, not browser rendering.
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .* from '\.\/[^']+';$/gm, '');
function harness(saved, fetchImpl) {
  const nodes = new Map(), listeners = new Map(), storage = new Map(saved ? [['learnflow.v1', saved]] : []);
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', open: false, classList: { add() {}, remove() {} }, scrollIntoView() {}, focus() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    demoPlan, demoLessons, lessonFromBlocks, validOutline, validBlockContent, validBlockSpec, blockGenerationContext, revisedContent, restoredContent, Marked, DOMPurify, createMarkdownRenderer, structuredClone, crypto: webcrypto, AbortSignal,
    document: { querySelector: node, addEventListener(name, listener) { listeners.set(name, listener); } },
    localStorage: { get length() { return storage.size; }, key: index => [...storage.keys()][index] ?? null, getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { scrollTo() {}, confirm: () => true }, setTimeout: () => 1, clearTimeout() {},
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ mode: 'demo', model: null }) })),
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  async function submit(id, values, lessonId, blockId) {
    const button = { innerHTML: 'Submit', disabled: false, isConnected: false };
    await listeners.get('submit')({ preventDefault() {}, target: { id, values, dataset: { id: lessonId, block: blockId }, querySelector: () => button } });
  }
  return { run, submit, node, storage };
}
test('learning loop: incorrect answers, retry, completion, Wiki creation, edit and persistence', async () => {
  const app = harness();
  app.run("openLesson('p1', 'quiz')");
  await app.submit('quiz-form', { q0: '0', q1: '0' }, 'p1');
  assert.equal(app.run('state.progress.p1.completed'), false);
  assert.equal(app.run('state.progress.p1.lastScore'), 0);
  assert.equal(app.run('state.progress.p1.attempts'), 1);
  await assert.rejects(app.run("createNote('p1')"), /通过/);
  await app.submit('quiz-form', { q0: '1', q1: '1' }, 'p1');
  assert.equal(app.run('state.progress.p1.completed'), true);
  assert.equal(app.run('state.progress.p1.bestScore'), 100);
  app.run("state.reflections.p1 = '我理解了字符串与计算表达式的区别';");
  await app.run("createNote('p1')");
  assert.equal(app.run('state.notes.length'), 1);
  assert.match(app.run('state.notes[0].content'), /我理解了字符串/);
  await app.run("createNote('p1')");
  assert.equal(app.run('state.notes.length'), 1, 'repeated clicks must not duplicate cards');
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
  assert.equal(app.run('state.progress.p1.lastScore'), 0);
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
  assert.match(app.node('#app').innerHTML, /这一块的正文/);
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
  await app.run("action('request-revision', {dataset:{id:'p1',block:'reading-1'}})");
  assert.equal(app.node('#revise-block-dialog').open, true);
  assert.match(app.node('#revise-block-dialog').innerHTML, /你的具体要求/);
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
  assert.throws(() => revisedContent('practice', {text:'任务'}, {text:'新任务'}), /只能重新生成/);
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
  await app.submit('ask-form', { question: 'print' });
  assert.equal(app.run('answer.demo'), true);
  assert.equal(app.run('answer.citations.length'), 1);
  await app.submit('ask-form', { question: 'nonexistentkeyword' });
  assert.equal(app.run('answer.citations.length'), 0);
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
