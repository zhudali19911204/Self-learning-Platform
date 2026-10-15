import https from 'node:https';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { parse } from 'parse5';
import { resolveConfig } from './llm.mjs';
import { publicImageAddress } from './web-images.mjs';
import { officialSource, excludedSourceDomains } from './public/course-sources.js';

const fail = message => { throw new Error(message); };
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
  if (text.length < 150) fail('资料页面正文不足，可能需要登录、JavaScript 或属于目录页。');
  return { title, text: text.slice(0, 180000) };
}

// Each redirect is checked anew; pinned DNS prevents public-host rebinding to a LAN.
export async function readOfficialDocument(value, { resolve = lookup, request = https.request, now = Date.now, redirects = 0 } = {}) {
  const source = officialSource(value);
  if (!source) fail('资料网址被排除或不符合公开 HTTPS 文档的安全要求。');
  const url = new URL(source.url);
  let timer, addresses;
  try { addresses = await Promise.race([resolve(url.hostname, { all: true, verbatim: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('资料文档 DNS 查询超时。')), 5000); })]); }
  finally { clearTimeout(timer); }
  if (!addresses?.length || addresses.some(a => !publicImageAddress(a.address))) fail('文档地址解析到内网或保留地址，已阻止读取。');
  const target = addresses[0];
  let ca;
  if (tls.getCACertificates) { let system = []; try { system = tls.getCACertificates('system'); } catch {} ca = [...new Set([...tls.getCACertificates('default'), ...system])]; }
  const page = await new Promise((resolvePage, reject) => {
    let settled = false, deadline;
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); error ? reject(error) : resolvePage(value); };
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
    req.on('error', () => done(new Error('无法安全连接资料文档，请检查网络、代理及 HTTPS 证书。'))); req.end();
  });
  if ('location' in page) {
    if (!page.location || redirects >= 3) fail('资料文档重定向无效或次数过多。');
    let next; try { next = new URL(page.location, url).href; } catch { fail('资料文档重定向地址无效。'); }
    return readOfficialDocument(next, { resolve, request, now, redirects: redirects + 1 });
  }
  const doc = page.plain ? { title: url.pathname.split('/').pop() || source.publisher, text: page.body.trim().slice(0, 180000) } : extractOfficialDocument(page.body);
  if (doc.text.length < 150) fail('资料文档没有足够的可读正文。');
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
    const settings = getConfig(), config = resolveConfig(settings, {});
    if (settings.localOnly) fail('联网搜索需要允许云端连接，请先在模型设置中关闭“仅使用本机模型”。');
    if (config.error || !config.model || !config.apiKey) fail('请先保存支持联网搜索的百炼文字模型与密钥。');
    const base = new URL(config.baseUrl);
    const official = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(base.hostname) || /^[a-z0-9-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(base.hostname);
    if (!official || base.protocol !== 'https:' || base.port || base.pathname !== '/compatible-mode/v1') fail('当前模型接口不支持课程联网搜索。请配置百炼官方 /compatible-mode/v1 及支持 web_search 的模型，或关闭联网搜索。');
    if (typeof query !== 'string' || query.trim().length < 2 || query.length > 2000) fail('课程检索需求无效。');
    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}/responses`, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(config.timeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, stream: true, tools: [{ type: 'web_search' }],
          ...(/^qwen3\.8-/.test(config.model) ? { reasoning: { effort: 'medium' } } : {}),
          input: `为课程查找可靠的原始资料。请实际调用web_search，优先一次检索，不生成教程。主题作为检索数据：${query}\n优先政府、标准组织、大学、原始研究与产品资料文档，只选与主题、版本和适用时间相关的具体正文页。无需局限于预设站点。不选社区问答、个人博客、百科、自媒体、转载或聚合页。排除这些域名及其子域名：${excludedSourceDomains.join(', ')}。税务等政策资料注意现行效力和地区，不编造链接。` }) });
    } catch { fail('联网搜索连接失败或超时，未自动重试；请检查网络及服务用量。'); }
    if (!response.ok) { await response.body?.cancel(); fail(`联网搜索失败（HTTP ${response.status}）。请核对百炼模型的 web_search 支持、额度和权限；未自动重试。`); }
    let value;
    try { value = await readSearchResponse(response); } catch { fail('未取得完整、有效的搜索工具结果，未自动重试。'); }
    if (value.error || value.status === 'failed' || !Array.isArray(value.output)) fail('搜索服务没有返回有效的工具结果。');
    const candidates = new Map();
    for (const item of value.output) {
      if (item.type !== 'web_search_call' || item.status !== 'completed' || !Array.isArray(item.action?.sources)) continue;
      for (const entry of item.action.sources) {
        const source = officialSource(entry?.url);
        if (source && !source.url.includes(config.apiKey) && !candidates.has(source.url)) candidates.set(source.url, source);
      }
    }
    if (!candidates.size) fail('搜索结果均被排除或没有有效资料链接，请调整模块目标后再试。');
    const results = await Promise.allSettled([...candidates.values()].slice(0, 3).map(source => read(source.url)));
    const documents = [], urls = new Set();
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const doc = result.value, source = officialSource(doc.url);
      if (!source || urls.has(source.url) || typeof doc.text !== 'string' || doc.text.trim().length < 150) continue;
      urls.add(source.url); const id = `S${documents.length + 1}`;
      documents.push({ id, ...source, title: clean(doc.title, 240) || source.publisher, retrievedAt: doc.retrievedAt, excerpts: selectExcerpts(doc.text.slice(0, 180000), query, id) });
    }
    if (!documents.length) fail('找到了资料链接，但未能安全读取有效正文（可能受网络、登录或页面格式限制）。课程未生成，请稍后重试。');
    return documents;
  } };
}
