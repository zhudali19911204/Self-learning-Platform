import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { demoPlan, demoLessons } from '../public/demo.js';
import { lessonFromBlocks, validOutline, validBlockContent, validBlockSpec, blockGenerationContext, revisedContent, restoredContent } from '../public/blocks.js';
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer } from '../public/markdown.js';
import { validQuestionnaire, validClarification, learningBriefFrom } from '../public/planning.js';
import { questionnaire, clarification } from '../test-support/planning.mjs';
import { validIllustration, validImageProposal } from '../public/illustrations.js';
const DOMPurify = createDOMPurify(new JSDOM('').window);
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .* from '\.\/[^']+';$/gm, '');

test('desktop image suggestions never generate without confirmation; failed generation keeps text, prompt and current image', async () => {
  let generationCalls = 0;
  const image = {id:'a'.repeat(64),prompt:'旧图',caption:'旧图注',model:'image-test',created:1};
  const bridge = {
    load: async () => ({state:null,settings:{},status:{mode:'ai'},dataDirectory:'test',imageSettings:{enabled:true}}),
    generateIllustration: async value => {
      generationCalls++;
      if (generationCalls === 1) throw new Error('模拟生成失败');
      return {text:value.expectedText,illustration:{...image,id:'b'.repeat(64),prompt:value.prompt,caption:value.caption}};
    }
  };
  const app = harness(null, null, bridge); await Promise.resolve();
  app.run(`state.blockCourses = {p1:{intro:'测试',blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文',illustration:${JSON.stringify(image)}}},{id:'b2',type:'quiz',title:'测验',objective:'理解',content:null}]}}; activeLesson='p1';page='study';lessonTab='read';render()`);
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  assert.equal(generationCalls,0);
  assert.equal(app.node('#illustration-dialog').open,true);
  assert.match(app.node('#illustration-dialog').innerHTML,/可能计费/);
  await app.submit('illustration-form',{prompt:'新的配图',caption:'新的图注'});
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.illustration.id'),image.id);
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.text'),'原正文');
  assert.match(app.node('#illustration-error').textContent,/模拟生成失败/);
  assert.equal(app.run('illustrationDraft.prompt'),'新的配图');
  assert.equal(app.run('illustrationBusy'),false);
  await app.submit('illustration-form',{prompt:'新的配图',caption:'<script>caption</script>'});
  assert.equal(generationCalls,2);
  assert.equal(app.node('#illustration-dialog').open,false);
  assert.match(app.node('#app').innerHTML,/src="\/course-images\/b{64}"/);
  assert.ok(!app.node('#app').innerHTML.includes('<script>caption</script>'));
});
test('repeated image confirmation cannot clear the busy state or start another paid request', async () => {
  let calls=0,finish;
  const image={id:'a'.repeat(64),prompt:'示意',caption:'图注',model:'image',created:1};
  const bridge={load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:true}}),generateIllustration:async value=>{calls++;await new Promise(resolve=>{finish=resolve;});return {text:value.expectedText,illustration:image};}};
  const app=harness(null,null,bridge);await Promise.resolve();
  app.run(`state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文',imageProposal:{prompt:'示意',caption:'图注'}}}]}}`);
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  const pending=app.submit('illustration-form',{prompt:'示意',caption:'图注'});
  await app.submit('illustration-form',{prompt:'示意',caption:'图注'});
  assert.equal(calls,1);assert.equal(app.run('illustrationBusy'),true);
  finish();await pending;assert.equal(app.run('illustrationBusy'),false);
});

test('pending image downloads preserve the old image and reopen as download-only, with no repeated generation or analysis', async () => {
  let generationCalls=0,downloadCalls=0,analysisCalls=0,retained=null;
  const old={id:'a'.repeat(64),prompt:'旧图',caption:'旧图注',model:'image',created:1};
  const pending={pendingDownload:{id:'download-token',host:'cdn.example',expiresAt:9999},prompt:'新图',caption:'新图注',error:'图片下载地址不在允许范围内。下载域名：cdn.example。'};
  const bridge={load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:true}}),getPendingIllustration:async()=>retained,
    suggestIllustration:async()=>{analysisCalls++;throw new Error('must not analyse again');},
    generateIllustration:async()=>{generationCalls++;retained=pending;return pending;},
    retryIllustrationDownload:async value=>{downloadCalls++;assert.equal(value.pendingId,'download-token');return downloadCalls===1 ? {...pending,error:'仍未允许下载域名'} : {text:'原正文',illustration:{...old,id:'b'.repeat(64),prompt:pending.prompt,caption:pending.caption}};}
  };
  const app=harness(null,null,bridge);await Promise.resolve();
  app.run(`state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文',illustration:${JSON.stringify(old)}}}]}}`);
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  await app.submit('illustration-form',{prompt:'新图',caption:'新图注'});
  assert.equal(generationCalls,1);assert.equal(app.run('state.blockCourses.p1.blocks[0].content.illustration.id'),old.id);
  assert.equal(app.node('#illustration-dialog').open,true);assert.match(app.node('#illustration-dialog').innerHTML,/仅重试下载（不重新生成）/);
  assert.match(app.node('#illustration-dialog').innerHTML,/readonly/);assert.match(app.node('#illustration-dialog').innerHTML,/cdn.example/);
  await app.run("action('close-illustration',{dataset:{}})");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  assert.equal(analysisCalls,0);assert.equal(app.run('illustrationDraft.prompt'),'新图');
  await app.submit('illustration-form',{prompt:'新图',caption:'新图注'});
  assert.equal(generationCalls,1);assert.equal(downloadCalls,1);
  assert.match(app.node('#illustration-dialog').innerHTML,/仍未允许下载域名/);
  await app.submit('illustration-form',{prompt:'新图',caption:'新图注'});
  assert.equal(generationCalls,1);assert.equal(downloadCalls,2);assert.equal(app.node('#illustration-dialog').open,false);
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.illustration.id'),'b'.repeat(64));
});

