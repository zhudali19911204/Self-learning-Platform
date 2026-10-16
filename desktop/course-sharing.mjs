import { randomUUID } from 'node:crypto';
import { validState } from './local-store.mjs';
import { referencedImages } from '../public/illustrations.js';

export const COURSE_PACKAGE_MAX_BYTES = 250 * 1024 * 1024;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const question = value => ({ ...pick(value, ['prompt', 'answer', 'explanation']), options: [...value.options] });
function grounding(value) {
  const legacy = value.verification === 'quotes_checked';
  return { ...pick(value, legacy ? ['version', 'verification', 'revision'] : ['version']), citations: value.citations.map(c => pick(c,
    legacy ? ['sourceId', 'url', 'title', 'hash', 'fetchedAt', 'quote', 'claim'] : ['excerptId', 'url', 'title', 'publisher', 'retrievedAt', 'quote', 'claim'])) };
}
function content(value, type) {
  if (value === null) return null;
  const result = type === 'quiz' ? { questions: value.questions.map(question) } : { text: value.text };
  if (value.grounding) result.grounding = grounding(value.grounding);
  if (type !== 'quiz' && value.illustration) {
    const image = value.illustration;
    result.illustration = pick(image, ['id', 'caption', 'created', 'source']);
    Object.assign(result.illustration, pick(image, image.source === 'commons' || image.source === 'web'
      ? ['title', 'author', 'license', 'sourceUrl', 'licenseUrl', 'retrieved'] : ['model']));
    // Original prompts may include personal context; keep the image, not that prompt.
    if (!['commons', 'web'].includes(image.source)) result.illustration.prompt = '课程配图';
  }
  return result;
}
function legacyLesson(value) {
  return { ...pick(value, ['intro', 'example', 'challenge']), sections: value.sections.map(s => pick(s, ['heading', 'body'])), takeaways: [...value.takeaways], questions: value.questions.map(question) };
}
const stateFor = value => ({ version: 1, plans: [value.plan], active: value.plan?.id, lessons: value.lessons, blockCourses: value.blockCourses, progress: {}, notes: [], reflections: {}, chats: {} });
function cleanCourse(value, newIds = false) {
  let valid = false;
  try { valid = validState(stateFor(value)) && !Object.keys(value.lessons).some(id => !value.plan.lessons.some(l => l.id === id)); } catch { /* Invalid external shapes must not escape as implementation errors. */ }
  if (!valid) throw new Error('课程包内容格式无效，未修改现有课程。');
  const plan = { ...pick(value.plan, ['title', 'description', 'goal', 'level', 'daily', 'days', 'source']), id: newIds ? randomUUID() : 'shared-course', lessons: [] };
  const lessons = {}, blockCourses = {};
  value.plan.lessons.forEach((meta, index) => {
    const id = newIds ? randomUUID() : `lesson-${index + 1}`;
    plan.lessons.push({ ...pick(meta, ['title', 'objective', 'phase', 'minutes']), tags: [...meta.tags], id });
    const course = value.blockCourses?.[meta.id], lesson = value.lessons[meta.id];
    if (course) blockCourses[id] = { intro: course.intro, blocks: course.blocks.map((b, i) => ({
      id: newIds ? randomUUID() : `block-${index + 1}-${i + 1}`, ...pick(b, ['type', 'title', 'objective']), content: content(b.content, b.type)
    })) };
    else if (lesson) lessons[id] = legacyLesson(lesson);
  });
  const cleaned = { plan, lessons, blockCourses };
  if (!validState(stateFor(cleaned))) throw new Error('课程包内容不完整，未修改现有课程。');
  return cleaned;
}
export function createCoursePackage(plan, getLesson) {
  if (!plan) throw new Error('要导出的课程不存在。');
  const lessons = {}, blockCourses = {};
  for (const meta of plan.lessons) {
    const item = getLesson(meta.id);
    if (item.blockCourse) blockCourses[meta.id] = item.blockCourse;
    else if (item.lesson) lessons[meta.id] = item.lesson;
  }
  return { format: 'learnflow-course', version: 1, exportedAt: new Date().toISOString(), ...cleanCourse({ plan, lessons, blockCourses }) };
}
export function readCoursePackage(value) {
  if (value?.format !== 'learnflow-course' || value.version !== 1) throw new Error('请选择版本 1 的 Learnflow 课程包；完整学习备份请在设置中恢复。');
  const result = { format: 'learnflow-course', version: 1, ...cleanCourse(value) };
  const ids = new Set(referencedImages(result)), assets = value.imageAssets ?? [];
  if (!Array.isArray(assets) || assets.length !== ids.size || assets.some(a => !ids.has(a?.id) || typeof a.data !== 'string') || new Set(assets.map(a => a.id)).size !== assets.length) throw new Error('课程包配图缺失、重复或包含无关文件。');
  if (assets.length) result.imageAssets = assets.map(a => pick(a, ['id', 'data']));
  return result;
}
export function instantiateCoursePackage(value) {
  return stateFor(cleanCourse(readCoursePackage(value), true));
}
export function coursePackageSummary(value) {
  let generated = 0, pendingBlocks = 0, pendingLessons = 0;
  for (const lesson of value.plan.lessons) {
    const blocks = value.blockCourses[lesson.id]?.blocks;
    if (blocks) { generated += blocks.filter(b => b.content !== null).length; pendingBlocks += blocks.filter(b => b.content === null).length; }
    else if (value.lessons[lesson.id]) generated++;
    else pendingLessons++;
  }
  return `共 ${value.plan.lessons.length} 节课；已生成 ${generated} 个内容单元，待生成 ${pendingBlocks} 个模块、${pendingLessons} 节课。`;
}
