import https from 'node:https';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { parse } from 'parse5';
import { resolveConfig } from './llm.mjs';
import { publicImageAddress } from './web-images.mjs';
import { officialSource, excludedSourceDomains } from './public/course-sources.js';
import { generationAwait, generationSignal, checkGenerationCancellation, currentGenerationSignal, generationCancelled } from './generation-cancellation.mjs';

export class CourseSourceError extends Error {
  constructor(message, { status = 502, code = 'COURSE_SEARCH_FAILED', stage = 'searching' } = {}) {
    super(message); this.name = 'CourseSourceError'; this.status = status; this.code = code; this.stage = stage;
  }
}
const fail = (message, options) => { throw new CourseSourceError(message, options); };
const documentFail = (message, options = {}) => fail(message, { status: 422, code: 'COURSE_DOCUMENT_FAILED', stage: 'reading', ...options });
const timedOut = error => ['AbortError', 'TimeoutError'].includes(error?.name) || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code || error?.cause?.code);
function readingFailure(error) {
  // Match only known categories. Never expose upstream messages, URLs or keys.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (timedOut(error) || /超时/.test(message)) return '页面读取超时';
  if (/DNS|ENOTFOUND|EAI_AGAIN/.test(`${error?.code || ''} ${message}`)) return '网页域名解析失败';
  if (/连接|证书|代理|中断/.test(message)) return '网页网络、代理或证书连接失败';
  if (/格式|HTML|文本正文/.test(message)) return '网站拒绝访问或页面格式不支持';
  if (/不足|登录|JavaScript/.test(message)) return '网页正文不足或需要登录、JavaScript';
  if (/内网|保留地址|排除|安全要求|重定向/.test(message)) return '网页不符合安全读取要求';
  return '网页未能读取';
}
const clean = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
export function extractOfficialDocument(html) {
  const tree = parse(html), excluded = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer', 'form', 'aside', 'svg', 'template', 'iframe']);
  const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
  const ignored = node => excluded.has(node.tagName) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true' || /(?:^|[\s_-])(?:comments?|discussion|user-content)(?:$|[\s_-])/i.test(`${attr(node, 'id') || ''} ${attr(node, 'class') || ''}`);
  const find = (node, predicate) => predicate(node) ? node : (node.childNodes || []).filter(n => !ignored(n)).map(n => find(n, predicate)).find(Boolean);
  const flatten = node => ignored(node) ? '' : node.nodeName === '#text' ? node.value : (node.childNodes || []).map(flatten).join('') + (['p', 'div', 'section', 'article', 'li', 'pre', 'h1', 'h2', 'h3', 'tr', 'br'].includes(node.tagName) ? '\n' : '');
  const title = clean(flatten(find(tree, n => n.tagName === 'title') || {}), 240);
  const root = find(tree, n => n.tagName === 'main' || attr(n, 'role') === 'main') || find(tree, n => n.tagName === 'article') || tree;
  const text = flatten(root).replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim();
  if (text.length < 150) documentFail('资料页面正文不足，可能需要登录、JavaScript 或属于目录页。');
  return { title, text: text.slice(0, 180000) };
}

// Each redirect is checked anew; pinned DNS prevents public-host rebinding to a LAN.
export async function readOfficialDocument(value, { resolve = lookup, request = https.request, now = Date.now, redirects = 0 } = {}) {
  checkGenerationCancellation();
  const source = officialSource(value);
  if (!source) documentFail('资料网址被排除或不符合公开 HTTPS 文档的安全要求。');
  const url = new URL(source.url);
  let timer, addresses;
  try { addresses = await generationAwait(Promise.race([resolve(url.hostname, { all: true, verbatim: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('资料文档 DNS 查询超时。')), 5000); })])); }
  finally { clearTimeout(timer); }
  if (!addresses?.length || addresses.some(a => !publicImageAddress(a.address))) documentFail('文档地址解析到内网或保留地址，已阻止读取。');
  const target = addresses[0];
  let ca;
  if (tls.getCACertificates) { let system = []; try { system = tls.getCACertificates('system'); } catch {} ca = [...new Set([...tls.getCACertificates('default'), ...system])]; }
  const page = await new Promise((resolvePage, reject) => {
    let settled = false, deadline;
    const signal = currentGenerationSignal();
    const abort = () => { done(generationCancelled()); req.destroy(); };
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort); error ? reject(error) : resolvePage(value); };
    const req = request(url, { method: 'GET', agent: false, ...(ca ? { ca } : {}), rejectUnauthorized: true,
      headers: { Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'Learnflow/1.2 (course reference reader)' },
      lookup: (_host, options, callback) => callback(null, options.all ? [target] : target.address, target.family) }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) { const location = res.headers.location; res.destroy(); return done(null, { location }); }
      const mime = res.headers['content-type'] || '';
      if (res.statusCode !== 200 || !/^(?:text\/html|text\/plain)(?:;|$)/i.test(mime) || Number(res.headers['content-length']) > 2 * 1024 * 1024) { res.destroy(); return done(new Error('资料页面无法读取或不是受支持的 HTML/文本正文。')); }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { res.destroy(); done(new Error('资料页面超过读取上限。')); } else chunks.push(chunk); });
      res.on('end', () => done(null, { body: Buffer.concat(chunks).toString('utf8'), plain: /^text\/plain/i.test(mime) }));
      res.on('error', () => done(new Error('资料文档读取中断。')));
      res.on('aborted', () => done(new Error('资料文档读取中断。')));
    });
    deadline = setTimeout(() => { req.destroy(); done(new Error('资料文档读取超时。')); }, 20000);
    req.on('error', () => done(new Error('无法安全连接资料文档，请检查网络、代理及 HTTPS 证书。')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else req.end();
  });
  if ('location' in page) {
    if (!page.location || redirects >= 3) documentFail('资料文档重定向无效或次数过多。');
    let next; try { next = new URL(page.location, url).href; } catch { documentFail('资料文档重定向地址无效。'); }
    return readOfficialDocument(next, { resolve, request, now, redirects: redirects + 1 });
  }
  const doc = page.plain ? { title: url.pathname.split('/').pop() || source.publisher, text: page.body.trim().slice(0, 180000) } : extractOfficialDocument(page.body);
  if (doc.text.length < 150) documentFail('资料文档没有足够的可读正文。');
  return { ...source, ...doc, title: doc.title || source.publisher, retrievedAt: now() };
}