test('download-only confirmation is single-flight and errors cannot turn into a new paid generation', async () => {
  let downloads=0,finish,generations=0;
  const pending={pendingDownload:{id:'download-token',host:'cdn.example',expiresAt:9999},prompt:'教学图',caption:'图注',error:'下载失败'};
  const app=harness(null,null,{load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:true}}),getPendingIllustration:async()=>pending,
    generateIllustration:async()=>{generations++;throw new Error('must not generate');},
    retryIllustrationDownload:async()=>{downloads++;await new Promise(resolve=>{finish=resolve;});throw new Error('待下载结果已过期，未重新生成');}});await Promise.resolve();
  app.run("state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文'}}]}}");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  const inFlight=app.submit('illustration-form',{prompt:'教学图',caption:'图注'});
  await app.submit('illustration-form',{prompt:'教学图',caption:'图注'});
  assert.equal(downloads,1);assert.equal(app.run('illustrationBusy'),true);
  finish();await inFlight;assert.equal(generations,0);assert.equal(app.run('illustrationBusy'),false);
  assert.match(app.node('#illustration-error').textContent,/过期/);
});

test('discarding a pending download needs confirmation and never generates until the next explicit form submission', async () => {
  let discarded=0,generations=0;
  const pending={pendingDownload:{id:'download-token',host:'cdn.example',expiresAt:9999},prompt:'教学图',caption:'图注',error:'下载失败'};
  const app=harness(null,null,{load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:true}}),getPendingIllustration:async()=>pending,
    discardIllustrationDownload:async()=>{discarded++;},generateIllustration:async()=>{generations++;throw new Error('模拟生成失败');}});await Promise.resolve();
  app.run("state.blockCourses={p1:{blocks:[{id:'b1',type:'reading',title:'知识',objective:'理解',content:{text:'原正文'}}]}}");
  await app.run("action('request-illustration',{dataset:{id:'p1',block:'b1'}})");
  app.run('window.confirm=()=>false');await app.run("action('discard-illustration-download',{dataset:{}})");assert.equal(discarded,0);
  app.run('window.confirm=()=>true');await app.run("action('discard-illustration-download',{dataset:{}})");
  assert.equal(discarded,1);assert.equal(generations,0);assert.equal(app.run('illustrationDraft.pendingDownload'),undefined);
  assert.match(app.node('#illustration-dialog').innerHTML,/确认生成图片（可能计费）/);
  await app.submit('illustration-form',{prompt:'教学图',caption:'图注'});assert.equal(generations,1);
});

test('native image settings submit the protocol and automatic format while keeping keys out of the rendered form', async () => {
  const saves=[];
  const bridge={load:async()=>({settings:{},status:{mode:'ai'},imageSettings:{enabled:false}}),saveImageSettings:async input=>{saves.push(input);const {apiKey,keyAction,...safe}=input;return {...safe,hasApiKey:true};}};
  const app=harness(null,null,bridge);await Promise.resolve();
  await app.submit('image-settings-form',{enabled:'on',protocol:'dashscope',model:'wan2.7-image-pro',baseUrl:'https://dashscope.aliyuncs.com/api/v1',keyAction:'replace',apiKey:'secret-image-key',size:'1024x1024',timeout:'180',downloadHosts:''});
  assert.equal(saves.length,1);assert.equal(saves[0].protocol,'dashscope');assert.equal(saves[0].responseFormat,'auto');
  assert.equal(saves[0].localOnly,false);assert.equal(saves[0].apiKey,'secret-image-key');
  const html=app.run('imageSettingsPanel()');
  assert.match(html,/value="dashscope" selected/);assert.match(html,/id="image-response-format"[^>]+disabled/);
  assert.match(html,/Token Plan/);assert.ok(!html.includes('secret-image-key'));
});

test('changing image protocol preserves the draft and requires saving before a connection check', async () => {
  const app=harness(null,null,{load:async()=>({settings:{},status:{mode:'ai'}})});await Promise.resolve();
  app.node('#image-model-url').value='https://old.example/compatible-mode/v1';
  app.node('#image-model-name').value='wan2.7-image-pro';app.node('#image-model-key').value='old-draft-key';
  app.node('#image-settings-form [name=localOnly]').checked=false;
  app.change('image-protocol','dashscope');
  assert.equal(app.node('#image-model-url').value,'https://old.example/compatible-mode/v1');
  assert.equal(app.node('#image-model-name').value,'wan2.7-image-pro');
  assert.equal(app.node('#image-model-key').value,'');assert.equal(app.node('#image-key-action').value,'replace');
  assert.equal(app.node('#image-response-format').disabled,true);assert.equal(app.node('#image-response-format').value,'auto');
  assert.equal(app.node('[data-action="check-image-connection"]').disabled,true);
  assert.match(app.node('#image-protocol-hint').textContent,/\/api\/v1/);
  app.change('image-protocol','compatible');assert.equal(app.node('#image-response-format').disabled,false);
});

