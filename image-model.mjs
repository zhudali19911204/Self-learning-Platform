export const imageDefaults = { enabled: false, protocol: 'compatible', model: '', baseUrl: '', size: '1024x1024', responseFormat: 'auto', timeoutMs: 180000, localOnly: true, downloadHosts: '' };
const nativeModels = ['wan2.7-image-pro', 'wan2.7-image', 'qwen-image-3.0-pro', 'qwen-image-3.0'];
// Official, exact image output domains (not all OSS buckets or *.aliyuncs.com).
// https://help.aliyun.com/zh/model-studio/text-to-image-api-reference
// https://help.aliyun.com/zh/model-studio/qwen-image-api (dynamic OSS bucket FAQ)
export const BAILIAN_IMAGE_DOWNLOAD_HOSTS = Object.freeze([
  'dashscope-result-bj.oss-cn-beijing.aliyuncs.com',
  'dashscope-result-hz.oss-cn-hangzhou.aliyuncs.com',
  'dashscope-result-sh.oss-cn-shanghai.aliyuncs.com',
  'dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com',
  'dashscope-result-zjk.oss-cn-zhangjiakou.aliyuncs.com',
  'dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com',
  'dashscope-result-hy.oss-cn-heyuan.aliyuncs.com',
  'dashscope-result-cd.oss-cn-chengdu.aliyuncs.com',
  'dashscope-result-gz.oss-cn-guangzhou.aliyuncs.com',
  'dashscope-result-wlcb-acdr-1.oss-cn-wulanchabu-acdr-1.aliyuncs.com',
  // Exact accelerated buckets documented by Bailian; no wildcard OSS trust.
  ...['a717', '66f3', '7c2c', '2522', 'c72b', '0484', '7e0f', '5859', '5496', '35f9', '31d9', '7f1f', 'cc75', '64e9']
    .map(id => `dashscope-${id}.oss-accelerate.aliyuncs.com`)
]);
const officialBailian = hostname => ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(hostname) || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(hostname);
const tokenPlan = hostname => hostname === 'token-plan.cn-beijing.maas.aliyuncs.com';
const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const string = (v, max) => typeof v === 'string' && v.length <= max;
const fail = message => { throw new Error(message); };
export function normalizeImageSettings(input, previous = imageDefaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('图片模型配置格式不正确。');
  const next = { protocol: input.protocol ?? 'compatible' }; // Version 1 configurations predate protocol selection.
  if (!['compatible', 'dashscope'].includes(next.protocol)) fail('请选择通用兼容接口或百炼原生接口。');
  for (const key of ['model', 'baseUrl', 'size', 'responseFormat', 'downloadHosts']) {
    if (!string(input[key], ['baseUrl', 'downloadHosts'].includes(key) ? 2000 : 200)) fail('请完整填写图片模型配置。');
    next[key] = input[key].trim();
  }
  if (typeof input.enabled !== 'boolean' || typeof input.localOnly !== 'boolean') fail('请设置是否启用图片模型和仅本机模式。');
  next.enabled = input.enabled; next.localOnly = input.localOnly; next.timeoutMs = input.timeoutMs;
  if (!Number.isInteger(next.timeoutMs) || next.timeoutMs < 1000 || next.timeoutMs > 600000) fail('图片生成超时须为 1–600 秒。');
  if (!['auto', 'b64_json', 'url'].includes(next.responseFormat)) fail('图片返回格式无效。');
  if (next.protocol === 'dashscope') {
    next.size = next.size.replace('*', 'x').toUpperCase().replace('X', 'x');
    if (next.responseFormat === 'b64_json') fail('百炼原生接口返回图片 URL，请将返回格式改为自动。');
    if (next.model && !nativeModels.includes(next.model)) fail('百炼原生同步接口目前支持 wan2.7-image[-pro]、qwen-image-3.0[-pro]；旧版异步模型暂不支持。');
    const wan = next.model.startsWith('wan2.7-');
    const max = next.model === 'wan2.7-image-pro' ? 4096 : 2048;
    if (/^[124]K$/.test(next.size)) {
      if (!wan || (next.size === '4K' && max < 4096)) fail('1K / 2K 仅用于万相 2.7，4K 仅用于 wan2.7-image-pro。');
    } else {
      const [width, height] = next.size.split('x').map(Number), min = wan ? 768 : 512;
      if (!/^\d{2,4}x\d{2,4}$/.test(next.size) || width < 64 || height < 64 || width > 4096 || height > 4096 || width * height < min * min || width * height > max * max || width / height < 1 / 8 || width / height > 8) fail(`百炼图片尺寸须为宽x高，总像素范围 ${min}×${min}–${max}×${max}，宽高比为 1:8–8:1。`);
    }
  } else if (!/^\d{2,4}x\d{2,4}$/.test(next.size) || next.size.split('x').some(n => Number(n) < 64 || Number(n) > 4096)) fail('图片尺寸应为宽x高，范围为 64–4096；还须符合服务商支持的尺寸。');
  let url;
  if (next.baseUrl) {
    try { url = new URL(next.baseUrl); } catch { fail('图片接口根地址不是有效的 URL。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/(?:images\/generations|chat\/completions|services\/aigc\/.+\/generation)\/?$/.test(url.pathname)) fail('请填写接口根地址，不要包含完整生成路径、密钥或查询参数。');
    if (next.localOnly && !loopback(url.hostname)) fail('图片模型的仅本机模式只允许 localhost、127.0.0.1 或 ::1；使用云端请明确关闭此选项。');
    if (!loopback(url.hostname) && url.protocol !== 'https:') fail('非本机图片服务必须使用 HTTPS，避免泄露密钥与提示词。');
    if (next.protocol === 'dashscope') {
      // Accept a provider's chat-compatible root as an alias, without moving
      // credentials to another origin. Never infer native paths for unknown providers.
      if (['/compatible-mode/v1', '/compatible-mode/v1/'].includes(url.pathname) && (officialBailian(url.hostname) || loopback(url.hostname))) url.pathname = '/api/v1';
      if (!['/', '/api/v1', '/api/v1/'].includes(url.pathname)) fail('百炼原生根地址应以 /api/v1 结尾，不能使用 /compatible-mode/v1。');
      url.pathname = '/api/v1';
    }
    next.baseUrl = url.href.replace(/\/+$/, '');
  }
  if (next.enabled && (!next.model || !url)) fail('启用图片模型前，请填写模型名称与接口根地址。');
  const hosts = next.downloadHosts.split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (hosts.length > 20 || hosts.some(h => !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h) || h.includes('..') || loopback(h))) fail('额外下载域名须为逗号分隔的完整域名，不支持路径、端口或通配符。');
  if (next.localOnly && hosts.length) fail('仅本机模式不能允许远端图片下载域名。');
  next.downloadHosts = [...new Set(hosts)].join(',');
  if (!['keep', 'replace', 'clear'].includes(input.keyAction)) fail('图片密钥操作无效。');
  next.apiKey = input.keyAction === 'keep' && next.baseUrl === previous.baseUrl && next.protocol === (previous.protocol ?? 'compatible') ? previous.apiKey || '' : '';
  if (input.keyAction === 'replace') {
    if (!string(input.apiKey, 4096) || !input.apiKey.trim() || /[\r\n]/.test(input.apiKey)) fail('请填写有效的图片模型 API Key。');
    next.apiKey = input.apiKey.trim();
  }
  if (next.enabled && next.protocol === 'dashscope' && url && !loopback(url.hostname) && !next.apiKey) fail('百炼云端原生接口需要独立 API Key；切换协议或地址后请重新填写，不会沿用旧密钥。');
  return next;
}
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
function dimensions(bytes, mime) {
  let width = 0, height = 0;
  if (mime === 'image/png' && bytes.length >= 33 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (mime === 'image/webp' && bytes.length >= 25) {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X' && bytes.length >= 30) {
      if (bytes[20] & 2) fail('暂不支持动态 WebP 配图。');
      width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3);
    } else if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    }
  }
  if (!width || !height || width > 4096 || height > 4096) fail('图片尺寸无法识别或超过 4096，请调整图片模型尺寸。');
}
export function imageMime(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_IMAGE_BYTES || bytes.length < 16) fail('图片无效或超过 12 MB。');
  let mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else fail('仅支持 PNG、JPEG、WebP 图片，不接受 SVG、HTML 或其他文件。');
  dimensions(bytes, mime); return mime;
}
async function limitedBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); fail('模型响应或图片过大。'); }
  if (!response.body) fail('模型返回了空响应。');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) { await reader.cancel(); fail('模型响应或图片过大。'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function httpError(status, value, native) {
  const messages = { 400: '图片请求参数不被服务支持，请检查接口协议、模型、尺寸和返回格式。', 401: '图片模型密钥无效。', 403: '图片模型没有访问权限。', 402: '图片服务余额不足。', 404: `图片接口或模型不存在；请确认服务支持 ${native ? '百炼原生同步生成接口' : '/images/generations'}。`, 429: '图片服务限流或额度不足，请稍后手动重试。' };
  // Never echo upstream messages: they may include credentials, prompts or URLs.
  const codes = { InvalidParameter: messages[400], InvalidApiKey: messages[401], ModelNotFound: messages[404], AccessDenied: messages[403], Arrearage: messages[402], Throttling: messages[429], DataInspectionFailed: '图片提示词或结果未通过服务商内容审核，请调整提示词。', InternalError: '图片服务内部错误，未自动重试。' };
  const code = value?.code ?? value?.error?.code;
  const known = typeof code === 'string' && Object.hasOwn(codes, code);
  const requestId = typeof value?.request_id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.request_id) ? value.request_id : '';
  return new Error((known ? codes[code] : messages[status] || `图片服务请求失败（HTTP ${status}），没有自动重试。`) + (known ? ` 错误码：${code}。` : '') + (requestId ? ` 请求 ID：${requestId}。` : ''));
}
export function createImageModel(config, fetchImpl = fetch) {
  const native = config.protocol === 'dashscope';
  const check = () => { if (!config.enabled || !config.model || !config.baseUrl) fail('请先启用并保存图片模型配置。'); };
  const headers = () => ({ 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) });
  async function jsonRequest(endpoint, payload, signal, limit) {
    const response = await fetchImpl(new URL(endpoint, `${config.baseUrl}/`).href, { method: payload ? 'POST' : 'GET', headers: headers(), ...(payload ? { body: JSON.stringify(payload) } : {}), redirect: 'error', signal, credentials: 'omit' });
    if (!response.ok) {
      let value;
      try { value = JSON.parse((await limitedBytes(response, 65536)).toString('utf8')); } catch (error) { if (['AbortError', 'TimeoutError'].includes(error.name)) throw error; }
      throw httpError(response.status, value, native);
    }
    try { return JSON.parse((await limitedBytes(response, limit)).toString('utf8')); } catch (error) { if (error instanceof SyntaxError) fail('图片服务没有返回有效 JSON。'); throw error; }
  }
  const guard = async (task, downloadOnly = false) => {
    check();
    try { return await task(AbortSignal.timeout(config.timeoutMs)); }
    catch (error) {
      if (['AbortError', 'TimeoutError'].includes(error.name)) fail(downloadOnly ? '图片下载超时，未重新生成。可手动仅重试下载。' : '图片请求超时。服务可能仍在生成，请先查看服务记录，再决定是否重试，避免重复计费。');
      if (error instanceof TypeError || error.code) fail('无法连接图片服务。请检查地址、网络和服务是否启动；未自动重试。');
      throw error;
    }
  };
  function imageURL(value) {
    if (!string(value, 8000)) fail('服务返回了无效图片地址。');
    let url; try { url = new URL(value); } catch { fail('服务返回了无效图片地址。'); }
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) fail('图片下载地址不在允许范围内：不接受账号密码或非 HTTP(S) 协议。');
    return url;
  }
  async function downloadImage(url, signal) {
    const base = new URL(config.baseUrl), sameOrigin = url.origin === base.origin;
    const hosts = (config.downloadHosts || '').split(',');
    if (native && base.protocol === 'https:' && !base.port && officialBailian(base.hostname)) hosts.push(...BAILIAN_IMAGE_DOWNLOAD_HOSTS);
    const trusted = !config.localOnly && url.protocol === 'https:' && !url.port && hosts.includes(url.hostname);
    if (!sameOrigin && !trusted) {
      // Expose only the hostname, never a signed URL, query, path or credential.
      const host = config.apiKey && url.hostname.includes(config.apiKey.toLowerCase()) ? '（已隐藏）' : url.hostname;
      fail(`图片下载地址不在允许范围内。下载域名：${host}。请核对服务商 CDN 后在图片设置中添加精确域名；远端下载须为 HTTPS 默认端口且关闭仅本机模式。未访问该地址，也未重新生成。`);
    }
    const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', signal });
    if (!response.ok) { await response.body?.cancel(); fail(`图片下载失败（HTTP ${response.status}），未重新请求生成；可仅重试下载，或先在服务商记录中查看结果。`); }
    const bytes = await limitedBytes(response, MAX_IMAGE_BYTES); imageMime(bytes); return bytes;
  }
  return {
    // A caller may retain a provider-returned URL privately and retry ONLY the GET.
    // Every retry re-applies the current download policy and validates the bytes.
    download: url => guard(signal => downloadImage(imageURL(url), signal), true),
    checkConnection: () => guard(async signal => {
      // Token Plan publishes its model catalog via the compatible endpoint;
      // image generation remains on the native endpoint on the SAME origin.
      const compatibleCatalog = native && tokenPlan(new URL(config.baseUrl).hostname);
      const value = await jsonRequest(compatibleCatalog ? '/compatible-mode/v1/models' : native ? `models?model=${encodeURIComponent(config.model)}&page_no=1&page_size=20` : 'models', null, signal, 1024 * 1024);
      if (native && (value?.success === false || value?.code)) throw httpError(200, value, native);
      const nativeCatalog = native && !compatibleCatalog;
      const models = nativeCatalog ? value?.output?.models : value?.data;
      if (!Array.isArray(models)) fail('服务未返回所选协议的模型列表；部分图片服务不支持 /models，可直接在课程中手动验证生成。');
      const listed = models.some(item => (nativeCatalog ? item?.model : item?.id) === config.model);
      return { message: listed ? '服务可访问，已在列表中找到模型。未生成图片；生成能力与计费须以实际请求为准。' : '服务可访问，但列表未找到该模型。请核对名称；部分服务的图片模型不在 /models 中列出。' };
    }),
    generate: (prompt, onDownloadReady) => guard(async signal => {
      if (!string(prompt, 4000) || !prompt.trim()) fail('图片提示词应为 1–4000 字。');
      const payload = native ? { model: config.model, input: { messages: [{ role: 'user', content: [{ text: prompt }] }] }, parameters: { n: 1, size: config.size.replace('x', '*') } } : { model: config.model, prompt, n: 1, size: config.size, ...(config.responseFormat === 'auto' ? {} : { response_format: config.responseFormat }) };
      const value = await jsonRequest(native ? 'services/aigc/multimodal-generation/generation' : 'images/generations', payload, signal, native ? 1024 * 1024 : MAX_IMAGE_BYTES * 1.4 + 65536);
      if (native && (value?.success === false || value?.code)) throw httpError(200, value, native);
      if (native && value?.output?.task_id) fail('服务返回了异步任务；目前仅支持百炼同步生成，未轮询或重新生成。请先在服务商记录中查看任务结果。');
      const nativeImages = native && Array.isArray(value?.output?.choices) ? value.output.choices.flatMap(choice => Array.isArray(choice?.message?.content) ? choice.message.content : []).filter(item => typeof item?.image === 'string') : [];
      const result = native ? (nativeImages[0] ? { url: nativeImages[0].image } : null) : value?.data?.[0]; let bytes;
      if (typeof result?.b64_json === 'string') {
        if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(result.b64_json) || result.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) fail('图片 Base64 数据无效或过大。');
        bytes = Buffer.from(result.b64_json, 'base64');
      } else if (typeof result?.url === 'string' && result.url.length <= 8000) {
        const url = imageURL(result.url);
        if (onDownloadReady) onDownloadReady(url.href, config.apiKey && url.hostname.includes(config.apiKey.toLowerCase()) ? '（已隐藏）' : url.hostname);
        // Generation and downloading are separate network stages. A slow model
        // must not consume the download's time budget after it returns a URL.
        bytes = await guard(downloadSignal => downloadImage(url, downloadSignal), true);
      } else fail(native ? '百炼同步接口未返回 output.choices[].message.content[].image，未重新生成。' : '服务未返回 data[0].b64_json 或 data[0].url，请确认图片接口兼容格式。');
      imageMime(bytes); return bytes;
    })
  };
}
