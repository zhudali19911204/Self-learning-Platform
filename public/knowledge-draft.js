const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const list = (value, max, itemMax) => Array.isArray(value) && value.length <= max && value.every(item => text(item, itemMax));

export function validKnowledgeSource(value) {
  return !!value && text(value.courseTitle, 160) && text(value.lessonTitle, 160) && text(value.objective, 1000) && text(value.sourceTitle, 160) && text(value.sourceText, 12000) && list(value.tags, 6, 40);
}

export function validKnowledgeDraft(value) {
  return !!value && text(value.title, 160) && text(value.summary, 500) && text(value.content, 20000) && list(value.tags, 6, 40) && value.tags.length > 0 && list(value.useWhen, 12, 500) && list(value.avoidWhen, 12, 500);
}

export function localKnowledgeDraft(source) {
  if (!validKnowledgeSource(source)) throw new Error('当前课程内容不足，无法制作知识卡片。');
  const excerpt = source.sourceText.trim();
  return {
    title: source.sourceTitle,
    summary: source.objective.trim().slice(0, 500),
    content: `## 课程摘录\n\n${excerpt}\n\n> 这是课程摘录草稿。请核对、提炼知识，并补充适用与不适用场景。`,
    tags: source.tags.length ? [...source.tags] : ['课程笔记'],
    useWhen: [], avoidWhen: []
  };
}

export function knowledgeTags(value) {
  return [...new Set(String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean))];
}

export function knowledgeConditions(value) {
  return [...new Set(String(value || '').split(/\r?\n/).map(item => item.trim().replace(/^[-*]\s*/, '')).filter(Boolean))];
}
