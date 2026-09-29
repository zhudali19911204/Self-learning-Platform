import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, validPlan, validLesson } from '../server.mjs';
import { demoPlan, demoLessons } from '../public/demo.js';
import { validQuestionnaire, learningBriefFrom } from '../public/planning.js';
import { questionnaire, clarification } from '../test-support/planning.mjs';

async function serve(t, config = {}) {
  const server = createApp({ env: {}, model: '', ...config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: path => fetch(base + path), post: (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), base };
}
const input = { goal: '学会 Python 编写工具', level: '零基础', daily: 25, days: 14 };
const mock = output => async () => Response.json({ message: { content: JSON.stringify(output) } });

test('image proposals are opt-in, bounded and cannot let text models attach arbitrary image URLs', async t => {
  let enabled = true, proposal = {prompt:'具体的教学插图',caption:'解释阅读重点'}, instructions;
  const app = await serve(t,{model:'test',getImageSettings:()=>({enabled}),fetchImpl:async(_url,init)=>{
    instructions = JSON.parse(init.body).messages[0].content;
    return Response.json({message:{content:JSON.stringify({text:'## 教学正文',imageProposal:proposal,illustration:{url:'https://untrusted.example/track'}})}});
  }});
  const request = {goal:'理解输入输出',title:'第一课',objective:'理解关键概念',level:'零基础',intro:'课程',block:{type:'reading',title:'输入输出',objective:'理解'}};
  assert.deepEqual(await (await app.post('/api/lesson-block',request)).json(),{text:'## 教学正文',imageProposal:proposal});
  assert.match(instructions,/不为装饰硬凑/);
  enabled=false;
  assert.deepEqual(await (await app.post('/api/lesson-block',request)).json(),{text:'## 教学正文'});
  assert.ok(!instructions.includes('教学配图编辑'));
  enabled=true;proposal={prompt:'x'.repeat(4001),caption:'图注'};
  assert.deepEqual(await (await app.post('/api/lesson-block',request)).json(),{text:'## 教学正文'},'a malformed optional proposal must not lose otherwise valid course text');
  proposal={prompt:'图',caption:'图注'};
  assert.deepEqual(await (await app.post('/api/lesson-block',{...request,block:{...request.block,type:'practice'}})).json(),{text:'## 教学正文'});
});
test('cached images require the desktop asset cookie and never accept arbitrary path traversal', async t => {
  const id='a'.repeat(64);let reads=0;
  const app=await serve(t,{apiToken:'asset-test-token',getImageAsset:async()=>{reads++;return {bytes:Buffer.from('test image'),mime:'image/png'};}});
  assert.equal((await app.get(`/course-images/${id}`)).status,403);assert.equal(reads,0);
  const authorized=await fetch(`${app.base}/course-images/${id}`,{headers:{Cookie:'learnflow-assets=asset-test-token'}});
  assert.equal(authorized.status,200);assert.equal(authorized.headers.get('content-type'),'image/png');
  assert.equal(authorized.headers.get('cache-control'),'no-store');assert.equal(reads,1);
  assert.equal((await app.get('/course-images/settings.json')).status,404);
  assert.equal((await fetch(`${app.base}/course-images/${id}`,{headers:{Cookie:'learnflow-assets=asset-test-token',Origin:'https://untrusted.example'}})).status,403);
});

test('AI clarification is topic-specific, bounded, repaired once, and uses application-owned identifiers', async t => {
  let calls = 0, sent;
  const app = await serve(t, {model:'test',fetchImpl:async (_url,init) => {
    sent = JSON.parse(init.body); calls++;
    return Response.json({message:{content:JSON.stringify(calls === 1 ? {summary:'缺问题',questions:[]} : {...questionnaire,questions:questionnaire.questions.map(question => ({...question,id:'model-id'}))})}});
  }});
  const response = await app.post('/api/plan-clarify', input);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(validQuestionnaire(result));
  assert.deepEqual(result.questions.map(question => question.id), ['q1','q2']);
  assert.equal(calls, 2);
  assert.match(sent.messages[0].content, /不机械套用/);
  assert.match(sent.messages[0].content, /不要默认替用户选择/);
  assert.equal(JSON.parse(sent.messages[1].content).goal, input.goal);
  assert.equal((await app.post('/api/plan-clarify',{...input,goal:''})).status,400);
  assert.equal(calls,2);
  const invalid = await serve(t,{model:'test',fetchImpl:mock({summary:'缺问题',questions:[]})});
  assert.equal((await invalid.post('/api/plan-clarify',input)).status,502);
});
test('personalized plans prioritize confirmed answers, preserve original goals, and validate choices before model calls', async t => {
  let calls = 0, sent;
  const app = await serve(t,{model:'test',fetchImpl:async (_url,init) => {
    calls++; sent=JSON.parse(init.body);
    return Response.json({message:{content:JSON.stringify({...demoPlan,learningBrief:{summary:'模型编造的背景'}})}});
  }});
  const response=await app.post('/api/plan',{...input,clarification});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.goal,input.goal);
  assert.deepEqual(result.learningBrief,learningBriefFrom(clarification));
  assert.deepEqual(JSON.parse(sent.messages[1].content).learningBrief,result.learningBrief);
  assert.match(sent.messages[0].content,/验收方法/);
  assert.match(sent.messages[0].content,/前置依赖/);
  assert.match(sent.messages[0].content,/不能覆盖用户回答/);
  assert.equal((await app.post('/api/plan',{...input,clarification:{...clarification,answers:[]}})).status,400);
  assert.equal((await app.post('/api/plan',{...input,clarification:{...clarification,notes:'x'.repeat(1001)}})).status,400);
  assert.equal(calls,1);
});
test('duplicate learning outcomes are diagnosed and repaired instead of accepted', async t => {
  let calls=0,repair;
  const app=await serve(t,{model:'test',fetchImpl:async (_url,init) => {
    calls++;
    if(calls===2) repair=JSON.parse(init.body).messages[0].content;
    return Response.json({message:{content:JSON.stringify(calls===1 ? {...demoPlan,lessons:demoPlan.lessons.map(lesson => ({...lesson,objective:'重复的目标'}))} : demoPlan)}});
  }});
  assert.equal((await app.post('/api/plan',{...input,clarification})).status,200);
  assert.equal(calls,2);
  assert.match(repair,/学习目标重复/);
});
test('later course generation carries the confirmed learning brief without requiring it on old routes', async t => {
  const sent=[];
  const outline={intro:'针对文件整理',blocks:[{type:'reading',title:'规则',objective:'制定规则'},{type:'quiz',title:'检查',objective:'识别错误'}]};
  const app=await serve(t,{model:'test',fetchImpl:async (_url,init) => {
    const payload=JSON.parse(init.body); sent.push(payload);
    return Response.json({message:{content:JSON.stringify(JSON.parse(payload.messages[1].content).block ? {text:'安全预览步骤'} : outline)}});
  }});
  const context={goal:input.goal,level:input.level,title:'文件整理',objective:'独立整理',learningBrief:learningBriefFrom(clarification)};
  assert.equal((await app.post('/api/lesson-outline',context)).status,200);
  assert.equal((await app.post('/api/lesson-block',{...context,intro:'预览再执行',block:outline.blocks[0]})).status,200);
  for(const payload of sent){assert.deepEqual(JSON.parse(payload.messages[1].content).learningBrief,context.learningBrief);assert.match(payload.messages[0].content,/用户确认的学习需求/);}
  assert.equal((await app.post('/api/lesson-outline',{...context,learningBrief:{}})).status,400);
});

