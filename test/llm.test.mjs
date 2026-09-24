import test from 'node:test';
import assert from 'node:assert/strict';
import { createLLM, resolveConfig } from '../llm.mjs';

const ok = value => value?.ok === true;
const output = (provider, content = '{"ok":true}', reason = 'stop') => provider === 'ollama'
  ? { message: { content }, done_reason: reason }
  : { choices: [{ message: { content }, finish_reason: reason }] };
const client = options => createLLM({ env: {}, model: 'test-model', ...options });

test('empty configuration is demo; legacy Ollama config remains usable', () => {
  assert.equal(createLLM({ env: {} }).status().mode, 'demo');
  const config = resolveConfig({}, { OLLAMA_MODEL: 'local-model', OLLAMA_BASE_URL: 'http://127.0.0.1:11435/' });
  assert.equal(config.model, 'local-model');
  assert.equal(config.baseUrl, 'http://127.0.0.1:11435');
  assert.equal(config.error, null);
  const modern = resolveConfig({}, { LLM_PROVIDER: 'ollama', LLM_MODEL: 'new', OLLAMA_MODEL: 'old' });
  assert.equal(modern.model, 'new');
  const cloud = resolveConfig({}, { LLM_PROVIDER: 'qwen', OLLAMA_MODEL: 'old', OLLAMA_BASE_URL: 'http://localhost:11434' });
  assert.equal(cloud.model, '');
  assert.equal(cloud.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
});

for (const [provider, endpoint] of [
  ['ollama', 'http://127.0.0.1:11434/api/chat'],
  ['deepseek', 'https://api.deepseek.com/chat/completions'],
  ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
  ['lmstudio', 'http://127.0.0.1:1234/v1/chat/completions'],
  ['vllm', 'http://127.0.0.1:8000/v1/chat/completions'],
  ['compatible', 'https://example.test/custom/v1/chat/completions']
]) {
  test(`${provider}: correct endpoint, protocol, authentication and result parsing`, async () => {
    let sent;
    const llm = client({ provider, apiKey: 'test-secret', ...(provider === 'compatible' ? { baseUrl: 'https://example.test/custom/v1///' } : {}), fetchImpl: async (url, init) => {
      sent = { url, init, payload: JSON.parse(init.body) };
      return Response.json(output(provider));
    } });
    assert.equal(llm.status().mode, 'ai');
    assert.deepEqual(await llm.generate('输出 JSON', { goal: '学习' }, ok), { ok: true });
    assert.equal(sent.url, endpoint);
    assert.equal(sent.init.headers.Authorization, 'Bearer test-secret');
    assert.equal(sent.init.redirect, 'error');
    assert.equal(sent.payload.stream, false);
    assert.equal(sent.payload.model, 'test-model');
    assert.deepEqual(JSON.parse(sent.payload.messages[1].content), { goal: '学习' });
    assert.ok(!JSON.stringify(llm.status()).includes('test-secret'));
    assert.ok(!Object.hasOwn(llm.status(), 'baseUrl'));
    if (provider === 'ollama') {
      assert.equal(sent.payload.format, 'json');
      assert.equal(sent.payload.options.num_predict, 8192);
      assert.equal(sent.payload.think, false);
      assert.equal(sent.payload.response_format, undefined);
    } else {
      assert.equal(sent.payload.max_tokens, 8192);
      assert.equal(sent.payload.options, undefined);
      if (['deepseek', 'qwen'].includes(provider)) assert.deepEqual(sent.payload.response_format, { type: 'json_object' });
      else assert.equal(sent.payload.response_format, undefined);
    }
    if (provider === 'deepseek') assert.deepEqual(sent.payload.thinking, { type: 'disabled' });
    if (provider === 'qwen') assert.equal(sent.payload.enable_thinking, false);
  });
}

test('invalid configuration fails before network I/O, without disclosing secrets', async () => {
  const cases = [
    { provider: 'unknown' }, { provider: 'constructor' }, { provider: 'deepseek', apiKey: '' },
    { provider: 'qwen', apiKey: 'secret', baseUrl: 'http://example.test' },
    { provider: 'compatible' }, { baseUrl: 'file:///secrets' },
    { baseUrl: 'https://user:secret@example.test/v1' }, { baseUrl: 'https://example.test/?key=secret' },
    { baseUrl: 'http://localhost:11434/api/chat' }, { baseUrl: 'http://localhost:1234/v1/chat/completions/' },
    { timeoutMs: 0 }, { timeoutMs: 600001 }, { timeoutMs: 'abc' }, { maxTokens: 3 },
    { jsonMode: 'yes' }, { apiKey: 'secret\nheader' }
  ];
  for (const config of cases) {
    let calls = 0;
    const llm = client({ ...config, fetchImpl: async () => { calls++; } });
    assert.equal(llm.status().mode, 'error');
    await assert.rejects(llm.generate('', {}, ok), e => e.status === 503);
    assert.equal(calls, 0);
    assert.ok(!JSON.stringify(llm.status()).includes('secret'));
  }
});

test('JSON mode may be explicitly enabled or disabled and local keys are optional', async () => {
  for (const [provider, jsonMode] of [['ollama', 'off'], ['qwen', 'off'], ['lmstudio', 'on'], ['compatible', 'on']]) {
    let sent, headers;
    const llm = client({ provider, jsonMode, baseUrl: 'https://example.test/v1', apiKey: provider === 'qwen' ? 'test' : '', fetchImpl: async (_, init) => {
      sent = JSON.parse(init.body); headers = init.headers;
      return Response.json(output(provider));
    } });
    await llm.generate('', {}, ok);
    if (jsonMode === 'off') { assert.equal(sent.format, undefined); assert.equal(sent.response_format, undefined); }
    else assert.deepEqual(sent.response_format, { type: 'json_object' });
    if (provider !== 'qwen') assert.equal(headers.Authorization, undefined);
  }
});

test('connection test sends only a fixed prompt with a short output limit', async () => {
  let sent;
  const llm = client({ provider: 'lmstudio', fetchImpl: async (_, init) => { sent = JSON.parse(init.body); return Response.json(output('lmstudio')); } });
  const result = await llm.testConnection();
  assert.equal(result.ok, true);
  assert.equal(result.model, 'test-model');
  assert.ok(result.latencyMs >= 0);
  assert.equal(sent.max_tokens, 128);
  assert.deepEqual(JSON.parse(sent.messages[1].content), { task: 'connection-test' });
});

test('auth, quota, invalid model and parameter failures have actionable, sanitized errors', async () => {
  for (const [code, message] of [[401, /鉴权/], [403, /鉴权/], [402, /余额/], [429, /限流/], [404, /模型或接口/], [400, /参数/], [422, /参数/], [500, /暂时不可用/]]) {
    let calls = 0;
    const llm = client({ fetchImpl: async () => { calls++; return new Response('secret-and-private-prompt', { status: code }); } });
    await assert.rejects(llm.generate('', {}, ok), e => {
      assert.match(e.message, message);
      assert.ok(!e.message.includes('secret'));
      assert.equal(e.status, code === 429 ? 429 : 502);
      return true;
    });
    assert.equal(calls, 1, 'never retry billed calls automatically');
  }
});

test('timeouts, transport failures and non-JSON HTTP bodies produce clear errors', async () => {
  for (const [error, message, status] of [[new DOMException('secret', 'TimeoutError'), /超时/, 504], [new Error('secret'), /无法连接/, 502]]) {
    await assert.rejects(client({ fetchImpl: async () => { throw error; } }).generate('', {}, ok), e => e.status === status && message.test(e.message));
  }
  await assert.rejects(client({ fetchImpl: async () => new Response('<html>Error</html>') }).generate('', {}, ok), /有效的 JSON 响应/);
  await assert.rejects(client({ fetchImpl: async () => ({ ok: true, json: async () => { throw new DOMException('slow body', 'TimeoutError'); } }) }).generate('', {}, ok), e => e.status === 504);
});

test('transport diagnostics identify certificate, DNS and proxy failures without exposing upstream details', async () => {
  for (const [code, expected] of [
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', /证书验证失败/],
    ['ENOTFOUND', /无法解析/],
    ['ERR_PROXY_CONNECTION_FAILED', /网络代理/]
  ]) {
    const cause = Object.assign(new Error('upstream-secret'), { code });
    const llm = client({ fetchImpl: async () => { throw new TypeError('private-request', { cause }); } });
    await assert.rejects(llm.testConnection(), error => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes('secret') && !error.message.includes('private'));
      return true;
    });
  }
});

test('fenced JSON is accepted; prose, reasoning-only, truncation and invalid shapes are rejected', async () => {
  const llm = content => client({ provider: 'lmstudio', fetchImpl: async () => Response.json(output('lmstudio', content)) });
  assert.deepEqual(await llm('```json\n{"ok":true}\n```').generate('', {}, ok), { ok: true });
  for (const content of ['', null, 'Here is {"ok":true}', '{broken', '{"ok":false}', 'null', '<think>reasoning</think>{"ok":true}']) {
    await assert.rejects(llm(content).generate('', {}, ok), /JSON|格式/);
  }
  await assert.rejects(client({ provider: 'lmstudio', fetchImpl: async () => Response.json({ choices: [{ message: { reasoning_content: '{"ok":true}' } }] }) }).generate('', {}, ok), /JSON/);
  for (const provider of ['ollama', 'lmstudio']) {
    await assert.rejects(client({ provider, fetchImpl: async () => Response.json(output(provider, '{"ok":true}', 'length')) }).generate('', {}, ok), /截断/);
  }
});
