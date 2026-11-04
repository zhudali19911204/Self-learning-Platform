import { courseDomain } from './course-categories.js';
const fold = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
const unique = values => [...new Set(values)];
export const knowledgeTopic = value => String(value || '未分类').split(/[\\/]/).map(item => item.trim()).filter(Boolean).join('/') || '未分类';

// Stable, deliberately broad shelves. Unknown courses stay visible for review.
export const knowledgeDomains = ['技术与开发', '数据与分析', '人工智能', '语言与沟通', '商业与管理', '设计与创作', '科学与通识', '生活与兴趣', '待归类'];
// Fixed graph colors for every top-level shelf. Adding cards or sorting shelves must not change them.
export const knowledgeDomainColors = Object.freeze({
  '技术与开发': '#60a5fa',
  '数据与分析': '#e6a34f',
  '人工智能': '#a78bfa',
  '语言与沟通': '#78bd63',
  '商业与管理': '#52b5b0',
  '设计与创作': '#e17d94',
  '科学与通识': '#7788c4',
  '生活与兴趣': '#b49c69',
  '待归类': '#9ca3af'
});
export function knowledgeDomain(course = {}) {
  return courseDomain(course);
}

export function knowledgeTheme(note) {
  if (typeof note.category === 'string' && note.category.trim()) return note.category.trim();
  const topic = knowledgeTopic(note.topic);
  if (!/^(未分类|其他|通用|知识点|课程要点)$/.test(topic)) return topic.split('/').slice(0, 2).join(' / ');
  return (note.tags || []).map(tag => String(tag).trim()).find(Boolean) || '课程要点';
}

export function validKnowledgeOrganization(value, cardIds) {
  if (!value || !Array.isArray(value.groups) || value.groups.length < 1 || value.groups.length > 6 || !Array.isArray(cardIds) || cardIds.length < 2 || cardIds.length > 80) return false;
  const expected = new Set(cardIds);
  if (expected.size !== cardIds.length) return false;
  const names = new Set(), seen = new Set();
  for (const group of value.groups) {
    if (!group || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 40 || names.has(group.name.trim()) || !Array.isArray(group.ids) || !group.ids.length) return false;
    names.add(group.name.trim());
    if (group.ids.length === 1 && group.name.trim() !== '课程要点') return false;
    for (const id of group.ids) {
      if (!expected.has(id) || seen.has(id)) return false;
      seen.add(id);
    }
  }
  return seen.size === expected.size;
}

export function knowledgeTerms(value) {
  const words = fold(value).match(/[\p{Script=Han}]+|[a-z0-9_+#.]+/gu) || [];
  return unique(words.flatMap(word => /\p{Script=Han}/u.test(word) && word.length > 2
    ? [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))]
    : [word]));
}

export function knowledgeCatalog(notes) {
  const entries = notes.map(note => ({
    id: note.id, title: note.title, description: note.summary ?? note.description, topic: knowledgeTopic(note.topic),
    ...(note.category ? { category: note.category } : {}),
    tags: note.tags || [], aliases: note.aliases || [], useWhen: note.useWhen || [], avoidWhen: note.avoidWhen || [],
    sourceCourse: note.courseTitle ?? note.sourceCourse, sourceLessons: note.sourceLessons || [note.lessonId],
    related: note.related || [], prerequisites: note.prerequisites || [], contrasts: note.contrasts || [], updated: note.updated
  }));
  const topics = new Map();
  for (const entry of entries) {
    const parts = entry.topic.split('/');
    const segments = parts.length ? parts : ['未分类'];
    for (let index = 0; index < segments.length; index++) {
      const name = segments.slice(0, index + 1).join('/');
      const previous = topics.get(name) || { path: name, parent: index ? segments.slice(0, index).join('/') : null, count: 0, directCount: 0 };
      previous.count++;
      if (index === segments.length - 1) previous.directCount++;
      topics.set(name, previous);
    }
  }
  return { schema: 1, count: entries.length, topics: [...topics.values()].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN')), cards: entries };
}

export function retrieveKnowledge(question, notes, limit = 12, plans = []) {
  const terms = knowledgeTerms(question).filter(term => term.length >= 2);
  if (!terms.length || !notes.length) return [];
  const catalog = knowledgeCatalog(notes);
  const courses = new Map(plans.flatMap(course => (course.lessons || []).map(lesson => [lesson.id, course])));
  const matchedTopics = catalog.topics.filter(topic => terms.some(term => fold(topic.path).includes(term))).map(topic => topic.path);
  const candidates = notes.map(note => {
    const course = courses.get(note.lessonId);
    const fields = [
      [note.title, 9], [(note.aliases || []).join(' '), 8], [(note.tags || []).join(' '), 6],
      [knowledgeTopic(note.topic), 6], [knowledgeTheme(note), 6], [note.summary, 5], [(note.useWhen || []).join(' '), 3],
      [(note.avoidWhen || []).join(' '), 3], [course?.title || note.courseTitle, 4], [knowledgeDomain(course || { title: note.courseTitle }), 2], [note.content, 1]
    ];
    const score = terms.reduce((sum, term) => sum + fields.reduce((best, [value, weight]) => fold(value).includes(term) ? Math.max(best, weight) : best, 0), 0)
      + (matchedTopics.some(topic => knowledgeTopic(note.topic) === topic || knowledgeTopic(note.topic).startsWith(topic + '/')) ? 4 : 0);
    return { note, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.note.updated - a.note.updated || a.note.id.localeCompare(b.note.id));
  const selected = candidates.slice(0, Math.min(limit, 8)).map(item => item.note);
  if (selected.length && selected.length < limit) {
    const byId = new Map(notes.map(note => [note.id, note]));
    const seen = new Set(selected.map(note => note.id));
    for (const note of [...selected]) {
      for (const id of [...(note.related || []), ...(note.prerequisites || []), ...(note.contrasts || [])]) {
        const linked = byId.get(id);
        if (linked && !seen.has(id)) { selected.push(linked); seen.add(id); }
        if (selected.length >= limit) break;
      }
      if (selected.length >= limit) break;
    }
  }
  const seen = new Set(selected.map(note => note.id));
  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    if (!seen.has(candidate.note.id)) { selected.push(candidate.note); seen.add(candidate.note.id); }
  }
  return selected;
}