test('every sample lesson contains usable content, questions, and unique IDs', () => {
  assert.ok(validPlan(demoPlan));
  assert.equal(new Set(demoPlan.lessons.map(l => l.id)).size, demoPlan.lessons.length);
  for (const l of demoPlan.lessons) {
    assert.ok(validLesson(demoLessons[l.id]), l.title);
    for (const question of demoLessons[l.id].questions) assert.equal(new Set(question.options).size, 4);
  }
});
test('serves all client assets and demo status; does not expose server files', async t => {
  const app = await serve(t);
  const status = await (await app.get('/api/status')).json();
  assert.equal(status.mode, 'demo');
  assert.equal(status.model, null);
  assert.equal(status.provider, 'ollama');
  assert.equal(status.configurationError, null);
  for (const path of ['/', '/app.js', '/demo.js', '/blocks.js', '/planning.js', '/markdown.js', '/vendor/marked.js', '/vendor/purify.js', '/styles.css', '/favicon.svg']) {
    const r = await app.get(path); assert.equal(r.status, 200); assert.ok((await r.text()).length > 0);
    assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));
  }
  for (const path of ['/server.mjs', '/.env', '/package.json', '/diagrams.js', '/vendor/package.json', '/node_modules/marked/package.json', '/unknown']) assert.equal((await app.get(path)).status, 404);
});
test('stepwise lesson APIs validate outline and individual block output', async t => {
  const outline = { intro: '从概念开始', blocks: [{ type: 'reading', title: '概念', objective: '理解概念' }, { type: 'quiz', title: '自测', objective: '检验理解' }] };
  const app = await serve(t, { model: 'test', fetchImpl: mock(outline) });
  const context = { goal: '学习 Python', level: '零基础', title: '变量', objective: '认识变量' };
  assert.deepEqual(await (await app.post('/api/lesson-outline', context)).json(), outline);
  assert.equal((await app.post('/api/lesson-outline', { ...context, route: [{ title: '缺目标' }], lessonPosition: 1 })).status, 400);
  assert.equal((await app.post('/api/lesson-block', { ...context, intro: outline.intro, block: outline.blocks[0] })).status, 502);
  let sent;
  const blockApp = await serve(t, { model: 'test', fetchImpl: async (_url, init) => { sent = JSON.parse(init.body); return Response.json({ message: { content: JSON.stringify({ text: '分步讲解正文' }) } }); } });
  const blockRequest = { ...context, intro: outline.intro, block: outline.blocks[0], minutes: 25, outline: outline.blocks, previous: [{ type: 'reading', title: '前一段', excerpt: '已经解释过的概念' }], sequence: { position: 2, total: 4 } };
  assert.deepEqual(await (await blockApp.post('/api/lesson-block', blockRequest)).json(), { text: '分步讲解正文' });
  assert.match(sent.messages[0].content, /首次出现的术语要定义/);
  assert.match(sent.messages[0].content, /text 字段内使用 Markdown 文档格式/);
  assert.match(sent.messages[0].content, /关键定义或核心结论用 \*\*加粗\*\*/);
  assert.match(sent.messages[0].content, /不要生成流程图、架构图、数据图表/);
  assert.match(sent.messages[0].content, /普通 Markdown 表格/);
  assert.doesNotMatch(sent.messages[0].content, /最多 24 个节点、40 条连线/);
  assert.deepEqual(JSON.parse(sent.messages[1].content).previous, blockRequest.previous);
  assert.deepEqual(await (await blockApp.post('/api/lesson-block', { ...blockRequest, block: { type: 'practice', title: '动手做', objective: '独立完成' } })).json(), { text: '分步讲解正文' });
  assert.match(sent.messages[0].content, /完成标准和两个由浅入深的提示/);
  assert.match(sent.messages[0].content, /不要生成流程图、架构图、数据图表/);
  assert.equal((await blockApp.post('/api/lesson-block', { ...blockRequest, previous: [{ ...blockRequest.previous[0], excerpt: 'x'.repeat(1001) }] })).status, 400);
  assert.equal((await blockApp.post('/api/lesson-block', { ...context, intro: outline.intro, block: { type: 'unknown', title: '错', objective: '错' } })).status, 400);
});

