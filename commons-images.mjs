import { imageMime, MAX_IMAGE_BYTES } from './image-model.mjs';

const API = 'https://commons.wikimedia.org/w/api.php';
const mediaHosts = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const supported = new Set(['image/png', 'image/jpeg', 'image/webp']);
const fail = message => { throw new Error(message); };
const clean = (value, max = 300) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity])).replace(/\s+/g, ' ').trim().slice(0, max);
const meta = (info, name, max) => clean(info?.extmetadata?.[name]?.value, max);

export function commonsMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('图片地址无效。'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !mediaHosts.has(url.hostname) || !url.pathname.startsWith('/wikipedia/commons/') || url.hash) fail('图片地址不属于 Wikimedia Commons 可信媒体域名。');
  return url.href;
}

async function bounded(response, max) {
  if (!response.ok) { await response.body?.cancel(); fail(`Wikimedia 请求失败（HTTP ${response.status}）。`); }
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); fail('图库响应过大。'); }
  if (!response.body) fail('图库返回空内容。');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); fail('图库响应过大。'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function createCommonsImages(fetchImpl = fetch) {
  async function request(params) {
    const url = new URL(API);
    for (const [key, value] of Object.entries({ action: 'query', format: 'json', formatversion: '2', ...params })) url.searchParams.set(key, value);
    const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    let data;
    try { data = JSON.parse((await bounded(response, 1024 * 1024)).toString('utf8')); } catch (error) { if (error instanceof SyntaxError) fail('图库未返回有效数据。'); throw error; }
    if (data?.error || !data?.query || (data.query.pages !== undefined && !Array.isArray(data.query.pages))) fail('图库未返回有效图片列表。');
    return data.query.pages || [];
  }
  function candidate(page) {
    const info = page?.imageinfo?.[0], license = meta(info, 'LicenseShortName', 120);
    if (!Number.isSafeInteger(page?.pageid) || page.pageid < 1 || !page.title?.startsWith('File:') || !supported.has(info?.mime) || !license) return null;
    const media = info.thumburl || info.url;
    try { commonsMediaUrl(media); } catch { return null; }
    return { pageId: page.pageid, title: clean(page.title.slice(5), 240), author: meta(info, 'Artist', 300) || '作者未注明，请查看原始页面', license, licenseUrl: /^https:\/\//.test(info?.extmetadata?.LicenseUrl?.value || '') ? String(info.extmetadata.LicenseUrl.value).slice(0, 1000) : '', pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title).replace(/%3A/i, ':')}`, media };
  }
  async function image(url, max = MAX_IMAGE_BYTES) {
    const response = await fetchImpl(commonsMediaUrl(url), { method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000) });
    const bytes = await bounded(response, max), mime = imageMime(bytes);
    if (!supported.has(mime)) fail('图库图片格式不支持。');
    return { bytes, mime };
  }
  return {
    async search(query) {
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100) fail('请输入 2–100 字的图片搜索词。');
      const pages = await request({ generator: 'search', gsrsearch: query.trim(), gsrnamespace: '6', gsrlimit: '12', prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '320' });
      const entries = pages.map(candidate).filter(Boolean).slice(0, 8);
      const results = await Promise.all(entries.map(async entry => {
        try {
          const { bytes, mime } = await image(entry.media, 750 * 1024);
          return { ...entry, preview: `data:${mime};base64,${bytes.toString('base64')}`, media: undefined };
        } catch { return null; /* Skip unavailable, unsupported or oversized thumbnails. */ }
      }));
      return results.filter(Boolean).slice(0, 6);
    },
    async download(pageId, expectedLicense) {
      if (!Number.isSafeInteger(pageId) || pageId < 1 || typeof expectedLicense !== 'string' || !expectedLicense.trim()) fail('请选择有效的图库图片。');
      const pages = await request({ pageids: String(pageId), prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '1280' });
      const entry = candidate(pages[0]);
      if (!entry || entry.pageId !== pageId || entry.license !== expectedLicense) fail('图片许可或文件状态已变化，请重新搜索并核对。');
      const { bytes } = await image(entry.media);
      return { bytes, metadata: { source: 'commons', title: entry.title, author: entry.author, license: entry.license, licenseUrl: entry.licenseUrl, sourceUrl: entry.pageUrl } };
    }
  };
}