export function selectExcerpts(text, query, sourceId) {
  const words = [...new Set((query.toLowerCase().match(/[a-z][a-z0-9.+_-]{1,}|[\u4e00-\u9fff]{2,}/g) || []).flatMap(word => /[\u4e00-\u9fff]/.test(word) ? [word, ...Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2))] : [word]))];
  const chunks = []; let position = 0;
  // Preserve original text exactly, including whitespace and code indentation.
  while (position < text.length) {
    let end = Math.min(position + 1100, text.length);
    const boundary = text.lastIndexOf('\n', end);
    if (boundary > position + 500) end = boundary + 1;
    const chunk = text.slice(position, end);
    chunks.push({ position, text: chunk, score: words.reduce((sum, word) => sum + (chunk.toLowerCase().includes(word) ? word.length : 0), 0) });
    position = end;
  }
  return chunks.sort((a, b) => b.score - a.score || a.position - b.position).slice(0, 6).sort((a, b) => a.position - b.position).map((chunk, i) => ({ id: `${sourceId}E${i + 1}`, text: chunk.text }));
}

export async function readSearchResponse(response) {
  const reader = response.body?.getReader(); if (!reader) fail('搜索服务返回空响应。');
  const stream = /text\/event-stream/i.test(response.headers.get('content-type') || '');
  const decoder = new TextDecoder(), items = new Map(); let size = 0, pending = '', complete;
  const event = raw => {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let v; try { v = JSON.parse(data); } catch { fail('搜索响应格式无效。'); }
    if (v.type === 'error' || v.type === 'response.failed') fail('搜索服务未完成请求，未自动重试。');
    if (v.type === 'response.output_item.done' && v.item) items.set(v.output_index ?? v.item.id ?? items.size, v.item);
    if (['response.completed', 'response.incomplete'].includes(v.type)) complete = v.response;
  };
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); fail('搜索响应超过大小上限。'); }
      pending += decoder.decode(value, { stream: true });
      if (stream) { const events = pending.split(/\r?\n\r?\n/); pending = events.pop(); events.forEach(event); }
    }
    pending += decoder.decode();
    if (stream) { if (pending.trim()) event(pending); return complete || { output: [...items.values()] }; }
    try { return JSON.parse(pending); } catch { fail('搜索服务没有返回有效 JSON。'); }
  } catch (error) { try { await reader.cancel(); } catch {} throw error; }
  finally { reader.releaseLock(); }
}

