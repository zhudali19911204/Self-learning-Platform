import { speechDefaults, validSpeechVoice } from './public/speech.js';
import { BAILIAN_IMAGE_DOWNLOAD_HOSTS } from './image-model.mjs';
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
const official = host => ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(host) || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(host);
const fail = message => { throw new Error(message); };
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export function normalizeSpeechSettings(input, previous = speechDefaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('语音配置格式不正确。');
  const next = {};
  for (const field of ['model', 'baseUrl', 'voice', 'otherVoice', 'language', 'downloadHosts']) {
    if (typeof input[field] !== 'string' || input[field].length > (['baseUrl', 'downloadHosts'].includes(field) ? 2000 : 200)) fail('请完整填写语音配置。');
    next[field] = input[field].trim();
  }
  if (next.model !== 'qwen-audio-3.0-tts-plus') fail('本版语音接口支持 qwen-audio-3.0-tts-plus，不自动切换模型。');
  if (!validSpeechVoice(next.voice) || !validSpeechVoice(next.otherVoice)) fail('请填写模型支持的音色 ID（仅字母、数字、下划线与连字符）。');
  if (!['en', 'zh'].includes(next.language)) fail('请选择英语或中文。');
  if (typeof input.enabled !== 'boolean' || typeof input.localOnly !== 'boolean') fail('请设置启用状态和仅本机模式。');
  next.enabled = input.enabled; next.localOnly = input.localOnly;
  if (!Number.isFinite(input.rate) || input.rate < 0.5 || input.rate > 2) fail('合成语速范围为 0.5–2。');
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 600000) fail('语音超时须为 1–600 秒。');
  next.rate = input.rate; next.timeoutMs = input.timeoutMs;
  let base; try { base = new URL(next.baseUrl); } catch { fail('语音接口根地址无效。'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) fail('根地址不可包含账号密码或查询参数。');
  if (!loopback(base.hostname) && base.protocol !== 'https:') fail('远端语音服务须使用 HTTPS。');
  if (next.localOnly && !loopback(base.hostname)) fail('云端语音服务请关闭“仅本机语音服务”。');
  if (['/compatible-mode/v1', '/compatible-mode/v1/'].includes(base.pathname) && (official(base.hostname) || loopback(base.hostname))) base.pathname = '/api/v1';
  if (!['/', '/api/v1', '/api/v1/'].includes(base.pathname)) fail('语音原生根地址应为 /api/v1，不包含完整生成路径。');
  base.pathname = '/api/v1'; next.baseUrl = base.href.replace(/\/+$/, '');
  const hosts = next.downloadHosts.split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  if (hosts.length > 20 || hosts.some(host => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..') || loopback(host))) fail('额外下载域名须为精确域名，用英文逗号分隔，不接受通配符或端口。');
  if (next.localOnly && hosts.length) fail('仅本机模式不可添加远端下载域名。');
  next.downloadHosts = [...new Set(hosts)].join(',');
  if (!['keep', 'replace', 'clear'].includes(input.keyAction)) fail('语音密钥操作无效。');
  next.apiKey = input.keyAction === 'keep' && next.baseUrl === previous.baseUrl ? previous.apiKey || '' : '';
  if (input.keyAction === 'replace') {
    if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey)) fail('请填写有效的独立语音 API Key。');
    next.apiKey = input.apiKey.trim();
  }
  if (next.enabled && !loopback(base.hostname) && !next.apiKey) fail('启用云端语音前，请填写独立 API Key。不会沿用文字或图片密钥。');
  return next;
}

