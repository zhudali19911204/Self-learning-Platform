import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import tls from 'node:tls';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebImageSearch, publicImageAddress, webImageUrl, downloadWebImage } from '../web-images.mjs';
import { createWebSearchStore } from '../desktop/web-search-store.mjs';
import { validIllustration } from '../public/illustrations.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const config = { enabled: true, provider: 'qwen', localOnly: false, apiKey: 'test-secret', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max' };
const response = () => Response.json({ output: [{ type: 'web_search_image_call', status: 'completed', output: JSON.stringify([{ url: 'https://images.example.org/heart.png', title: '心脏结构', source_url: 'https://example.org/heart' }]) }, { type: 'message', content: [{ type: 'output_text', text: '第一张适合讲解心房。' }] }] });

test('Bailian web images use one same-account Responses tool call; saving a candidate only downloads', async () => {
  let posts = 0, gets = 0;
  const service = createWebImageSearch({ getConfig: () => config, fetchImpl: async (url, options) => {
    posts++; assert.equal(url, config.baseUrl + '/responses'); assert.equal(options.headers.Authorization, 'Bearer test-secret');
    const value = JSON.parse(options.body); assert.equal(value.model, config.model); assert.deepEqual(value.tools, [{ type: 'web_search_image' }]);
    assert.ok(!options.body.includes('test-secret')); return response();
  }, download: async () => { gets++; return png; } });
  const result = await service.search('心脏结构');
  assert.equal(posts, 1); assert.equal(result.results.length, 1); assert.ok(result.results[0].preview); assert.match(result.recommendation, /心房/);
  const chosen = await service.use(result.results[0].candidateId);
  assert.equal(posts, 1); assert.equal(gets, 2); assert.equal(chosen.metadata.source, 'web');
  assert.ok(validIllustration({ ...chosen.metadata, id: 'a'.repeat(64), caption: '结构', created: 1 }));
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});

test('Bailian search never trusts model-written URLs; errors and empty tool output do not trigger retries', async () => {
  let calls = 0;
  const noTool = createWebImageSearch({ getConfig: () => config, fetchImpl: async () => { calls++; return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '![fake](https://example.org/fake.png)' }] }] }); } });
  await assert.rejects(noTool.search('心脏结构'), /未实际调用/); assert.equal(calls, 1);
  const denied = createWebImageSearch({ getConfig: () => config, fetchImpl: async () => { calls++; return Response.json({ error: 'test-secret' }, { status: 403 }); } });
  await assert.rejects(denied.search('心脏结构'), error => /无访问权限/.test(error.message) && !error.message.includes('test-secret'));
  assert.equal(calls, 2);
});
test('Bailian streamed tool results and recommendations are decoded without trusting text URLs', async () => {
  const tool = { type: 'web_search_image_call', status: 'completed', output: JSON.stringify([{ title: '中文心脏', url: 'https://images.example.org/heart.png' }]) };
  const payload = `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: tool })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [tool], status: 'completed' } })}\n\n`;
  const bytes = new TextEncoder().encode(payload);
  const service = createWebImageSearch({ getConfig: () => config, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body); assert.equal(request.stream, true); assert.equal(request.tool_choice, 'required'); assert.equal(request.reasoning.effort, 'low');
    return new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  }, download: async () => png });
  const result = await service.search('中文心脏'); assert.equal(result.results[0].title, '中文心脏'); assert.equal(result.results[0].sourceUrl, '');
});

test('Bailian candidates remain visible when preview fails and expire or invalidate on account changes', async () => {
  let timestamp = 1, selectedConfig = { ...config };
  const service = createWebImageSearch({ getConfig: () => selectedConfig, fetchImpl: async () => response(), download: async () => { throw new Error('private-host'); }, now: () => timestamp });
  const result = await service.search('心脏结构'); assert.equal(result.results.length, 1); assert.equal(result.results[0].preview, '');
  timestamp += 30 * 60 * 1000 + 1;
  await assert.rejects(service.use(result.results[0].candidateId), /过期/);
  const next = await service.search('心脏结构'); selectedConfig.model = 'qwen3.8-flash';
  await assert.rejects(service.use(next.results[0].candidateId), /模型配置/);
  for (const patch of [{ enabled: false }, { localOnly: true }, { baseUrl: 'https://other.example.org/v1' }]) {
    selectedConfig = { ...config, ...patch }; await assert.rejects(service.search('心脏结构'));
  }
});

test('public image addresses exclude private, reserved and mapped IPs; download pins DNS without authorization or redirects', async () => {
  for (const address of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '192.168.1.1', '100.100.100.200', '172.16.1.1', '::1', '::ffff:127.0.0.1', '2001:db8::1', '2001:20::1']) assert.equal(publicImageAddress(address), false, address);
  assert.equal(publicImageAddress('8.8.8.8'), true); assert.equal(publicImageAddress('2001:4860::1'), true);
  for (const url of ['https://127.0.0.1/x.png', 'https://localhost/x.png', 'http://example.org/x.png', 'https://user:pass@example.org/x.png', 'https://example.org:444/x.png']) assert.throws(() => webImageUrl(url));
  let requests = 0;
  const request = (_url, options, callback) => {
    requests++; assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined); assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.checkServerIdentity, undefined);
    if (typeof tls.getCACertificates === 'function') {
      for (const certificate of [...tls.getCACertificates('default'), ...tls.getCACertificates('system')]) assert.ok(options.ca.includes(certificate));
    }
    options.lookup('images.example.org', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => { const stream = new PassThrough(); stream.statusCode = 200; stream.headers = { 'content-type': 'image/png' }; callback(stream); stream.end(png); }); return req;
  };
  assert.deepEqual(await downloadWebImage('https://images.example.org/x.png', { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request }), png);
  await assert.rejects(downloadWebImage('https://images.example.org/x.png', { resolve: async () => [{ address: '127.0.0.1', family: 4 }], request }), /内网/);
  assert.equal(requests, 1);
});

test('image download failures explain certificate rejection without exposing upstream errors', async () => {
  const request = (_url, _options, _callback) => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => req.emit('error', Object.assign(new Error('secret upstream details'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }))); return req;
  };
  const download = url => downloadWebImage(url, { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request });
  const service = createWebImageSearch({ getConfig: () => config, fetchImpl: async () => response(), download });
  const result = await service.search('心脏结构');
  assert.match(result.results[0].previewError, /证书/);
  assert.ok(!JSON.stringify(result).includes('secret upstream'));
  await assert.rejects(service.use(result.results[0].candidateId), /不会跳过验证/);
});

test('web search preference persists consent only, not another model key', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'learnflow-web-search-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWebSearchStore(directory); assert.equal((await store.initialize()).enabled, false);
  await store.saveSettings({ enabled: true, apiKey: 'do-not-store' });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'web-search-settings.json'), 'utf8')), { version: 1, enabled: true });
  const reopened = createWebSearchStore(directory); assert.equal((await reopened.initialize()).enabled, true);
});
