import test from 'node:test';
import assert from 'node:assert/strict';
import { validQuestionnaire, validClarification, learningBriefFrom, validLearningBrief, learningBriefWithAdjustment, planAdjustmentSnapshot } from '../public/planning.js';
import { demoPlan } from '../public/demo.js';
import { questionnaire, clarification } from '../test-support/planning.mjs';

test('planning schemas validate bounded unique questions and user-owned choices', () => {
  assert.ok(validQuestionnaire(questionnaire));
  assert.ok(validClarification(clarification));
  assert.ok(validLearningBrief(learningBriefFrom(clarification)));
  const invalid = [null, {}, { ...questionnaire, questions: [] }, { ...questionnaire, questions: Array(7).fill(questionnaire.questions[0]) }];
  for (const value of invalid) assert.equal(!!validQuestionnaire(value), false);
  const repeated = structuredClone(questionnaire);
  repeated.questions[0].options[1].id = 'o1';
  assert.equal(validQuestionnaire(repeated), false);
  for (const answers of [[], clarification.answers.slice(0,1), [clarification.answers[0],clarification.answers[0]], [{ questionId:'q1',optionIds:['invented'],detail:'' },clarification.answers[1]], [{ questionId:'q1',optionIds:['o1','o2'],detail:'' },clarification.answers[1]], [{ questionId:'q1',optionIds:[],detail:'' },clarification.answers[1]], [clarification.answers[0],{ questionId:'q2',optionIds:['unsure','o1'],detail:'' }]]) {
    assert.equal(validClarification({ ...clarification, answers }), false);
  }
});
test('free-text answers and uncertainty are explicit, not silently inferred', () => {
  const custom = structuredClone(clarification);
  custom.answers[0] = { questionId:'q1',optionIds:[],detail:'我只想学如何做安全的文件预览。' };
  custom.answers[1] = { questionId:'q2',optionIds:['unsure'],detail:'' };
  assert.ok(validClarification(custom));
  const brief = learningBriefFrom(custom);
  assert.deepEqual(brief.answers[0].selected, []);
  assert.equal(brief.answers[1].selected[0], '还不确定，请 AI 推荐');
  assert.equal(brief.notes, custom.notes);
  assert.equal(!!validLearningBrief({ ...brief, notes:'x'.repeat(1001) }), false);
});

test('directory feedback retains real survey answers, supports imported courses without a survey and bounds repeated requests',()=>{
  const original={...demoPlan,learningBrief:learningBriefFrom(clarification),notes:'private notes',chats:['private chat'],materials:['not for metadata']};
  const before=structuredClone(original),snapshot=planAdjustmentSnapshot(original);
  assert.equal(snapshot.notes,undefined);assert.equal(snapshot.chats,undefined);assert.equal(snapshot.materials,undefined);
  let brief=learningBriefWithAdjustment(original,'先讲案例，再解释术语');
  assert.deepEqual(brief.answers,original.learningBrief.answers);assert.equal(brief.notes,original.learningBrief.notes);
  assert.equal(brief.adjustments.at(-1),'先讲案例，再解释术语');assert.deepEqual(original,before);
  for(let i=0;i<15;i++)brief=learningBriefWithAdjustment({...original,learningBrief:brief},`追加调整 ${i}`);
  assert.equal(brief.adjustments.length,10);assert.equal(brief.adjustments.at(-1),'追加调整 14');assert.equal(validLearningBrief(brief),true);
  const withoutSurvey=learningBriefWithAdjustment(demoPlan,'增加一节实操');assert.deepEqual(withoutSurvey.answers,[]);assert.equal(validLearningBrief(withoutSurvey),true);
  assert.equal(validLearningBrief({...withoutSurvey,adjustments:undefined}),false);
  assert.equal(validLearningBrief({...brief,adjustments:['x'.repeat(1001)]}),false);
  assert.throws(()=>learningBriefWithAdjustment(demoPlan,''),/调整要求/);
});
