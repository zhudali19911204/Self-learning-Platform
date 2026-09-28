import test from 'node:test';
import assert from 'node:assert/strict';
import { validQuestionnaire, validClarification, learningBriefFrom, validLearningBrief } from '../public/planning.js';
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