test('regeneration uses user clarity requirements and original text, but cannot revise quizzes', async t => {
  let sent;
  const app = await serve(t, {model:'test', fetchImpl:async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({message:{content:JSON.stringify({text:'重新解释的完整正文', revisions:[{text:'模型伪造的历史',updated:1}]})}});
  }});
  const request = {goal:'学习财务分析', level:'零基础', title:'现金流', objective:'理解现金流', intro:'课程', block:{type:'reading', title:'概念', objective:'理解'}, revisionRequest:'用家庭收支表讲清第二段，逐步计算', currentExcerpt:'原始正文', related:[{type:'example',title:'收支表',excerpt:'当前配套案例'}]};
  assert.deepEqual(await (await app.post('/api/lesson-block', request)).json(), {text:'重新解释的完整正文'});
  const payload = JSON.parse(sent.messages[1].content);
  assert.equal(payload.revisionRequest, request.revisionRequest);
  assert.equal(payload.currentExcerpt, request.currentExcerpt);
  assert.deepEqual(payload.related, request.related);
  assert.match(sent.messages[0].content, /明确解决反馈中的困惑/);
  for (const patch of [{revisionRequest:''}, {revisionRequest:'x'.repeat(1001)}, {currentExcerpt:undefined}, {currentExcerpt:'x'.repeat(12001)}, {block:{...request.block,type:'quiz'}}, {related:[{type:'reading',title:'越界',excerpt:'错误'}]}]) {
    assert.equal((await app.post('/api/lesson-block', {...request,...patch})).status, 400);
  }
  assert.equal((await app.post('/api/lesson-block', {...request,block:{...request.block,type:'example'}})).status, 200);
  assert.match(sent.messages[0].content, /操作步骤使用编号列表/);
  assert.match(sent.messages[0].content, /若反馈仅要求优化排版，保留原有事实/);
});
test('demo mode refuses arbitrary AI generation instead of returning fabricated results', async t => {
  const app = await serve(t);
  const response = await app.post('/api/plan', input);
  assert.equal(response.status, 503); assert.match((await response.json()).error, /尚未配置/);
});
test('rejects malformed requests, oversized content and cross-origin calls', async t => {
  const app = await serve(t);
  assert.equal((await app.post('/api/plan', { ...input, daily: -1 })).status, 400);
  assert.equal((await app.post('/api/plan', null)).status, 400);
  assert.equal((await app.post('/api/plan', { ...input, goal: 'x'.repeat(520000) })).status, 413);
  assert.equal((await app.post('/api/plan', input, { Origin: 'http://untrusted.example' })).status, 403);
  const malformed = await fetch(app.base + '/api/plan', { method: 'POST', body: '{' });
  assert.equal(malformed.status, 400);
  // fetch normalizes Host; use the native client to exercise DNS-rebinding protection.
  const badHost = await new Promise((resolve, reject) => {
    http.get(app.base + '/api/status', { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(badHost, 403);
});
test('AI planning uses user constraints and assigns application-owned IDs', async t => {
  let sent;
  const app = await serve(t, { model: 'test-model', fetchImpl: async (url, init) => { sent = { url, ...JSON.parse(init.body) }; return Response.json({ message: { content: JSON.stringify(demoPlan) } }); } });
  const response = await app.post('/api/plan', input);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.source, 'ai'); assert.equal(result.goal, input.goal); assert.notEqual(result.id, demoPlan.id);
  assert.equal(new Set(result.lessons.map(l => l.id)).size, result.lessons.length);
  assert.notEqual(result.lessons[0].id, demoPlan.lessons[0].id);
  assert.equal(sent.stream, false); assert.equal(sent.format, 'json'); assert.equal(sent.model, 'test-model');
  assert.deepEqual(JSON.parse(sent.messages[1].content), input);
});
test('planning repairs one structurally invalid model response and explains repeated budget failures', async t => {
  let calls = 0, repairPrompt = '', repairData;
  const repaired = await serve(t, { model: 'test', fetchImpl: async (_url, init) => {
    calls++;
    const payload = JSON.parse(init.body);
    if (calls === 2) { repairPrompt = payload.messages[0].content; repairData = JSON.parse(payload.messages[1].content); }
    return Response.json({ message: { content: JSON.stringify(calls === 1 ? { title: '过短路线', description: '只有一节', lessons: [demoPlan.lessons[0]] } : demoPlan) } });
  } });
  assert.equal((await repaired.post('/api/plan', input)).status, 200);
  assert.equal(calls, 2);
  assert.match(repairPrompt, /课程数量必须为 3–12 节/);
  assert.match(repairPrompt, /实际返回了 1 节/);
  assert.equal(repairData.goal, input.goal);
  assert.equal(repairData.repair.receivedLessonCount, 1);
  assert.equal(repairData.repair.previousPlan.lessons[0].title, demoPlan.lessons[0].title);
  let failedCalls = 0;
  const overBudget = await serve(t, { model: 'test', fetchImpl: async () => { failedCalls++; return Response.json({ message: { content: JSON.stringify(demoPlan) } }); } });
  const response = await overBudget.post('/api/plan', { ...input, daily: 10, days: 7 });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /总时长.*超过可用/);
  assert.equal(failedCalls, 2);
});

test('planning uses a full multi-course example and reports actual count versus a missing array', async t => {
  let prompt;
  const valid = await serve(t, {model:'test', fetchImpl:async (_url, init) => {
    prompt = JSON.parse(init.body).messages[0].content;
    return Response.json({message:{content:JSON.stringify(demoPlan)}});
  }});
  assert.equal((await valid.post('/api/plan', input)).status, 200);
  const shape = JSON.parse(prompt.slice(prompt.indexOf('{"title":"根据目标命名的路线"')));
  assert.ok(shape.lessons.length >= 3 && shape.lessons.length <= 12);
  assert.ok(shape.lessons.reduce((total, lesson) => total + lesson.minutes, 0) <= input.daily * input.days);
  assert.match(prompt, /days 表示整个学习周期，不等于课程数量/);
  for (const count of [0, 1, 2, 13, 30]) {
    const lessons = Array.from({length:count}, (_, index) => ({...demoPlan.lessons[0],title:`课程 ${index}`}));
    const app = await serve(t, {model:'test',fetchImpl:mock({...demoPlan,lessons})});
    const response = await app.post('/api/plan', input);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, new RegExp(`实际返回了 ${count} 节`));
  }
  for (const lessons of [undefined, '课程列表', {title:'单个对象'}]) {
    const app = await serve(t, {model:'test',fetchImpl:mock({title:'路线',description:'课程',lessons})});
    assert.match((await (await app.post('/api/plan',input)).json()).error, /lessons/);
  }
});

test('planning repair bounds rejected drafts and preserves the original goal when too many courses are returned', async t => {
  let calls = 0, repair;
  const app = await serve(t, {model:'test',fetchImpl:async (_url, init) => {
    calls++;
    const payload = JSON.parse(init.body);
    if (calls === 2) repair = JSON.parse(payload.messages[1].content).repair;
    const output = calls === 1 ? {...demoPlan,lessons:Array.from({length:80}, (_, index) => ({...demoPlan.lessons[0],title:`主题 ${index}`,objective:'x'.repeat(1500)}))} : demoPlan;
    return Response.json({message:{content:JSON.stringify(output)}});
  }});
  assert.equal((await app.post('/api/plan',input)).status, 200);
  assert.equal(repair.receivedLessonCount, 80);
  assert.equal(repair.previousPlan.lessons.length, 24);
  assert.ok(repair.previousPlan.lessons.every(lesson => lesson.objective.length <= 320));
  assert.equal(calls, 2);
});
test('rejects impossible study budgets and incomplete model output', async t => {
  const app = await serve(t, { model: 'test', fetchImpl: mock(demoPlan) });
  assert.equal((await app.post('/api/plan', { ...input, daily: 10, days: 7 })).status, 502);
  const broken = await serve(t, { model: 'test', fetchImpl: mock({ title: 'Incomplete' }) });
  assert.equal((await broken.post('/api/plan', input)).status, 502);
});
test('returns actionable errors for unavailable models and invalid JSON', async t => {
  const offline = await serve(t, { model: 'test', fetchImpl: async () => { throw new Error('connection refused'); } });
  const r = await offline.post('/api/plan', input); assert.equal(r.status, 502); assert.match((await r.json()).error, /无法连接/);
  const invalid = await serve(t, { model: 'test', fetchImpl: async () => Response.json({ message: { content: 'not JSON' } }) });
  assert.equal((await invalid.post('/api/plan', input)).status, 502);
  const failed = await serve(t, { model: 'test', fetchImpl: async () => new Response('failed', { status: 500 }) });
  assert.equal((await failed.post('/api/plan', input)).status, 502);
});
test('lesson generation validates that each answer refers to a real option', async t => {
  const input = { goal: '学习 Python', title: '第一课', objective: '学会 print', level: '零基础' };
  const app = await serve(t, { model: 'test', fetchImpl: mock(demoLessons.p1) });
  assert.equal((await app.post('/api/lesson', input)).status, 200);
  const broken = structuredClone(demoLessons.p1); broken.questions[0].answer = 4;
  const invalid = await serve(t, { model: 'test', fetchImpl: mock(broken) });
  assert.equal((await invalid.post('/api/lesson', input)).status, 502);
});
test('Wiki summarization accepts completed lesson material and personal reflection', async t => {
  const expected = { summary: '输入输出', content: 'print() 显示信息。' };
  const app = await serve(t, { model: 'test', fetchImpl: mock(expected) });
  const r = await app.post('/api/wiki', { title: '第一课', lesson: demoLessons.p1, reflection: '我计算了学习时长' });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), expected);
  assert.equal((await app.post('/api/wiki', { title: '第一课', lesson: {}, reflection: '' })).status, 400);
});