export function createCourseSources({ getConfig, fetchImpl = fetch, read = readOfficialDocument } = {}) {
  return { async prepare(query) {
    checkGenerationCancellation();
    const settings = getConfig(), config = resolveConfig(settings, {});
    if (settings.localOnly) fail('联网搜索需要允许云端连接，请先在模型设置中关闭“仅使用本机模型”。', { status: 400, code: 'COURSE_SEARCH_CONFIG' });
    if (config.error || !config.model || !config.apiKey) fail('请先保存支持联网搜索的百炼文字模型与密钥。', { status: 400, code: 'COURSE_SEARCH_CONFIG' });
    const base = new URL(config.baseUrl);
    const official = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(base.hostname) || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(base.hostname);
    if (!official || base.protocol !== 'https:' || base.port || base.pathname !== '/compatible-mode/v1') fail('当前模型接口不支持课程联网搜索。请配置百炼官方 /compatible-mode/v1 及支持 web_search 的模型，或关闭联网搜索。', { status: 400, code: 'COURSE_SEARCH_CONFIG' });
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 2000) fail('课程检索需求无效。', { status: 400, code: 'COURSE_SEARCH_QUERY' });
    let response;
    try {
      response = await generationAwait(fetchImpl(`${config.baseUrl}/responses`, { method: 'POST', redirect: 'error', credentials: 'omit', signal: generationSignal(config.timeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, stream: true, tools: [{ type: 'web_search' }],
          ...(/^qwen3\.8-/.test(config.model) ? { reasoning: { effort: 'medium' } } : {}),
          input: `为课程查找可靠的原始资料。请实际调用web_search，优先一次检索，不生成教程。主题作为检索数据：${query}\n优先政府、标准组织、大学、原始研究与产品资料文档，只选与主题、版本和适用时间相关的具体正文页。无需局限于预设站点。不选社区问答、个人博客、百科、自媒体、转载或聚合页。排除这些域名及其子域名：${excludedSourceDomains.join(', ')}。税务等政策资料注意现行效力和地区，不编造链接。` }) }));
    } catch (error) {
      checkGenerationCancellation();
      if (timedOut(error)) fail('联网搜索超时，尚未开始生成课程正文。请稍后重试或检查网络；未自动重试。', { status: 504, code: 'COURSE_SEARCH_TIMEOUT' });
      fail('联网搜索连接失败，尚未开始生成课程正文。请检查网络、代理及 HTTPS 证书；未自动重试。', { code: 'COURSE_SEARCH_NETWORK' });
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* Discard only; do not hide the HTTP failure. */ }
      const status = response.status;
      const reason = [401, 403].includes(status) ? '搜索鉴权或权限不足，请检查密钥与 web_search 权限'
        : status === 402 ? '搜索账户余额不足，请检查服务商账户'
        : status === 429 ? '搜索被限流或额度不足，请稍后重试并检查账户额度'
        : [400, 404, 422].includes(status) ? '搜索模型、接口或参数不受支持，请检查百炼模型的 web_search 支持'
        : [408, 504].includes(status) ? '搜索服务响应超时，请稍后重试'
        : '搜索服务暂时不可用，请稍后重试';
      fail(`联网搜索失败（HTTP ${status}）：${reason}。尚未开始生成正文，未自动重试。`, { status: status === 429 ? 429 : [408, 504].includes(status) ? 504 : 502, code: `COURSE_SEARCH_HTTP_${status}` });
    }
    let value;
    try { value = await generationAwait(readSearchResponse(response)); } catch (error) {
      checkGenerationCancellation();
      if (timedOut(error)) fail('联网搜索响应读取超时，尚未开始生成课程正文；未自动重试。', { status: 504, code: 'COURSE_SEARCH_TIMEOUT' });
      if (error instanceof CourseSourceError) throw error;
      fail('搜索响应读取中断，未取得完整的搜索工具结果。尚未开始生成正文，未自动重试。', { code: 'COURSE_SEARCH_RESPONSE' });
    }
    if (!value || value.error || value.status === 'failed' || !Array.isArray(value.output)) fail('搜索服务没有返回有效的工具结果。尚未开始生成正文。', { code: 'COURSE_SEARCH_RESPONSE' });
    const candidates = new Map();
    for (const item of value.output) {
      if (item?.type !== 'web_search_call' || item.status !== 'completed' || !Array.isArray(item.action?.sources)) continue;
      for (const entry of item.action.sources) {
        const source = officialSource(entry?.url);
        if (source && !source.url.includes(config.apiKey) && !candidates.has(source.url)) candidates.set(source.url, source);
      }
    }
    if (!candidates.size) fail('搜索结果均被排除或没有有效资料链接，请调整模块目标后再试。尚未开始生成正文。', { status: 422, code: 'COURSE_SEARCH_NO_SOURCES' });
    checkGenerationCancellation();
    const results = await generationAwait(Promise.allSettled([...candidates.values()].slice(0, 3).map(source => read(source.url))));
    checkGenerationCancellation();
    const documents = [], urls = new Set(), failures = new Map();
    const recordFailure = reason => failures.set(reason, (failures.get(reason) || 0) + 1);
    for (const result of results) {
      if (result.status !== 'fulfilled') { recordFailure(readingFailure(result.reason)); continue; }
      const doc = result.value, source = officialSource(doc?.url);
      if (!source || typeof doc?.text !== 'string' || doc.text.trim().length < 150) { recordFailure('网页缺少有效正文或链接'); continue; }
      if (urls.has(source.url)) continue;
      urls.add(source.url); const id = `S${documents.length + 1}`;
      documents.push({ id, ...source, title: clean(doc.title, 240) || source.publisher, retrievedAt: doc.retrievedAt, excerpts: selectExcerpts(doc.text.slice(0, 180000), query, id) });
    }
    if (!documents.length) fail(`找到了资料链接，但尝试读取的 ${results.length} 个页面均无可用正文：${[...failures].map(([reason, count]) => `${reason}（${count} 个）`).join('；')}。尚未开始生成正文，请调整模块目标或稍后重试。`, { status: 422, code: 'COURSE_DOCUMENTS_UNREADABLE', stage: 'reading' });
    return documents;
  } };
}
