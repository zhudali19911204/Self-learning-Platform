import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { speechDefaults, speechTurns, speechRequest, listeningText } from '../public/speech.js';
import { normalizeSpeechSettings, createSpeechModel, audioMime, normalizeAudio, MAX_AUDIO_BYTES } from '../speech-model.mjs';
import { createSpeechStore } from '../desktop/speech-store.mjs';
import { createSpeechService, speechCacheKey } from '../desktop/speech-service.mjs';
import { wavFixture } from '../test-support/audio.mjs';
const wav = wavFixture(), cfg = (patch = {}) => ({ ...speechDefaults, enabled: true, baseUrl: 'http://127.0.0.1:8999/api/v1', localOnly: true, apiKey: '', ...patch });
const secrets = { encrypt: async value => Buffer.from(value).toString('base64'), decrypt: async value => Buffer.from(value, 'base64').toString() };
const transcript = "Sarah: Alright, let's get started.\nMark: I've finished the login page.\nLisa: I'll wrap it up tomorrow.";
async function createStore(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'learnflow-speech-'));
  let store = createSpeechStore(root, secrets); await store.initialize();
  t.after(async () => { await store.flush(); store.close(); assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  return { root, get store() { return store; }, async reopen() { await store.flush(); store.close(); store = createSpeechStore(root, secrets); await store.initialize(); return store; } };
}
test('specified Token Plan root becomes the same-origin native speech endpoint without reusing unrelated keys', () => {
  const input = { ...speechDefaults, enabled: true, baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', keyAction: 'replace', apiKey: 'speech-only-key' };
  const saved = normalizeSpeechSettings(input);
  assert.equal(saved.baseUrl, 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1');
  assert.equal(saved.model, 'qwen-audio-3.0-tts-plus'); assert.equal(saved.apiKey, 'speech-only-key');
  assert.throws(() => normalizeSpeechSettings({ ...input, localOnly: true }), /仅本机/);
  assert.throws(() => normalizeSpeechSettings({ ...input, baseUrl: 'https://unknown.example/compatible-mode/v1' }), /原生根地址/);
  assert.throws(() => normalizeSpeechSettings({ ...input, baseUrl: saved.baseUrl, keyAction: 'keep' }), /独立 API Key/);
  assert.throws(() => normalizeSpeechSettings({ ...input, model: 'qwen3-tts-flash' }), /不自动切换/);
  assert.throws(() => normalizeSpeechSettings({ ...input, downloadHosts: '*.aliyuncs.com' }), /精确域名/);
  assert.throws(() => normalizeSpeechSettings({ ...input, rate: 2.1 }), /语速/);
  assert.throws(() => normalizeSpeechSettings({ ...input, baseUrl: saved.baseUrl + '?key=secret' }), /查询参数/);
  assert.equal(normalizeSpeechSettings({ ...saved, keyAction: 'keep' }, saved).apiKey, 'speech-only-key');
  assert.equal(normalizeSpeechSettings({ ...saved, enabled: false, baseUrl: 'https://dashscope.aliyuncs.com/api/v1', keyAction: 'keep' }, saved).apiKey, '');
});
test('listening previews prefer transcript fences; role names are not spoken and chunks are bounded', () => {
  assert.equal(listeningText('中文说明\n```text\n' + transcript + '\n```\n```js\nconst a = 1;\n```'), transcript);
  assert.equal(listeningText('```python\nprint("not listening")\n```'), '');
  const turns = speechRequest(transcript, speechDefaults, { Lisa: 'my-custom-English-voice' });
  assert.deepEqual(turns.map(turn => turn.speaker), ['Sarah', 'Mark', 'Lisa']);
  assert.equal(turns[0].voice, 'longanlingxin'); assert.equal(turns[1].voice, 'longanlufeng');
  assert.equal(turns[2].voice, 'my-custom-English-voice'); assert.ok(turns.every(turn => !/^(Sarah|Mark|Lisa):/.test(turn.text)));
  assert.ok(speechTurns('hello '.repeat(800)).every(turn => turn.text.length <= 1500));
  assert.throws(() => speechTurns('x'.repeat(8001)), /8000/);
  assert.throws(() => speechTurns(Array.from({ length: 17 }, (_, i) => `Speaker: turn ${i}`).join('\n')), /最多 16 段/);
  assert.throws(() => speechRequest(transcript, speechDefaults, { Sarah: '<script>' }), /音色/);
});
test('Token Plan speech requests use the specified model, native path and English WAV payload exactly once', async () => {
  const calls = [], config = cfg({ baseUrl: speechDefaults.baseUrl, localOnly: false, apiKey: 'speech-only-key' });
  const model = createSpeechModel(config, async (url, options) => { calls.push({ url, options }); return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } }); });
  assert.deepEqual(await model.synthesize('Hello world.', 'longanlingxin'), wav);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'qwen-audio-3.0-tts-plus', input: { text: 'Hello world.', voice: 'longanlingxin', format: 'wav', sample_rate: 24000, rate: 1, language_hints: ['en'] } });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer speech-only-key');
  assert.equal(calls[0].options.redirect, 'error');
});
test('JSON audio URLs use separate download timeouts; signed HTTP URLs upgrade to HTTPS only for exact trusted hosts', async () => {
  const calls = [], config = cfg({ baseUrl: speechDefaults.baseUrl, localOnly: false, apiKey: 'speech-only-key' });
  const url = 'http://dashscope-7c2c.oss-accelerate.aliyuncs.com/audio.wav?Signature=private';
  const model = createSpeechModel(config, async (url, options) => { calls.push({ url, options }); return options.method === 'POST' ? Response.json({ output: { audio: { url } } }) : new Response(wav); });
  // The callback receives the provider URL privately, before applying download policy.
  const fetchImpl = async (request, options) => { calls.push({ url: request, options }); return options.method === 'POST' ? Response.json({ output: { audio: { url } } }) : new Response(wav); };
  assert.deepEqual(await createSpeechModel(config, fetchImpl).synthesize('Hello.', 'longanlingxin'), wav);
  assert.equal(calls[1].url, url.replace('http:', 'https:'));
  assert.equal(calls[1].options.headers, undefined); assert.equal(calls[1].options.credentials, 'omit'); assert.equal(calls[1].options.redirect, 'error');
  assert.notEqual(calls[0].options.signal, calls[1].options.signal);
  for (const bad of ['https://dashscope-7c2c.oss-accelerate.aliyuncs.com.evil.example/audio.wav', 'https://dashscope-ffff.oss-accelerate.aliyuncs.com/audio.wav', 'http://127.0.0.1:8999/audio.wav', 'https://dashscope-7c2c.oss-accelerate.aliyuncs.com:8443/audio.wav']) {
    let attempted = 0;
    await assert.rejects(createSpeechModel(config, async () => { attempted++; return new Response(wav); }).download(bad), /未授权/);
    assert.equal(attempted, 0);
  }
  await assert.rejects(model.download('file:///secret'), /协议/);
});
test('speech errors are sanitized, non-generating checks never POST and failures never retry or fall back', async () => {
  let calls = 0;
  const model = createSpeechModel(cfg(), async () => { calls++; return Response.json({ code: 'InvalidParameter', message: 'private prompt api-key https://signed.example' }, { status: 400 }); });
  await assert.rejects(model.synthesize('Hello.', 'longanlingxin'), error => /InvalidParameter/.test(error.message) && !/private|api-key|signed/.test(error.message));
  assert.equal(calls, 1);
  const checked = [];
  const result = await createSpeechModel(cfg({ baseUrl: speechDefaults.baseUrl, localOnly: false }), async (url, options) => { checked.push({ url, options }); return Response.json({ data: [{ id: speechDefaults.model }] }); }).check();
  assert.match(result.message, /未合成音频/); assert.equal(checked.length, 1); assert.equal(checked[0].options.method, 'GET');
  assert.ok(checked[0].url.endsWith('/compatible-mode/v1/models'));
});
test('audio validation rejects truncated, oversized, non-audio and invalid PCM headers', () => {
  assert.equal(audioMime(wav), 'audio/wav');
  for (const bad of [wav.subarray(0, wav.length - 1), Buffer.from('<html>' + 'x'.repeat(100)), Buffer.alloc(MAX_AUDIO_BYTES + 1)]) assert.throws(() => audioMime(bad));
  const invalid = Buffer.from(wav); invalid.writeUInt32LE(1000000, 24); assert.throws(() => audioMime(invalid), /PCM/);
});
test('verified provider streaming WAV placeholders are repaired without relaxing stored audio validation', async () => {
  const streamed = Buffer.from(wav); streamed.writeUInt32LE(0x7fffffbf, 4); streamed.writeUInt32LE(0x7fffff9b, 40);
  assert.throws(() => audioMime(streamed), /完整 WAV/);
  assert.deepEqual(normalizeAudio(streamed), wav); assert.equal(streamed.readUInt32LE(4), 0x7fffffbf);
  const invalid = Buffer.from(streamed); invalid.writeUInt32LE(0xffffffff, 40); assert.throws(() => normalizeAudio(invalid));
  assert.throws(() => normalizeAudio(streamed.subarray(0, streamed.length - 1)), /对齐/);
  assert.deepEqual(await createSpeechModel(cfg(), async () => new Response(streamed)).synthesize('Hello.', 'longanlingxin'), wav);
  assert.deepEqual(await createSpeechModel(cfg(), async (_url, options) => options.method === 'POST' ? Response.json({ output: { audio: { url: 'http://127.0.0.1:8999/audio.wav' } } }) : new Response(streamed)).synthesize('Hello.', 'longanlingxin'), wav);
});
test('speech settings encrypt an independent key; cache and content-addressed audio survive reopening without JSON course writes', async t => {
  const env = await createStore(t), store = env.store;
  await store.saveSettings({ ...cfg({ apiKey: 'speech-only-key' }), keyAction: 'replace' });
  const file = await readFile(path.join(env.root, 'speech-settings.json'), 'utf8'); assert.ok(!file.includes('speech-only-key'));
  assert.ok(!JSON.stringify(store.getSettings()).includes('speech-only-key'));
  const key = speechCacheKey(cfg(), { text: 'Hello.', voice: 'longanlingxin' });
  const asset = await store.put(key, wav); assert.deepEqual((await store.readAsset(asset.id)).bytes, wav);
  const reopened = await env.reopen(); assert.equal((await reopened.lookup(key)).id, asset.id); assert.equal(reopened.getConfig().apiKey, 'speech-only-key');
  await assert.rejects(reopened.readAsset('../settings.json'), /标识/);
  const damaged = Buffer.from(wav); damaged[50] ^= 1; await writeFile(path.join(env.root, 'audio', asset.id + '.wav'), damaged);
  await assert.rejects(reopened.lookup(key), /校验失败/);
});
test('deleting a lesson removes only its owned audio; shared and legacy caches remain', async t => {
  const env = await createStore(t), store = env.store;
  const own = 'a'.repeat(64), shared = 'b'.repeat(64), legacy = 'c'.repeat(64);
  const ownAudio = await store.put(own, wavFixture(2));
  const sameAudio = await store.put(shared, wav);
  await store.put(legacy, wav);
  await store.linkLesson('lesson-one', own);
  await store.linkLesson('lesson-one', shared);
  await store.linkLesson('lesson-two', shared);
  await store.deleteLessons(['lesson-one']);
  assert.equal(await store.lookup(own), null);
  await assert.rejects(store.readAsset(ownAudio.id), { code: 'ENOENT' });
  assert.equal((await store.lookup(shared)).id, sameAudio.id);
  assert.equal((await store.lookup(legacy)).id, sameAudio.id);
  await store.deleteLessons(['lesson-two']);
  assert.equal(await store.lookup(shared), null);
  assert.equal((await store.lookup(legacy)).id, sameAudio.id);
  await assert.rejects(store.deleteLessons(['../outside']), /标识/);
});
test('corrupt speech settings are retained and cannot be overwritten or used for generation', async t => {
  const env = await createStore(t), target = path.join(env.root, 'speech-settings.json');
  await writeFile(target, '{corrupt'); const store = await env.reopen();
  assert.match(store.getSettings().error, /原文件已保留/); assert.throws(() => store.getConfig());
  await assert.rejects(store.saveSettings({ ...cfg(), keyAction: 'clear' })); assert.equal(await readFile(target, 'utf8'), '{corrupt');
});
test('a damaged audio cache disables synthesis without preventing desktop initialization or erasing data', async t => {
  const env = await createStore(t); env.store.close();
  const target = path.join(env.root, 'speech-cache.sqlite');
  await writeFile(target, 'damaged-audio-index');
  const store = createSpeechStore(env.root, { encrypt: async () => '', decrypt: async () => '' });
  t.after(() => store.close());
  const result = await store.initialize(); assert.match(result.error, /课程仍可正常使用/);
  assert.equal(await readFile(target, 'utf8'), 'damaged-audio-index');
  assert.throws(() => store.getConfig(), /缓存无法读取/);
  await assert.rejects(store.lookup('a'.repeat(64)), /缓存无法读取/);
});
test('local previews require no requests; explicit synthesis caches per role/text/config and replays without new requests', async t => {
  const env = await createStore(t); await env.store.saveSettings({ ...cfg(), keyAction: 'clear' });
  let posts = 0;
  const service = createSpeechService(env.store, async (_url, options) => { assert.equal(options.method, 'POST'); posts++; return new Response(wav); });
  const value = { text: transcript, assignments: {} };
  assert.equal((await service.prepare(value)).newCount, 3); assert.equal(posts, 0);
  await assert.rejects(service.generate(value), /明确确认/); assert.equal(posts, 0);
  assert.equal((await service.generate({ ...value, mode: 'generate', confirmed: true })).cachedCount, 3); assert.equal(posts, 3);
  assert.equal((await service.generate({ ...value, mode: 'generate', confirmed: true })).newCount, 0); assert.equal(posts, 3);
  const cache = await service.prepare(value); assert.ok(cache.turns.every(turn => turn.id && !turn.pending));
  const reopened = await env.reopen(), offline = createSpeechService(reopened, () => { throw new Error('No network on cached playback'); });
  assert.equal((await offline.prepare(value)).cachedCount, 3);
  assert.equal((await offline.prepare({ ...value, assignments: { Sarah: 'different-voice' } })).newCount, 1);
  await reopened.saveSettings({ ...cfg({ rate: 0.8 }), keyAction: 'clear' }); assert.equal((await offline.prepare(value)).newCount, 3);
});
test('partial results survive failed downloads; download-only retry omits secrets and cannot synthesize remaining turns', async t => {
  const env = await createStore(t); await env.store.saveSettings({ ...cfg({ baseUrl: speechDefaults.baseUrl, localOnly: false, apiKey: 'speech-only-key' }), keyAction: 'replace' });
  let posts = 0, gets = 0;
  const service = createSpeechService(env.store, async (_url, options) => {
    if (options.method === 'POST') { posts++; return posts === 1 ? new Response(wav) : Response.json({ output: { audio: { url: 'https://custom-cdn.example/audio.wav?Signature=private-key' } } }); }
    gets++; assert.equal(options.headers, undefined); return new Response(wav);
  });
  const value = { text: transcript, assignments: {}, confirmed: true, mode: 'generate' };
  const failed = await service.generate(value); assert.equal(posts, 2); assert.equal(gets, 0);
  assert.equal(failed.cachedCount, 1); assert.equal(failed.pendingCount, 1); assert.equal(failed.newCount, 1);
  assert.match(failed.error, /custom-cdn.example/); assert.ok(!JSON.stringify(failed).includes('Signature')); assert.ok(!JSON.stringify(failed).includes('private-key'));
  await assert.rejects(service.generate(value), /先仅重试下载/); assert.equal(posts, 2);
  await env.store.saveSettings({ ...env.store.getConfig(), downloadHosts: 'custom-cdn.example', keyAction: 'keep' });
  const retry = await service.generate({ ...value, mode: 'download-only' }); assert.equal(retry.cachedCount, 2); assert.equal(retry.newCount, 1); assert.equal(posts, 2); assert.equal(gets, 1);
  assert.equal((await service.prepare({ ...value, assignments: { Mark: 'different' } })).newCount, 2);
});
test('concurrent confirmation is single-flight and cannot double-charge the same speech material', async t => {
  const env = await createStore(t); await env.store.saveSettings({ ...cfg(), keyAction: 'clear' });
  let finish, posts = 0;
  const service = createSpeechService(env.store, async () => { posts++; await new Promise(resolve => { finish = resolve; }); return new Response(wav); });
  const value = { text: 'Hello world.', assignments: {}, confirmed: true, mode: 'generate' };
  const first = service.generate(value);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(service.generate(value), /勿重复/); assert.equal(posts, 1);
  finish(); assert.equal((await first).cachedCount, 1);
});
