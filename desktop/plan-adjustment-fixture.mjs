import assert from 'node:assert/strict';
export function planAdjustmentFixture() {
  const counts={generations:0,searches:0};
  const llm={status:()=>({mode:'ai',model:'directory-adjustment-fixture',providerLabel:'隔离测试',timeoutMs:1000}),generate:async(instruction,input,validate)=>{
    counts.generations++;
    assert.ok(input.adjustmentRequirement);assert.equal(input.learningBrief.adjustments.at(-1),input.adjustmentRequirement);
    assert.equal(input.previousPlan.chats,undefined);assert.equal(input.previousPlan.notes,undefined);
    assert.deepEqual(input.learningMaterials,[]);assert.equal(input.materialReading,'full-text');
    assert.equal(input.materialUnits[0].name,'目录调整操作手册.md');
    const value={title:'文件保存与核对实操',description:'先演示完整案例，再拆解操作步骤，最后检验文件保存结果。',lessons:['完整保存案例','拆解保存与核对步骤','综合实践检验'].map(title=>({title,objective:`能够完成${title}并检查操作结果`,phase:'操作实战',minutes:25,tags:['文件保存']})),materialAssignments:input.materialUnits.map(unit=>({unitId:unit.id,lessonIndexes:[1,2,3]}))};
    assert.equal(validate(value),true);return value;
  }};
  return {llm,counts,courseSources:{prepare:async()=>{counts.searches++;throw Error('Directory adjustment must not search the web');}}};
}
