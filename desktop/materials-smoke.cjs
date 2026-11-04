const assert=require('node:assert/strict');
const {dialog}=require('electron');
const path=require('node:path');
const {writeFile}=require('node:fs/promises');
exports.run=async(window,directory,fixture)=>{
 const evaluate=code=>window.webContents.executeJavaScript(code,true);
 window.webContents.setBackgroundThrottling(false);
 window.setMinimumSize(320,480);
 const frames=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
 const wait=expression=>evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve();}else if(++n>200){clearInterval(timer);reject(Error('Material UI timed out: '+${JSON.stringify(expression)}));}},75);})`);
 const {wordFixture,pdfFixture}=await import('../test-support/materials.mjs');
 const files=[path.join(directory,'guide.md'),path.join(directory,'guide.docx'),path.join(directory,'guide.pdf')];
 await writeFile(files[0],'# 文件操作\n保存文件后应重新打开，核对文件名、保存位置与文件中的实际内容。');
 await writeFile(files[1],await wordFixture('保存文件后，应重新打开核对。\n不要把快捷方式当作原文件。'));
 await writeFile(files[2],pdfFixture());
 let selectedFiles=files;
 const original=dialog.showOpenDialog;dialog.showOpenDialog=async()=>({canceled:false,filePaths:selectedFiles});
 try {
  await wait("document.querySelector('[data-action=planner]')");
  await evaluate("document.querySelector('[data-action=planner]').click(); document.querySelector('#goal').value='用 Word 保存一份练习文档，再重新打开核对文件位置与内容'; document.querySelector('[data-action=import-planner-materials]').click()");
  await wait("document.querySelectorAll('.planner-material-item').length===3");
  assert.equal(fixture.counts.generations,0);
  assert.equal(await evaluate("document.querySelector('#goal').value.includes('Word')"),true);
  await evaluate("document.querySelectorAll('[data-action=preview-planner-material]')[1].click()");
  assert.equal(await evaluate("document.querySelector('#material-preview-dialog').textContent.includes('快捷方式')"),true);
  await frames();
  await writeFile(path.join(directory,'material-preview.png'),(await window.webContents.capturePage()).toPNG());
  window.setContentSize(390,900);await frames();
  assert.equal(await evaluate('innerWidth'),390);
  assert.equal(await evaluate("(()=>{const d=document.querySelector('#material-preview-dialog');return d.scrollWidth<=d.clientWidth&&d.getBoundingClientRect().left>=0&&d.getBoundingClientRect().right<=innerWidth;})()"),true);
  await writeFile(path.join(directory,'material-preview-390.png'),(await window.webContents.capturePage()).toPNG());
  window.setContentSize(1360,900);await frames();
  await evaluate("document.querySelector('[data-action=close-material-preview]').click()");
  const moreFiles=[];
  for(let i=4;i<=20;i++) {
    const filename=path.join(directory,`guide-${i}.md`);
    await writeFile(filename,i===20?'保存与核对：用 Word 保存练习文档之后，应重新打开核对文件位置和实际内容。':`背景材料 ${i}：此文档仅描述其他背景，不包含文件保存的具体操作。`);
    moreFiles.push(filename);
  }
  selectedFiles=moreFiles;
  await evaluate("document.querySelector('[data-action=import-planner-materials]').click()");
  await wait("document.querySelectorAll('.planner-material-item').length===20");
  assert.equal(await evaluate("document.querySelector('[data-action=import-planner-materials]').disabled"),true);
  assert.equal(fixture.counts.generations,0);
  window.setContentSize(390,900);await frames();
  assert.equal(await evaluate("(()=>{const d=document.querySelector('#planner'),list=d.querySelector('.planner-material-list');return d.scrollWidth<=d.clientWidth&&list.clientHeight<=260&&list.scrollHeight>list.clientHeight;})()"),true);
  await writeFile(path.join(directory,'material-library-20.png'),(await window.webContents.capturePage()).toPNG());
  window.setContentSize(1360,900);await frames();
  await evaluate("document.querySelector('#plan-form').requestSubmit()");
  await wait("document.querySelector('#clarification-form')");
  await evaluate("document.querySelectorAll('.clarification-question').forEach(q=>q.querySelector('input').checked=true);document.querySelector('#clarification-form').requestSubmit()");
  await wait("document.querySelector('#plan-confirm-form')");
  await evaluate("document.querySelector('#plan-confirm-form').requestSubmit()");
  await wait("!document.querySelector('#planner').open");
  const saved=await evaluate("window.learnflowDesktop.load()");
  const plan=saved.state.plans.find(p=>p.title==='导入资料课程测试');
  assert.ok(plan);assert.equal(plan.materials.length,20);
  await evaluate(`document.querySelector('[data-action=open-lesson][data-id="${plan.lessons[0].id}"]').click()`);
  await wait("document.querySelector('[data-action=generate-lesson]') || document.querySelector('[data-action=generate-block]')");
  await evaluate("(document.querySelector('[data-action=generate-lesson]')||document.querySelector('[data-action=generate-block]')).click()");
  await wait("document.querySelector('.course-inline-citation') || document.querySelector('[data-action=generate-block]')");
  if(!await evaluate("!!document.querySelector('.course-inline-citation')")) {
   await evaluate("document.querySelector('[data-action=generate-block]').click()");
   await wait("document.querySelector('.course-inline-citation')");
  }
  assert.equal(await evaluate("document.querySelector('.course-source-controls').textContent.includes('本地资料')"),true);
  await evaluate("document.querySelector('.course-inline-citation').click()");
  await wait("document.querySelector('#material-preview-dialog')?.open");
  assert.equal(await evaluate("!!document.querySelector('.material-part-selected')"),true);
  assert.equal(fixture.counts.searches,0);
  assert.equal(fixture.counts.largestCatalog,20);assert.ok(fixture.counts.largestDocumentCount<=3);assert.ok(fixture.counts.sentCharacters<=19800);
  console.log('MATERIALS_SMOKE',JSON.stringify({passed:true,formats:3,library:20,realModelCalls:0,...fixture.counts,screenshot:path.join(directory,'material-library-20.png')}));
 } finally {dialog.showOpenDialog=original;}
};
