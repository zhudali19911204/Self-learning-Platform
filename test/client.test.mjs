import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { demoPlan, demoLessons } from '../public/demo.js';

// This harness checks application state transitions, not browser rendering.
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace("import { demoPlan, demoLessons } from './demo.js';", '');
function harness(saved, fetchImpl) {
  const nodes = new Map(), listeners = new Map(), storage = new Map(saved ? [['learnflow.v1', saved]] : []);
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', classList: { add() {}, remove() {} }, scrollIntoView() {}, showModal() {}, close() {} });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    demoPlan, demoLessons, structuredClone, crypto: webcrypto, AbortSignal,
    document: { querySelector: node, addEventListener(name, listener) { listeners.set(name, listener); } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { scrollTo() {} }, setTimeout: () => 1, clearTimeout() {},
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ mode: 'demo', model: null }) })),
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  async function submit(id, values, lessonId) {
    const button = { innerHTML: 'Submit', disabled: false, isConnected: false };
    await listeners.get('submit')({ preventDefault() {}, target: { id, values, dataset: { id: lessonId }, querySelector: () => button } });
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