test('saving an aliased native image root explains the same-provider adjustment rather than forbidding Token Plan', async () => {
  const saves=[],bridge={load:async()=>({settings:{},status:{mode:'ai'}}),saveImageSettings:async input=>{
    saves.push(input);const {apiKey,keyAction,...safe}=input;return {...safe,baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1',hasApiKey:true};
  }};
  const app=harness(null,null,bridge);await Promise.resolve();
  await app.submit('image-settings-form',{enabled:'on',protocol:'dashscope',model:'wan2.7-image-pro',baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',keyAction:'replace',apiKey:'sk-sp-test-only',size:'1024x1024',timeout:'180',downloadHosts:''});
  assert.equal(saves.length,1);assert.equal(saves[0].apiKey,'sk-sp-test-only');
  assert.match(app.run('imageConnectionResult'),/已保存.*同域名.*未更换服务商或密钥/);
  const html=app.run('imageSettingsPanel()');assert.match(html,/此提醒不阻止保存/);assert.match(html,/token-plan.cn-beijing.maas.aliyuncs.com\/api\/v1/);
  assert.ok(!html.includes('sk-sp-test-only'));
});

test('image settings save failures expose the cause in both notices and preserve the previous configuration and draft', async () => {
  const safe={enabled:true,protocol:'compatible',model:'old-model',baseUrl:'http://localhost/v1',size:'1024x1024',responseFormat:'auto',timeoutMs:180000,localOnly:true,downloadHosts:''};
  const app=harness(null,null,{load:async()=>({settings:{},status:{mode:'ai'},imageSettings:safe}),saveImageSettings:async()=>{throw new Error('云端须关闭仅本机选项');}});await Promise.resolve();
  app.node('#image-model-key').value='draft-key';
  await app.submit('image-settings-form',{enabled:'on',protocol:'dashscope',model:'wan2.7-image-pro',baseUrl:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',localOnly:'on',keyAction:'replace',apiKey:'draft-key',size:'1024x1024',timeout:'180',downloadHosts:''});
  assert.match(app.node('#image-settings-error').textContent,/仅本机/);
  assert.match(app.node('#image-connection-result').textContent,/保存失败.*仅本机/);
  assert.equal(app.node('[data-action="check-image-connection"]').disabled,true);
  assert.equal(app.run('imageSettings.model'),'old-model');assert.equal(app.node('#image-model-key').value,'draft-key');
});

// This harness checks application state transitions, not browser rendering.
function harness(saved, fetchImpl, desktopBridge) {
  const nodes = new Map(), listeners = new Map(), storage = new Map(saved ? [['learnflow.v1', saved]] : []);
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', textContent: '', open: false, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, classList: { add() {}, remove() {} }, scrollIntoView() {}, focus() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(selector);
  };
  const context = vm.createContext({
    demoPlan, demoLessons, lessonFromBlocks, validOutline, validBlockContent, validBlockSpec, blockGenerationContext, revisedContent, restoredContent, Marked, DOMPurify, createMarkdownRenderer, validQuestionnaire, validClarification, learningBriefFrom, validIllustration, validImageProposal, structuredClone, crypto: webcrypto, AbortSignal,
    document: { querySelector: node, addEventListener(name, listener) { listeners.set(name, listener); } },
    localStorage: { get length() { return storage.size; }, key: index => [...storage.keys()][index] ?? null, getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { learnflowDesktop: desktopBridge, scrollY: 0, scrollTo({ top }) { this.scrollY = top; }, confirm: () => true }, setTimeout: () => 1, clearTimeout() {},
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ mode: 'demo', model: null }) })),
    FormData: class { constructor(form) { this.values = form.values; } get(key) { return this.values[key] ?? null; } getAll(key) { const value = this.values[key]; return value === undefined ? [] : Array.isArray(value) ? value : [value]; } }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  async function submit(id, values, lessonId, blockId) {
    const button = { innerHTML: 'Submit', disabled: false, isConnected: false };
    await listeners.get('submit')({ preventDefault() {}, target: { id, values, dataset: { id: lessonId, block: blockId }, querySelector: () => button } });
  }
  const input = (id, value, dataset = {}) => {
    node('#' + id).value = value;
    listeners.get('input')({ target: { id, value, dataset } });
  };
  const change = (id,value) => listeners.get('change')({target:{id,value}});
  return { run, submit, input, change, node, storage };
}
test('learning loop: incorrect answers, retry, completion, Wiki creation, edit and persistence', async () => {
  const app = harness();
  app.run("openLesson('p1', 'quiz')");
  await app.submit('quiz-form', { q0: '0', q1: '0' }, 'p1');
  assert.equal(app.run('state.progress.p1.completed'), false);
  assert.equal(app.run('state.progress.p1.lastScore'), 0);
  assert.equal(app.run('state.progress.p1.attempts'), 1);
  await assert.rejects(app.run("createNote('p1')"), /通过/);
  await app.submit('quiz-form', { q0: '1', q1: '1' }, 'p1');
  assert.equal(app.run('state.progress.p1.completed'), true);
  assert.equal(app.run('state.progress.p1.bestScore'), 100);
  app.run("state.reflections.p1 = '我理解了字符串与计算表达式的区别';");
  await app.run("createNote('p1')");
  assert.equal(app.run('state.notes.length'), 1);
  assert.match(app.run('state.notes[0].content'), /我理解了字符串/);
  await app.run("createNote('p1')");
  assert.equal(app.run('state.notes.length'), 1, 'repeated clicks must not duplicate cards');
  const id = app.run('state.notes[0].id');
  await app.submit('note-form', { title: '我的输入输出笔记', summary: '用自己的话理解 print', content: 'print 会显示内容，字符串原样显示。', tags: 'Python，输入输出，Python' }, id);
  assert.equal(app.run('state.notes[0].title'), '我的输入输出笔记');
  assert.equal(app.run('state.notes[0].tags.length'), 2);
  const restored = harness(app.storage.get('learnflow.v1'));
  assert.equal(restored.run('state.progress.p1.completed'), true);
  assert.equal(restored.run('state.notes[0].title'), '我的输入输出笔记');
  await app.submit('quiz-form', { q0: '0', q1: '0' }, 'p1');
  assert.equal(app.run('state.progress.p1.completed'), true, 'review mistakes do not delete prior mastery');
  assert.equal(app.run('state.progress.p1.bestScore'), 100);
  assert.equal(app.run('state.progress.p1.lastScore'), 0);
});
test('new learning clarifies before planning, preserves answers on failure, and persists the confirmed brief', async () => {
  const calls = [];
  let failPlan = true;
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok:true, json:async () => ({mode:'ai'}) };
    const data = JSON.parse(options.body); calls.push({url,data});
    if (url === '/api/plan-clarify') return {ok:true,json:async () => questionnaire};
    if (failPlan) return {ok:false,json:async () => ({error:'测试模型暂时不可用'})};
    return {ok:true,json:async () => ({...structuredClone(demoPlan),id:'new-route',source:'ai',goal:data.goal,learningBrief:learningBriefFrom(data.clarification),lessons:demoPlan.lessons.map((lesson,index) => ({...lesson,id:`new-${index}`}))})};
  });
  app.run("status = {mode:'ai'}; planner()");
  await app.submit('plan-form', {goal:'我想用 Python 提高效率',level:'零基础',daily:'25',days:'14'});
  assert.equal(app.run('plannerDraft.step'), 'questions');
  assert.equal(app.run('state.plans.length'), 1, 'no route exists before confirmation');
  assert.match(app.node('#planner').innerHTML, /type="checkbox"/);
  assert.match(app.node('#planner').innerHTML, /还不确定/);
  await app.submit('clarification-form', {q1:'o1'});
  assert.equal(app.run('plannerDraft.step'), 'questions');
  assert.match(app.node('#planner').innerHTML, /请回答每个问题/);
  await app.submit('clarification-form', {q1:'o1',q2:['o1','o2'],'detail-q1':'先预览，再执行'});
  assert.equal(app.run('plannerDraft.step'), 'review');
  assert.equal(calls.length, 1, 'review itself must not call the model');
  await app.submit('plan-confirm-form', {notes:'不学习网页开发'});
  assert.equal(app.run('plannerDraft.step'), 'review');
  assert.equal(app.run('plannerDraft.notes'), '不学习网页开发');
  assert.match(app.node('#planner').innerHTML, /测试模型暂时不可用/);
  assert.equal(app.run('plannerBusy'), false);
  failPlan = false;
  await app.submit('plan-confirm-form', {notes:'不学习网页开发'});
  assert.equal(app.run('page'), 'routes');
  assert.equal(app.node('#planner').open, false);
  assert.equal(app.run('state.plans.length'), 2);
  assert.equal(calls.at(-1).data.clarification.answers[0].detail, '先预览，再执行');
  const restored = harness(app.storage.get('learnflow.v1'));
  assert.equal(restored.run('plan().learningBrief.notes'), '不学习网页开发');
  assert.match(app.node('#app').innerHTML, /查看定制需求与回答/);
});
test('questionnaire retries keep the goal; returning to edit invalidates answers only when input changes', async () => {
  let calls = 0, failQuestionnaire = true;
  const app = harness(null, async (url) => {
    if (url === '/api/status') return {ok:true,json:async () => ({mode:'ai'})};
    calls++;
    return failQuestionnaire ? {ok:false,json:async () => ({error:'问卷生成失败'})} : {ok:true,json:async () => questionnaire};
  });
  app.run("status = {mode:'ai'}; planner()");
  const values = {goal:'我想学 Python',level:'零基础',daily:'25',days:'14'};
  await app.submit('plan-form', values);
  assert.equal(app.run('plannerDraft.goal'), values.goal);
  assert.equal(app.run('plannerDraft.step'), 'goal');
  failQuestionnaire = false;
  await app.submit('plan-form', values);
  app.node('#clarification-form').values = {q1:'o1',q2:'unsure'};
  await app.run("action('planner-back',{dataset:{}})");
  await app.submit('plan-form', values);
  assert.equal(calls, 2, 'unchanged inputs reuse the same questionnaire and answers');
  assert.equal(app.run('plannerDraft.answers[1].optionIds[0]'), 'unsure');
  await app.run("action('planner-back',{dataset:{}})");
  await app.submit('plan-form', {...values,goal:'我想学数据分析'});
  assert.equal(calls, 3);
  assert.equal(app.run('plannerDraft.answers.length'), 0);
});
test('in-flight clarification prevents duplicate requests and closing; model question text cannot inject controls', async () => {
  let resolveQuestionnaire, calls = 0;
  const app = harness(null, async url => {
    if (url === '/api/status') return {ok:true,json:async () => ({mode:'ai'})};
    calls++;
    return new Promise(resolve => { resolveQuestionnaire = resolve; });
  });
  app.run("status = {mode:'ai'}; planner()");
  const values = {goal:'想学自动化',level:'零基础',daily:'25',days:'14'};
  const pending = app.submit('plan-form',values);
  assert.equal(app.run('plannerBusy'),true);
  await app.submit('plan-form',values);
  await app.run("action('close-planner',{dataset:{}})");
  assert.equal(app.node('#planner').open,true);
  assert.equal(calls,1);
  const malicious=structuredClone(questionnaire);
  malicious.questions[0].question='<button data-action="delete-plan">点击删除</button>';
  resolveQuestionnaire({ok:true,json:async () => malicious});
  await pending;
  assert.equal(app.run('plannerBusy'),false);
  assert.doesNotMatch(app.node('#planner').innerHTML,/<button data-action="delete-plan">/);
  assert.match(app.node('#planner').innerHTML,/&lt;button/);
});
test('AI course expands from outline to independently generated blocks', async () => {
  const outline = { intro: '循序学习', blocks: [{ type: 'reading', title: '概念', objective: '理解' }, { type: 'quiz', title: '练习', objective: '检验' }] };
  const calls = [], payloads = [];
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    calls.push(url); payloads.push(JSON.parse(options.body));
    return { ok: true, json: async () => url.endsWith('lesson-outline') ? outline : { text: '这一块的正文' } };
  });
  app.run("state.plans[0].source = 'ai'; state.plans[0].lessons[0].id = 'custom-1'; state.lessons = {}; activeLesson = 'custom-1'; page = 'study'; render()");
  app.run(`state.plans[0].learningBrief = ${JSON.stringify(learningBriefFrom(clarification))}`);
  await app.run("action('generate-lesson', {dataset:{id:'custom-1'}})");
  assert.equal(app.run('state.blockCourses["custom-1"].blocks.length'), 2);
  assert.match(app.node('#app').innerHTML, /生成这一块/);
  const blockId = app.run('state.blockCourses["custom-1"].blocks[0].id');
  await app.run(`action('generate-block', {dataset:{id:'custom-1', block:'${blockId}'}})`);
  assert.equal(app.run('state.blockCourses["custom-1"].blocks[0].content.text'), '这一块的正文');
  assert.deepEqual(calls, ['/api/lesson-outline', '/api/lesson-block']);
  assert.equal(payloads[0].route.length, demoPlan.lessons.length);
  assert.equal(payloads[0].lessonPosition, 1);
  assert.equal(payloads[1].sequence.position, 1);
  assert.equal(payloads[1].outline.length, 2);
  assert.deepEqual(payloads[0].learningBrief,learningBriefFrom(clarification));
  assert.deepEqual(payloads[1].learningBrief,payloads[0].learningBrief);
  assert.match(app.node('#app').innerHTML, /这一块的正文/);
});

