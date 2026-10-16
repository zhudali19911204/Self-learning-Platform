import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createGenerationProgress } from '../public/generation-progress.js';
import { createApp } from '../server.mjs';

function fixture(t) {
  const dom = new JSDOM('<div id="app"></div><aside id="generation-progress" popover="manual" hidden></aside><dialog id="tools"></dialog>');
  t.after(() => dom.window.close());
  const document = dom.window.document, host = document.querySelector('#generation-progress'), timers = new Map();
  let time = 0, timerId = 0;
  const progress = createGenerationProgress({ document, now: () => time, setTimer: fn => { timers.set(++timerId, fn); return timerId; }, clearTimer: id => timers.delete(id) });
  return { progress, document, host, timers, tick(ms) { time += ms; const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); } };
}

test('pending requests show indeterminate activity and elapsed time, never a fabricated percentage', async t => {
  const { progress, document, host, tick, timers } = fixture(t);
  let resolve;
  const result = progress.run({ title: '生成课程内容', detail: '<img src=x onerror=alert(1)>' }, () => new Promise(done => { resolve = done; }));
  assert.equal(host.hidden, false);
  assert.match(host.textContent, /正在生成 · 1 项任务/);
  assert.equal(host.querySelector('img'), null);
  assert.equal(host.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow'), false);
  assert.match(host.textContent, /未提供完成百分比/);
  tick(65000); assert.match(host.textContent, /已等待 1 分 5 秒/);
  document.querySelector('#app').innerHTML = '<h1>另一页</h1>';
  assert.equal(host.hidden, false);
  progress.toggle(); assert.equal(host.querySelector('#generation-progress-list').hidden, true);
  assert.equal(host.querySelector('[aria-expanded]').getAttribute('aria-expanded'), 'false');
  resolve({ text: '已生成正文' }); assert.deepEqual(await result, { text: '已生成正文' });
  progress.toggle(); assert.match(host.textContent, /生成完成/); assert.equal(host.querySelector('[role="progressbar"]'), null);
  tick(8000); assert.equal(host.hidden, true); assert.equal(timers.size, 0);
});

test('concurrent requests remain independent, errors persist and removing notifications cannot cancel running work', async t => {
  const { progress, host, tick } = fixture(t);
  const a = progress.start({ title: '正文' }), b = progress.start({ title: '问答' });
  assert.match(host.textContent, /2 项任务/);
  progress.dismiss(a.id); assert.equal(host.querySelectorAll('.generation-progress-task').length, 2);
  progress.update(a.id, '正在搜索参考资料'); assert.match(host.textContent, /搜索参考资料/);
  a.finish(); assert.match(host.textContent, /1 项任务/);
  b.finish('<script>错误信息</script>');
  assert.equal(host.querySelector('script'), null);
  assert.match(host.textContent, /未完成/);
  progress.update(b.id, 'late event'); assert.ok(!host.textContent.includes('late event'));
  tick(10000); assert.equal(host.querySelectorAll('.generation-progress-task').length, 1);
  assert.match(host.textContent, /错误信息/);
  progress.dismiss(b.id); assert.equal(host.hidden, true);
});

test('progress remains visible in open modal tools and returns to the page after dialogs close or rerender', t => {
  const { progress, document, host, tick } = fixture(t);
  const dialog = document.querySelector('dialog'); dialog.open = true;
  const a = progress.start({ title: '生成配图' });
  assert.equal(host.parentNode, dialog);
  dialog.innerHTML = '<p>更新工具内容</p>'; tick(1000);
  assert.equal(host.isConnected, true); assert.equal(host.parentNode, dialog);
  dialog.open = false; tick(1000); assert.equal(host.parentNode, document.body);
  a.finish();
});

test('rejections and partial results retain errors without changing the original async contract', async t => {
  const { progress, host } = fixture(t);
  await assert.rejects(progress.run({ title: '生成图片' }, () => { throw new Error('下载失败'); }), /下载失败/);
  assert.match(host.textContent, /下载失败/);
  const partial = { completed: 1, error: '还有两个音频片段未完成' };
  assert.equal(await progress.run({ title: 'AI 朗读' }, async () => partial), partial);
  assert.equal(host.querySelectorAll('.is-failed').length, 2);
});

async function serve(t, onGenerationProgress, extra = {}) {
  const outline = { intro: '课程导语', blocks: [{ type: 'reading', title: '讲解', objective: '解释概念' }, { type: 'example', title: '案例', objective: '应用概念' }, { type: 'quiz', title: '检验', objective: '判断条件' }] };
  let calls = 0;
  const server = createApp({ onGenerationProgress, getLLM: () => ({ status: () => ({ mode: 'ai' }), generate: async (_instruction, _input, validate) => { calls++; assert.equal(validate(outline), true); return outline; } }), ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { calls: () => calls, post: (data, id = 'generation-test-1', path = 'lesson-outline') => fetch(`http://127.0.0.1:${server.address().port}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Learnflow-Progress': id }, body: JSON.stringify(data) }) };
}
const input = { goal: '学习概念', level: '零基础', title: '本课', objective: '解释概念', minutes: 25 };

test('server reports actual generation and validation stages without leaking content or changing model calls', async t => {
  const events = [], app = await serve(t, (...args) => events.push(args));
  assert.equal((await app.post(input)).status, 200);
  assert.deepEqual(events, [['generation-test-1', 'generating'], ['generation-test-1', 'validating']]);
  assert.equal(app.calls(), 1);
  events.length = 0;
  assert.equal((await app.post(input, 'invalid task id')).status, 200); assert.deepEqual(events, []);
  const observerFailure = await serve(t, () => { throw new Error('observer failed'); });
  assert.equal((await observerFailure.post(input)).status, 200);
});

test('search stage precedes retrieval; a failed search is not presented as model generation', async t => {
  const events = [];
  const app = await serve(t, (...args) => events.push(args), { courseSources: { prepare: async () => { throw Object.assign(new Error('无可用参考资料'), { status: 422 }); } } });
  const response = await app.post({ ...input, intro: '导语', block: { type: 'reading', title: '讲解', objective: '解释概念' }, sourceSearch: { enabled: true, revision: 0 } }, 'generation-test-2', 'lesson-block');
  assert.equal(response.status, 422); assert.equal(app.calls(), 0);
  assert.deepEqual(events, [['generation-test-2', 'searching']]);
});
