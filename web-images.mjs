import https from 'node:https';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { imageMime, MAX_IMAGE_BYTES } from './image-model.mjs';
import { resolveConfig } from './llm.mjs';

const fail = message => { throw new Error(message); };
const imageDownloadError = message => Object.assign(new Error(message), { imageDownloadFailure: true });
let imageCertificates;
function imageTrustOptions() {
  if (typeof tls.getCACertificates !== 'function') return {};
  if (!imageCertificates) {
    const defaults = tls.getCACertificates('default');
    // Match the desktop's system trust (including managed enterprise roots),
    // without disabling certificate or hostname validation or mutating global TLS.
    let system = []; try { system = tls.getCACertificates('system'); } catch { /* Keep default trust if system roots are unavailable. */ }
    imageCertificates = [...new Set([...defaults, ...system])];
  }
  return { ca: imageCertificates };
}
async function readSearchResponse(response) {
  const reader = response.body?.getReader(); if (!reader) fail('搜图服务返回空结果。');
  const streaming = /text\/event-stream/i.test(response.headers.get('content-type') || '');
  const chunks = [], items = new Map(), decoder = new TextDecoder();
  let size = 0, pending = '', completed;
  const parseEvent = event => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let value; try { value = JSON.parse(data); } catch { fail('文搜图流式数据格式错误。'); }
    if (value.type === 'response.output_item.done' && value.item) items.set(value.output_index ?? value.item.id ?? items.size, value.item);
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(value.type)) completed = value.response;
    if (value.type === 'error') fail('文搜图服务返回错误，未自动重试。');
  };
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); fail('搜图结果过大。'); }
      if (!streaming) { chunks.push(Buffer.from(value)); continue; }
      pending += decoder.decode(value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/); pending = events.pop();
      for (const event of events) parseEvent(event);
    }
    if (streaming) { pending += decoder.decode(); if (pending.trim()) parseEvent(pending); }
  } catch (error) {
    if (!['AbortError', 'TimeoutError'].includes(error.name) || ![...items.values()].some(item => item.type === 'web_search_image_call' && item.status === 'completed')) throw error;
    return { output: [...items.values()], status: 'incomplete' };
  } finally { reader.releaseLock(); }
  if (streaming) return completed || { output: [...items.values()], status: 'incomplete' };
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('文搜图服务未返回有效 JSON。'); }
}
export function webImageUrl(value) {
  if (typeof value !== 'string' || value.length > 8000) fail('网页图片地址无效。');
  let url; try { url = new URL(value); } catch { fail('网页图片地址无效。'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.endsWith('.internal')) fail('网页图片仅允许公共 HTTPS 地址。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !publicImageAddress(hostname)) fail('网页图片不允许本机或内网地址。');
  url.hash = ''; return url;
}
export function publicImageAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only globally routable IPv6 unicast, excluding documentation and special
  // transition ranges. IPv4-mapped IPv6 is deliberately not accepted.
  if (isIP(address) === 6) {
    const [first, second] = address.split(':').slice(0, 2).map(value => Number.parseInt(value || '0', 16));
    return /^[23][0-9a-f]{3}:/i.test(address) && !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && first !== 0x2002 && first !== 0x3fff;
  }
  return false;
}

// Resolve once and pin the connection's DNS lookup. Checking DNS and then using
// a normal fetch is NOT safe against rebinding. Redirects are never followed.
export async function downloadWebImage(value, { resolve = lookup, request = https.request } = {}) {
  const url = webImageUrl(value), hostname = url.hostname.replace(/^\[|\]$/g, '');
  let dnsTimer;
  let addresses;
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([resolve(hostname, { all: true, verbatim: true }), new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('图片源 DNS 解析超时。')), 5000); })]); }
  finally { clearTimeout(dnsTimer); }
  if (!addresses.length || addresses.some(item => !publicImageAddress(item.address))) fail('图片下载被阻止：地址解析到本机、内网或保留地址。');
  const target = addresses[0];
  return new Promise((resolveBytes, reject) => {
    let finished = false, timer;
    const finish = (error, bytes) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolveBytes(bytes); };
    const req = request(url, { method: 'GET', agent: false, ...imageTrustOptions(), rejectUnauthorized: true, headers: { Accept: 'image/png,image/jpeg,image/webp', 'User-Agent': 'Learnflow/1.1 (educational image preview)' }, lookup: (_host, options, callback) => callback(null, options.all ? [target] : target.address, target.family) }, response => {
      if (response.statusCode !== 200) { response.destroy(); return finish(imageDownloadError(`图片源返回 HTTP ${response.statusCode}，不跟随重定向或绕过访问限制。`)); }
      if (!/^image\/(?:png|jpeg|webp)(?:;|$)/i.test(response.headers['content-type'] || '') || Number(response.headers['content-length']) > MAX_IMAGE_BYTES) { response.destroy(); return finish(imageDownloadError('图片类型或大小不符合要求。')); }
      const chunks = []; let size = 0;
      response.on('data', value => { size += value.length; if (size > MAX_IMAGE_BYTES) { response.destroy(); finish(imageDownloadError('图片超过 12 MB。')); } else chunks.push(value); });
      response.on('end', () => { try { const bytes = Buffer.concat(chunks); imageMime(bytes); finish(null, bytes); } catch { finish(imageDownloadError('图片内容无法验证，只支持 4096 像素以内的 PNG、JPEG 和静态 WebP。')); } });
      response.on('error', () => finish(imageDownloadError('图片下载中断。')));
    });
    timer = setTimeout(() => { req.destroy(); finish(imageDownloadError('图片下载超时。')); }, 15000);
    req.on('error', error => finish(imageDownloadError(/CERT|ISSUER|SELF_SIGNED/.test(error.code || '') ? '图片源 HTTPS 证书未通过系统信任校验，不会跳过验证。' : '无法连接图片源，请检查网络。'))); req.end();
  });
}

