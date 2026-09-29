import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createImageModel, imageDefaults, normalizeImageSettings, imageMime, MAX_IMAGE_BYTES, BAILIAN_IMAGE_DOWNLOAD_HOSTS } from '../image-model.mjs';
import { createPendingImageDownloads } from '../desktop/pending-images.mjs';
import { createImageStore } from '../desktop/image-store.mjs';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { validBlockContent, revisedContent, restoredContent } from '../public/blocks.js';
import { validImageSuggestion, validIllustration, referencedImages } from '../public/illustrations.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const id = createHash('sha256').update(png).digest('hex');
const image = { id, prompt: '一张帮助理解输入输出的教学示意，不含文字', caption: '输入经处理变成输出。', model: 'image-test', created: 1 };
const config = (patch = {}) => ({ ...imageDefaults, enabled: true, model: 'image-test', baseUrl: 'http://127.0.0.1:8001/v1', apiKey: 'image-only-key', ...patch });
const secrets = { encrypt: async v => Buffer.from(v).toString('base64'), decrypt: async v => Buffer.from(v, 'base64').toString() };
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'learnflow-images-test-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('image settings are independent, bounded, local-only by default and never carry keys to a new origin', () => {
  assert.equal(imageDefaults.enabled, false);
  assert.equal(imageDefaults.localOnly, true);
  const previous = config();
  const normalized = normalizeImageSettings({ ...previous, keyAction: 'keep' }, previous);
  assert.equal(normalized.apiKey, 'image-only-key');
  assert.equal(normalizeImageSettings({ ...previous, baseUrl: 'http://localhost:8001/v1', keyAction: 'keep' }, previous).apiKey, '');
  for (const patch of [ { baseUrl: 'https://cloud.example/v1' }, {baseUrl:'http://192.168.1.2/v1'}, {baseUrl:'file:///tmp'}, {baseUrl:'http://127.0.0.1/v1/images/generations'}, {baseUrl:'http://key@localhost/v1'}, {baseUrl:'http://localhost/v1?k=secret'}, {size:'9999x9999'}, {timeoutMs:0}, {downloadHosts:'*.cdn.example'}, {responseFormat:'html'}, {downloadHosts:'cdn.example'} ]) {
    assert.throws(() => normalizeImageSettings({ ...previous, keyAction:'clear', ...patch }));
  }
  assert.throws(() => normalizeImageSettings({ ...previous, localOnly:false, baseUrl:'http://cloud.example/v1', keyAction:'clear' }), /HTTPS/);
  assert.equal(normalizeImageSettings({ ...previous, localOnly:false, baseUrl:'https://cloud.example/v1', downloadHosts:'cdn.example', keyAction:'clear' }).downloadHosts, 'cdn.example');
});
test('image settings persist encrypted keys separately; corrupt settings and unavailable encryption preserve existing configuration', async t => {
  const root = await directory(t), store = createImageStore(root, secrets);
  await store.initialize();
  const safe = await store.saveSettings({ ...config(), keyAction:'replace' });
  assert.equal(safe.hasApiKey, true); assert.equal(safe.apiKey, undefined);
  const raw = await readFile(path.join(root, 'image-settings.json'), 'utf8'); assert.ok(!raw.includes('image-only-key'));
  const reopened = createImageStore(root, secrets); await reopened.initialize();
  assert.equal(reopened.getConfig().apiKey, 'image-only-key');
  const failing = createImageStore(root, { ...secrets, encrypt: async () => { throw new Error('no encryption'); } }); await failing.initialize();
  await assert.rejects(failing.saveSettings({ ...config(), apiKey:'new-key', keyAction:'replace' }));
  assert.equal(await readFile(path.join(root, 'image-settings.json'), 'utf8'), raw);
  await writeFile(path.join(root, 'image-settings.json'), '{bad');
  const damaged = createImageStore(root, secrets); assert.match((await damaged.initialize()).error, /原文件已保留/);
  await assert.rejects(damaged.saveSettings({ ...config(), keyAction:'clear' }));
  assert.equal(damaged.getConfig().enabled, false);
});

