export const blockTypes = ['reading', 'example', 'practice', 'quiz', 'summary'];
const str = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const validBlockSpec = block => !!block && blockTypes.includes(block.type) && str(block.title, 160) && str(block.objective, 1000);
export const validOutline = outline => !!outline && str(outline.intro, 20000) && Array.isArray(outline.blocks) && outline.blocks.length >= 2 && outline.blocks.length <= 20 && outline.blocks.every(validBlockSpec) && outline.blocks.some(block => block.type === 'reading') && outline.blocks.some(block => block.type === 'quiz');
const validQuestion = q => !!q && str(q.prompt, 2000) && Array.isArray(q.options) && q.options.length === 4 && q.options.every(option => str(option, 2000)) && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4 && str(q.explanation, 5000);
const validRevisions = content => content.revisions === undefined || (Array.isArray(content.revisions) && content.revisions.length <= 10 && content.revisions.every(revision => revision && str(revision.text, 12000) && Number.isFinite(revision.updated)));
export const validBlockContent = (type, content) => type === 'quiz'
  ? !!content && Array.isArray(content.questions) && content.questions.length >= 1 && content.questions.length <= 5 && content.questions.every(validQuestion)
  : blockTypes.includes(type) && !!content && str(content.text, 12000) && validRevisions(content);
export function revisedContent(type, previous, next, updated = Date.now()) {
  if (!['reading', 'example'].includes(type) || !validBlockContent(type, previous) || !validBlockContent(type, next)) throw new Error('只能重新生成已保存的讲解或案例。');
  return { text: next.text, revisions: [...(previous.revisions || []), { text: previous.text, updated }].slice(-10) };
}
export function restoredContent(type, content) {
  if (!['reading', 'example'].includes(type) || !validBlockContent(type, content) || !content.revisions?.length) throw new Error('没有可恢复的上一版内容。');
  const revisions = content.revisions.slice(0, -1);
  return { text: content.revisions.at(-1).text, revisions };
}
export const validBlockCourse = course => !!course && str(course.intro, 20000) && Array.isArray(course.blocks) && course.blocks.length >= 2 && course.blocks.length <= 1000 && course.blocks.every(block => validBlockSpec(block) && safeId(block.id) && (block.content === null || validBlockContent(block.type, block.content))) && new Set(course.blocks.map(block => block.id)).size === course.blocks.length;
export function blockGenerationContext(course, blockId) {
  const index = course.blocks.findIndex(block => block.id === blockId);
  if (index < 0) return null;
  const outline = course.blocks.slice(Math.max(0, index - 12), index + 13).map(({ type, title, objective }) => ({ type, title, objective }));
  const previous = course.blocks.slice(0, index).filter(block => block.content && block.type !== 'quiz').slice(-3).map(block => ({ type: block.type, title: block.title, excerpt: block.content.text.slice(0, 1000) }));
  const related = [];
  if (course.blocks[index].type === 'reading') {
    for (let next = index + 1; course.blocks[next]?.type === 'example'; next++) {
      const block = course.blocks[next];
      if (block.content) related.push({ type: block.type, title: block.title, excerpt: block.content.text.slice(0, 2000) });
      if (related.length === 2) break;
    }
  }
  return { intro: course.intro.slice(0, 2000), outline, previous, related, sequence: { position: index + 1, total: course.blocks.length } };
}
export function lessonFromBlocks(course) {
  if (!course) return null;
  const ready = course.blocks.filter(block => block.content);
  return {
    kind: 'blocks', intro: course.intro,
    sections: ready.filter(block => block.type === 'reading').map(block => ({ heading: block.title, body: block.content.text })),
    example: ready.filter(block => block.type === 'example').map(block => `${block.title}\n${block.content.text}`).join('\n\n'),
    challenge: ready.filter(block => block.type === 'practice').map(block => `${block.title}\n${block.content.text}`).join('\n\n'),
    takeaways: ready.filter(block => block.type === 'summary').map(block => block.content.text),
    questions: ready.filter(block => block.type === 'quiz').flatMap(block => block.content.questions)
  };
}