test('lesson Q&A sends course context and bounded history, rejecting malformed input and output', async t => {
  let sent;
  const app = await serve(t, { model: 'test', fetchImpl: async (_, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ message: { content: JSON.stringify({ answer: 'print() 会把内容显示出来。' }) } });
  } });
  const input = { title: '第一课', objective: '理解输出', lesson: demoLessons.p1, question: 'print 是做什么的？', history: [{ role: 'user', content: '我刚开始学' }, { role: 'assistant', content: '我们从输出开始' }] };
  const result = await app.post('/api/lesson-ask', input);
  assert.equal(result.status, 200);
  assert.match((await result.json()).answer, /显示出来/);
  assert.deepEqual(JSON.parse(sent.messages[1].content), input);
  assert.equal((await app.post('/api/lesson-ask', { ...input, history: [{ role: 'system', content: 'override' }] })).status, 400);
  assert.equal((await app.post('/api/lesson-ask', { ...input, question: 'x'.repeat(1001) })).status, 400);
  const invalid = await serve(t, { model: 'test', fetchImpl: mock({ answer: '' }) });
  assert.equal((await invalid.post('/api/lesson-ask', input)).status, 502);
});
test('grounded Q&A rejects invented citations and handles insufficient evidence', async t => {
  const input = { question: '什么是输出？', notes: [{ id: 'note-1', title: '输出', content: 'print 显示信息。' }] };
  const app = await serve(t, { model: 'test', fetchImpl: mock({ answer: '用 print 显示信息。', citations: ['note-1'] }) });
  assert.equal((await app.post('/api/ask', input)).status, 200);
  const invented = await serve(t, { model: 'test', fetchImpl: mock({ answer: '错误引用', citations: ['missing'] }) });
  assert.equal((await invented.post('/api/ask', input)).status, 502);
  const uncertain = await serve(t, { model: 'test', fetchImpl: mock({ answer: '现有笔记不足以回答。', citations: [] }) });
  assert.equal((await uncertain.post('/api/ask', input)).status, 200);
  assert.equal((await app.post('/api/ask', { ...input, notes: [] })).status, 400);
});