export function audioMime(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES) fail('音频为空、过小或超过 20 MB。');
  // First version requests PCM WAV, providing bounded, inspectable decoding.
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('语音服务未返回完整 WAV 音频，不接受 HTML、SVG 或其他文件。');
  let format = false, data = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > bytes.length) fail('WAV 数据不完整。');
    if (kind === 'fmt ') {
      if (size < 16) fail('WAV 格式信息无效。');
      const channels = bytes.readUInt16LE(start + 2), rate = bytes.readUInt32LE(start + 4), bits = bytes.readUInt16LE(start + 14);
      if (bytes.readUInt16LE(start) !== 1 || ![1, 2].includes(channels) || rate < 8000 || rate > 48000 || ![8, 16, 24, 32].includes(bits) || bytes.readUInt16LE(start + 12) !== channels * bits / 8 || bytes.readUInt32LE(start + 8) !== rate * channels * bits / 8) fail('仅支持 8–48 kHz 的标准 PCM WAV。');
      format = true;
    }
    if (kind === 'data' && size > 0) data = true;
    offset = start + size + (size % 2);
  }
  if (!format || !data) fail('WAV 缺少有效音频数据。');
  return 'audio/wav';
}

export function normalizeAudio(bytes) {
  // Verified Qwen Audio HTTP response: a complete PCM body with the provider's
  // specific streaming length placeholders. Repair only this exact 44-byte
  // header shape; arbitrary truncated RIFFs must still fail strict validation.
  if (Buffer.isBuffer(bytes) && bytes.length >= 44 && bytes.length <= MAX_AUDIO_BYTES &&
      bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === 0x7fffffbf &&
      bytes.toString('ascii', 8, 16) === 'WAVEfmt ' && bytes.readUInt32LE(16) === 16 &&
      bytes.toString('ascii', 36, 40) === 'data' && bytes.readUInt32LE(40) === 0x7fffff9b) {
    const blockAlign = bytes.readUInt16LE(32);
    if (!blockAlign || (bytes.length - 44) % blockAlign) fail('WAV 音频数据未按采样帧对齐。');
    bytes = Buffer.from(bytes);
    bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(bytes.length - 44, 40);
  }
  audioMime(bytes); return bytes;
}

async function limited(response, max) {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); fail('语音响应超过大小限制。'); }
  if (!response.body) fail('语音服务返回空响应。');
  const reader = response.body.getReader(), parts = []; let length = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > max) { await reader.cancel(); fail('语音响应超过大小限制。'); } parts.push(Buffer.from(value)); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}