test('the persistent lesson Q&A shortcut opens the current course in both lesson formats', () => {
  const app = harness();
  app.run("openLesson('p1')");
  assert.match(app.node('#app').innerHTML, /data-action="quick-ask"/);
  assert.equal(app.run('lessonTab'), 'read');
  app.run("action('quick-ask', { dataset: {} })");
  assert.equal(app.run('lessonTab'), 'chat');
  assert.match(app.node('#app').innerHTML, /class="study-chat"/);
  assert.match(app.node('#app').innerHTML, /data-action="quick-ask"/);
  app.run("state.blockCourses.p1 = {intro:'分步课程',blocks:[{id:'reading-1',type:'reading',title:'讲解',objective:'理解',content:null},{id:'quiz-1',type:'quiz',title:'练习',objective:'检验',content:null}]}; openLesson('p1')");
  assert.match(app.node('#app').innerHTML, /data-action="quick-ask"/);
  app.run("action('quick-ask', { dataset: {} })");
  assert.equal(app.run('lessonTab'), 'chat');
  assert.match(app.node('#app').innerHTML, /当前课程的 AI 答疑/);
});
test('returning from Q&A restores the reading position for both lesson formats and tab entry', () => {
  const app = harness();
  app.run("openLesson('p1')");
  app.run('window.scrollY = 742');
  app.run("action('quick-ask', { dataset: {} })");
  assert.match(app.node('#app').innerHTML, /data-action="back-to-reading"/);
  app.run('window.scrollY = 0');
  app.run("action('back-to-reading', { dataset: {} })");
  assert.equal(app.run('lessonTab'), 'read');
  assert.equal(app.run('window.scrollY'), 742);

  app.run("state.blockCourses.p1 = {intro:'分步课程',blocks:[{id:'reading-1',type:'reading',title:'讲解',objective:'理解',content:null}]}; openLesson('p1')");
  assert.equal(app.run('readingReturn'), null, 'opening a lesson clears the previous return position');
  app.run('window.scrollY = 386');
  app.run("action('lesson-tab', { dataset: { tab: 'chat' } })");
  app.run('window.scrollY = 0');
  app.run("action('lesson-tab', { dataset: { tab: 'read' } })");
  assert.equal(app.run('window.scrollY'), 386);
});
test('block generation carries bounded nearby outline and prior teaching context', () => {
  const blocks = Array.from({ length: 45 }, (_, index) => ({ id: `block-${index}`, type: 'reading', title: `模块 ${index}`, objective: `目标 ${index}`, content: index < 30 ? { text: '概念解释'.repeat(400) } : null }));
  const context = blockGenerationContext({ intro: '课程导语'.repeat(800), blocks }, 'block-30');
  assert.equal(context.outline.length, 25);
  assert.equal(context.previous.length, 3);
  assert.ok(context.previous.every(item => item.excerpt.length <= 1000));
  assert.equal(context.intro.length, 2000);
  assert.deepEqual(context.sequence, { position: 31, total: 45 });
  assert.equal(context.outline[0].title, '模块 18');
  assert.equal(context.outline.at(-1).title, '模块 42');
});

