// Real Chromium layout checks. Only runs in the disposable --smoke-test profile.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { mkdir, writeFile } = require('node:fs/promises');

exports.run = async (window, directory) => {
  const { demoPlan } = await import('../public/demo.js');
  const evaluate = code => window.webContents.executeJavaScript(code, true);
  const frames = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const wait = expression => evaluate(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(${expression}){clearInterval(timer);resolve()}else if(++n>100){clearInterval(timer);reject(new Error('UI smoke timed out'));}},50);})`);
  const screenshots = path.join(directory, '..', 'round-one-previews');
  await mkdir(screenshots, { recursive:true });
  window.webContents.setBackgroundThrottling(false);
  window.setMinimumSize(320, 480);
  const original = (await evaluate('window.learnflowDesktop.load()')).state;
  const plan = { ...structuredClone(demoPlan), id:`ui-${randomUUID()}`, title:'用 AI 提升日常工作效率', source:'ai', lessons:demoPlan.lessons.map((lesson,i)=>({ ...lesson, id:`ui-${randomUUID()}`, ...(i===0?{title:'从清晰的问题到可靠的输出：理解输入、约束与验证，并在实际工作中复用',objective:'通过明确目标、约束与检查方式，完成一次可核对的工作任务。'}:{}) })) };
  const lessonId = plan.lessons[0].id;
  await evaluate(`window.learnflowDesktop.savePlan(${JSON.stringify(plan)})`);
  const outline = { intro:'先理解任务，再设计输入，最后核对结果。这里的所有内容均为本地界面测试素材。', blocks:[
    {type:'reading',title:'把业务问题拆成清晰的目标、输入与完成标准',objective:'能用自己的话描述任务，并列出验证方式。'},
    {type:'example',title:'案例：将会议纪要整理为可执行的待办事项',objective:'观察目标、约束和检查方式的配合。'},
    {type:'practice',title:'独立实践：为自己的任务制定输入和完成标准',objective:'写出任务目标、必要输入与可检查的结果。'},
    {type:'quiz',title:'随堂练习',objective:'检查核心方法的理解。'},
    {type:'summary',title:'本课总结',objective:'回顾任务拆解的核心步骤。'}
  ] };
  const course = await evaluate(`window.learnflowDesktop.saveOutline(${JSON.stringify(lessonId)},${JSON.stringify(outline)})`);
  const reading = '## 从问题开始\n\n**清晰的目标**是一个可以核对的结果。先说明任务背景，再列出输入与约束。\n\n'+Array.from({length:18},(_,i)=>`### 检查点 ${i+1}\n\n写下需要完成的事情、已有材料和完成标准。结果生成后，逐项核对，不将表达流畅等同于事实准确。\n\n`).join('');
  for (const block of course.blocks.filter(block=>block.type!=='quiz')) {
    const content = {text:block.type==='reading'?reading:block.type==='example'?'## 示例\n\n将待办写成负责人、动作与时间。\n\n```text\n负责人：项目组\n动作：核对会议结论\n完成时间：确认后填写\n```':block.type==='practice'?'## 你的任务\n\n1. 选择一个实际问题。\n2. 说明必要输入。\n3. 列出完成标准。':'## 核心步骤\n\n- 明确目标。\n- 列出输入与约束。\n- 检查生成结果。'};
    await evaluate(`window.learnflowDesktop.saveBlock(${JSON.stringify(lessonId)},${JSON.stringify(block.id)},${JSON.stringify(content)})`);
  }
  window.webContents.reload();
  await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
  await wait("document.querySelector('.home-continue [data-action=open-lesson]')");
  const learningData=({studyPositions,...state})=>JSON.stringify(state);
  const baseline = learningData((await evaluate('window.learnflowDesktop.load()')).state);
  const checks = [];
  for (const width of [1920, 1680, 1360, 1100, 900, 760, 560, 390]) {
    window.setContentSize(width, 900);
    await evaluate("document.querySelector('[data-page=home]').click(); window.scrollTo(0,0)"); await frames();
    const home = await evaluate(`(() => {const hero=document.querySelector('.page-home .hero'),stats=document.querySelector('.page-home .stats'),dashboard=document.querySelector('.page-home .dashboard-columns');return {overflow:document.documentElement.scrollWidth>innerWidth,primaryHeight:document.querySelector('.home-continue .btn.primary').getBoundingClientRect().height,heroBeforeStats:hero.nextElementSibling===stats,statsBeforeDashboard:stats.nextElementSibling===dashboard,panels:[...dashboard.children].map(panel=>panel.className),columns:getComputedStyle(dashboard).gridTemplateColumns.split(' ').length,floatingCards:hero.querySelectorAll('.float-card').length};})()`);
    assert.equal(home.overflow, false, `home overflow at ${width}`);
    assert.equal(home.heroBeforeStats,true); assert.equal(home.statsBeforeDashboard,true);
    assert.deepEqual(home.panels,['home-continue','home-knowledge']);
    assert.equal(home.columns,width>560?2:1); assert.equal(home.floatingCards,3);
    assert.equal(home.primaryHeight, 40);
    await writeFile(path.join(screenshots,`home-${width}.png`),(await window.webContents.capturePage()).toPNG());
    if(width===1360 || width===390) {
      await evaluate("document.querySelector('.dashboard-columns').scrollIntoView({block:'start'})"); await frames();
      await writeFile(path.join(screenshots,`home-panels-${width}.png`),(await window.webContents.capturePage()).toPNG());
    }
    await evaluate("document.querySelector('.home-continue [data-action=open-lesson]').click()");
    await wait("document.querySelector('.teaching-reading .block-text')"); await frames();
    const directoryWidth = await evaluate("({viewport:innerWidth,directory:document.querySelector('#course-syllabus').getBoundingClientRect().width,reader:document.querySelector('.lesson-content').getBoundingClientRect().width})");
    if(directoryWidth.viewport>1050) {
      assert.equal(directoryWidth.directory,directoryWidth.viewport>1200?280:240,'Directory width follows the wider desktop layout');
      assert.ok(directoryWidth.reader>=520,'Wider directory must leave room for the lesson');
    }
    const directoryToggle = await evaluate(`(() => {const toggle=document.querySelector('.syllabus-toggle'),back=toggle.previousElementSibling,rect=toggle.getBoundingClientRect(),backRect=back.getBoundingClientRect();return {gap:rect.left-backRect.right,sameRow:Math.abs(rect.top+rect.height/2-backRect.top-backRect.height/2)<2,height:rect.height,icons:toggle.querySelectorAll('svg').length,background:getComputedStyle(toggle).backgroundColor};})()`);
    assert.ok(directoryToggle.gap>=8 && directoryToggle.gap<=16 && directoryToggle.sameRow, `directory control not next to Back at ${width}`);
    assert.equal(directoryToggle.height,36); assert.equal(directoryToggle.icons,2);
    assert.notEqual(directoryToggle.background,'rgba(0, 0, 0, 0)');
    await evaluate("document.querySelector('.syllabus-toggle').click()");
    assert.equal(await evaluate("document.querySelector('#course-syllabus').hidden && document.querySelector('.syllabus-toggle').getAttribute('aria-expanded')==='false' && document.querySelector('.syllabus-toggle').querySelectorAll('svg').length===2"),true);
    await frames();
    const collapsedLayout = await evaluate(`(() => {const layout=document.querySelector('.study-layout'),reader=document.querySelector('.lesson-content'),intro=reader.querySelector('.lesson-intro'),blocks=reader.querySelector('.block-sequence'),outer=layout.getBoundingClientRect(),rect=reader.getBoundingClientRect(),style=getComputedStyle(reader);return {leftGap:rect.left-outer.left,rightGap:outer.right-rect.right,readerWidth:rect.width,bodyWidth:reader.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),introWidth:intro.getBoundingClientRect().width,blocksWidth:blocks.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
    assert.ok(Math.abs(collapsedLayout.leftGap)<1 && Math.abs(collapsedLayout.rightGap)<1,`Collapsed reader must fill its available column at ${width}`);
    assert.ok(Math.abs(collapsedLayout.introWidth-collapsedLayout.bodyWidth)<1 && Math.abs(collapsedLayout.blocksWidth-collapsedLayout.bodyWidth)<1,`Collapsed lesson body must not retain the centered 880px limit at ${width}`);
    assert.equal(collapsedLayout.overflow,false,`Collapsed reader overflow at ${width}`);
    if(width===1920 || width===1360 || width===390) await writeFile(path.join(screenshots,`directory-collapsed-${width}.png`),(await window.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('.syllabus-toggle').click()"); await frames();
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.lesson-content')).maxWidth"),'1040px','Reopening the directory restores the normal reader limit');
    const study = await evaluate(`(() => { const toolbar=document.querySelector('.lesson-toolbar'), section=document.querySelector('.teaching-reading'); return {overflow:document.documentElement.scrollWidth>innerWidth,bodyFont:getComputedStyle(section.querySelector('.block-text')).fontSize,position:getComputedStyle(toolbar).position,tabs:toolbar.querySelectorAll('[role=tab]').length,controlsOutside:!toolbar.querySelector('.course-source-controls,.quality-entry,.knowledge-entry-toolbar'),switches:[...document.querySelectorAll('.course-source-controls [role=switch]')].map(x=>x.dataset.action),heights:[section.querySelector('.revision-actions>.btn'),section.querySelector('.more-learning-tools>summary'),section.querySelector('.block-collapse-toggle')].map(x=>x.getBoundingClientRect().height)}; })()`);
    assert.equal(study.overflow, false, `study overflow at ${width}`);
    assert.equal(study.bodyFont, '16px'); assert.equal(study.position,'sticky'); assert.equal(study.tabs,2); assert.equal(study.controlsOutside,true);
    await evaluate("document.querySelector('[data-action=quick-ask]').click()");
    assert.equal(await evaluate("!!document.querySelector('.study-chat') && !!document.querySelector('.quick-ask-button.active') && !document.querySelector('.lesson-toolbar [data-tab=chat]')"),true,'Only the floating Q&A entry remains');
    await evaluate("document.querySelector('[data-action=back-to-reading]').click()"); await frames();
    assert.deepEqual(study.switches,['toggle-course-search','toggle-course-fact-check']);
    assert.deepEqual(study.heights,[32,32,32]);
    await writeFile(path.join(screenshots,`study-${width}.png`),(await window.webContents.capturePage()).toPNG());
    await evaluate("window.scrollTo(0,document.querySelector('.lesson-toolbar').getBoundingClientRect().top+scrollY+240)"); await frames();
    const sticky = await evaluate("({top:document.querySelector('.lesson-toolbar').getBoundingClientRect().top,height:document.querySelector('.lesson-toolbar').getBoundingClientRect().height,viewport:innerHeight})");
    assert.ok(Math.abs(sticky.top)<1, `toolbar did not stick at ${width}: ${sticky.top}`);
    assert.ok(sticky.height<sticky.viewport*.4);
    if (width===1360 || width===390) await writeFile(path.join(screenshots,`sticky-${width}.png`),(await window.webContents.capturePage()).toPNG());
    await evaluate("window.scrollTo(0,0);document.querySelector('.teaching-reading .block-collapse-toggle').click()");
    assert.equal(await evaluate("document.querySelector('.teaching-reading .block-collapsible-body').hidden"),true);
    await evaluate("document.querySelector('.teaching-reading .block-collapse-toggle').click();document.querySelector('.teaching-reading .more-learning-tools>summary').scrollIntoView({block:'center'});document.querySelector('.teaching-reading .more-learning-tools>summary').click()"); await frames();
    const menu = await evaluate("(() => { const menu=document.querySelector('.teaching-reading .more-learning-tools-menu'),rect=menu.getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,viewport:innerWidth,height:innerHeight,visible:!!document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)?.closest('.more-learning-tools-menu')}; })()");
    assert.ok(menu.left>=0 && menu.right<=menu.viewport && menu.top>=0 && menu.bottom<=menu.height && menu.visible, `module tools outside window or covered at ${width}`);
    await evaluate("document.querySelector('.teaching-reading .more-learning-tools').open=false;document.querySelector('[data-page=settings]').click();window.scrollTo(0,0)"); await frames();
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `settings overflow at ${width}`);
    if (width===1360 || width===390) await writeFile(path.join(screenshots,`settings-${width}.png`),(await window.webContents.capturePage()).toPNG());
    checks.push({width,home,study,sticky,directoryToggle,directoryWidth,collapsedLayout});
  }
  assert.equal(learningData((await evaluate('window.learnflowDesktop.load()')).state),baseline,'layout actions may update a reading position, but must not change lessons, scores or notes');
  await evaluate(`window.learnflowDesktop.setActivePlan(${JSON.stringify(original.active)})`);
  console.log('UI_SMOKE',JSON.stringify({passed:true,realModelCalls:0,checks,screenshots}));
};