function serviceError(status, body) {
  const codes = { InvalidParameter: '语音参数或音色不被该模型支持，请核对音色 ID。', InvalidApiKey: '语音密钥无效。', AccessDenied: '没有该语音模型的访问权限。', Arrearage: '语音服务余额不足。', Throttling: '语音服务限流或额度不足。' };
  const code = body?.code ?? body?.error?.code;
  return new Error((Object.hasOwn(codes, code) ? `${codes[code]} 错误码：${code}。` : `语音请求失败（HTTP ${status}），请核对模型、音色、套餐权限和接口。`) + ' 未自动重试或切换服务。');
}
export function createSpeechModel(config, fetchImpl = fetch) {
  const base = new URL(config.baseUrl);
  const guard = async (task, downloading = false) => {
    if (!config.enabled) fail('请先启用并保存语音模型。');
    try { return await task(AbortSignal.timeout(config.timeoutMs)); }
    catch (error) {
      if (['AbortError', 'TimeoutError'].includes(error.name)) fail(downloading ? '音频下载超时，可仅重试下载，未重新合成。' : '语音生成超时，可能已计费；请先查服务记录，未自动重试。');
      if (error instanceof TypeError || error.code) fail('无法连接语音服务，请检查地址和网络；未自动重试。');
      throw error;
    }
  };
  async function download(value, signal) {
    if (typeof value !== 'string' || value.length > 8000) fail('服务返回无效音频地址。');
    let url; try { url = new URL(value); } catch { fail('服务返回无效音频地址。'); }
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) fail('音频下载协议无效。');
    const knownProvider = official(base.hostname) && base.protocol === 'https:' && !base.port;
    const hosts = [...(config.downloadHosts || '').split(','), ...(knownProvider ? BAILIAN_IMAGE_DOWNLOAD_HOSTS : [])];
    const host = config.apiKey && url.hostname.includes(config.apiKey.toLowerCase()) ? '（已隐藏）' : url.hostname;
    // Official samples may contain signed HTTP URLs: upgrade only an exact
    // trusted host to HTTPS before any request. Never try HTTP as a fallback.
    if (url.protocol === 'http:' && !url.port && !config.localOnly && hosts.includes(url.hostname)) url.protocol = 'https:';
    const same = url.origin === base.origin;
    if ((!same && !(!config.localOnly && url.protocol === 'https:' && !url.port && hosts.includes(url.hostname))) || (config.localOnly && !loopback(url.hostname))) fail(`音频下载域名未授权：${host}。核对后添加精确下载域名，仅重试下载即可；未访问未知地址。`);
    const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal });
    if (!response.ok) { await response.body?.cancel(); fail(`音频下载失败（HTTP ${response.status}），可仅重试下载，未重新合成。`); }
    return normalizeAudio(await limited(response, MAX_AUDIO_BYTES));
  }
  return {
    download: value => guard(signal => download(value, signal), true),
    check: () => guard(async signal => {
      const path = base.hostname === 'token-plan.cn-beijing.maas.aliyuncs.com' ? '/compatible-mode/v1/models' : 'models';
      const response = await fetchImpl(new URL(path, base.href + '/').href, { method: 'GET', headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}, redirect: 'error', credentials: 'omit', signal });
      if (!response.ok) throw serviceError(response.status);
      let body; try { body = JSON.parse((await limited(response, 1024 * 1024)).toString('utf8')); } catch (error) { if (error instanceof SyntaxError) fail('语音服务未返回有效模型列表 JSON。'); throw error; }
      const models = body.data || body.output?.models;
      if (!Array.isArray(models)) fail('服务未返回模型列表。未合成音频，不能据此确认生成权限。');
      return { message: models.some(model => (model.id || model.model) === config.model) ? '服务可访问，模型已列出。未合成音频；音色与套餐权限仍以实际请求为准。' : '服务可访问，列表中未找到该模型。未合成音频，请核对套餐权限。' };
    }),
    synthesize: (text, voice, ready) => guard(async signal => {
      if (typeof text !== 'string' || !text.trim() || text.length > 1500 || !validSpeechVoice(voice)) fail('请提供有效文本（每段最多 1500 字）和音色。');
      const response = await fetchImpl(new URL('services/audio/tts/SpeechSynthesizer', base.href + '/').href, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) }, body: JSON.stringify({ model: config.model, input: { text, voice, format: 'wav', sample_rate: 24000, rate: config.rate, language_hints: [config.language] } }), redirect: 'error', credentials: 'omit', signal });
      if (!response.ok) { let body; try { body = JSON.parse((await limited(response, 65536)).toString('utf8')); } catch {} throw serviceError(response.status, body); }
      // Token Plan may directly return binary audio; standard DashScope returns
      // JSON output.audio.url. Both are parsed; neither triggers a fallback POST.
      if (!/json/i.test(response.headers.get('content-type') || '')) return normalizeAudio(await limited(response, MAX_AUDIO_BYTES));
      let body; try { body = JSON.parse((await limited(response, 1024 * 1024)).toString('utf8')); } catch (error) { if (error instanceof SyntaxError) fail('语音服务未返回有效 JSON。'); throw error; }
      if (body.code || body.error || body.success === false) throw serviceError(200, body);
      const url = body.output?.audio?.url;
      if (typeof url !== 'string' || url.length > 8000) fail('语音服务未返回 output.audio.url；未重试、未切换接口。');
      let parsed; try { parsed = new URL(url); } catch { fail('服务返回无效音频地址。'); }
      if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol)) fail('服务返回无效音频协议。');
      ready?.(url);
      return guard(downloadSignal => download(url, downloadSignal), true);
    })
  };
}
