import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createGenerationTasks, generationAwait, withGenerationSignal, currentGenerationSignal, checkGenerationCancellation, isGenerationCancelled } from '../generation-cancellation.mjs';
import { createGenerationProgress } from '../public/generation-progress.js';
import { createLLM } from '../llm.mjs';
import { createApp } from '../server.mjs';
import { EventEmitter } from 'node:events';
import { readOfficialDocument, createCourseSources } from '../course-sources.mjs';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const cancelled = error => isGenerationCancelled(error) && error.name === 'AbortError';
function panel(t, cancelTask) {
  const dom = new JSDOM('<aside id="generation-progress" hidden></aside>'); t.after(() => dom.window.close());
  return { host: dom.window.document.querySelector('aside'), progress: createGenerationProgress({ document: dom.window.document, cancelTask, setTimer: () => 1, clearTimer: () => {} }) };
}
test('cancellation is isolated, ignores a late result, frees its task and allows an explicit retry', async () => {
  const registry = createGenerationTasks(), late = deferred(), other = deferred(); let saved = 0, firstSignal;
  const first = registry.run('generation-first', async () => { firstSignal = currentGenerationSignal(); await generationAwait(late.promise); checkGenerationCancellation(); saved++; });
  const second = registry.run('generation-second', () => generationAwait(other.promise));
  const rejected = assert.rejects(first, cancelled);
  assert.equal(registry.cancel('unknown'), false); assert.equal(registry.cancel('generation-first'), true); assert.equal(firstSignal.aborted, true);
  assert.equal(registry.signal('generation-second').aborted, false); await rejected;
  late.resolve('late paid response'); await turn(); assert.equal(saved, 0); assert.equal(registry.cancel('generation-first'), false);
  other.resolve('independent'); assert.equal(await second, 'independent');
  assert.equal(await registry.run('generation-first', async () => 'explicit retry'), 'explicit retry');
});
test('progress cancel waits for acknowledgement, disables duplicate cancel and shows cancelled rather than failed/completed', async t => {
  const registry = createGenerationTasks(), ack = deferred(), hold = deferred();
  const { host, progress } = panel(t, async id => { const accepted = registry.cancel(id); await ack.promise; return accepted; });
  let taskId;
  const work = progress.run({ title: '生成课程内容' }, task => { taskId = task.id; return registry.run(task.id, () => generationAwait(hold.promise)); });
  const rejected = assert.rejects(work, cancelled), cancelling = progress.cancel(taskId);
  assert.match(host.textContent, /正在取消/); assert.equal(host.querySelector('[data-action=cancel-generation-task]').disabled, true);
  assert.equal(await progress.cancel(taskId), false); await rejected; ack.resolve(); await cancelling;
  assert.ok(host.querySelector('.is-cancelled')); assert.match(host.textContent, /本次生成结果已丢弃/);
  assert.equal(host.querySelector('.is-failed, .is-done'), null);
  progress.dismiss(taskId); assert.equal(host.hidden, true); hold.resolve();
});
test('web cancellation aborts its fetch signal; completed work and rejected cancellation are not discarded', async t => {
  const { host, progress } = panel(t); let task;
  const work = progress.run({ title: 'AI 答疑' }, value => { task = value; return generationAwait(new Promise(() => {}), value.signal); });
  const rejected = assert.rejects(work, cancelled); await progress.cancel(task.id); assert.equal(task.signal.aborted, true); await rejected;
  const complete = progress.start({ title: '已完成任务' }); complete.finish(); assert.equal(await progress.cancel(complete.id), false);
  assert.ok(host.querySelector('.is-done'));
  const denied = panel(t, async () => false), active = denied.progress.start({ title: '收尾中' });
  assert.equal(await denied.progress.cancel(active.id), false); assert.equal(active.signal.aborted, false); active.finish(); assert.ok(denied.host.querySelector('.is-done'));
});
test('cancel IPC failure stays actionable and does not falsely claim cancellation', async t => {
  const { host, progress } = panel(t, async () => { throw new Error('IPC unavailable'); }); const task = progress.start({ title: '任务' });
  await assert.rejects(progress.cancel(task.id), /IPC unavailable/); assert.equal(task.signal.aborted, false);
  assert.equal(host.querySelector('[data-action=cancel-generation-task]').disabled, false); assert.match(host.textContent, /取消请求未成功/); task.finish();
});
test('Electron-bridged cancellation remains identifiable after custom Error fields are stripped', () => {
  assert.equal(isGenerationCancelled(new Error('任务已取消，本次生成结果已丢弃，原有内容保留。')), true);
  assert.equal(isGenerationCancelled(new Error('服务取消了响应')), false);
});
test('reference search cancellation aborts upstream and never starts page reads or fallback generation', async () => {
  const registry = createGenerationTasks(); let signal, calls = 0, reads = 0;
  const service = createCourseSources({ getConfig: () => ({ provider: 'qwen', model: 'mock-model', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'mock-only' }), fetchImpl: async (_url, options) => {
    calls++; signal = options.signal; return new Promise(() => {});
  }, read: async () => { reads++; } });
  const work = registry.run('generation-search', () => service.prepare('学习条件判断'));
  const rejected = assert.rejects(work, isGenerationCancelled); registry.cancel('generation-search'); await rejected;
  assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(reads, 0);
});
test('native reference reader destroys its socket on cancellation and stops before a pending DNS result', async () => {
  const resolve = async () => [{ address: '8.8.8.8', family: 4 }], dns = deferred();
  let requested = 0, destroyed = 0; const controller = new AbortController();
  const request = () => { requested++; const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed++; req.emit('error', new Error('closed')); }; return req; };
  const work = withGenerationSignal(controller.signal, () => readOfficialDocument('https://docs.example.org/test', { resolve, request }));
  const rejected = assert.rejects(work, isGenerationCancelled); await turn(); assert.equal(requested, 1); controller.abort(); await rejected; assert.equal(destroyed, 1);
  const second = new AbortController(), pending = withGenerationSignal(second.signal, () => readOfficialDocument('https://docs.example.org/test', { resolve: () => dns.promise, request }));
  const stopped = assert.rejects(pending, isGenerationCancelled); second.abort(); await stopped; dns.resolve(await resolve()); await turn(); assert.equal(requested, 1);
});
test('LLM cancels fetch and late JSON without validating, retrying or confusing provider timeouts', async () => {
  for (const phase of ['fetch', 'json']) {
    const registry = createGenerationTasks(), hold = deferred(); let signal, calls = 0, validated = 0;
    const llm = createLLM({ env: {}, provider: 'compatible', model: 'local-test', baseUrl: 'http://127.0.0.1:10001/v1', fetchImpl: async (_url, options) => {
      calls++; signal = options.signal;
      return phase === 'fetch' ? hold.promise : { ok: true, json: () => hold.promise };
    } });
    const work = registry.run('generation-model', () => llm.generate('mock', {}, () => { validated++; return true; }));
    const rejected = assert.rejects(work, cancelled); await turn(); registry.cancel('generation-model'); await rejected;
    assert.equal(signal.aborted, true); hold.resolve({ choices: [{ message: { content: '{"ok":true}' } }] }); await turn();
    assert.equal(calls, 1); assert.equal(validated, 0);
  }
  const llm = createLLM({ env: {}, model: 'test', fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  await assert.rejects(llm.generate('', {}, () => true), error => error.status === 504 && !isGenerationCancelled(error));
});
test('server cancellation during reference retrieval starts no model call and stops after client disconnect', async t => {
  const registry = createGenerationTasks(), entered = deferred(), stopped = deferred(); let calls = 0;
  const server = createApp({ getGenerationSignal: id => registry.signal(id), getLLM: () => ({ status: () => ({ mode: 'ai' }), generate: async () => { calls++; } }), courseSources: { prepare: async () => {
    entered.resolve(currentGenerationSignal()); try { await generationAwait(new Promise(() => {})); } finally { stopped.resolve(); }
  } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const request = fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: (t.controller = new AbortController()).signal, body: JSON.stringify({ goal: '学习知识', level: '零基础', intro: '导语', title: '学习', objective: '说明条件', block: { type: 'reading', title: '讲解', objective: '说明条件' }, sourceSearch: { enabled: true, revision: 0 } }) });
  const rejected = assert.rejects(request, error => error.name === 'AbortError'); const signal = await entered.promise; t.controller.abort(); await rejected; await stopped.promise;
  assert.equal(signal.aborted, true); assert.equal(calls, 0);
});