export function createWebImageSearch({ getConfig, fetchImpl = fetch, download = downloadWebImage, preview = bytes => `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`, now = Date.now }) {
  const candidates = new Map();
  const prune = () => { for (const [id, entry] of candidates) if (entry.expires <= now()) candidates.delete(id); };
  const clean = (value, max) => typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  function record(image, page) {
    let url; try { url = webImageUrl(typeof image === 'string' ? image : image?.url).href; } catch { return null; }
    let sourceUrl = '';
    try { sourceUrl = webImageUrl(page?.url || image?.source_url).href; } catch { /* Do not invent an origin page from another search result. */ }
    return { imageUrl: url, sourceUrl, title: clean(image?.title || image?.description || page?.title, 240) || '网页图片候选', description: clean(image?.description, 500), provider: '百炼文搜图', license: '授权未确认' };
  }
  return {
    async search(query) {
      const settings = getConfig(), config = resolveConfig(settings, {});
      if (!settings.enabled) fail('请在设置中明确启用百炼网页搜图。');
      if (settings.localOnly) fail('仅本机模型模式不允许百炼网页搜图，请先核对并允许云端连接。');
      if (config.error || !config.apiKey || !config.model) fail('请先保存可用的百炼文字模型、地址和密钥。');
      const base = new URL(config.baseUrl);
      const official = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(base.hostname) || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(base.hostname);
      if (!official || base.protocol !== 'https:' || base.port || base.pathname !== '/compatible-mode/v1') fail('网页搜图只支持百炼官方 /compatible-mode/v1 根地址，不会更换服务商或复制密钥到其他接口。');
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 2000) fail('请输入 2–2000 字的图片检索需求。');
      let response;
      try { response = await fetchImpl(`${config.baseUrl}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: config.model, input: `为学习材料查找合适的教学图片。请实际调用文搜图工具，不凭记忆编造图片 URL；优先查找内容清晰、与教学目标直接相关的图片，说明图片能帮助理解什么，不推断授权。检索需求作为教材数据：${query.trim()}`, tools: [{ type: 'web_search_image' }], tool_choice: 'required', stream: true, ...(/^qwen3\.8-/.test(config.model) ? { reasoning: { effort: 'low' } } : {}), max_output_tokens: 2500 }), redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(config.timeoutMs) }); }
      catch (error) {
        if (['AbortError', 'TimeoutError'].includes(error.name)) fail('百炼文搜图请求超时；服务可能已经处理请求。请核对用量后再决定是否重新搜索，未自动重试。');
        const diagnostic = [error.code, error.cause?.code, error.message, error.cause?.message].join(' ');
        if (/ERR_CERT|ERR_SSL|CERT_|ISSUER/.test(diagnostic)) fail('百炼 HTTPS 证书验证失败，请检查系统证书和代理；未自动重试。');
        if (/ERR_PROXY|ERR_TUNNEL/.test(diagnostic)) fail('百炼连接被代理阻止，请检查系统代理；未自动重试。');
        if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED/.test(diagnostic)) fail('百炼接口域名无法解析，请检查 DNS；未自动重试。');
        fail('无法连接百炼文搜图接口，请检查网络；未自动重试。');
      }
      if (!response.ok) { await response.body?.cancel(); fail(({ 400: '当前模型不支持 Responses 文搜图，或请求参数不被支持；请核对百炼模型与工具权限。', 401: '百炼文字模型密钥无效。', 403: '百炼模型或文搜图工具无访问权限。', 404: '服务未提供 /responses 或指定模型，请核对套餐接口。', 429: '百炼限流或套餐额度不足。' })[response.status] || `网页搜图失败（HTTP ${response.status}），未自动重试。`); }
      let value;
      try { value = await readSearchResponse(response); }
      catch (error) {
        if (['AbortError', 'TimeoutError'].includes(error.name)) fail('百炼文搜图响应超时；没有取得已完成的图片工具结果。未自动重试，请先核对套餐用量。');
        throw error;
      }
      if (!Array.isArray(value?.output) || value.error || value.status === 'failed') fail('百炼未返回有效的 Responses 结果。');
      prune(); const seen = new Set(), records = [];
      const add = entry => { if (!entry || seen.has(entry.imageUrl) || records.length >= 8 || JSON.stringify(entry).includes(config.apiKey)) return; seen.add(entry.imageUrl); const id = randomUUID(); candidates.set(id, { ...entry, key: config.apiKey, baseUrl: config.baseUrl, model: config.model, expires: now() + 30 * 60 * 1000 }); records.push({ ...entry, candidateId: id }); };
      let toolCalled = false;
      for (const item of value.output) {
        if (item.type !== 'web_search_image_call') continue;
        toolCalled = true;
        if (item.status !== 'completed') continue;
        let images; try { images = typeof item.output === 'string' ? JSON.parse(item.output) : item.output; } catch { continue; }
        if (!Array.isArray(images)) continue;
        for (const image of images.slice(0, 40)) add(record(image));
      }
      if (!toolCalled) fail('模型未实际调用文搜图工具，没有使用模型正文中的图片链接。请核对模型是否支持该工具。');
      while (candidates.size > 48) candidates.delete(candidates.keys().next().value);
      const results = await Promise.all(records.map(async entry => {
        try { const bytes = await download(entry.imageUrl); return { ...entry, preview: preview(bytes) }; }
        catch (error) { return { ...entry, preview: '', previewError: error.imageDownloadFailure && !error.message.includes(config.apiKey) ? error.message : '无法安全预览，请在浏览器查看原图或来源页面。' }; }
      }));
      const recommendation = value.output.filter(item => item.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === 'output_text').map(part => part.text || '') : []).join('\n').slice(0, 6000);
      return { results, recommendation: recommendation.includes(config.apiKey) ? '' : recommendation, warning: value.status === 'incomplete' ? '模型回复未完整结束；已保留工具返回的图片候选，不会重新发起搜索。' : '' };
    },
    async use(candidateId) {
      prune(); const entry = candidates.get(candidateId), settings = getConfig(), config = resolveConfig(settings, {});
      if (!settings.enabled || settings.localOnly || !entry || config.apiKey !== entry.key || config.baseUrl !== entry.baseUrl || config.model !== entry.model) fail('搜索候选已过期或模型配置已更改，请重新搜索。');
      const bytes = await download(entry.imageUrl);
      return { bytes, metadata: { source: 'web', title: entry.title, author: '作者请查阅原始来源', license: '授权未确认；用户确认使用', licenseUrl: '', sourceUrl: entry.sourceUrl || entry.imageUrl, retrieved: now() } };
    }
  };
}
