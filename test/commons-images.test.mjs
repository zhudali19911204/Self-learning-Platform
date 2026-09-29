import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCommonsImages, commonsMediaUrl } from '../commons-images.mjs';
import { validIllustration } from '../public/illustrations.js';
import { validBlockContent } from '../public/blocks.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const media = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Heart.png/320px-Heart.png';
function fakeCommons() {
  const calls = []; let license = 'CC BY-SA 4.0';
  const fetchImpl = async (value, options) => {
    const url = new URL(value); calls.push({ url, options });
    if (url.hostname === 'commons.wikimedia.org') {
      const width = url.searchParams.get('iiurlwidth');
      const page = { pageid: 42, title: 'File:Heart.png', imageinfo: [{ mime: 'image/png', thumburl: width === '1280' ? media.replace('320px', '1280px') : media, extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a>Example Artist</a>' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' } } }] };
      return Response.json({ query: { pages: [page] } });
    }
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  };
  return { fetchImpl, calls, changeLicense: value => { license = value; } };
}

test('Commons search transfers only explicit keywords, returns safe previews and records attribution', async () => {
  const fake = fakeCommons(), service = createCommonsImages(fake.fetchImpl);
  const results = await service.search('human heart');
  assert.equal(results.length, 1);
  assert.equal(fake.calls[0].url.searchParams.get('gsrsearch'), 'human heart');
  assert.equal(fake.calls[0].url.searchParams.get('gsrnamespace'), '6');
  assert.equal(fake.calls[0].options.credentials, 'omit');
  assert.equal(fake.calls[1].options.redirect, 'error');
  assert.match(results[0].preview, /^data:image\/png;base64,/);
  assert.equal(results[0].author, 'Example Artist');
  assert.equal(results[0].license, 'CC BY-SA 4.0');
  assert.equal(results[0].media, undefined);
  const selected = await service.download(results[0].pageId, results[0].license);
  assert.deepEqual(selected.bytes, png);
  assert.equal(selected.metadata.sourceUrl, 'https://commons.wikimedia.org/wiki/File:Heart.png');
  const illustration = { id: createHash('sha256').update(selected.bytes).digest('hex'), caption: '心脏结构示意', ...selected.metadata, created: 1 };
  assert.ok(validIllustration(illustration));
  assert.ok(validBlockContent('reading', { text: '讲解内容', illustration }));
  assert.equal(fake.calls.at(-1).url.hostname, 'upload.wikimedia.org');
});

test('Commons rejects arbitrary image hosts, missing selection and changed license before download', async () => {
  for (const url of ['http://upload.wikimedia.org/wikipedia/commons/a.png', 'https://upload.wikimedia.org.evil.test/wikipedia/commons/a.png', 'https://127.0.0.1/a.png', 'https://upload.wikimedia.org/wiki/a.png']) assert.throws(() => commonsMediaUrl(url));
  const fake = fakeCommons(), service = createCommonsImages(fake.fetchImpl);
  await assert.rejects(service.search('x'), /2–100/);
  await assert.rejects(service.download(0, 'CC BY-SA 4.0'), /有效/);
  fake.changeLicense('Public domain');
  await assert.rejects(service.download(42, 'CC BY-SA 4.0'), /许可或文件状态已变化/);
  assert.equal(fake.calls.filter(call => call.url.hostname === 'upload.wikimedia.org').length, 0);
});
