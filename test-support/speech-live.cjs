// Explicit, one-request paid diagnostic. Never invoked by automated tests.
const { app, safeStorage, session } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
app.setName('Learnflow');
// Windows safeStorage encryption is tied to the application's profile key.
app.setPath('userData', path.join(root, '.desktop-dev'));
app.whenReady().then(async () => {
  let store, desktopStore, stage = 'confirmation';
  try {
    const recover = process.argv.includes('--recover-local');
    if (!recover && !process.argv.includes('--confirm-paid')) throw new Error('未明确确认真实付费测试。');
    stage = 'system-encryption';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥解密不可用。');
    stage = 'image-config';
    const image = JSON.parse(await readFile(path.join(root, '.desktop-dev', 'data', 'image-settings.json'), 'utf8'));
    if (new URL(image.baseUrl).hostname !== 'token-plan.cn-beijing.maas.aliyuncs.com') throw new Error('图片密钥来源与本次指定服务不一致，未发送请求。');
    if (!image.encryptedApiKey) throw new Error('尚未保存图片服务密钥，未发送请求。');
    stage = 'key-decryption';
    const apiKey = safeStorage.decryptString(Buffer.from(image.encryptedApiKey, 'base64'));
    stage = 'test-initialization';
    const { speechDefaults } = await import(pathToFileURL(path.join(root, 'public', 'speech.js')));
    const { createSpeechStore } = await import(pathToFileURL(path.join(root, 'desktop', 'speech-store.mjs')));
    const { createSpeechService } = await import(pathToFileURL(path.join(root, 'desktop', 'speech-service.mjs')));
    const { speechCacheKey } = await import(pathToFileURL(path.join(root, 'desktop', 'speech-service.mjs')));
    const { normalizeAudio } = await import(pathToFileURL(path.join(root, 'speech-model.mjs')));
    const secrets = { encrypt: async key => safeStorage.encryptString(key).toString('base64'), decrypt: async key => safeStorage.decryptString(Buffer.from(key, 'base64')) };
    const diagnosticDirectory = path.join(root, '.desktop-test', 'tts-live', 'data');
    store = createSpeechStore(diagnosticDirectory, secrets); await store.initialize();
    await store.saveSettings({ ...speechDefaults, enabled: true, keyAction: 'replace', apiKey });
    let posts = 0, downloads = 0;
    const network = session.fromPartition('learnflow-speech-paid-diagnostic');
    const service = createSpeechService(store, async (url, options) => {
      if (options.method === 'POST') {
        if (recover) throw new Error('本地恢复模式禁止生成请求。');
        if (++posts > 1) throw new Error('本次真实测试最多一次合成请求。');
        console.log('TTS_LIVE_REQUEST', JSON.stringify({ model: speechDefaults.model, voice: speechDefaults.voice, endpoint: new URL(url).origin + new URL(url).pathname, requests: posts }));
      } else downloads++;
      const response = await network.fetch(url, { ...options, credentials: 'omit' });
      if (response.ok && options.method === 'GET') {
        const reader = response.clone().body.getReader(), parts = []; let size = 0;
        try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('Diagnostic audio size exceeded'); } parts.push(Buffer.from(item.value)); } }
        finally { reader.releaseLock(); }
        const bytes = Buffer.concat(parts);
        await writeFile(path.join(diagnosticDirectory, 'returned-audio.bin'), bytes);
        console.log('TTS_AUDIO_METADATA', JSON.stringify({ bytes: bytes.length, contentType: response.headers.get('content-type'), headerHex: bytes.subarray(0, 16).toString('hex') }));
      }
      return response;
    });
    const text = "Good morning. Let's practise clear English pronunciation together.";
    stage = 'synthesis';
    if (recover) {
      const bytes = normalizeAudio(await readFile(path.join(diagnosticDirectory, 'returned-audio.bin')));
      await store.put(speechCacheKey(store.getConfig(), { text, voice: speechDefaults.voice }), bytes);
    }
    const result = recover ? await service.prepare({ text, assignments: {} }) : await service.generate({ text, assignments: {}, confirmed: true, mode: 'generate' });
    if (result.error) {
      console.log('TTS_LIVE_RESULT', JSON.stringify({ ok: false, posts, downloads, message: result.error, pendingCount: result.pendingCount, retried: false }));
      process.exitCode = 1; return;
    }
    const id = result.turns[0].id, asset = await store.readAsset(id);
    // User explicitly authorized the image account key for speech. Save it in
    // the independent encrypted speech configuration, never expose it to UI.
    desktopStore = createSpeechStore(path.join(root, '.desktop-dev', 'data'), secrets); await desktopStore.initialize();
    await desktopStore.saveSettings({ ...speechDefaults, enabled: true, keyAction: 'replace', apiKey });
    await desktopStore.put(speechCacheKey(desktopStore.getConfig(), { text, voice: speechDefaults.voice }), asset.bytes);
    console.log('TTS_LIVE_RESULT', JSON.stringify({ ok: true, posts, downloads, recoveredLocal: recover, characters: text.length, bytes: asset.bytes.length, format: asset.mime, file: path.join(root, '.desktop-dev', 'data', 'audio', id + '.wav'), configuredDesktop: true, retried: false }));
  } catch {
    console.log('TTS_LIVE_RESULT', JSON.stringify({ ok: false, stage, message: '真实测试初始化失败，未输出任何密钥或服务原始响应；请检查保存的图片配置和系统安全存储。', retried: false }));
    process.exitCode = 1;
  } finally { await store?.flush(); store?.close(); await desktopStore?.flush(); desktopStore?.close(); app.exit(process.exitCode || 0); }
});
