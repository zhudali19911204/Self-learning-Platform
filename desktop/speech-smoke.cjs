// Real renderer, IPC, OS encryption and playback; all model requests are local mocks.
const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
exports.run = async (window, directory) => {
  const { speechDefaults } = await import('../public/speech.js');
  const { wavFixture } = await import('../test-support/audio.mjs');
  const { normalizeAudio } = await import('../speech-model.mjs');
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const wait = expression => evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{try{if(${expression}){clearInterval(timer);resolve(true);}else if(++n>150){clearInterval(timer);reject(new Error('Speech desktop check timed out'));}}catch(error){clearInterval(timer);reject(error);}},100);})`);
  let audio = wavFixture(3);
  // If an explicitly authorized live diagnostic already exists, verify its
  // repaired file in Chromium too. Merely reading it cannot generate or bill.
  try { audio = normalizeAudio(await readFile(path.resolve('.desktop-test/tts-live/data/returned-audio.bin'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const requests = []; let downloads = 0, checks = 0;
  let origin;
  const model = http.createServer(async (req, res) => {
    try {
      if (req.url === '/api/v1/models') { checks++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: speechDefaults.model }] })); return; }
      if (req.url.startsWith('/audio.wav?')) {
        assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
        downloads++; res.writeHead(downloads === 1 ? 503 : 200, { 'Content-Type': 'audio/wav' }); res.end(downloads === 1 ? 'temporary download failure' : audio); return;
      }
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/v1/services/audio/tts/SpeechSynthesizer');
      assert.equal(req.headers.authorization, 'Bearer speech-smoke-key-not-real');
      let body = ''; for await (const part of req) body += part;
      const value = JSON.parse(body); requests.push(value);
      assert.equal(value.model, speechDefaults.model); assert.equal(value.input.format, 'wav');
      assert.ok(!/Sarah:|Mark:|Lisa:/.test(value.input.text));
      if (requests.length === 2) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ output: { audio: { url: origin + '/audio.wav?Signature=not-public' } } })); }
      else { res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(audio); }
    } catch { res.writeHead(500); res.end('Mock validation failed'); }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${model.address().port}`;
  try {
    await evaluate("document.querySelector('[data-page=settings]').click()");
    await wait("document.querySelector('#speech-settings-form')");
    await evaluate(`document.querySelector('#speech-settings-form [name=enabled]').checked=true;document.querySelector('#speech-settings-form [name=localOnly]').checked=true;document.querySelector('#speech-url').value=${JSON.stringify(origin + '/api/v1')};document.querySelector('#speech-key-action').value='replace';document.querySelector('#speech-key').value='speech-smoke-key-not-real';document.querySelector('#speech-settings-form').requestSubmit()`);
    await wait("document.querySelector('#speech-connection-result')?.textContent.includes('语音配置已保存')");
    const saved = await readFile(path.join(directory, 'speech-settings.json'), 'utf8');
    assert.ok(!saved.includes('speech-smoke-key-not-real')); assert.ok(JSON.parse(saved).encryptedApiKey);
    assert.equal((await evaluate('window.learnflowDesktop.load()')).speechSettings.apiKey, undefined);
    await evaluate("document.querySelector('[data-action=check-speech-connection]').click()");
    await wait("document.querySelector('#speech-connection-result')?.textContent.includes('未合成音频')");
    assert.equal(checks, 1); assert.equal(requests.length, 0);
    await evaluate("document.querySelector('[data-page=routes]').click();document.querySelector('[data-action=open-lesson]').click()");
    await wait("document.querySelector('[data-action=open-speech]')");
    await evaluate("document.querySelector('[data-action=open-speech]').click()");
    await wait("document.querySelector('#speech-dialog').open && !document.querySelector('#speech-preview-fields').disabled");
    const text = "Sarah: Alright, let's get started.\nMark: I've finished the login page.\nLisa: I'll wrap it up tomorrow.";
    await evaluate(`document.querySelector('#speech-material').value=${JSON.stringify(text)};document.querySelector('#speech-material').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#speech-preview-form').requestSubmit()`);
    await wait("document.querySelectorAll('.speech-turns li').length===3 && !document.querySelector('#speech-preview-fields').disabled");
    assert.equal(requests.length, 0);
    await evaluate("document.querySelector('#speech-generate-form').requestSubmit()");
    await wait("document.querySelector('#speech-error')?.textContent.includes('HTTP 503') && !document.querySelector('#speech-preview-fields').disabled");
    assert.equal(requests.length, 2); assert.equal(downloads, 1);
    assert.equal(await evaluate("document.querySelector('#speech-dialog').textContent.includes('Signature')"), false);
    assert.match(await evaluate("document.querySelector('#speech-generate-form').textContent"), /仅重试下载/);
    await evaluate("document.querySelector('#speech-generate-form').requestSubmit()");
    await wait("document.querySelector('#speech-preview-body')?.textContent.includes('已缓存 2 段') && !document.querySelector('#speech-preview-fields').disabled");
    assert.equal(requests.length, 2); assert.equal(downloads, 2);
    await evaluate("document.querySelector('#speech-generate-form').requestSubmit()");
    await wait("document.querySelector('#speech-preview-body')?.textContent.includes('已缓存 3 段') && !document.querySelector('#speech-preview-fields').disabled");
    assert.equal(requests.length, 3); assert.equal(downloads, 2);
    await evaluate("document.querySelector('[data-action=play-speech-all]').click()");
    await wait("document.querySelector('#speech-player')?.readyState>=2 && !document.querySelector('#speech-player').paused");
    const playback = await evaluate("({duration:document.querySelector('#speech-player').duration,source:document.querySelector('#speech-player').src,error:document.querySelector('#speech-player').error?.code||0})");
    assert.ok(playback.duration > 0.1); assert.equal(playback.error, 0); assert.match(playback.source, /\/course-audio\/[a-f0-9]{64}$/);
    await evaluate("document.querySelector('#speech-play-rate').value='0.75';document.querySelector('#speech-play-rate').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#speech-player').pause()");
    assert.equal(await evaluate("document.querySelector('#speech-player').playbackRate"), 0.75);
    assert.equal(requests.length, 3);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await writeFile(path.join(directory, '..', 'speech-smoke.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('[data-action=close-speech]').click();document.querySelector('[data-action=open-speech]').click()");
    await wait("document.querySelector('#speech-dialog').open && !document.querySelector('#speech-preview-fields').disabled");
    await evaluate(`document.querySelector('#speech-material').value=${JSON.stringify(text)};document.querySelector('#speech-preview-form').requestSubmit()`);
    await wait("document.querySelector('#speech-preview-body')?.textContent.includes('已缓存 3 段')");
    assert.equal(requests.length, 3);
    await evaluate("document.querySelector('[data-action=close-speech]').click()");
    console.log('SPEECH_DESKTOP_SMOKE', JSON.stringify({ passed: true, posts: requests.length, downloads, duration: playback.duration, checks: ['encrypted-independent-key', 'non-generating-preview-and-service-check', 'native-payload-role-voices', 'partial-failure-download-only-retry', 'private-signed-url', 'real-chromium-playback', 'pause-playback-speed', 'persistent-cache-reopen-no-generation'] }));
  } finally {
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await evaluate(`window.learnflowDesktop.saveSpeechSettings(${JSON.stringify({ ...speechDefaults, keyAction: 'clear', apiKey: '' })})`);
  }
};
