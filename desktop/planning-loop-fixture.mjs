import assert from 'node:assert/strict';
export function planningLoopFixture() {
  const counts={analyses:0,questionnaires:0,previews:0,revisions:0,contextualClarifications:0,searches:0};
  const llm={status:()=>({mode:'ai',model:'planning-loop-fixture',providerLabel:'隔离测试',timeoutMs:1000}),generate:async(prompt,input,validate)=>{
    let value;
    if(input.learningBrief) {
      counts.previews++;if(input.previousPlan){counts.revisions++;assert.ok(input.adjustmentRequirement);}
      value={title:`文件操作课程 · 第 ${counts.previews} 版`,description:'根据已确认的学习方向组织案例、操作练习与综合检验。',lessons:['完整案例观察','拆解操作步骤','独立实践检验'].map(title=>({title,objective:`能够完成${title}并核对结果`,phase:'文件操作',minutes:25,tags:['文件操作']}))};
    } else if(input.assessment) {
      counts.questionnaires++;value={summary:input.previewContext?'根据大纲反馈进一步确定实践安排':'先明确学习场景和验收方式',questions:input.assessment.gaps.map((gap,i)=>({question:`${gap.dimension}如何选择？`,why:gap.reason,type:i?'multiple':'single',options:[{label:i?'完成独立任务':'使用完整案例',description:'围绕可检查的结果练习'},{label:i?'说明每步理由':'先看基础概念',description:'练习解释与自查'}]}))};
    } else {
      counts.analyses++;if(input.previewContext){counts.contextualClarifications++;assert.ok(input.previewContext.feedback);assert.ok(input.previewContext.learningBrief.answers.length);}
      value={scope:'focused',known:['用户明确要学习文件操作'],gaps:[{dimension:input.previewContext?'实践安排':'学习场景',reason:'决定练习素材'},{dimension:'验收方式',reason:'决定检验成果'}]};
    }
    assert.equal(validate(value),true);return value;
  }};
  return {llm,counts,courseSources:{prepare:async()=>{counts.searches++;throw Error('Planning preview must not search');}}};
}
