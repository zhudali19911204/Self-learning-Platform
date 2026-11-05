const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(value);
const unique = values => new Set(values).size === values.length;

export function validQuestionnaire(value, withIds = true) {
  return object(value) && text(value.summary, 1000) && Array.isArray(value.questions) && value.questions.length >= 2 && value.questions.length <= 6
    && value.questions.every(question => object(question) && (!withIds || id(question.id)) && text(question.question, 200) && text(question.why, 300)
      && ['single', 'multiple'].includes(question.type) && Array.isArray(question.options) && question.options.length >= 2 && question.options.length <= 5
      && question.options.every(option => object(option) && (!withIds || (id(option.id) && option.id !== 'unsure')) && text(option.label, 120) && text(option.description, 240, true))
      && unique(question.options.map(option => option.label.trim())) && (!withIds || unique(question.options.map(option => option.id))))
    && unique(value.questions.map(question => question.question.trim())) && (!withIds || unique(value.questions.map(question => question.id)));
}

export function validClarification(value) {
  if (!object(value) || !validQuestionnaire(value.questionnaire) || !text(value.notes, 1000, true) || !Array.isArray(value.answers) || value.answers.length !== value.questionnaire.questions.length) return false;
  if (!unique(value.answers.map(answer => answer?.questionId))) return false;
  return value.questionnaire.questions.every(question => {
    const answer = value.answers.find(item => item?.questionId === question.id);
    return object(answer) && Array.isArray(answer.optionIds) && answer.optionIds.length <= (question.type === 'single' ? 1 : 5)
      && unique(answer.optionIds) && answer.optionIds.every(optionId => optionId === 'unsure' || question.options.some(option => option.id === optionId))
      && (!answer.optionIds.includes('unsure') || answer.optionIds.length === 1) && text(answer.detail, 500, true)
      && (answer.optionIds.length > 0 || answer.detail.trim().length > 0);
  });
}

export function learningBriefFrom(value) {
  if (!validClarification(value)) throw new Error('请回答每个问题：选择方向、补充自己的想法，或选择“还不确定”。');
  return {
    summary: value.questionnaire.summary.trim(),
    answers: value.questionnaire.questions.map(question => {
      const answer = value.answers.find(item => item.questionId === question.id);
      return { question: question.question.trim(), selected: answer.optionIds.map(optionId => optionId === 'unsure' ? '还不确定，请 AI 推荐' : question.options.find(option => option.id === optionId).label.trim()), detail: answer.detail.trim() };
    }),
    notes: value.notes.trim()
  };
}

export function validLearningBrief(value) {
  return object(value) && text(value.summary, 1000) && text(value.notes, 1000, true) && Array.isArray(value.answers) && (value.answers.length >= 2 || (value.answers.length === 0 && value.adjustments?.length > 0)) && value.answers.length <= 6
    && (value.adjustments === undefined || (Array.isArray(value.adjustments) && value.adjustments.length > 0 && value.adjustments.length <= 10 && value.adjustments.every(item => text(item, 1000))))
    && value.answers.every(answer => object(answer) && text(answer.question, 200) && Array.isArray(answer.selected) && answer.selected.length <= 5 && answer.selected.every(item => text(item, 120))
      && text(answer.detail, 500, true) && (answer.selected.length || answer.detail.trim().length));
}

export function validPlanOutline(value) {
  return object(value) && text(value.title,160) && text(value.description,2000) && Array.isArray(value.lessons) && value.lessons.length >= 3 && value.lessons.length <= 12
    && value.lessons.every(l => object(l) && text(l.title,160) && text(l.objective,1000) && text(l.phase,80) && Number.isInteger(l.minutes) && l.minutes >= 5 && l.minutes <= 180 && Array.isArray(l.tags) && l.tags.length > 0 && l.tags.length <= 6 && l.tags.every(t => text(t,40)));
}
export function planAdjustmentSnapshot(plan) {
  return { title:plan.title, description:plan.description, goal:plan.goal, level:plan.level, daily:plan.daily, days:plan.days,
    ...(plan.learningBrief ? {learningBrief:structuredClone(plan.learningBrief)} : {}),
    lessons:plan.lessons.map(({title,objective,phase,minutes,tags})=>({title,objective,phase,minutes,tags:[...tags]})) };
}
export function learningBriefWithAdjustment(plan,requirement) {
  if (!text(requirement,1000)) throw new Error('请填写不超过 1000 字的目录调整要求。');
  const brief=plan.learningBrief ? structuredClone(plan.learningBrief) : {summary:plan.goal,answers:[],notes:''};
  brief.adjustments=[...(brief.adjustments || []).slice(-9),requirement.trim()];
  if (!validLearningBrief(brief)) throw new Error('原学习需求无效，无法调整目录。');
  return brief;
}
