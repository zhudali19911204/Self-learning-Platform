// Native workflow regression with test-only HTTP models and isolated learning data.
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
exports.run = async (window,directory) => {
  const { demoPlan } = await import('../public/demo.js');
  const evaluate = code => window.webContents.executeJavaScript(code).catch(error=>{console.error('REVISION_SMOKE_STEP',code.slice(0,180));throw error;});
  const wait = expression => evaluate(`new Promise((resolve,reject)=>{let attempts=0;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve(true);}else if(++attempts>150){clearInterval(timer);reject(new Error('Revision smoke timed out: '+document.querySelector('#toast')?.textContent+' / '+document.querySelector('#quality-revision-dialog .inline-error')?.textContent));}},100);})`);
  const reload = async()=>{window.webContents.reload();await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));await wait("document.querySelector('main h1')");};
  const original = await evaluate('window.learnflowDesktop.load()');let generated=0,reviewed=0;
  const server = http.createServer(async(req,res)=>{
    try {
      assert.equal(req.headers.authorization,'Bearer revision-smoke-only-key');
      let body='';for await(const part of req) body+=part;
      const payload=JSON.parse(body),input=JSON.parse(payload.messages[1].content);let result;
      if(payload.model==='revision-smoke-generator') {
        generated++;assert.equal(input.selectedUnits.length,2);
        result={changes:input.selectedUnits.map(unitId=>{const u=input.snapshot.units.find(u=>u.id===unitId);return {unitId,content:u.type==='quiz'?{questions:u.questions.map(q=>({...q,answer:1,explanation:'测试修改后的独立答案。'}))}:{text:'## 核对身份\n\n提交前设置 user.name 和 user.email，并运行 git config --get user.name 核对。'},note:'增加具体核对操作。'};})};
      } else {
        assert.equal(payload.model,'revision-smoke-reviewer');reviewed++;
        assert.ok(!JSON.stringify(input).includes('"answer":'));
        result={summary:'已结合当前稿核对，事实未外部核验。',dimensions:input.rubric.map(r=>({id:r.id,rating:4,reason:'结合目标和操作说明检查。'})),issues:input.selectedIssues?[]:input.units.filter(u=>!u.pending).map(u=>({unitId:u.id,severity:'minor',kind:u.type==='quiz'?'quiz':'clarity',quote:u.text?.slice(0,30)||u.questions[0].prompt,reason:'需要核对具体操作和条件。',suggestion:'增加条件与验证步骤。'})),solutions:input.units.flatMap(u=>(u.questions||[]).map((q,questionIndex)=>({unitId:u.id,questionIndex,answer:1,ambiguous:false,reason:'测试独立求解。'}))),...(input.selectedIssues?{checks:input.selectedIssues.map(i=>({issueIndex:i.issueIndex,status:'not_found',reason:'当前稿补充了操作和条件。'}))}:{})};
      }
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}]}));
    } catch {res.writeHead(500);res.end('Mock validation failed');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  const config = model=>({provider:'compatible',model,baseUrl,localOnly:true,jsonMode:'on',timeoutMs:30000,maxTokens:8192,keyAction:'replace',apiKey:'revision-smoke-only-key'});
  try {
    await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify(config('revision-smoke-generator'))})`);
    await evaluate(`window.learnflowDesktop.saveQualitySettings(${JSON.stringify(config('revision-smoke-reviewer'))})`);
    const plan={...structuredClone(demoPlan),id:`revision-${randomUUID()}`,title:'课程修订闭环测试',lessons:demoPlan.lessons.map(l=>({...l,id:`revision-${randomUUID()}`}))};const lessonId=plan.lessons[0].id;
    await evaluate(`window.learnflowDesktop.savePlan(${JSON.stringify(plan)})`);
    const outline=await evaluate(`window.learnflowDesktop.saveOutline(${JSON.stringify(lessonId)},{intro:'核对身份再提交。',blocks:[{type:'reading',title:'提交身份',objective:'能核对提交身份'},{type:'quiz',title:'提交时机',objective:'能判断提交条件'}]})`);
    const reading={text:'提交前配置身份。'};
    await evaluate(`window.learnflowDesktop.saveBlock(${JSON.stringify(lessonId)},${JSON.stringify(outline.blocks[0].id)},${JSON.stringify(reading)})`);
    await evaluate(`window.learnflowDesktop.saveBlock(${JSON.stringify(lessonId)},${JSON.stringify(outline.blocks[1].id)},{questions:[{prompt:'何时配置身份？',options:['提交前','提交后','删除时','无关'],answer:0,explanation:'提交前需要身份。'}]})`);
    await evaluate(`window.learnflowDesktop.saveProgress(${JSON.stringify(lessonId)},{completed:true,attempts:1,lastScore:100,bestScore:100,lastAnswers:[0]})`);
    const inspection=await evaluate(`window.learnflowDesktop.inspectQuality('lesson',${JSON.stringify(lessonId)})`);
    await evaluate(`window.learnflowDesktop.evaluateQuality('lesson',${JSON.stringify(lessonId)},${JSON.stringify(inspection.fingerprint)})`);
    await reload();await evaluate(`document.querySelector('[data-page=routes]').click();document.querySelector('[data-action=open-lesson][data-id="${lessonId}"]').click()`);
    await wait("document.querySelector('[data-action=open-quality]')");await evaluate("document.querySelector('[data-action=open-quality]').click()");
    await wait("document.querySelectorAll('[name=revision-issue]').length>=2");
    await evaluate("document.querySelector('[name=revision-issue][value=\"0\"]').checked=true;document.querySelector('[name=revision-issue][value=\"1\"]').checked=true;document.querySelector('[data-action=quality-create-revision]').click()");
    await wait("document.querySelector('#quality-revision-dialog').open");assert.equal(generated,0);assert.equal(reviewed,1);
    await evaluate("document.querySelector('[data-action=quality-generate-revision]').click()");
    await wait("document.querySelectorAll('.revision-change').length===2 && !document.querySelector('[data-action=quality-review-revision]').disabled");
    assert.equal(generated,1);assert.equal((await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(lessonId)})`)).blockCourse.blocks[0].content.text,reading.text);
    const quizSelector=`#revision-edit-${outline.blocks[1].id}`,savedQuiz=await evaluate(`document.querySelector(${JSON.stringify(quizSelector)}).value`);
    await evaluate(`document.querySelector(${JSON.stringify(quizSelector)}).value='invalid JSON';document.querySelector(${JSON.stringify(quizSelector)}).dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=quality-review-revision]').click()`);
    await wait("document.querySelector('#quality-revision-dialog .inline-error').textContent.includes('有效的题目 JSON')");assert.equal(reviewed,1);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(quizSelector)}).value`),'invalid JSON');
    await evaluate(`document.querySelector(${JSON.stringify(quizSelector)}).value=${JSON.stringify(savedQuiz)};document.querySelector(${JSON.stringify(quizSelector)}).dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action=quality-review-revision]').click()`);
    await wait("document.querySelector('.revision-review') && !document.querySelector('[data-action=quality-apply-revision]').disabled");assert.equal(reviewed,2);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await writeFile(path.join(directory,'..','revision-smoke.png'),(await window.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('[data-action=quality-apply-revision]').click()");
    await wait("document.querySelector('#quality-revision-dialog .inline-error').textContent.includes('确认应用')");
    assert.equal((await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(lessonId)})`)).blockCourse.blocks[0].content.text,reading.text);
    await evaluate("document.querySelector('#revision-confirmed').checked=true;document.querySelector('[data-action=quality-apply-revision]').click()");
    await wait("document.querySelector('[data-action=quality-restore-revision]') && !document.querySelector('[data-action=quality-restore-revision]').disabled");
    const applied=await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(lessonId)})`);assert.notEqual(applied.quizRecord.currentFingerprint,applied.quizRecord.progressFingerprint);
    await evaluate("document.querySelector('[data-action=quality-close-revision]').click();document.querySelector('[data-action=lesson-tab][data-tab=quiz]').click()");
    await wait("document.querySelector('.quiz-version-notice').textContent.includes('尚未练习')");
    assert.equal((await evaluate('window.learnflowDesktop.load()')).state.progress[lessonId].bestScore,100);
    await evaluate("document.querySelector('[data-action=open-quality]').click()");await wait("document.querySelector('[data-action=quality-open-revision]')");
    await evaluate("document.querySelector('[data-action=quality-open-revision]').click()");await wait("document.querySelector('#quality-revision-dialog').open && document.querySelector('[data-action=quality-restore-revision]')");
    // Avoid an interactive native confirm in the hidden automated window.
    await evaluate('window.confirm=()=>true;true');await evaluate("document.querySelector('[data-action=quality-restore-revision]').click()");
    await wait("document.querySelector('#quality-revision-dialog').textContent.includes('已恢复原版') && !document.querySelector('[data-action=quality-restore-revision]')");
    assert.equal((await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(lessonId)})`)).blockCourse.blocks[0].content.text,reading.text);
    assert.equal(generated,1);assert.equal(reviewed,2);
    await evaluate("document.querySelector('[data-action=quality-close-revision]').click()");
    console.log('REVISION_SMOKE',JSON.stringify({passed:true,generationCalls:generated,reviewCalls:reviewed,checks:['free-task-creation','draft-diff-original-preserved','invalid-edit-no-paid-review','independent-review','confirmation-required','atomic-apply-report','versioned-quiz-progress','reopen-and-restore'],screenshot:path.join(directory,'..','revision-smoke.png')}));
  } finally {
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await evaluate(`window.learnflowDesktop.saveSettings(${JSON.stringify({...original.settings,keyAction:'keep',apiKey:''})})`);
    await evaluate(`window.learnflowDesktop.saveQualitySettings(${JSON.stringify({...original.qualitySettings,keyAction:'keep',apiKey:''})})`);
    await evaluate(`window.learnflowDesktop.setActivePlan(${JSON.stringify(original.state.active)})`);await reload();
  }
};