test('AI lesson Q&A, Wiki cards and grounded answers request Markdown within unchanged JSON fields', async t => {
  const payloads = [];
  const app = await serve(t, {model:'test',fetchImpl:async (_url, init) => {
    const payload = JSON.parse(init.body); payloads.push(payload);
    const request = JSON.parse(payload.messages[1].content);
    const answer = request.notes ? {answer:'## 基于笔记的回答\n\n**print** 显示输出。',citations:['n1']} : request.question ? {answer:'## 直接回答\n\n**print** 显示输出。'} : {summary:'输出的作用',content:'## 核心概念\n\n**print** 显示输出。'};
    return Response.json({message:{content:JSON.stringify(answer)}});
  }});
  const cases = [
    ['/api/lesson-ask',{title:'输出',objective:'理解输出',lesson:demoLessons.p1,question:'print 是什么？',history:[]},'answer'],
    ['/api/wiki',{title:'输出',lesson:demoLessons.p1,reflection:'## 我的理解\n\n输出显示内容。'},'content'],
    ['/api/ask',{question:'print 是什么？',notes:[{id:'n1',title:'输出',content:'## 概念\n\nprint 显示内容。'}]},'answer']
  ];
  for (const [path,request,field] of cases) {
    const response = await app.post(path, request);
    assert.equal(response.status, 200);
    assert.match((await response.json())[field], /^## /);
    assert.match(payloads.at(-1).messages[0].content, /正文使用 Markdown/);
    assert.match(payloads.at(-1).messages[0].content, /根输出仍须是 JSON/);
    assert.match(payloads.at(-1).messages[0].content, /不要生成流程图、架构图、数据图表/);
  }
});

test('compatible service works over HTTP for connection, plan, lesson, Wiki and grounded Q&A', async t => {
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    captured.push({ url: req.url, auth: req.headers.authorization, body });
    const data = JSON.parse(body.messages[1].content);
    const value = data.task === 'connection-test' ? { ok: true }
      : data.notes ? { answer: 'print 显示信息。', citations: ['n1'] }
      : data.lesson ? { summary: '输出', content: 'print 显示信息。' }
      : data.objective ? demoLessons.p1 : demoPlan;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const app = await serve(t, { provider: 'compatible', model: 'deployed-model', apiKey: 'private-key', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
  const status = await (await app.get('/api/status')).json();
  assert.equal(status.mode, 'ai');
  assert.equal(status.provider, 'compatible');
  assert.equal(status.model, 'deployed-model');
  assert.ok(!JSON.stringify(status).includes('private-key'));
  assert.equal(captured.length, 0, 'status must not trigger billed generation');
  const probe = await app.post('/api/test-connection', { notes: ['should never reach upstream'] });
  assert.equal(probe.status, 200);
  assert.equal((await probe.json()).ok, true);
  assert.deepEqual(JSON.parse(captured[0].body.messages[1].content), { task: 'connection-test' });
  assert.equal((await app.post('/api/plan', input)).status, 200);
  assert.equal((await app.post('/api/lesson', { goal: '学习', title: '输出', objective: '掌握输出', level: '零基础' })).status, 200);
  assert.equal((await app.post('/api/wiki', { title: '输出', lesson: demoLessons.p1, reflection: '已掌握' })).status, 200);
  assert.equal((await app.post('/api/ask', { question: '输出？', notes: [{ id: 'n1', title: '输出', content: 'print 显示信息。' }] })).status, 200);
  assert.equal(captured.length, 5);
  for (const request of captured) {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.auth, 'Bearer private-key');
    assert.equal(request.body.model, 'deployed-model');
  }
  assert.equal((await app.get('/llm.mjs')).status, 404);
  assert.equal((await app.post('/api/test-connection', {}, { Origin: 'http://untrusted.example' })).status, 403);
});

test('configuration errors are visible in status; connection test never claims success when unconfigured', async t => {
  const broken = await serve(t, { provider: 'deepseek', model: 'test', apiKey: '', fetchImpl: async () => { assert.fail('must not call upstream'); } });
  const status = await (await broken.get('/api/status')).json();
  assert.equal(status.mode, 'error');
  assert.match(status.configurationError, /API_KEY/);
  assert.equal((await broken.post('/api/test-connection', {})).status, 503);
  const demo = await serve(t);
  assert.equal((await demo.post('/api/test-connection', {})).status, 503);
});

test('desktop internal API requires a session token and accepts live model configuration', async t => {
  let model = 'first';
  const app = await serve(t, { apiToken: 'session-secret', getLLM: () => ({ status: () => ({ mode: 'ai', model }), testConnection: async () => ({ ok: true, model }) }) });
  assert.equal((await app.get('/api/status')).status, 403);
  assert.equal((await app.post('/api/test-connection', {})).status, 403);
  const response = await app.post('/api/test-connection', {}, { 'X-Learnflow-Token': 'session-secret' });
  assert.equal((await response.json()).model, 'first');
  model = 'second';
  assert.equal((await (await app.post('/api/test-connection', {}, { 'X-Learnflow-Token': 'session-secret' })).json()).model, 'second');
  assert.equal((await app.get('/')).status, 200);
});
