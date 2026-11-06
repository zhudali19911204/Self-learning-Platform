import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Agent } from 'undici';
import timers from 'undici/lib/util/timers.js';
import { fetchWithoutTimeout } from '../src/runtime/generation-fetch.mjs';
import { createGenerationTasks, isGenerationCancelled } from '../src/runtime/generation-cancellation.mjs';
import { createLLM } from '../src/models/llm.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const result = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] };

test('untimed model fetch and JSON waits retain manual cancellation and discard late results', async t => {
  t.mock.method(AbortSignal, 'timeout', () => { throw new Error('unexpected automatic deadline'); });
  for (const phase of ['fetch', 'json']) {
    const tasks = createGenerationTasks(), hold = deferred(); let signal, validated = 0;
    const llm = createLLM({ env: {}, model: 'mock-model', fetchImpl: async (_url, options) => {
      signal = options.signal;
      return phase === 'fetch' ? hold.promise : { ok: true, json: () => hold.promise };
    } });
    const work = tasks.run('generation-untimed', () => llm.generate('', {}, () => { validated++; return true; }, { timeout: false }));
    const rejected = assert.rejects(work, isGenerationCancelled);
    await turn(); assert.equal(signal, tasks.signal('generation-untimed'));
    assert.equal(tasks.cancel('generation-untimed'), true); await rejected;
    assert.equal(signal.aborted, true); hold.resolve(result); await turn(); assert.equal(validated, 0);
  }
});

test('ordinary model calls and connection tests still use the configured automatic deadline', async t => {
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', milliseconds => { deadlines.push(milliseconds); return AbortSignal.any([]); });
  const llm = createLLM({ env: {}, model: 'mock-model', provider: 'compatible', baseUrl: 'http://127.0.0.1:1234/v1', timeoutMs: 1234, fetchImpl: async () => Response.json(result) });
  await llm.generate('', {}, value => value.ok);
  await llm.testConnection();
  assert.deepEqual(deadlines, [1234, 1234]);
});

for (const phase of ['headers', 'body']) test(`untimed HTTP ${phase} wait survives beyond five minutes and remains manually cancellable`, async t => {
  const responses = [], arrived = deferred(), defaultAgent = new Agent();
  const server = http.createServer((req, res) => {
    req.resume(); responses.push(res);
    if (phase === 'body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"ok":'); }
    if (responses.length === 2) arrived.resolve();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await defaultAgent.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`, controller = new AbortController();
  let completed = false;
  const baseline = fetch(url, { dispatcher: defaultAgent });
  const baselineRejected = assert.rejects(baseline.then(response => response.json()), error => error.cause?.code === (phase === 'headers' ? 'UND_ERR_HEADERS_TIMEOUT' : 'UND_ERR_BODY_TIMEOUT'));
  const pending = fetchWithoutTimeout(url, { signal: controller.signal });
  const headers = pending.then(response => response.json()).then(value => { completed = true; return value; });
  const stopped = assert.rejects(headers, error => error.name === 'AbortError');
  await arrived.promise;
  if (phase === 'body') await Promise.all([baseline, pending]);
  // Advance Undici's real dispatcher clock, not the application's AbortSignal.
  timers.tick(1000); timers.tick(360000); await baselineRejected;
  assert.equal(completed, false); assert.equal(controller.signal.aborted, false);
  const held = responses.find(response => !response.destroyed); assert.ok(held);
  const disconnected = new Promise(resolve => held.once('close', resolve));
  controller.abort(); await stopped; await disconnected;
});

test('uncapped native model transport returns and validates a successful response', async t => {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const llm = createLLM({ env: {}, provider: 'compatible', model: 'mock-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  assert.deepEqual(await llm.generate('', {}, value => value.ok, { timeout: false }), { ok: true });
});
