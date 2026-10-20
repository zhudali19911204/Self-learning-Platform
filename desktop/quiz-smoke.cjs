// Explicit isolated smoke mode: all model requests go to this loopback server.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
exports.run = async (window, directory) => {
  window.webContents.setBackgroundThrottling(false);
  const { demoPlan } = await import('../public/demo.js');
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = expression => evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve();}else if(++n>150){clearInterval(timer);reject(new Error('Quiz smoke timed out: '+document.querySelector('#toast')?.textContent));}},100);})`);
  const reload = async () => { const ready = new Promise(resolve => window.webContents.once('did-finish-load', resolve)); window.webContents.reload(); await ready; await wait("document.querySelector('main h1')"); };
  const calls = []; let failNext = false;
  const backend = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw), input = JSON.parse(payload.messages[1].content); calls.push(input);
      assert.equal(payload.model, 'quiz-smoke-model'); assert.equal(input.block.type, 'quiz');
      assert.ok(!raw.includes('private-note')); assert.ok(!raw.includes('lastAnswers'));
      if (failNext) { failNext = false; res.writeHead(503); res.end('mock upstream error'); return; }
      const questions = Array.from({ length: input.questionCount }, (_, i) => ({ prompt: `新增第${calls.length}组第${i + 1}个情境：应先做什么？`, options: ['核对任务与条件', '忽略条件', '只看表面', '跳过检查'], answer: 0, explanation: '应依据已讲方法，先核对任务与条件。' }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions }) }, finish_reason: 'stop' }] }));
    } catch (error) { console.error('QUIZ_SMOKE_MOCK', error.message); res.writeHead(500); res.end('mock validation error'); }
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  try {
    await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify({ provider: 'compatible', model: 'quiz-smoke-model', baseUrl: `http://127.0.0.1:${backend.address().port}/v1`, localOnly: true, jsonMode: 'on', timeoutMs: 30000, maxTokens: 8192, keyAction: 'clear', apiKey: '' })})`);
    const plan = { ...structuredClone(demoPlan), id: 'quiz-course', title: '追加练习测试', source: 'ai', lessons: demoPlan.lessons.map((l, i) => ({ ...l, id: `quiz-lesson-${i}` })) }, id = plan.lessons[0].id;
    await evaluate(`window.learnflowDesktop.savePlan(${JSON.stringify(plan)})`);
    const outline = await evaluate(`window.learnflowDesktop.saveOutline('${id}',${JSON.stringify({ intro: '已讲内容', blocks: [{ type: 'reading', title: '核对方法', objective: '核对任务与条件' }, { type: 'quiz', title: '初始四题', objective: '应用判断' }] })})`);
    const questions = Array.from({ length: 4 }, (_, i) => ({ prompt: `原题${i + 1}：选择正确条件。`, options: ['条件甲', '条件乙', '条件丙', '条件丁'], answer: i, explanation: `本题依据条件${i + 1}判断。` }));
    await evaluate(`window.learnflowDesktop.saveBlock('${id}','${outline.blocks[0].id}',{text:'先核对任务和条件，再判断方法是否适用。'})`);
    await evaluate(`window.learnflowDesktop.saveBlock('${id}','${outline.blocks[1].id}',${JSON.stringify({ questions })})`);
    const open = async () => { await evaluate(`document.querySelector('[data-page=routes]').click();document.querySelector('[data-action=open-lesson][data-id="${id}"]').click()`); await wait("document.querySelector('[data-action=lesson-tab][data-tab=quiz]')"); await evaluate("document.querySelector('[data-action=lesson-tab][data-tab=quiz]').click()"); await wait("document.querySelector('#more-quiz-form')"); };
    await reload(); await open();
    await evaluate("for(const [i,a] of [[0,0],[1,0],[2,2],[3,0]])document.querySelector('#quiz-form input[name=q'+i+'][value=\"'+a+'\"]').checked=true;document.querySelector('#quiz-form').requestSubmit()");
    await wait("document.querySelectorAll('.quiz-mastered').length===2");
    assert.equal(calls.length, 0);
    await evaluate("document.querySelector('#more-quiz-count').value='3';document.querySelector('#more-quiz-form').requestSubmit()");
    await wait("document.querySelectorAll('.question').length===7 && !document.querySelector('#more-quiz-form button').disabled");
    assert.equal(calls.length, 1); assert.equal(calls[0].questionCount, 3); assert.equal(calls[0].existingQuestions.length, 4);
    const appended = await evaluate(`window.learnflowDesktop.getLesson('${id}')`);
    assert.deepEqual(appended.blockCourse.blocks[1].content.questions, questions);
    assert.equal(await evaluate("document.querySelectorAll('.quiz-mastered').length"), 2);
    assert.equal(await evaluate("document.querySelector('#quiz-form [name=q0]')"), null);
    assert.equal(await evaluate("document.querySelector('#quiz-form [name=q2]')"), null);
    await evaluate("for(const [i,a] of [[1,1],[3,3],[4,0],[5,0],[6,0]])document.querySelector('#quiz-form input[name=q'+i+'][value=\"'+a+'\"]').checked=true;document.querySelector('#quiz-form').requestSubmit()");
    await wait("document.querySelectorAll('.quiz-mastered').length===7");
    assert.equal((await evaluate(`window.learnflowDesktop.getLesson('${id}')`)).progress.lastScore, 100);
    await reload(); await open(); await wait("document.querySelectorAll('.quiz-mastered').length===7");
    assert.equal(await evaluate("document.querySelector('#quiz-form input')"), null);
    failNext = true;
    await evaluate("document.querySelector('#more-quiz-count').value='1';document.querySelector('#more-quiz-form').requestSubmit()");
    await wait("document.querySelector('.more-quiz-panel .inline-error').textContent.includes('原题和成绩已保留') && !document.querySelector('#more-quiz-form button').disabled");
    assert.equal(calls.length, 2); assert.equal(await evaluate("document.querySelectorAll('.quiz-mastered').length"), 7);
    const failed = await evaluate(`window.learnflowDesktop.getLesson('${id}')`);
    assert.equal(failed.progress.lastScore, 100);
    await evaluate("document.querySelector('#more-quiz-form').requestSubmit()");
    await wait("document.querySelectorAll('.question').length===8 && !document.querySelector('#more-quiz-form button').disabled");
    assert.equal(calls.length, 3); const retried = await evaluate(`window.learnflowDesktop.getLesson('${id}')`);
    assert.equal(retried.blockCourse.blocks.length, failed.blockCourse.blocks.length, 'retry reuses the pending batch');
    assert.equal(await evaluate("document.querySelectorAll('.quiz-mastered').length"), 7);
    await evaluate("document.querySelector('#quiz-form input[name=q7][value=\"0\"]').checked=true;document.querySelector('#quiz-form').requestSubmit()");
    await wait("document.querySelectorAll('.quiz-mastered').length===8");
    await evaluate("document.querySelector('#more-quiz-form').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const screenshot = path.join(directory, 'quiz-append-smoke.png'); await writeFile(screenshot, (await window.webContents.capturePage()).toPNG());
    console.log('QUIZ_SMOKE_OK', JSON.stringify({ passed: true, calls: calls.length, questions: 8, realKeyCalls: 0, checks: ['append-selected-count', 'original-questions-preserved', 'passed-questions-show-answers', 'only-unpassed-answers-required', 'grades-survive-reload', 'failed-batch-retried-once-explicitly'], screenshot }));
  } finally { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
};
