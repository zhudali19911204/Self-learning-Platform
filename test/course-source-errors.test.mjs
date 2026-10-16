import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { createCourseSources } from '../course-sources.mjs';

const cfg = { provider: 'qwen', model: 'qwen3.8-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'secret-never-echo', timeoutMs: 1000, localOnly: false };
const input = { goal: '理解概念', level: '零基础', title: '课程示例', objective: '解释定义', intro: '导语', block: { type: 'reading', title: '概念讲解', objective: '解释概念' }, sourceSearch: { enabled: true, revision: 0 } };
const urls = ['https://docs.example.org/one', 'https://docs.example.org/two', 'https://docs.example.org/three'];
const tools = () => Response.json({ output: [{ type: 'web_search_call', status: 'completed', action: { sources: urls.map(url => ({ url })) } }] });
const document = url => ({ url, title: '资料正文', text: '可读取的资料内容与概念定义。'.repeat(30), retrievedAt: 1000 });
async function serve(t, options) {
  let searches = 0, generations = 0;
  const courseSources = createCourseSources({ getConfig: () => cfg, ...options, fetchImpl: async (...args) => { searches++; return options.fetchImpl(...args); } });
  const server = createApp({ courseSources, getLLM: () => ({ generate: async (_instruction, request, validate) => {
    generations++;
    const output = { text: '概念定义来自资料。[S1E1]' };
    assert.equal(validate(output), true); assert.equal(request.officialDocuments.length, 1); return output;
  } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { counts: () => ({ searches, generations }), post: async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, value: await response.json() };
  } };
}

test('expected search HTTP failures retain specific causes through the complete generation endpoint', async t => {
  for (const [http, status, message] of [[400, 502, /参数不受支持/], [401, 502, /鉴权或权限不足/], [403, 502, /鉴权或权限不足/], [402, 502, /余额不足/], [429, 429, /限流或额度不足/], [503, 502, /搜索服务暂时不可用/], [504, 504, /响应超时/]]) {
    const app = await serve(t, { fetchImpl: async () => new Response('secret-never-echo and private-query', { status: http }) });
    const response = await app.post();
    assert.equal(response.status, status); assert.match(response.value.error, message);
    assert.ok(response.value.error.includes(`HTTP ${http}`));
    assert.equal(response.value.code, `COURSE_SEARCH_HTTP_${http}`); assert.equal(response.value.stage, 'searching');
    assert.ok(!JSON.stringify(response.value).includes('secret-never-echo')); assert.ok(!JSON.stringify(response.value).includes('private-query'));
    assert.deepEqual(app.counts(), { searches: 1, generations: 0 });
  }
});

test('both connection and streamed-body timeouts remain actionable and make no hidden retries', async t => {
  const scenarios = [
    async () => { throw new DOMException('private-upstream-data', 'TimeoutError'); },
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('private-upstream-data', 'AbortError')); } }), { headers: { 'content-type': 'text/event-stream' } }),
    async () => { throw new TypeError('private-network-error'); }
  ];
  for (let i = 0; i < scenarios.length; i++) {
    const app = await serve(t, { fetchImpl: scenarios[i] }); const response = await app.post();
    assert.equal(response.status, i < 2 ? 504 : 502);
    assert.match(response.value.error, i < 2 ? /搜索.*超时/ : /搜索连接失败/);
    assert.ok(!response.value.error.includes('private'));
    assert.deepEqual(app.counts(), { searches: 1, generations: 0 });
  }
});

test('malformed and failed search tool results do not become generic application errors', async t => {
  for (const fetchImpl of [async () => new Response('not-json-secret-never-echo'), async () => Response.json(null), async () => Response.json({ output: [null, { type: 'message', content: 'invented link' }] }), async () => new Response('data: {"type":"response.failed"}\n\n', { headers: { 'content-type': 'text/event-stream' } })]) {
    const app = await serve(t, { fetchImpl }); const response = await app.post();
    assert.ok([422, 502].includes(response.status)); assert.match(response.value.error, /搜索/);
    assert.ok(!response.value.error.includes('服务发生错误')); assert.ok(!response.value.error.includes('secret-never-echo'));
    assert.deepEqual(app.counts(), { searches: 1, generations: 0 });
  }
});

test('empty or unreadable pages aggregate safe reasons while a usable page still permits generation', async t => {
  let reads = 0;
  const app = await serve(t, { fetchImpl: async () => tools(), read: async url => {
    reads++;
    if (url.endsWith('one')) throw new Error('资料文档读取超时。private-url');
    if (url.endsWith('two')) throw new Error('无法安全连接资料文档，请检查网络、代理及 HTTPS 证书。secret-never-echo');
    return { ...document(url), text: '过短' };
  } });
  const response = await app.post();
  assert.equal(response.status, 422); assert.equal(response.value.code, 'COURSE_DOCUMENTS_UNREADABLE'); assert.equal(response.value.stage, 'reading');
  assert.match(response.value.error, /3 个页面/); assert.match(response.value.error, /读取超时/); assert.match(response.value.error, /网络、代理或证书/); assert.match(response.value.error, /缺少有效正文/);
  assert.ok(!JSON.stringify(response.value).includes('secret-never-echo')); assert.ok(!JSON.stringify(response.value).includes('private-url'));
  assert.equal(reads, 3); assert.deepEqual(app.counts(), { searches: 1, generations: 0 });
  const partial = await serve(t, { fetchImpl: async () => tools(), read: async url => {
    if (url.endsWith('three')) return document(url);
    throw new Error('资料页面无法读取或不是受支持的 HTML/文本正文。');
  } });
  const success = await partial.post(); assert.equal(success.status, 200); assert.ok(success.value.grounding);
  assert.deepEqual(partial.counts(), { searches: 1, generations: 1 });
});

test('unsupported saved providers explain the configuration problem before any network request', async t => {
  const app = await serve(t, { getConfig: () => ({ provider: 'compatible', model: 'qwen-27b', baseUrl: 'http://localhost:8000/v1', localOnly: false }), fetchImpl: async () => { throw new Error('Unexpected request'); } });
  const response = await app.post();
  assert.equal(response.status, 400); assert.equal(response.value.code, 'COURSE_SEARCH_CONFIG'); assert.match(response.value.error, /百炼/);
  assert.deepEqual(app.counts(), { searches: 0, generations: 0 });
});