test('teaching units pair adjacent examples and regenerate only the requested block with recoverable history', async () => {
  const payloads = [];
  let fail = false;
  const app = harness(null, async (url, options) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai' }) };
    payloads.push(JSON.parse(options.body));
    return { ok: !fail, json: async () => fail ? { error: '模型暂时不可用' } : { text: '用收支表逐步解释后的正文' } };
  });
  app.run(`state.blockCourses = { p1: {intro: '课程导语', blocks: [
    {id: 'reading-1', type: 'reading', title: '理解现金流', objective: '理解概念', content: {text: '原始讲解'}},
    {id: 'example-1', type: 'example', title: '一张收支表', objective: '应用概念', content: {text: '原始案例'}},
    {id: 'quiz-1', type: 'quiz', title: '检验理解', objective: '独立回答', content: null}
  ]}}; state.progress.p1 = {completed:true}; state.notes = [{id:'note-1',lessonId:'p1',title:'现金流',content:'原Wiki',tags:[],updated:1}]; page = 'study'; activeLesson = 'p1'; status = {mode:'ai'}; render();`);
  const html = app.node('#app').innerHTML;
  assert.match(html, /<article class="teaching-unit"[^>]*>.*知识讲解.*原始讲解.*配套案例.*原始案例.*<\/article>/s);
  assert.equal((html.match(/class="teaching-unit"/g) || []).length, 1);
  assert.ok(html.indexOf('</article>') < html.indexOf('data-block-id="quiz-1"'));
  await app.run("action('request-revision', {dataset:{id:'p1',block:'reading-1'}})");
  assert.equal(app.node('#revise-block-dialog').open, true);
  assert.match(app.node('#revise-block-dialog').innerHTML, /你的具体要求/);
  assert.match(app.node('#revise-block-dialog').innerHTML, /普通表格/);
  assert.doesNotMatch(app.node('#revise-block-dialog').innerHTML, /流程图|架构图|数据图|柱状图/);
  await app.run("action('markdown-revision-preset', {dataset:{}})");
  assert.match(app.node('#revision-request').value, /请仅优化.*Markdown/);
  await app.submit('revision-form', { request: '请用收支表一步步解释' }, 'p1', 'reading-1');
  assert.equal(payloads[0].revisionRequest, '请用收支表一步步解释');
  assert.equal(payloads[0].currentExcerpt, '原始讲解');
  assert.equal(payloads[0].related[0].excerpt, '原始案例');
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.text'), '用收支表逐步解释后的正文');
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.text'), '原始案例');
  assert.equal(app.run('state.progress.p1.completed'), true);
  assert.equal(app.run('state.notes[0].content'), '原Wiki');
  assert.equal(app.node('#revise-block-dialog').open, false);
  const restoredApp = harness(app.storage.get('learnflow.v1'));
  assert.equal(restoredApp.run('state.blockCourses.p1.blocks[0].content.revisions[0].text'), '原始讲解');
  await app.run("action('restore-block', {dataset:{id:'p1',block:'reading-1'}})");
  assert.equal(app.run('state.blockCourses.p1.blocks[0].content.text'), '原始讲解');
  fail = true;
  await app.run("action('request-revision', {dataset:{id:'p1',block:'example-1'}})");
  await app.submit('revision-form', { request: '改成家庭日常支出的案例' }, 'p1', 'example-1');
  assert.equal(app.run('state.blockCourses.p1.blocks[1].content.text'), '原始案例');
  assert.equal(app.node('#revise-block-dialog').open, true);
  assert.match(app.node('#revision-error').textContent, /模型暂时不可用/);
  assert.equal(app.run('revisionBusy'), false);
});

