const assert=require('node:assert/strict');
const path=require('node:path');
const {writeFile}=require('node:fs/promises');
exports.run=async(window,directory,fixture)=>{
 const evaluate=code=>window.webContents.executeJavaScript(code,true);
 const frames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const wait=expression=>evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve();}else if(++n>150){clearInterval(timer);reject(Error('Plan adjustment timed out: '+${JSON.stringify(expression)}));}},75);})`);
 window.webContents.setBackgroundThrottling(false);window.setMinimumSize(320,480);
 const {demoPlan,demoLessons}=await import('../public/demo.js');
 const material={version:1,id:'a'.repeat(64),name:'目录调整操作手册.md',type:'md',bytes:100,importedAt:Date.now(),parts:[{id:'part-1',location:'第 1 行',text:'保存文件后，重新打开并核对目录、名称与实际内容。通过完整案例练习上述步骤。'}]};
 const original={...structuredClone(demoPlan),id:'adjustment-original',source:'ai',title:'文件操作学习路线',category:'办公与自动化',materials:[material],lessons:demoPlan.lessons.map((l,i)=>({...l,id:`original-lesson-${i}`}))};
 await evaluate(`window.learnflowDesktop.savePlan(${JSON.stringify(original)})`);
 await evaluate(`window.learnflowDesktop.saveLesson('original-lesson-0',${JSON.stringify(demoLessons.p1)})`);
 await evaluate("window.learnflowDesktop.appendChat('original-lesson-0','不应发送的私人聊天','已有答疑')");
 const originalDetail=await evaluate("window.learnflowDesktop.getLesson('original-lesson-0')");
 window.webContents.reload();await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
 await wait("document.querySelector('[data-page=routes]')");await evaluate("document.querySelector('[data-page=routes]').click()");
 const baseline=(await evaluate('window.learnflowDesktop.load()')).state;
 const requirement='先提供完整案例，再拆解操作步骤，最后安排综合实践。';
 const preview=async()=>{
  await evaluate("document.querySelector('[data-action=open-plan-adjustment]').click()");
  await evaluate(`(()=>{const t=document.querySelector('#plan-adjustment-requirement');t.value=${JSON.stringify(requirement)};t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#plan-adjustment-form').requestSubmit();})()`);
  try { await wait("document.querySelector('.plan-adjustment-preview')&&!document.querySelector('[data-action=save-plan-adjustment]').disabled"); }
  catch (error) {
   const diagnostics=await evaluate(`(()=>({preview:!!document.querySelector('.plan-adjustment-preview'),disabled:document.querySelector('[data-action=save-plan-adjustment]')?.disabled,error:document.querySelector('#plan-adjustment-error')?.textContent,requirement:document.querySelector('#plan-adjustment-requirement')?.value,staleHidden:document.querySelector('#plan-adjustment-stale')?.hidden}))()`);
   throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
  }
 };
 await preview();assert.equal((await evaluate('window.learnflowDesktop.load()')).state.plans.length,baseline.plans.length);
 await frames();await writeFile(path.join(directory,'plan-adjustment-preview.png'),(await window.webContents.capturePage()).toPNG());
 window.setContentSize(390,900);await frames();
 assert.equal(await evaluate("(()=>{const d=document.querySelector('#plan-adjustment-dialog');return innerWidth===390&&d.scrollWidth<=d.clientWidth&&d.getBoundingClientRect().right<=innerWidth;})()"),true);
 await writeFile(path.join(directory,'plan-adjustment-390.png'),(await window.webContents.capturePage()).toPNG());
 window.setContentSize(1360,920);await frames();
 await evaluate("document.querySelector('[data-action=close-plan-adjustment]').click()");assert.equal((await evaluate('window.learnflowDesktop.load()')).state.plans.length,baseline.plans.length);
 await preview();await evaluate("document.querySelector('[data-action=save-plan-adjustment]').click()");await wait("!document.querySelector('#plan-adjustment-dialog').open");
 const after=(await evaluate('window.learnflowDesktop.load()')).state,adjusted=after.plans.find(p=>p.id===after.active);
 assert.equal(after.plans.length,baseline.plans.length+1);assert.notEqual(adjusted.id,original.id);assert.match(adjusted.title,/（调整版）$/);
 assert.equal(adjusted.category,original.category);assert.deepEqual(adjusted.materials,[material]);assert.equal(adjusted.learningBrief.adjustments.at(-1),requirement);
 assert.deepEqual(after.plans.find(p=>p.id===original.id),baseline.plans.find(p=>p.id===original.id));
 assert.deepEqual(await evaluate("window.learnflowDesktop.getLesson('original-lesson-0')"),originalDetail);
 assert.equal((await evaluate(`window.learnflowDesktop.getLesson(${JSON.stringify(adjusted.lessons[0].id)})`)).lesson,null);
 await evaluate(`document.querySelector('[data-action=open-lesson][data-id="${adjusted.lessons[0].id}"]').click()`);
 await wait("document.querySelector('#course-syllabus .syllabus-adjust')");
 await frames();await writeFile(path.join(directory,'plan-adjustment-syllabus.png'),(await window.webContents.capturePage()).toPNG());
 window.webContents.reload();await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));await wait("document.querySelector('[data-page=routes]')");
 const reopened=(await evaluate('window.learnflowDesktop.load()')).state;
 assert.equal(reopened.plans.find(p=>p.id===adjusted.id).learningBrief.adjustments.at(-1),requirement);
 assert.equal(fixture.counts.generations,2);assert.equal(fixture.counts.searches,0);
 console.log('PLAN_ADJUSTMENT_SMOKE',JSON.stringify({passed:true,previewBeforeSaving:true,cancelPreservesOriginal:true,materialReuse:true,originalBodyAndChatPreserved:true,reload:true,narrowScreen:true,...fixture.counts,realModelCalls:0,screenshots:directory}));
};