test('legacy image configuration loads without migration or loss of its encrypted key', async t => {
  const root = await directory(t), legacy = {version:1,...config(),encryptedApiKey:await secrets.encrypt('legacy-key')};
  delete legacy.protocol; delete legacy.apiKey;
  const raw = JSON.stringify(legacy);
  await writeFile(path.join(root,'image-settings.json'), raw);
  const store = createImageStore(root,secrets);
  assert.equal((await store.initialize()).protocol,'compatible');
  assert.equal(store.getConfig().apiKey,'legacy-key');
  assert.equal(await readFile(path.join(root,'image-settings.json'),'utf8'),raw);
});

const nativeConfig = (patch = {}) => config({protocol:'dashscope',model:'wan2.7-image-pro',baseUrl:'http://127.0.0.1:8001/api/v1',...patch});
test('native settings normalize roots and sizes, reject incompatible endpoints and validate model limits before generation', () => {
  const normalize = patch => normalizeImageSettings({...nativeConfig(),keyAction:'replace',...patch});
  assert.equal(normalize({baseUrl:'http://127.0.0.1:8001'}).baseUrl,'http://127.0.0.1:8001/api/v1');
  assert.equal(normalize({size:'1024*1024'}).size,'1024x1024');
  assert.equal(normalize({size:'2k'}).size,'2K');
  for (const patch of [
    {protocol:'unknown'}, {baseUrl:'https://proxy.example/compatible-mode/v1',localOnly:false},
    {baseUrl:'http://localhost/api/v1/services/aigc/multimodal-generation/generation'},
    {size:'64x64'}, {size:'4000x100'}, {model:'wan2.7-image',size:'4K'},
    {model:'qwen-image-3.0',size:'2K'}, {model:'qwen-image-3.0-pro',size:'3000x3000'},
    {model:'wan2.6-t2i'}, {responseFormat:'b64_json'}
  ]) assert.throws(()=>normalize(patch));
  assert.equal(normalize({model:'qwen-image-3.0-pro',size:'512x512'}).size,'512x512');
  assert.equal(normalize({baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1',localOnly:false}).baseUrl,'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1');
  assert.throws(()=>normalize({baseUrl:'https://dashscope.aliyuncs.com/api/v1',localOnly:false,keyAction:'clear'}),/独立 API Key/);
  const previous = config({baseUrl:'http://localhost/api/v1'});
  assert.equal(normalizeImageSettings({...nativeConfig(),baseUrl:previous.baseUrl,keyAction:'keep'},previous).apiKey,'','protocol changes must not reuse keys');
});

test('Token Plan screenshot configuration saves a same-origin native root with its own encrypted key and survives reload', async t => {
  const root=await directory(t), store=createImageStore(root,secrets);await store.initialize();
  const input={...nativeConfig(),baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',localOnly:false,apiKey:'sk-sp-test-only-not-real',keyAction:'replace'};
  const safe=await store.saveSettings(input);
  assert.equal(safe.baseUrl,'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1');
  assert.equal(safe.protocol,'dashscope');assert.equal(safe.hasApiKey,true);assert.equal(safe.apiKey,undefined);
  assert.equal(new URL(safe.baseUrl).origin,new URL(input.baseUrl).origin,'never replace Token Plan with ordinary paid Bailian');
  assert.equal(store.getConfig().apiKey,input.apiKey);
  const raw=await readFile(path.join(root,'image-settings.json'),'utf8');assert.ok(!raw.includes(input.apiKey));
  const reopened=createImageStore(root,secrets);assert.equal((await reopened.initialize()).error,'');
  assert.equal(reopened.getConfig().apiKey,input.apiKey);assert.equal(reopened.getSettings().baseUrl,safe.baseUrl);
  assert.equal((await reopened.saveSettings({...input,keyAction:'keep',apiKey:''})).hasApiKey,true,'the same native root alias can keep its existing key');
  await assert.rejects(reopened.saveSettings({...input,baseUrl:'https://dashscope.aliyuncs.com/api/v1',keyAction:'keep',apiKey:''}),/独立 API Key/);
  assert.equal(reopened.getSettings().baseUrl,safe.baseUrl,'rejected changes do not modify the saved origin');
});

test('native root aliases normalize only for known Bailian origins and explicit local services', () => {
  for (const baseUrl of ['https://token-plan.cn-beijing.maas.aliyuncs.com','https://dashscope.aliyuncs.com','https://workspace.cn-beijing.maas.aliyuncs.com','http://localhost:8001']) {
    const input={...nativeConfig(),baseUrl:`${baseUrl}/compatible-mode/v1/`,localOnly:baseUrl.startsWith('http:'),keyAction:'replace'};
    const next=normalizeImageSettings(input);
    assert.equal(next.baseUrl,`${baseUrl}/api/v1`);assert.equal(next.apiKey,input.apiKey);
  }
  for (const baseUrl of ['https://token-plan.cn-beijing.maas.aliyuncs.com.evil.example/compatible-mode/v1','https://proxy.example/compatible-mode/v1','https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1?api_key=secret','https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation']) {
    assert.throws(()=>normalizeImageSettings({...nativeConfig(),baseUrl,localOnly:false,keyAction:'replace'}));
  }
  assert.throws(()=>normalizeImageSettings({...nativeConfig(),baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',localOnly:true,keyAction:'replace'}),/仅本机/);
  const compatible=normalizeImageSettings({...config(),baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',localOnly:false,keyAction:'replace'});
  assert.equal(compatible.baseUrl,'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1','generic protocol roots must not be rewritten');
});

test('Token Plan checks the compatible catalog but generates on its native endpoint without switching providers or keys', async () => {
  const cfg=normalizeImageSettings({...nativeConfig(),baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',localOnly:false,keyAction:'replace'});
  const calls=[], model=createImageModel(cfg,async(url,options)=>{
    calls.push({url,options});
    if (url.endsWith('/models')) return Response.json({data:[{id:'wan2.7-image-pro'}]});
    if (url.endsWith('/generation')) return Response.json({output:{choices:[{message:{content:[{image:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.png'}]}}]}});
    return new Response(png);
  });
  assert.match((await model.checkConnection()).message,/已在列表中找到模型.*未生成图片/);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models');
  assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.body,undefined);
  assert.deepEqual(await model.generate('教学图片'),png);assert.equal(calls.length,3);
  assert.equal(calls[1].url,'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(calls[1].options.headers.Authorization,`Bearer ${cfg.apiKey}`);assert.equal(calls[2].options.headers,undefined);
  assert.deepEqual(JSON.parse(calls[1].options.body).parameters,{n:1,size:'1024*1024'});
  assert.ok(calls.every(call=>!call.url.startsWith('https://dashscope.aliyuncs.com')));
});

test('native synchronous generation sends messages and parameters once, and downloads the first image without authorization', async () => {
  for (const modelName of ['wan2.7-image-pro','wan2.7-image','qwen-image-3.0-pro','qwen-image-3.0']) {
    const calls = [];
    const model = createImageModel(nativeConfig({model:modelName}),async (url,options)=>{
      calls.push({url,options});
      return calls.length === 1 ? Response.json({output:{choices:[{message:{content:[{text:'explanation'},{image:'http://127.0.0.1:8001/result.png',type:'image'}]}}]}}) : new Response(png);
    });
    assert.deepEqual(await model.generate('教学图片'),png);
    assert.equal(calls[0].url,'http://127.0.0.1:8001/api/v1/services/aigc/multimodal-generation/generation');
    assert.deepEqual(JSON.parse(calls[0].options.body),{model:modelName,input:{messages:[{role:'user',content:[{text:'教学图片'}]}]},parameters:{n:1,size:'1024*1024'}});
    assert.equal(calls[0].options.headers.Authorization,'Bearer image-only-key');
    assert.equal(calls[0].options.headers['X-DashScope-Async'],undefined);
    assert.equal(calls[1].options.headers,undefined);
    assert.equal(calls[1].options.redirect,'error'); assert.equal(calls[1].options.credentials,'omit');
    assert.equal(calls.length,2);
  }
});

test('native model check filters by ID and parses output.models without sending an image request', async () => {
  const calls = [];
  const model = createImageModel(nativeConfig(),async (url,options)=>{
    calls.push({url,options});return Response.json({success:true,code:null,output:{models:[{model:'wan2.7-image-pro',capabilities:['IG']}]}});
  });
  assert.match((await model.checkConnection()).message,/已在列表中找到模型.*未生成图片/);
  assert.equal(calls[0].options.method,'GET'); assert.equal(calls[0].options.body,undefined);
  assert.equal(calls[0].url,'http://127.0.0.1:8001/api/v1/models?model=wan2.7-image-pro&page_no=1&page_size=20');
  assert.equal(calls.length,1);
  assert.match((await createImageModel(nativeConfig(),async()=>Response.json({output:{models:[]}})).checkConnection()).message,/未找到/);
  await assert.rejects(createImageModel(nativeConfig(),async()=>Response.json({data:[]})).checkConnection(),/所选协议/);
});

test('native built-in CDN trust covers documented regional and accelerated hosts, never arbitrary OSS, local-only or compatible mode', async () => {
  assert.equal(BAILIAN_IMAGE_DOWNLOAD_HOSTS.length,24);
  assert.equal(new Set(BAILIAN_IMAGE_DOWNLOAD_HOSTS).size,24);
  assert.ok(BAILIAN_IMAGE_DOWNLOAD_HOSTS.includes('dashscope-7c2c.oss-accelerate.aliyuncs.com'));
  assert.ok(BAILIAN_IMAGE_DOWNLOAD_HOSTS.includes('dashscope-64e9.oss-accelerate.aliyuncs.com'));
  assert.ok(BAILIAN_IMAGE_DOWNLOAD_HOSTS.includes('dashscope-result-sh.oss-cn-shanghai.aliyuncs.com'));
  assert.ok(BAILIAN_IMAGE_DOWNLOAD_HOSTS.includes('dashscope-result-wlcb.oss-cn-wulanchabu.aliyuncs.com'));
  for (const baseUrl of ['https://dashscope.aliyuncs.com/api/v1','https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1','https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1']) {
    for (const host of BAILIAN_IMAGE_DOWNLOAD_HOSTS) {
      const calls = [], model = createImageModel(nativeConfig({baseUrl,localOnly:false}),async (url,options)=>{
        calls.push({url,options});return calls.length === 1 ? Response.json({output:{choices:[{message:{content:[{image:`https://${host}/signed.png?Expires=test`}]}}]}}) : new Response(png);
      });
      assert.deepEqual(await model.generate('test'),png);assert.equal(calls[1].options.headers,undefined);
    }
  }
  for (const patch of [{baseUrl:'https://dashscope.aliyuncs.com.evil.example/api/v1',localOnly:false},{baseUrl:'https://proxy.example/api/v1',localOnly:false},{localOnly:true},{baseUrl:'https://dashscope.aliyuncs.com:8443/api/v1',localOnly:false}]) {
    let calls=0;
    await assert.rejects(createImageModel(nativeConfig(patch),async()=>{calls++;return Response.json({output:{choices:[{message:{content:[{image:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.png'}]}}]}});}).generate('test'),/允许范围/);
    assert.equal(calls,1);
  }
  await assert.rejects(createImageModel(config({baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',localOnly:false}),async()=>Response.json({data:[{url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.png'}]})).generate('test'),/允许范围/);
  for (const url of ['https://other-bucket.oss-cn-shanghai.aliyuncs.com/x.png','https://dashscope-ffff.oss-accelerate.aliyuncs.com/x.png','https://dashscope-7c2c.oss-accelerate.aliyuncs.com.evil.example/x.png','http://dashscope-7c2c.oss-accelerate.aliyuncs.com/x.png','https://dashscope-7c2c.oss-accelerate.aliyuncs.com:8443/x.png','https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com.evil.example/x.png','http://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com/x.png','https://dashscope-result-sh.oss-cn-shanghai.aliyuncs.com:8443/x.png','http://127.0.0.1:9999/x.png']) {
    let calls=0;
    await assert.rejects(createImageModel(nativeConfig({baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1',localOnly:false}),async()=>{calls++;return Response.json({output:{choices:[{message:{content:[{image:url}]}}]}});}).generate('test'),/允许范围/);
    assert.equal(calls,1);
  }
});

test('blocked image results report only the host and can retry the download under a new explicit allowlist without another generation', async () => {
  const cfg=config({localOnly:false,baseUrl:'https://api.example/v1'}), calls=[];
  const signed='https://cdn.example/private/secret-prompt.png?Signature=private-signature&api_key=image-only-key';
  const fetchImpl=async(url,options)=>{calls.push({url,options});return options.method==='POST' ? Response.json({data:[{url:signed}]}) : new Response(png);};
  let savedURL;
  await assert.rejects(createImageModel(cfg,fetchImpl).generate('test',url=>{savedURL=url;}),error=>{
    assert.match(error.message,/下载域名：cdn.example/);
    for (const secret of ['private','Signature','image-only-key','secret-prompt']) assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(savedURL,signed);assert.equal(calls.length,1,'blocked result must not be fetched');
  await assert.rejects(createImageModel(cfg,fetchImpl).download(savedURL),/允许范围/);assert.equal(calls.length,1);
  const allowed=createImageModel({...cfg,downloadHosts:'cdn.example'},fetchImpl);
  assert.deepEqual(await allowed.download(savedURL),png);
  assert.equal(calls.filter(call=>call.options.method==='POST').length,1);
  assert.equal(calls[1].options.method,'GET');assert.equal(calls[1].options.headers,undefined);
  assert.equal(calls[1].options.credentials,'omit');assert.equal(calls[1].options.redirect,'error');
  await assert.rejects(createImageModel({...cfg,enabled:false},fetchImpl).download(savedURL),/启用/);
  await assert.rejects(createImageModel({...cfg,localOnly:true},fetchImpl).download(savedURL),/允许范围/);
});

test('download failures retain only valid URL results; download-only retry never sends authorization, retries itself or accepts invalid images', async () => {
  const calls=[],cfg=nativeConfig();let retained;
  const fetchImpl=async(url,options)=>{calls.push({url,options});
    if (options.method==='POST') return Response.json({output:{choices:[{message:{content:[{image:'http://127.0.0.1:8001/result.png'}]}}]}});
    return calls.length===2 ? new Response('private error',{status:503}) : new Response(png);
  };
  await assert.rejects(createImageModel(cfg,fetchImpl).generate('test',url=>{retained=url;}),/下载失败.*503/);
  assert.equal(calls.length,2);assert.ok(retained);
  assert.deepEqual(await createImageModel(cfg,fetchImpl).download(retained),png);
  assert.equal(calls.filter(call=>call.options.method==='POST').length,1);
  assert.ok(calls.filter(call=>call.options.method==='GET').every(call=>call.options.headers===undefined));
  await assert.rejects(createImageModel(cfg,async()=>new Response('<svg>not image</svg>')).download(retained),/仅支持/);
  let callbacks=0;
  await assert.rejects(createImageModel(config(),async()=>Response.json({data:[{url:'file:///secret'}]})).generate('test',()=>{callbacks++;}),/允许范围/);
  assert.equal(callbacks,0);
  let safeHost;
  await assert.rejects(createImageModel(config({apiKey:'private-key'}),async()=>Response.json({data:[{url:'https://private-key.example/x.png'}]})).generate('test',(_url,host)=>{safeHost=host;}),error=>!error.message.includes('private-key'));
  assert.equal(safeHost,'（已隐藏）');
});

test('slow generation does not consume the separate image download timeout budget', async () => {
  const calls = [], cfg = nativeConfig({ timeoutMs: 200 });
  const model = createImageModel(cfg, async (url, options) => {
    calls.push({ url, options });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 120);
      options.signal.addEventListener('abort', () => {
        clearTimeout(timer); reject(new DOMException('timed out', 'TimeoutError'));
      }, { once: true });
    });
    return options.method === 'POST'
      ? Response.json({ output: { choices: [{ message: { content: [{ image: 'http://127.0.0.1:8001/result.png' }] } }] } })
      : new Response(png);
  });
  assert.deepEqual(await model.generate('test'), png);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].options.signal, calls[1].options.signal);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(calls[1].options.signal.aborted, false);
  const timeout = new DOMException('timed out', 'TimeoutError');
  let savedURL;
  await assert.rejects(createImageModel(cfg, async (_url, options) => {
    if (options.method === 'POST') return Response.json({ output: { choices: [{ message: { content: [{ image: 'http://127.0.0.1:8001/result.png' }] } }] } });
    throw timeout;
  }).generate('test', url => { savedURL = url; }), /图片下载超时，未重新生成/);
  assert.ok(savedURL);
});

test('pending result cache is private, bounded, expiring and token-scoped without exposing signed URLs or API keys', () => {
  let clock=1000;const cache=createPendingImageDownloads({now:()=>clock,max:2,ttlMs:100});
  const value={url:'https://cdn.example/x.png?Signature=secret-query',prompt:'教学图',caption:'图注',model:'image-test',error:'下载失败',expectedContent:'private snapshot'};
  const first=cache.put('p1/b1',value), safe=cache.public(first);
  assert.equal(safe.pendingDownload.host,'cdn.example');assert.equal(safe.pendingDownload.expiresAt,1100);
  assert.equal(cache.get('p1/b1','wrong'),null);
  assert.ok(!JSON.stringify(safe).includes('Signature'));assert.ok(!JSON.stringify(safe).includes('secret-query'));assert.ok(!JSON.stringify(safe).includes('private snapshot'));
  cache.drop('p1/b1','wrong');assert.ok(cache.get('p1/b1'));
  cache.put('p1/b2',value);cache.put('p1/b3',value);assert.equal(cache.get('p1/b1'),null);
  const second=cache.get('p1/b2');cache.drop('p1/b2',second.id);assert.equal(cache.get('p1/b2'),null);
  clock=1100;assert.equal(cache.get('p1/b3'),null);
  assert.equal(createPendingImageDownloads().get('p1/b3'),null,'new process cache has no prior signed URLs');
  assert.throws(()=>createPendingImageDownloads({max:0}));
});

test('native errors show only known codes and request UUIDs, and never retry, poll or fall back', async () => {
  const request_id='12345678-abcd-1234-abcd-1234567890ab';
  for (const status of [400,200]) {
    let calls=0;
    await assert.rejects(createImageModel(nativeConfig(),async()=>{calls++;return Response.json({code:'InvalidParameter',message:'secret-key private prompt https://signed.example',request_id},{status});}).generate('test'),error=>{
      assert.match(error.message,/InvalidParameter/);assert.ok(error.message.includes(request_id));assert.ok(!error.message.includes('secret-key'));assert.ok(!error.message.includes('private prompt'));assert.ok(!error.message.includes('signed.example'));return true;
    });
    assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(createImageModel(nativeConfig(),async()=>{calls++;return Response.json({output:{task_id:'upstream-task',task_status:'PENDING'}});}).generate('test'),/异步任务.*未轮询或重新生成/);
  assert.equal(calls,1);
  await assert.rejects(createImageModel(nativeConfig(),async()=>Response.json({output:{choices:[{message:{content:[{text:'no image'}]}}]}})).generate('test'),/output.choices/);
  await assert.rejects(createImageModel(nativeConfig(),async()=>Response.json({code:'secret-key',message:'secret-key',request_id:'secret-key'},{status:403})).generate('test'),error=>!error.message.includes('secret-key'));
});
test('compatible images request one image with no automatic retries; supports Base64 and non-generating model check', async () => {
  const calls = [];
  const model = createImageModel(config(), async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/models') ? {data:[{id:'image-test'}]} : {data:[{b64_json:png.toString('base64')}]});
  });
  assert.deepEqual(await model.generate(image.prompt), png);
  assert.equal(calls[0].url, 'http://127.0.0.1:8001/v1/images/generations');
  assert.deepEqual(JSON.parse(calls[0].options.body), {model:'image-test',prompt:image.prompt,n:1,size:'1024x1024'});
  assert.equal(calls[0].options.headers.Authorization, 'Bearer image-only-key');
  assert.equal(calls[0].options.redirect, 'error');
  assert.match((await model.checkConnection()).message, /未生成图片/);
  assert.equal(calls.length, 2);
  let attempts = 0;
  await assert.rejects(createImageModel(config(), async () => { attempts++; return Response.json({error:'secret-upstream-body'}, {status:401}); }).generate('test'), /密钥无效/);
  assert.equal(attempts, 1);
  await assert.rejects(createImageModel(config({enabled:false}), () => { throw new Error('must not fetch'); }).generate('test'), /启用/);
});
test('URL images require the configured origin or explicit CDN allowlist, omit credentials and API keys on downloads', async () => {
  const calls = [];
  const model = createImageModel(config({localOnly:false,baseUrl:'https://api.example/v1',downloadHosts:'cdn.example'}), async (url, options) => {
    calls.push({url,options});
    return calls.length === 1 ? Response.json({data:[{url:'https://cdn.example/picture.png?signature=test'}]}) : new Response(png);
  });
  assert.deepEqual(await model.generate('test'), png);
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls[1].options.credentials, 'omit'); assert.equal(calls[1].options.redirect, 'error');
  for (const url of ['https://untrusted.example/a','http://localhost:9999/a','file:///tmp/a','http://127.0.0.1:8002/a','https://secret@cdn.example/a']) {
    let attempts = 0;
    await assert.rejects(createImageModel(config(), async () => { attempts++; return Response.json({data:[{url}]}); }).generate('test'), /允许范围/);
    assert.equal(attempts, 1);
  }
  const local = createImageModel(config(), async url => url.endsWith('/images/generations') ? Response.json({data:[{url:'http://127.0.0.1:8001/result.png'}]}) : new Response(png));
  assert.deepEqual(await local.generate('test'), png);
});
test('untrusted, oversized and decompression-bomb images are rejected before decoding or rendering', async () => {
  assert.equal(imageMime(png), 'image/png');
  assert.throws(() => imageMime(Buffer.from('<svg onload="alert(1)"></svg>')), /仅支持/);
  const bomb = Buffer.from(png); bomb.writeUInt32BE(99999, 16); assert.throws(() => imageMime(bomb), /超过 4096/);
  assert.throws(() => imageMime(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /12 MB/);
  await assert.rejects(createImageModel(config(), async () => Response.json({data:[{b64_json:'not valid base64!'}]})).generate('test'), /Base64/);
  await assert.rejects(createImageModel(config(), async () => new Response('<html>bad</html>')).generate('test'), /JSON/);
  await assert.rejects(createImageModel(config(), async () => new Response('x', {headers:{'content-length':MAX_IMAGE_BYTES * 2}})).generate('test'), /过大/);
});
test('image metadata is validated and follows matching text through revision and restoration', () => {
  const content = {text:'原正文',illustration:image,imageProposal:{prompt:image.prompt,caption:image.caption}};
  assert.ok(validBlockContent('reading', content));
  assert.equal(validIllustration({...image,id:'../../secret'}), false);
  assert.equal(validImageSuggestion({needed:false,reason:'文字足够'}), true);
  assert.equal(validImageSuggestion({needed:true,reason:'需要图'}), false);
  const next = revisedContent('reading', content, {text:'新正文'});
  assert.equal(next.illustration, undefined);
  assert.deepEqual(next.revisions[0].illustration, image);
  assert.deepEqual(restoredContent('reading', next).illustration, image);
});
test('content-addressed local assets deduplicate, validate paths and round-trip with current and historic images in backups', async t => {
  const root = await directory(t), assets = createImageStore(root, secrets);
  assert.equal(await assets.put(png), id); assert.equal(await assets.put(png), id);
  assert.deepEqual((await assets.readAsset(id)).bytes, png);
  await assert.rejects(assets.readAsset('../settings.json'), /标识/);
  const state = { blockCourses:{p1:{blocks:[{content:{text:'正文',illustration:image,revisions:[{text:'旧',updated:1,illustration:image}]}}]}} };
  assert.deepEqual(referencedImages(state), [id]);
  const exported = await assets.withAssets(state); assert.equal(exported.imageAssets.length, 1);
  assert.ok(!JSON.stringify(exported).includes('image-only-key'));
  const imported = createImageStore(await directory(t), secrets);
  const stage = await imported.prepareImport(exported); await stage();
  assert.deepEqual((await imported.readAsset(id)).bytes, png);
  await assert.rejects(createImageStore(await directory(t), secrets).prepareImport(state), /缺少/);
  await assert.rejects(imported.prepareImport({...exported,imageAssets:[{id:'0'.repeat(64),data:png.toString('base64')}]}), /校验/);
  await assert.rejects(imported.prepareImport({...exported,imageAssets:[...exported.imageAssets,...exported.imageAssets]}), /重复/);
});
test('SQLite attaches images atomically, rejects stale generations and preserves assets in delete backups', async t => {
  const root = await directory(t), assets = createImageStore(root, secrets);
  const store = await createSqliteStore(root, {withAssets:state => assets.withAssets(state)});
  try {
  const course = store.saveOutline('p1', {intro:'教学示意',blocks:[{type:'reading',title:'输入输出',objective:'理解输入与输出'},{type:'quiz',title:'测验',objective:'检查理解'}]});
  const block = course.blocks[0]; store.saveBlock('p1',block.id,{text:'原正文'});
  await assets.put(png);
  assert.throws(() => store.attachIllustration('p1',block.id,image,JSON.stringify({text:'其他正文'})), /内容已更新/);
  const content = store.attachIllustration('p1',block.id,image,JSON.stringify({text:'原正文'}));
  assert.equal(content.illustration.id,id);
  assert.throws(() => store.attachIllustration('p1',block.id,image,JSON.stringify({text:'原正文'})), /内容已更新/);
  store.reviseBlock('p1',block.id,{text:'新正文'},'原正文');
  assert.equal(store.restoreBlock('p1',block.id,'新正文').illustration.id,id);
  const state = store.exportState(); assert.equal((await assets.withAssets(state)).imageAssets.length,1);
  const another = {...structuredClone(state.plans[0]),id:'another',lessons:state.plans[0].lessons.map(l=>({...l,id:`other-${l.id}`}))};
  store.savePlan(another);
  const deleted = await store.deletePlan(state.plans[0].id);
  const backup = JSON.parse(await readFile(deleted.backupPath,'utf8')); assert.equal(backup.imageAssets[0].id,id);
  assert.deepEqual((await assets.readAsset(id)).bytes,png,'deletion retains assets needed by backups');
  } finally { store.close(); }
});