test('revision history is bounded, validated and restored in order', () => {
  let content = { text: '初始正文' };
  for (let index = 1; index <= 12; index++) content = revisedContent('reading', content, { text: `第 ${index} 版` }, index);
  assert.equal(content.revisions.length, 10);
  assert.equal(content.revisions[0].text, '第 2 版');
  content = restoredContent('reading', content);
  assert.equal(content.text, '第 11 版');
  assert.equal(content.revisions.length, 9);
  assert.equal(restoredContent('reading', content).text, '第 10 版');
  assert.equal(validBlockContent('reading', { text: '正文', revisions: [{ text: '', updated: 1 }] }), false);
  assert.equal(validBlockContent('reading', { text: '正文', revisions: Array(11).fill({text:'旧版',updated:1}) }), false);
  assert.throws(() => revisedContent('practice', {text:'任务'}, {text:'新任务'}), /只能重新生成/);
  assert.throws(() => restoredContent('reading', {text:'正文'}), /没有可恢复/);
});
test('existing routes are categorized locally; deletion removes only the selected route and can be restored', async () => {
  const app = harness();
  assert.equal(app.run("categoryFor({title:'GitHub 中文实践路线', goal:'', description:'', lessons:[]})"), '开发工具');
  assert.equal(app.run("categoryFor({title:'Power BI DAX 基础', goal:'', description:'', lessons:[]})"), '数据分析');
  assert.equal(app.run("categoryFor({title:'LLM 基本原理', goal:'', description:'', lessons:[]})"), 'AI 与大模型');
  app.run("const extra = structuredClone(demoPlan); extra.id = 'data-route'; extra.title = 'Power BI DAX 基础'; extra.source = 'ai'; extra.lessons.forEach((lesson, index) => { lesson.id = 'data-' + index }); state.plans.push(extra); state.active = extra.id; state.progress['data-0'] = {completed:true, attempts:1, lastScore:100, bestScore:100, lastAnswers:[0]}; page = 'routes'; render()");
  assert.match(app.node('#app').innerHTML, /数据分析/);
  assert.match(app.node('#app').innerHTML, /编程开发/);
  await app.run("action('delete-plan', {dataset:{id:'data-route'}})");
  assert.equal(app.run('state.plans.length'), 1);
  assert.equal(app.run('state.active'), demoPlan.id);
  assert.equal(app.run("state.progress['data-0']"), undefined);
  assert.ok([...app.storage.keys()].some(key => key.startsWith('learnflow.before-delete.')));
  await app.run("action('restore-deleted-plan', {dataset:{}})");
  assert.equal(app.run('state.plans.length'), 2);
  assert.equal(app.run("state.progress['data-0'].completed"), true);
});
test('all pages render with empty and populated state; untrusted content is escaped', async () => {
  const app = harness();
  for (const page of ['home', 'routes', 'study', 'practice', 'wiki', 'settings']) {
    app.run(`navigate('${page}')`); assert.ok(app.node('#app').innerHTML.length > 2000);
  }
  app.run("state.reflections.p1 = '<script>alert(1)</script>'; state.progress.p1 = { completed: true };");
  await app.run("createNote('p1')");
  assert.ok(!app.node('#app').innerHTML.includes('<script>'));
  assert.ok(app.node('#app').innerHTML.includes('&lt;script&gt;'));
  for (const page of ['home', 'routes', 'study', 'practice', 'wiki', 'settings']) app.run(`navigate('${page}')`);
});
test('corrupt saved data is preserved instead of silently overwritten', () => {
  const app = harness('{broken');
  app.run('save()');
  assert.equal(app.storage.get('learnflow.v1'), '{broken');
  assert.match(app.run('storageWarning'), /不会覆盖/);
});
test('offline Wiki retrieval finds relevant notes and labels results honestly', async () => {
  const app = harness();
  app.run("state.progress.p1 = { completed: true }; status = { mode: 'demo' };");
  await app.run("createNote('p1')");
  await app.submit('ask-form', { question: 'print' });
  assert.equal(app.run('answer.demo'), true);
  assert.equal(app.run('answer.citations.length'), 1);
  await app.submit('ask-form', { question: 'nonexistentkeyword' });
  assert.equal(app.run('answer.citations.length'), 0);
});

