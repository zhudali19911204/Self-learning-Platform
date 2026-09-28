// Native Electron integration test. Invoked only by --smoke-test in an isolated profile.
const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
exports.run = async (window, store, directory) => {
  const { demoPlan } = await import('../public/demo.js');
  const evaluate = code => window.webContents.executeJavaScript(code).catch(error => { console.error('SMOKE_FAILED_STEP', code.slice(0, 220)); throw error; });
  const wait = expression => evaluate(`new Promise((resolve, reject) => { let attempts = 0; const timer = setInterval(() => { try { if (${expression}) { clearInterval(timer); resolve(true); } else if (++attempts > 150) { clearInterval(timer); reject(new Error('Desktop check timed out')); } } catch (error) { clearInterval(timer); reject(error); } }, 100); })`);
  await wait("document.querySelector('main h1')");
  const localSettings = { provider: 'ollama', model: '', baseUrl: '', keyAction: 'clear', apiKey: '', localOnly: true, jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192 };
  await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify(localSettings)})`);
  window.webContents.reload();
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('main h1')");
  assert.deepEqual(await evaluate("({ bridge: typeof window.learnflowDesktop?.saveSettings, node: typeof window.require })"), { bridge: 'function', node: 'undefined' });
  // Exercise settings through the real form and IPC bridge.
  await evaluate("document.querySelector('[data-page=settings]').click()");
  await wait("document.querySelector('#desktop-settings-form')");
  await evaluate("document.querySelector('#model-name').value = 'desktop-smoke-model'; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#connection-result')?.textContent.includes('配置已保存并生效')");
  const saved = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.equal(saved.model, 'desktop-smoke-model'); assert.equal(saved.localOnly, true);
  // Save a test-only local key, assert OS encryption, then clear it.
  await evaluate("document.querySelector('#key-action').value = 'replace'; document.querySelector('#model-key').value = 'smoke-only-not-a-real-key'; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#key-action')?.options[0].textContent.includes('保留') && document.querySelector('#model-key')?.value === ''");
  const encrypted = await readFile(path.join(directory, 'settings.json'), 'utf8');
  assert.ok(!encrypted.includes('smoke-only-not-a-real-key'));
  assert.ok(JSON.parse(encrypted).encryptedApiKey.length > 0);
  await evaluate("document.querySelector('#key-action').value = 'clear'; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#key-action')?.options[0].textContent.includes('不填写')");
  // Reproduce the reported conflict using a cloud preset, without making cloud requests.
  await evaluate("document.querySelector('#model-provider').value = 'deepseek'; document.querySelector('#model-provider').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#model-name').value = 'smoke-cloud-model'; document.querySelector('#model-key').value = 'smoke-cloud-key-not-real'; document.querySelector('#model-key').dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#remote-permission')?.hidden === false");
  assert.match(await evaluate("document.querySelector('#settings-error').textContent"), /仅使用本机模型/);
  assert.equal(store.getSettings().provider, 'ollama', 'rejected draft must not change saved configuration');
  assert.equal(await evaluate("document.querySelector('[data-action=test-connection]').disabled"), true);
  await evaluate("document.querySelector('[data-action=allow-remote-save]').click()");
  await wait("document.querySelector('#connection-result')?.textContent.includes('配置已保存并生效')");
  assert.equal(store.getSettings().provider, 'deepseek');
  assert.equal(store.getSettings().localOnly, false);
  assert.equal(store.getSettings().hasApiKey, true);
  window.webContents.reload();
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('main h1')");
  const cloud = await evaluate('window.learnflowDesktop.load()');
  assert.equal(cloud.settings.provider, 'deepseek');
  assert.equal(cloud.settings.localOnly, false);
  assert.equal(cloud.settings.hasApiKey, true);
  await evaluate("document.querySelector('[data-page=settings]').click()");
  // Cover the same issue for self-hosted services on another LAN machine.
  await evaluate("document.querySelector('#model-provider').value = 'vllm'; document.querySelector('#model-provider').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#model-name').value = 'smoke-lan-model'; document.querySelector('#model-url').value = 'http://192.168.1.2:8000/v1'; document.querySelector('[name=localOnly]').checked = true; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#remote-permission')?.hidden === false");
  assert.equal(store.getSettings().provider, 'deepseek');
  await evaluate("document.querySelector('[data-action=allow-remote-save]').click()");
  await wait("document.querySelector('#connection-result')?.textContent.includes('配置已保存并生效')");
  assert.equal(store.getSettings().provider, 'vllm');
  assert.equal(store.getSettings().hasApiKey, false);
  // Return the isolated test profile to a local-only model for the learning checks.
  await evaluate("document.querySelector('#model-provider').value = 'ollama'; document.querySelector('#model-provider').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#model-name').value = 'desktop-smoke-model'; document.querySelector('[name=localOnly]').checked = true; document.querySelector('#desktop-settings-form').requestSubmit()");
  await wait("document.querySelector('#connection-result')?.textContent.includes('配置已保存并生效')");
  // Complete a sample lesson, generate a Wiki card, and persist it on disk.
  // A previous smoke run may have left its custom test route active.
  await evaluate(`window.learnflowDesktop.setActivePlan(${JSON.stringify(demoPlan.id)})`);
  window.webContents.reload();
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('main h1')");
  await evaluate("document.querySelector('[data-page=routes]').click(); document.querySelector('[data-action=open-lesson][data-id=p1]').click()");
  await wait("document.querySelector('[data-tab=quiz]')");
  await evaluate("window.scrollTo(0, 350); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const quickAskPosition = await evaluate("(() => { const quick = document.querySelector('.quick-ask-button').getBoundingClientRect(), lesson = document.querySelector('.lesson-content').getBoundingClientRect(); return {left:quick.left,right:quick.right,top:quick.top,bottom:quick.bottom,lessonRight:lesson.right,viewportWidth:innerWidth,viewportHeight:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollTop:scrollY}; })()");
  assert.ok(quickAskPosition.left >= quickAskPosition.lessonRight && quickAskPosition.right <= quickAskPosition.viewportWidth, JSON.stringify(quickAskPosition));
  assert.ok(quickAskPosition.scrollWidth <= quickAskPosition.viewportWidth + 1, JSON.stringify(quickAskPosition));
  assert.ok(Math.abs((quickAskPosition.top + quickAskPosition.bottom) / 2 - quickAskPosition.viewportHeight / 2) < 110);
  await writeFile(path.join(directory, '..', 'quick-ask-smoke.png'), (await window.webContents.capturePage()).toPNG());
  const originalSize = window.getSize();
  window.setSize(900, originalSize[1]);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.quick-ask-dock')).position"), 'fixed');
  assert.equal(await evaluate("document.querySelector('.quick-ask-button').getBoundingClientRect().right <= innerWidth"), true);
  window.setSize(...originalSize);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await evaluate("document.querySelector('[data-action=quick-ask]').click()");
  await wait("document.querySelector('#lesson-question') && document.querySelector('.study-chat')");
  assert.equal(await evaluate("document.activeElement?.id"), 'lesson-question');
  await evaluate("document.querySelector('[data-action=back-to-reading]').click()");
  await wait("document.querySelector('.lesson-intro')");
  assert.ok(Math.abs((await evaluate('scrollY')) - quickAskPosition.scrollTop) <= 2, 'returning from Q&A should restore the reading scroll position');
  await evaluate("document.querySelector('[data-tab=quiz]').click(); document.querySelector('[name=q0][value=\"1\"]').checked = true; document.querySelector('[name=q1][value=\"1\"]').checked = true; document.querySelector('#quiz-form').requestSubmit()");
  await wait("document.querySelector('.quiz-result.passed')");
  const reflectionMarkdown = '## 桌面集成测试心得\n\n**掌握核心概念**。';
  await evaluate(`document.querySelector('[data-action=notes-tab]').click(); document.querySelector('#reflection').value = ${JSON.stringify(reflectionMarkdown)}; document.querySelector('#reflection').dispatchEvent(new Event('input', {bubbles:true}))`);
  assert.equal(await evaluate("document.querySelector('#reflection-preview h3').textContent"), '桌面集成测试心得');
  assert.equal(await evaluate("document.querySelector('#reflection-preview strong').textContent"), '掌握核心概念');
  await evaluate("document.querySelector('[data-action=create-note]').click()");
  await wait("document.querySelector('#note-form')");
  assert.equal(await evaluate("document.querySelector('#note-source-view').hidden"), true);
  assert.equal(await evaluate("document.querySelector('#note-preview-view').hidden"), false);
  const editedNote = '## 学习要点\n\n**输入与输出**是程序与用户交互的起点。\n\n1. 输入一条语句\n2. 观察输出\n\n```python\nprint("你好")\n```';
  await evaluate(`document.querySelector('#note-edit-switch').click(); document.querySelector('#note-summary').value = '**知识卡片摘要**'; document.querySelector('#note-content').value = ${JSON.stringify(editedNote)}; document.querySelector('#note-read-switch').click()`);
  assert.equal(await evaluate("document.querySelector('#note-preview-content h3').textContent"), '学习要点');
  assert.equal(await evaluate("document.querySelector('#note-preview-content strong').textContent"), '输入与输出');
  assert.equal(await evaluate("document.querySelector('#note-preview-summary strong').textContent"), '知识卡片摘要');
  await evaluate("document.querySelector('#note-edit-switch').click()");
  assert.equal(await evaluate("document.querySelector('#note-content').value"), editedNote);
  await evaluate("document.querySelector('#note-form').requestSubmit()");
  await wait("document.querySelector('#toast').textContent.includes('知识卡片已保存') && !document.querySelector('#note-save').disabled");
  await evaluate("document.querySelector('#note-read-switch').click()");
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await writeFile(path.join(directory, '..', 'note-markdown-smoke.png'), (await window.webContents.capturePage()).toPNG());
  await store.flush();
  const state = await store.loadState();
  assert.equal(state.progress.p1.completed, true);
  assert.equal(state.reflections.p1, reflectionMarkdown);
  assert.ok(state.notes.some(note => note.lessonId === 'p1'));
  assert.equal(state.notes.find(note => note.lessonId === 'p1').content, editedNote);
  // Reload the entire renderer, mimicking a new launch while preserving disk data.
  window.webContents.reload();
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('main h1')");
  const loaded = await evaluate('window.learnflowDesktop.load()');
  assert.equal(loaded.state.progress.p1.completed, true);
  assert.equal(loaded.settings.model, 'desktop-smoke-model');
  assert.equal(loaded.settings.apiKey, undefined);
  // Exercise the complete lesson Q&A path against a local mock model.
  const requests = [];
  const chatMarkdown = '## 直接回答\n\n**输出**会把内容显示给用户。\n\n```python\nprint("你好")\n```';
  const wikiMarkdown = '## 核心概念\n\n**现金流**表示一定期间的现金收入与支出。\n\n### 实践检查\n\n- 确认时间范围\n- 比较收入与支出';
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url, payload });
    const input = JSON.parse(payload.messages[1].content);
    if (input.revisionRequest === '测试模型不可用') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({error:{message:'Test-only unavailable model'}})); return;
    }
    const markdownAnswer = ['## 核心结论', '', '**剩余现金 40 元**：收入 100 元，减去支出 60 元。', '', '### 计算步骤', '', '1. 从收支表中找到收入。', '2. 减去支出，得到剩余现金。', '', '> 提示：先确认收入与支出的时间范围一致。', '', '| 项目 | 金额 |', '| --- | ---: |', '| 收入 | 100 |', '| 支出 | 60 |', '', '```flow', '开始 -> 员工提交申请', '员工提交申请 -> 主管审批', '主管审批 -> 判断天数', '判断天数 ->|是（<=3天）| 主管批准', '判断天数 ->|否（>3天）| 部门经理审批', '主管批准 -> 结束1', '部门经理审批 -> 经理判断', '经理判断 ->|批准| 结束2', '经理判断 ->|驳回| 结束3', '```', '', '```chart', 'type: bar', 'title: 示例收支', '收入 | 100', '支出 | 60', '```', '', '```python', 'balance = 100 - 60', 'print(balance)', '```'].join('\n');
    const output = input.daily !== undefined ? {...demoPlan,title:'路线纠正集成测试',lessons:input.repair ? demoPlan.lessons : [demoPlan.lessons[0]]}
      : input.revisionRequest ? {text:markdownAnswer}
      : input.notes ? {answer:'## 检索结论\n\n**输入与输出**已记录在你的知识卡片中。',citations:[input.notes[0].id]}
      : input.lesson && input.reflection !== undefined ? {summary:'**现金流**的核心概念与实践方法',content:wikiMarkdown}
      : {answer:chatMarkdown};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  try {
    const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
    const changed = await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify({ provider: 'compatible', model: 'smoke-chat-model', baseUrl: modelUrl, keyAction: 'clear', apiKey: '', localOnly: true, jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192 })})`);
    assert.equal(changed.status.mode, 'ai');
    window.webContents.reload();
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    await wait("document.querySelector('main h1')");
    await evaluate("document.querySelector('[data-page=routes]').click(); document.querySelector('[data-action=open-lesson][data-id=p1]').click()");
    await wait("document.querySelector('[data-tab=chat]')");
    await evaluate("document.querySelector('[data-tab=chat]').click(); document.querySelector('#lesson-question').value = '什么是输出？'; document.querySelector('#lesson-ask-form').requestSubmit()");
    await wait("document.querySelector('.chat-message.from-ai')?.textContent.includes('显示给用户') && !document.querySelector('#lesson-ask-form button[type=submit]').disabled");
    await store.flush();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/v1/chat/completions');
    assert.equal(JSON.parse(requests[0].payload.messages[1].content).question, '什么是输出？');
    const chatted = await store.loadState();
    assert.equal(chatted.chats.p1.at(-2).content, '什么是输出？');
    assert.equal(chatted.chats.p1.at(-1).content, chatMarkdown);
    assert.equal(await evaluate("document.querySelector('.chat-message.from-ai:last-child .markdown-content h3').textContent"), '直接回答');
    assert.ok(await evaluate("!!document.querySelector('.chat-message.from-ai:last-child pre code')"));
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.chat-message.from-ai:last-child .markdown-content strong')).display"), 'inline');
    await evaluate("document.querySelector('[data-page=wiki]').click(); document.querySelector('#wiki-question').value = '输入与输出有哪些要点？'; document.querySelector('#ask-form').requestSubmit()");
    await wait("document.querySelector('.grounded-answer .answer-body h3')?.textContent === '检索结论' && !document.querySelector('#ask-form button[type=submit]').disabled");
    assert.equal(await evaluate("document.querySelector('.grounded-answer .markdown-content strong').textContent"), '输入与输出');
    assert.ok(await evaluate("!!document.querySelector('.grounded-answer .citation')"));
    // Reproduce a one-course response and exercise the corrected retry through the real planner.
    await evaluate("document.querySelector('[data-page=routes]').click(); document.querySelector('[data-action=planner]').click(); document.querySelector('#goal').value = '用 Python 编写自动整理文件的小工具'; document.querySelector('#plan-form').requestSubmit()");
    await wait("!document.querySelector('#planner').open && document.querySelector('.route-overview h2')?.textContent === '路线纠正集成测试'");
    const planRequests = requests.map(request => JSON.parse(request.payload.messages[1].content)).filter(input => input.daily !== undefined);
    assert.equal(planRequests.length, 2);
    assert.equal(planRequests[1].repair.receivedLessonCount, 1);
    assert.equal(planRequests[1].goal, planRequests[0].goal);
    const planned = await store.loadState();
    assert.equal(planned.plans.find(plan => plan.id === planned.active).lessons.length, demoPlan.lessons.length);
    // Test grouped teaching and feedback regeneration on a fresh, isolated lesson.
    const { randomUUID } = require('node:crypto');
    const route = structuredClone(demoPlan);
    route.id = randomUUID(); route.source = 'ai'; route.title = '讲解与案例桌面测试';
    route.lessons = route.lessons.map(lesson => ({...lesson, id:randomUUID()}));
    const lessonId = route.lessons[0].id;
    await evaluate(`window.learnflowDesktop.savePlan(${JSON.stringify(route)})`);
    const course = await evaluate(`window.learnflowDesktop.saveOutline(${JSON.stringify(lessonId)}, ${JSON.stringify({intro:'独立集成测试课程', blocks:[
      {type:'reading',title:'理解现金流',objective:'理解收支与余额'},
      {type:'example',title:'日常收支案例',objective:'计算剩余现金'},
      {type:'quiz',title:'检验理解',objective:'独立作答'}
    ]})})`);
    const readingId = course.blocks[0].id, exampleId = course.blocks[1].id;
    await evaluate(`window.learnflowDesktop.saveBlock(${JSON.stringify(lessonId)}, ${JSON.stringify(readingId)}, {text:'原始讲解：认识现金流。'})`);
    await evaluate(`window.learnflowDesktop.saveBlock(${JSON.stringify(lessonId)}, ${JSON.stringify(exampleId)}, {text:'配套案例：收入 100 元，支出 60 元。'})`);
    await evaluate(`window.learnflowDesktop.saveProgress(${JSON.stringify(lessonId)}, {completed:true,attempts:1,lastScore:100,bestScore:100,lastAnswers:[0],updated:1234})`);
    window.webContents.reload();
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    await wait("document.querySelector('main h1')");
    await evaluate(`document.querySelector('[data-page=routes]').click(); document.querySelector('[data-action=open-lesson][data-id="${lessonId}"]').click()`);
    await wait("document.querySelector('.teaching-unit .teaching-example')");
    assert.equal(await evaluate("document.querySelector('.teaching-unit').querySelectorAll('.teaching-part').length"), 2);
    await evaluate(`document.querySelector('[data-action=request-revision][data-block="${readingId}"]').click()`);
    await wait("document.querySelector('#revise-block-dialog').open");
    await evaluate("document.querySelector('[data-action=markdown-revision-preset]').click()");
    assert.match(await evaluate("document.querySelector('#revision-request').value"), /请仅优化.*Markdown/);
    await evaluate("document.querySelector('#revision-request').value = '术语太多，请用收支表逐步计算并解释'; document.querySelector('#revision-form').requestSubmit()");
    await wait("!document.querySelector('#revise-block-dialog').open && document.querySelector('.teaching-reading .block-text').textContent.includes('剩余现金 40 元')");
    const revised = await store.loadState();
    assert.equal(revised.blockCourses[lessonId].blocks[0].content.revisions[0].text, '原始讲解：认识现金流。');
    assert.equal(revised.blockCourses[lessonId].blocks[1].content.text, '配套案例：收入 100 元，支出 60 元。');
    assert.equal(revised.progress[lessonId].completed, true);
    assert.deepEqual(revised.notes, chatted.notes);
    assert.equal(JSON.parse(requests.at(-1).payload.messages[1].content).revisionRequest, '术语太多，请用收支表逐步计算并解释');
    const typography = await evaluate("(() => { const body = document.querySelector('.teaching-reading .markdown-content'); return { heading:body.querySelector('h3')?.textContent, subheading:body.querySelector('h4')?.textContent, strong:body.querySelector('strong')?.textContent, steps:body.querySelectorAll('ol > li').length, table:!!body.querySelector('table'), code:!!body.querySelector('pre code'), quote:!!body.querySelector('blockquote'), bodyWhiteSpace:getComputedStyle(body).whiteSpace, headingSize:parseFloat(getComputedStyle(body.querySelector('h3')).fontSize), textSize:parseFloat(getComputedStyle(body.querySelector('p')).fontSize) }; })()");
    assert.equal(typography.heading, '核心结论');
    assert.equal(typography.subheading, '计算步骤');
    assert.equal(typography.strong, '剩余现金 40 元');
    assert.equal(typography.steps, 2);
    assert.ok(typography.table && typography.code && typography.quote);
    assert.equal(typography.bodyWhiteSpace, 'normal');
    assert.ok(typography.headingSize > typography.textSize);
    assert.equal(await evaluate("document.querySelectorAll('.teaching-reading .diagram-node').length"), 10);
    assert.equal(await evaluate("document.querySelectorAll('.teaching-reading .diagram-edge-label').length"), 4);
    assert.equal(await evaluate("document.querySelectorAll('.teaching-reading .learning-chart svg rect').length"), 2);
    assert.match(revised.blockCourses[lessonId].blocks[0].content.text, /```chart/);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(path.join(directory, '..', 'teaching-smoke.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('.teaching-reading .learning-flow').scrollIntoView({block:'center'})");
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(path.join(directory, '..', 'visual-smoke.png'), (await window.webContents.capturePage()).toPNG());
    window.webContents.reload();
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    await wait("document.querySelector('main h1')");
    await evaluate(`document.querySelector('[data-page=routes]').click(); document.querySelector('[data-action=open-lesson][data-id="${lessonId}"]').click()`);
    await wait("document.querySelector('.teaching-reading .learning-chart svg rect')");
    // A failed regeneration keeps both the original text and the feedback field.
    await evaluate(`document.querySelector('[data-action=request-revision][data-block="${exampleId}"]').click()`);
    await evaluate("document.querySelector('#revision-request').value = '测试模型不可用'; document.querySelector('#revision-form').requestSubmit()");
    await wait("document.querySelector('#revision-error').textContent.length > 0 && !document.querySelector('#revision-form button[type=submit]').disabled");
    assert.equal(await evaluate("document.querySelector('#revise-block-dialog').open"), true);
    assert.equal(await evaluate("document.querySelector('#revision-request').value"), '测试模型不可用');
    assert.equal((await store.loadState()).blockCourses[lessonId].blocks[1].content.text, '配套案例：收入 100 元，支出 60 元。');
    await writeFile(path.join(directory, '..', 'feedback-smoke.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('[data-action=close-revision]').click()");
    // Exercise restoration through IPC and then reload from the actual SQLite file.
    await evaluate(`window.learnflowDesktop.restoreBlock(${JSON.stringify(lessonId)}, ${JSON.stringify(readingId)}, ${JSON.stringify(revised.blockCourses[lessonId].blocks[0].content.text)})`);
    window.webContents.reload();
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    await wait("document.querySelector('main h1')");
    await evaluate(`document.querySelector('[data-page=routes]').click(); document.querySelector('[data-action=open-lesson][data-id="${lessonId}"]').click()`);
    await wait("document.querySelector('.teaching-reading .block-text')?.textContent.includes('原始讲解')");
    assert.equal(await evaluate("document.querySelector('[data-action=restore-block]') === null"), true);
    // Generate an AI Wiki card and verify that source Markdown survives a renderer reload.
    await evaluate("document.querySelector('[data-tab=notes]').click(); document.querySelector('[data-action=create-note]').click()");
    await wait("document.querySelector('#note-preview-content h3')?.textContent === '核心概念'");
    assert.equal(await evaluate("document.querySelector('#note-preview-content strong').textContent"), '现金流');
    const aiNote = (await store.loadState()).notes.find(note => note.lessonId === lessonId);
    assert.equal(aiNote.content, wikiMarkdown);
    window.webContents.reload();
    await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    await wait("document.querySelector('main h1')");
    await evaluate(`document.querySelector('[data-page=wiki]').click(); document.querySelector('[data-action=open-note][data-id="${aiNote.id}"]').click()`);
    await wait("document.querySelector('#note-preview-content h3')?.textContent === '核心概念'");
    assert.equal(await evaluate("document.querySelector('#note-content').value"), wikiMarkdown);
  } finally {
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
  }
  await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify({ ...localSettings, model: 'desktop-smoke-model' })})`);
  window.webContents.reload();
  await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  await wait("document.querySelector('main h1')");
  await evaluate("document.querySelector('[data-page=settings]').click()");
  await wait("document.querySelector('#desktop-settings-form')");
  const image = await window.webContents.capturePage();
  await writeFile(path.join(directory, '..', 'settings-smoke.png'), image.toPNG());
  console.log('DESKTOP_SMOKE', JSON.stringify({ passed: true, checks: ['window', 'sandbox', 'settings-save', 'os-encryption', 'cloud-save-confirmation', 'cloud-settings-reload', 'lan-save-confirmation', 'quick-ask-right-dock-and-focus', 'quick-ask-return-position', 'quiz', 'wiki', 'disk-persistence', 'reload', 'lesson-qa', 'plan-invalid-count-repair', 'teaching-unit', 'feedback-regeneration', 'markdown-typography', 'local-diagrams-and-charts-reload', 'markdown-revision-preset', 'reflection-markdown-preview', 'note-markdown-read-edit', 'chat-markdown', 'grounded-markdown-citations', 'ai-wiki-markdown-reload', 'revision-failure-preserves-content', 'revision-restore-reload'], screenshot: path.join(directory, '..', 'settings-smoke.png') }));
};
