// Explicit opt-in only: one real draft request and one real independent review.
// Credentials are read by main.cjs from the dev profile; all test records are isolated.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
exports.run = async ({learning,getGenerator,getReviewer}) => {
  const { demoPlan } = await import('../public/demo.js');
  const { assertDistinctQualityModels } = await import('../public/course-quality.js');
  const { qualitySnapshot,qualityFingerprint,applicableQualityRubric,makeQualityReport } = await import('../course-quality.mjs');
  const { createRevisionService } = await import('../course-revision.mjs');
  const generator=getGenerator().status(),reviewer=getReviewer().status();
  assertDistinctQualityModels(generator,reviewer);
  if(generator.mode!=='ai'||reviewer.mode!=='ai') throw new Error('生成或评审模型尚未配置成功；未发起真实调用。');
  const plan={...structuredClone(demoPlan),id:`live-revision-${randomUUID()}`,title:'真实修订联调 · 临时课程',goal:'在 Windows PowerShell 中配置 Git 提交身份并核对设置',level:'Git 初学者',lessons:demoPlan.lessons.map((l,i)=>({...l,id:`live-revision-${randomUUID()}`,title:`Git 身份配置 · ${i+1}`,objective:'能设置 user.name、user.email 并用命令核对'}))};
  learning.savePlan(plan);const lessonId=plan.lessons[0].id;
  const outline=learning.saveOutline(lessonId,{intro:'通过一个最小示例配置并核对提交身份。',blocks:[{type:'reading',title:'Git 提交身份配置',objective:'能设置并核对 Git 用户名与邮箱'},{type:'quiz',title:'核对配置',objective:'能选择查看用户名的命令'}]});
  learning.saveBlock(lessonId,outline.blocks[0].id,{text:'在 Windows PowerShell 中，首次提交前先配置 Git 的用户名和邮箱。'});
  const base=qualitySnapshot(learning.overview(),'lesson',lessonId,learning.getLesson(lessonId));
  // A known engineering fixture problem, not another paid initial assessment.
  const result={summary:'工程联调样本：缺少可执行命令和验证步骤，不是人工校准课程样本。',dimensions:applicableQualityRubric(base).map(r=>({id:r.id,rating:3,reason:'此项为工程测试基线，不是模型评估结果。'})),issues:[{unitId:outline.blocks[0].id,severity:'major',kind:'clarity',quote:base.units[0].text,reason:'只提到配置身份，没有说明配置命令和核对方式。',suggestion:'补充 git config --global user.name 与 user.email 的最小示例，并演示查看配置；说明这些信息与远程账号登录不同。'}],solutions:[]};
  const report=makeQualityReport(base,result,reviewer,generator);learning.saveQualityReport(report);
  const service=createRevisionService({learning,getGenerator,getReviewer});let view=service.create(report.id,[0],qualityFingerprint(base));
  const before=JSON.stringify(learning.getLesson(lessonId)),started=Date.now();
  console.log('REVISION_LIVE_STARTED',JSON.stringify({generator:generator.model,reviewer:reviewer.model,maxRequests:2,isolatedData:true}));
  view=await service.generate(view.job.id,view.job.rev);
  console.log('REVISION_LIVE_DRAFT',JSON.stringify({passed:true,elapsedMs:Date.now()-started,units:view.job.changes.length,characters:view.job.changes[0].content.text.length}));
  assert.equal(JSON.stringify(learning.getLesson(lessonId)),before);
  view=await service.review(view.job.id,view.job.rev);
  assert.equal(JSON.stringify(learning.getLesson(lessonId)),before);
  view=service.apply(view.job.id,view.job.rev,true,true);view=service.restore(view.job.id,view.job.rev);
  assert.equal(qualityFingerprint(qualitySnapshot(learning.overview(),'lesson',lessonId,learning.getLesson(lessonId))),report.fingerprint);
  console.log('REVISION_LIVE_RESULT',JSON.stringify({passed:true,elapsedMs:Date.now()-started,referenceScore:view.job.review.report.score,status:view.job.review.report.status,checks:view.job.review.checks.map(c=>c.status),requests:2,isolatedData:true,originalCourseRestored:true,verification:'unverified'}));
};