test('lesson Q&A keeps per-lesson context across turns, persists locally and escapes answers', async () => {
  const requests = [];
  const app = harness(undefined, async (url, init) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai', timeoutMs: 120000 }) };
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ answer: requests.length === 1 ? '先看 print 的输入。' : '<script>bad</script> 再看输出。' }) };
  });
  app.run("status = { mode: 'ai' }; openLesson('p1', 'chat')");
  assert.match(app.node('#app').innerHTML, /AI 答疑/);
  await app.submit('lesson-ask-form', { question: 'print 是什么？' }, 'p1');
  await app.submit('lesson-ask-form', { question: '能再举个例子吗？' }, 'p1');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/api/lesson-ask');
  assert.equal(requests[0].body.lesson.intro, demoLessons.p1.intro);
  assert.equal(requests[1].body.history.length, 2);
  assert.equal(requests[1].body.history[1].content, '先看 print 的输入。');
  assert.equal(app.run('state.chats.p1.length'), 4);
  assert.ok(!app.node('#app').innerHTML.includes('<script>bad</script>'));
  const restored = harness(app.storage.get('learnflow.v1'));
  restored.run("openLesson('p1', 'chat')");
  assert.equal(restored.run('chatFor("p1").length'), 4);
  assert.equal(restored.run('chatFor("p2").length'), 0);
});

test('lesson Q&A and grounded Wiki answers render Markdown while preserving raw stored messages and citations', async () => {
  const response = '## 回答要点\n\n**先理解输入**，再看输出。\n\n1. 阅读代码\n2. 检查结果\n\n```python\nprint("你好")\n```';
  const app = harness(null, async (url) => ({ ok: true, json: async () => url === '/api/status' ? {mode:'ai'} : { answer:response, citations:['note-1'] } }));
  app.run("status={mode:'ai'}; openLesson('p1','chat')");
  await app.submit('lesson-ask-form', {question:'**print** 是什么？'}, 'p1');
  const chatDOM = new JSDOM(app.node('#app').innerHTML).window.document;
  assert.equal(chatDOM.querySelector('.from-ai .markdown-content h3').textContent, '回答要点');
  assert.equal(chatDOM.querySelector('.from-ai .markdown-content strong').textContent, '先理解输入');
  assert.equal(chatDOM.querySelectorAll('.from-ai ol > li').length, 2);
  assert.ok(chatDOM.querySelector('.from-ai pre code'));
  assert.equal(chatDOM.querySelector('.from-user .markdown-content strong').textContent, 'print');
  assert.equal(app.run('state.chats.p1[1].content'), response);
  app.run("state.notes=[{id:'note-1',lessonId:'p1',title:'输入输出',summary:'**重点摘要**',content:'## 概念\\n\\n正文',tags:['Python'],updated:1}]; page='wiki'; activeNote=null; render()");
  assert.match(app.node('#app').innerHTML, /<strong>重点摘要<\/strong>/);
  await app.submit('ask-form', {question:'输入是什么？'});
  const answerDOM = new JSDOM(app.node('#wiki-answer').innerHTML).window.document;
  assert.ok(answerDOM.querySelector('.answer-body h3'));
  assert.ok(answerDOM.querySelector('.citation[data-id="note-1"]'));
});

