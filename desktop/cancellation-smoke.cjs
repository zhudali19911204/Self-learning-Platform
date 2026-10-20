// Only explicit --cancel-only, isolated data and loopback mocks. No real keys.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
exports.run = async (window, directory) => {
  window.webContents.setBackgroundThrottling(false);
  const { demoPlan } = await import('../public/demo.js');
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = expression => evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve();}else if(++n>150){clearInterval(timer);reject(new Error('Cancellation smoke timed out: '+document.querySelector('#toast')?.textContent));}},100);})`);
  const reload = async () => { const ready = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.webContents.reload(); await ready; await wait("document.querySelector('main h1')"); };
  const held = [], calls = []; let mode = 'generation', closed = 0;
  const backend = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw); calls.push(payload.model);
    const review = payload.model === 'cancel-reviewer';
    const reply = () => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(review ? { summary: '本地模拟核查无疑点', issues: [], solutions: [] } : { text: '本次任务新生成的正文。核对条件后再选择方法。' }) }, finish_reason: 'stop' }] }));
    };
    if ((mode === 'generation' && !review) || (mode === 'review' && review)) {
      held.push(reply); res.on('close', () => { if (!res.writableEnded) closed++; });
    } else reply();
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  try {
    const settings = { provider: 'compatible', model: 'cancel-generator', baseUrl: `http://127.0.0.1:${backend.address().port}/v1`, localOnly: true, jsonMode: 'on', timeoutMs: 30000, maxTokens: 8192, keyAction: 'clear', apiKey: '' };
    await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify(settings)})`);
    const plan = { ...structuredClone(demoPlan), id: 'cancel-course', title: '取消任务测试', source: 'ai', lessons: demoPlan.lessons.map((l, i) => ({ ...l, id: `cancel-lesson-${i}` })) }, id = plan.lessons[0].id;
    await evaluate(`window.learnflowDesktop.savePlan(${JSON.stringify(plan)})`);
    const outline = await evaluate(`window.learnflowDesktop.saveOutline('${id}',${JSON.stringify({ intro: '保留的课程导语', blocks: [{ type: 'reading', title: '本次待生成的讲解', objective: '说明条件' }, { type: 'reading', title: '原有讲解', objective: '核对条件' }, { type: 'practice', title: '原有实践', objective: '独立判断' }, { type: 'quiz', title: '原有练习', objective: '检验判断' }] })})`);
    const [target, previous, practice, quiz] = outline.blocks;
    await evaluate(`window.learnflowDesktop.saveBlock('${id}','${previous.id}',{text:'原有讲解：先核对条件，再判断方法。'})`);
    await evaluate(`window.learnflowDesktop.saveBlock('${id}','${practice.id}',{text:'原有实践：写出一个可核对的问题。'})`);
    const questions = Array.from({ length: 4 }, (_, i) => ({ prompt: `原题${i + 1}：应先做什么？`, options: ['核对条件', '忽略条件', '猜测', '跳过'], answer: 0, explanation: '先核对条件。' }));
    await evaluate(`window.learnflowDesktop.saveBlock('${id}','${quiz.id}',${JSON.stringify({ questions })})`);
    const open = async () => { await evaluate(`document.querySelector('[data-page=routes]').click();document.querySelector('[data-action=open-lesson][data-id="${id}"]').click()`); await wait(`document.querySelector('[data-action=generate-block][data-block="${target.id}"]')`); };
    const cancel = async () => {
      await wait("document.querySelector('[data-action=cancel-generation-task]')");
      await evaluate("document.querySelector('[data-action=cancel-generation-task]').click()");
      await wait("document.querySelector('.is-cancelled') && !document.querySelector('.is-running,.is-cancelling')");
    };
    const generate = () => evaluate(`document.querySelector('[data-action=generate-block][data-block="${target.id}"]').click()`);
    const unchanged = async () => {
      const detail = await evaluate(`window.learnflowDesktop.getLesson('${id}')`);
      assert.equal(detail.blockCourse.blocks[0].content, null);
      assert.equal(detail.blockCourse.blocks[1].content.text, '原有讲解：先核对条件，再判断方法。');
      assert.equal(detail.blockCourse.blocks[2].content.text, '原有实践：写出一个可核对的问题。');
      assert.deepEqual(detail.blockCourse.blocks[3].content.questions, questions);
      assert.equal(detail.factChecks.length, 0); return detail;
    };
    await reload(); await open(); await generate();
    await wait("document.querySelector('.generation-progress-message').textContent.includes('生成')");
    // Allow a real local request to reach the mock, then cancel the actual IPC.
    for (let n = 0; held.length < 1 && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(held.length, 1); await cancel(); await unchanged();
    await wait(`!document.querySelector('[data-action=generate-block][data-block="${target.id}"]').disabled`);
    held[0](); await unchanged();
    // Completed draft, still awaiting independent review: discard both draft/report.
    await evaluate(`window.learnflowDesktop.saveQualitySettings(${JSON.stringify({ ...settings, model: 'cancel-reviewer', autoFactCheck: true })})`);
    mode = 'review'; await reload(); await open(); await generate();
    await wait("document.querySelector('.generation-progress-message').textContent.includes('核查')");
    for (let n = 0; held.length < 2 && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(held.length, 2); await cancel(); await unchanged(); held[1]();
    // An in-flight rewrite must keep the original practice, not leave a draft/history.
    mode = 'generation';
    const revision = { lessonId: id, blockId: practice.id, expectedText: '原有实践：写出一个可核对的问题。', request: { goal: plan.goal, level: plan.level, title: plan.lessons[0].title, objective: plan.lessons[0].objective, intro: outline.intro, revisionRequest: '换一个任务', currentExcerpt: '原有实践：写出一个可核对的问题。', sourceSearch: { enabled: false, revision: 0 } } };
    await evaluate(`window.cancelRevision = window.learnflowDesktop.generateCourseBlock(${JSON.stringify(revision)},'generation-smoke-rewrite').then(()=>({unexpected:true}),error=>({message:error.message})); void 0`);
    for (let n = 0; held.length < 3 && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(held.length, 3); assert.equal(await evaluate("window.learnflowDesktop.cancelGeneration('generation-smoke-rewrite')"), true);
    assert.deepEqual(await evaluate('window.cancelRevision'), { message: '任务已取消，本次生成结果已丢弃，原有内容保留。' });
    const intact = await unchanged(); assert.equal(intact.blockCourse.blocks[2].content.history, undefined);
    // Adding questions creates a pending batch first; cancelling removes that batch.
    await evaluate('window.learnflowDesktop.setFactCheckEnabled(false)');
    await reload(); await open(); await evaluate("document.querySelector('[data-action=lesson-tab][data-tab=quiz]').click()");
    await wait("document.querySelector('#more-quiz-form')");
    await evaluate("document.querySelector('#more-quiz-count').value='2';document.querySelector('#more-quiz-form').requestSubmit()");
    for (let n = 0; held.length < 4 && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(held.length, 4); await cancel();
    await wait("!document.querySelector('#more-quiz-form button').disabled");
    assert.equal((await unchanged()).blockCourse.blocks.length, 4);
    // Only an explicit new request is allowed to save after cancellation.
    mode = 'complete'; await reload(); await open(); await generate();
    await wait("document.querySelector('.is-done') && !document.querySelector('.is-running,.is-cancelling')");
    const saved = await evaluate(`window.learnflowDesktop.getLesson('${id}')`);
    assert.equal(saved.blockCourse.blocks[0].content.text, '本次任务新生成的正文。核对条件后再选择方法。');
    assert.equal(calls.length, 6); assert.equal(closed, 4);
    // End on cancelled UI so the screenshot also covers the new control/status.
    mode = 'generation'; await evaluate("document.querySelector('[data-action=lesson-tab][data-tab=quiz]').click()");
    await wait("document.querySelector('#more-quiz-form')"); await evaluate("document.querySelector('#more-quiz-form').requestSubmit()");
    for (let n = 0; held.length < 5 && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(held.length, 5); await cancel(); await wait("!document.querySelector('#more-quiz-form button').disabled");
    assert.equal((await evaluate(`window.learnflowDesktop.getLesson('${id}')`)).blockCourse.blocks.length, 4);
    await writeFile(path.join(directory, 'cancellation-smoke.png'), (await window.webContents.capturePage()).toPNG());
    console.log('CANCELLATION_SMOKE_OK', JSON.stringify({ localCalls: calls.length, cancelledRequests: closed, directory }));
  } finally { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
};
