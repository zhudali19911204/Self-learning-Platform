import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, validPlan, validLesson } from '../server.mjs';
import { demoPlan, demoLessons } from '../public/demo.js';

async function serve(t, config = {}) {
  const server = createApp({ env: {}, model: '', ...config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: path => fetch(base + path), post: (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), base };
}
const input = { goal: '学会 Python 编写工具', level: '零基础', daily: 25, days: 14 };
const mock = output => async () => Response.json({ message: { content: JSON.stringify(output) } });

test('every sample lesson contains usable content, questions, and unique IDs', () => {
  assert.ok(validPlan(demoPlan));
  assert.equal(new Set(demoPlan.lessons.map(l => l.id)).size, demoPlan.lessons.length);
  for (const l of demoPlan.lessons) {
    assert.ok(validLesson(demoLessons[l.id]), l.title);
    for (const question of demoLessons[l.id].questions) assert.equal(new Set(question.options).size, 4);
  }
});
test('serves all client assets and demo status; does not expose server files', async t => {
  const app = await serve(t);
  const status = await (await app.get('/api/status')).json();
  assert.equal(status.mode, 'demo');
  assert.equal(status.model, null);
  assert.equal(status.provider, 'ollama');
  assert.equal(status.configurationError, null);
  for (const path of ['/', '/app.js', '/demo.js', '/styles.css', '/favicon.svg']) {
    const r = await app.get(path); assert.equal(r.status, 200); assert.ok((await r.text()).length > 0);
    assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));
  }
  for (const path of ['/server.mjs', '/.env', '/package.json', '/unknown']) assert.equal((await app.get(path)).status, 404);
});
test('demo mode refuses arbitrary AI generation instead of returning fabricated results', async t => {
  const app = await serve(t);
  const response = await app.post('/api/plan', input);
  assert.equal(response.status, 503); assert.match((await response.json()).error, /尚未配置/);
});
test('rejects malformed requests, oversized content and cross-origin calls', async t => {
  const app = await serve(t);
  assert.equal((await app.post('/api/plan', { ...input, daily: -1 })).status, 400);
  assert.equal((await app.post('/api/plan', null)).status, 400);
  assert.equal((await app.post('/api/plan', { ...input, goal: 'x'.repeat(520000) })).status, 413);
  assert.equal((await app.post('/api/plan', input, { Origin: 'http://untrusted.example' })).status, 403);
  const malformed = await fetch(app.base + '/api/plan', { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  // fetch normalizes Host; use the native client to exercise DNS-rebinding protection.
  const badHost = await new Promise((resolve, reject) => {
    http.get(app.base + '/api/status', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(badHost, 403);
});
test('AI planning uses user constraints and assigns application-owned IDs', async t => {
  let sent;
  const app = await serve(t, { model: 'test-model', fetchImpl: async (url, init) => { sent = { url, ...JSON.parse(init.body) }; return Response.json({ message: { content: JSON.stringify(demoPlan) } }); } });
  const response = await app.post('/api/plan', input);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.source, 'ai'); assert.equal(result.goal, input.goal); assert.notEqual(result.id, demoPlan.id);
  assert.equal(new Set(result.lessons.map(l => l.id)).size, result.lessons.length);
  assert.notEqual(result.lessons[0].id, demoPlan.lessons[0].id);
  assert.equal(sent.stream, false); assert.equal(sent.format, 'json'); assert.equal(sent.model, 'test-model');
  assert.deepEqual(JSON.parse(sent.messages[1].content), input);
});
test('rejects impossible study budgets and incomplete model output', async t => {
  const app = await serve(t, { model: 'test', fetchImpl: mock(demoPlan) });
  assert.equal((await app.post('/api/plan', { ...input, daily: 10, days: 7 })).status, 502);
  const broken = await serve(t, { model: 'test', fetchImpl: mock({ title: 'Incomplete' }) });
  assert.equal((await broken.post('/api/plan', input)).status, 502);
});
test('returns actionable errors for unavailable models and invalid JSON', async t => {
  const offline = await serve(t, { model: 'test', fetchImpl: async () => { throw new Error('connection refused'); } });
  const r = await offline.post('/api/plan', input); assert.equal(r.status, 502); assert.match((await r.json()).error, /无法连接/);
  const invalid = await serve(t, { model: 'test', fetchImpl: async () => Response.json({ message: { content: 'not JSON' } }) });
  assert.equal((await invalid.post('/api/plan', input)).status, 502);
  const failed = await serve(t, { model: 'test', fetchImpl: async () => new Response('failed', { status: 500 }) });
  assert.equal((await failed.post('/api/plan', input)).status, 502);
});
test('lesson generation validates that each answer refers to a real option', async t => {
  const input = { goal: '学习 Python', title: '第一课', objective: '学会 print', level: '零基础' };
  const app = await serve(t, { model: 'test', fetchImpl: mock(demoLessons.p1) });
  assert.equal((await app.post('/api/lesson', input)).status, 200);
  const broken = structuredClone(demoLessons.p1); broken.questions[0].answer = 4;
  const invalid = await serve(t, { model: 'test', fetchImpl: mock(broken) });
  assert.equal((await invalid.post('/api/lesson', input)).status, 502);
});
test('Wiki summarization accepts completed lesson material and personal reflection', async t => {
  const expected = { summary: '输入输出', content: 'print() 显示信息。' };
  const app = await serve(t, { model: 'test', fetchImpl: mock(expected) });
  const r = await app.post('/api/wiki', { title: '第一课', lesson: demoLessons.p1, reflection: '我计算了学习时长' });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), expected);
  assert.equal((await app.post('/api/wiki', { title: '第一课', lesson: {}, reflection: '' })).status, 400);
});
test('grounded Q&A rejects invented citations and handles insufficient evidence', async t => {
  const input = { question: '什么是输出？', notes: [{ id: 'note-1', title: '输出', content: 'print 显示信息。' }] };
  const app = await serve(t, { model: 'test', fetchImpl: mock({ answer: '用 print 显示信息。', citations: ['note-1'] }) });
  assert.equal((await app.post('/api/ask', input)).status, 200);
  const invented = await serve(t, { model: 'test', fetchImpl: mock({ answer: '错误引用', citations: ['missing'] }) });
  assert.equal((await invented.post('/api/ask', input)).status, 502);
  const uncertain = await serve(t, { model: 'test', fetchImpl: mock({ answer: '现有笔记不足以回答。', citations: [] }) });
  assert.equal((await uncertain.post('/api/ask', input)).status, 200);
  assert.equal((await app.post('/api/ask', { ...input, notes: [] })).status, 400);
});

test('compatible service works over HTTP for connection, plan, lesson, Wiki and grounded Q&A', async t => {
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    captured.push({ url: req.url, auth: req.headers.authorization, body });
    const data = JSON.parse(body.messages[1].content);
    const value = data.task === 'connection-test' ? { ok: true }
      : data.notes ? { answer: 'print 显示信息。', citations: ['n1'] }
      : data.lesson ? { summary: '输出', content: 'print 显示信息。' }
      : data.objective ? demoLessons.p1 : demoPlan;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const app = await serve(t, { provider: 'compatible', model: 'deployed-model', apiKey: 'private-key', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
  const status = await (await app.get('/api/status')).json();
  assert.equal(status.mode, 'ai');
  assert.equal(status.provider, 'compatible');
  assert.equal(status.model, 'deployed-model');
  assert.ok(!JSON.stringify(status).includes('private-key'));
  assert.equal(captured.length, 0, 'status must not trigger billed generation');
  const probe = await app.post('/api/test-connection', { notes: ['should never reach upstream'] });
  assert.equal(probe.status, 200);
  assert.equal((await probe.json()).ok, true);
  assert.deepEqual(JSON.parse(captured[0].body.messages[1].content), { task: 'connection-test' });
  assert.equal((await app.post('/api/plan', input)).status, 200);
  assert.equal((await app.post('/api/lesson', { goal: '学习', title: '输出', objective: '掌握输出', level: '零基础' })).status, 200);
  assert.equal((await app.post('/api/wiki', { title: '输出', lesson: demoLessons.p1, reflection: '已掌握' })).status, 200);
  assert.equal((await app.post('/api/ask', { question: '输出？', notes: [{ id: 'n1', title: '输出', content: 'print 显示信息。' }] })).status, 200);
  assert.equal(captured.length, 5);
  for (const request of captured) {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.auth, 'Bearer private-key');
    assert.equal(request.body.model, 'deployed-model');
  }
  assert.equal((await app.get('/llm.mjs')).status, 404);
  assert.equal((await app.post('/api/test-connection', {}, { Origin: 'http://untrusted.example' })).status, 403);
});

test('configuration errors are visible in status; connection test never claims success when unconfigured', async t => {
  const broken = await serve(t, { provider: 'deepseek', model: 'test', apiKey: '', fetchImpl: async () => { assert.fail('must not call upstream'); } });
  const status = await (await broken.get('/api/status')).json();
  assert.equal(status.mode, 'error');
  assert.match(status.configurationError, /API_KEY/);
  assert.equal((await broken.post('/api/test-connection', {})).status, 503);
  const demo = await serve(t);
  assert.equal((await demo.post('/api/test-connection', {})).status, 503);
});

test('desktop internal API requires a session token and accepts live model configuration', async t => {
  let model = 'first';
  const app = await serve(t, { apiToken: 'session-secret', getLLM: () => ({ status: () => ({ mode: 'ai', model }), testConnection: async () => ({ ok: true, model }) }) });
  assert.equal((await app.get('/api/status')).status, 403);
  assert.equal((await app.post('/api/test-connection', {})).status, 403);
  const response = await app.post('/api/test-connection', {}, { 'X-Learnflow-Token': 'session-secret' });
  assert.equal((await response.json()).model, 'first');
  model = 'second';
  assert.equal((await (await app.post('/api/test-connection', {}, { 'X-Learnflow-Token': 'session-secret' })).json()).model, 'second');
  assert.equal((await app.get('/')).status, 200);
});