test('knowledge cards default to Markdown reading, preserve editing drafts and save source rather than rendered HTML', async () => {
  const app = harness();
  app.run("state.notes=[{id:'note-1',lessonId:'p1',courseTitle:'Python',title:'输入输出',summary:'**摘要重点**',content:'## 概念\\n\\n- 第一项\\n- 第二项',tags:['Python'],source:'demo',updated:1}]; activeNote='note-1'; page='wiki'; render()");
  const initial = new JSDOM(app.node('#app').innerHTML).window.document;
  assert.equal(initial.querySelector('#note-source-view').hidden, true);
  assert.equal(initial.querySelector('#note-preview-content h3').textContent, '概念');
  assert.equal(initial.querySelectorAll('#note-preview-content ul li').length, 2);
  await app.run("action('note-view',{dataset:{mode:'edit'}})");
  assert.equal(app.node('#note-source-view').hidden, false);
  assert.equal(app.node('#note-preview-view').hidden, true);
  const draft = '## 我自己的理解\n\n**记住区别**。\n\n<script>bad</script>';
  app.node('#note-title').value = '未保存的标题';
  app.node('#note-summary').value = '**未保存的摘要**';
  app.node('#note-content').value = draft;
  await app.run("action('note-view',{dataset:{mode:'read'}})");
  assert.match(app.node('#note-preview-content').innerHTML, /<h3>我自己的理解<\/h3>/);
  assert.ok(!app.node('#note-preview-content').innerHTML.includes('<script>'));
  assert.equal(app.run('state.notes[0].title'), '输入输出');
  assert.equal(app.node('#note-save').hidden, true);
  await app.run("action('note-view',{dataset:{mode:'edit'}})");
  assert.equal(app.node('#note-content').value, draft);
  await app.submit('note-form', {title:'未保存的标题',summary:'**未保存的摘要**',content:draft,tags:'Python'}, 'note-1');
  assert.equal(app.run('state.notes[0].content'), draft);
  assert.equal(app.run('state.notes[0].title'), '未保存的标题');
  const restored = harness(app.storage.get('learnflow.v1'));
  assert.equal(restored.run('state.notes[0].content'), draft);
  assert.ok(restored.run('markdown(state.notes[0])').includes(draft));
});

test('learning reflection and takeaways have safe Markdown previews without changing auto-save', () => {
  const app = harness();
  app.run("state.lessons.p1=structuredClone(demoLessons.p1); state.lessons.p1.takeaways=['**关键收获**']; openLesson('p1','notes')");
  assert.match(app.node('#app').innerHTML, /id="reflection-preview"/);
  assert.match(app.node('#app').innerHTML, /<strong>关键收获<\/strong>/);
  const reflection = '## 我的理解\n\n**先看输入**。\n\n<img src=x onerror=alert(1)>';
  app.input('reflection', reflection, {reflection:'p1'});
  assert.match(app.node('#reflection-preview').innerHTML, /<h3>我的理解<\/h3>/);
  assert.ok(!app.node('#reflection-preview').innerHTML.includes('<img'));
  assert.equal(app.run('state.reflections.p1'), reflection);
  assert.equal(harness(app.storage.get('learnflow.v1')).run('state.reflections.p1'), reflection);
  app.run("state.blockCourses={p1:{intro:'课程',blocks:[{id:'summary-1',type:'summary',title:'总结',objective:'记住',content:{text:'**内容块总结**'}}]}}; render()");
  assert.match(app.node('#app').innerHTML, /<strong>内容块总结<\/strong>/);
  assert.match(app.node('#app').innerHTML, /id="reflection-preview"/);
});

test('settings display cloud status, test connection and keep failures visible', async () => {
  let fail = false;
  const requests = [];
  const app = harness(undefined, async (url, init) => {
    if (url === '/api/status') return { ok: true, json: async () => ({ mode: 'ai', provider: 'qwen', providerLabel: '通义千问 / 百炼', model: 'configured-model', timeoutMs: 600000 }) };
    requests.push({ url, body: init.body });
    return { ok: !fail, json: async () => fail ? { error: '模型鉴权失败' } : { provider: '通义千问 / 百炼', model: 'configured-model', latencyMs: 1200 } };
  });
  await new Promise(resolve => setImmediate(resolve));
  app.run("navigate('settings')");
  assert.match(app.node('#app').innerHTML, /通义千问 \/ 百炼/);
  assert.match(app.node('#app').innerHTML, /测试模型连接/);
  assert.ok(!app.node('#app').innerHTML.includes('本地 AI 已配置'));
  await app.run("action('test-connection', { dataset: {} })");
  assert.match(app.node('#connection-result').textContent, /连接成功/);
  assert.equal(requests[0].url, '/api/test-connection');
  assert.equal(requests[0].body, '{}');
  fail = true;
  await app.run("action('test-connection', { dataset: {} })");
  assert.match(app.node('#connection-result').textContent, /鉴权失败/);
  app.run("status = { mode: 'error', configurationError: '缺少 API_KEY' }; navigate('settings');");
  assert.match(app.node('#app').innerHTML, /缺少 API_KEY/);
  assert.match(app.node('#app').innerHTML, /data-action="test-connection" disabled/);
});
