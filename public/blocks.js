export const blockTypes = ['reading', 'example', 'practice', 'quiz', 'summary'];
const str = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
export const validBlockSpec = block => !!block && blockTypes.includes(block.type) && str(block.title, 160) && str(block.objective, 1000);
export const validOutline = outline => !!outline && str(outline.intro, 20000) && Array.isArray(outline.blocks) && outline.blocks.length >= 2 && outline.blocks.length <= 20 && outline.blocks.every(validBlockSpec) && outline.blocks.some(block => block.type === 'reading') && outline.blocks.some(block => block.type === 'quiz');
const validQuestion = q => !!q && str(q.prompt, 2000) && Array.isArray(q.options) && q.options.length === 4 && q.options.every(option => str(option, 2000)) && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4 && str(q.explanation, 5000);
export const validBlockContent = (type, content) => type === 'quiz'
  ? !!content && Array.isArray(content.questions) && content.questions.length >= 1 && content.questions.length <= 5 && content.questions.every(validQuestion)
  : blockTypes.includes(type) && !!content && str(content.text, 12000);
export const validBlockCourse = course => !!course && str(course.intro, 20000) && Array.isArray(course.blocks) && course.blocks.length >= 2 && course.blocks.length <= 1000 && course.blocks.every(block => validBlockSpec(block) && safeId(block.id) && (block.content === null || validBlockContent(block.type, block.content))) && new Set(course.blocks.map(block => block.id)).size === course.blocks.length;
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
