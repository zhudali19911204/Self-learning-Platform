const sourcePattern = /^(?:intro|example|challenge|section:\d{1,3}|block:[a-zA-Z0-9_-]{1,160})$/;
const annotationId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

export function validAnnotations(items) {
  return Array.isArray(items) && items.length <= 200 && new Set(items.map(item => item?.id)).size === items.length && items.every(item =>
    item && annotationId(item.id) && sourcePattern.test(item.source) && Number.isInteger(item.offset) && item.offset >= 0 && item.offset <= 200000 &&
    typeof item.quote === 'string' && item.quote.length <= 300 && typeof item.text === 'string' && item.text.trim().length > 0 && item.text.length <= 2000 &&
    Number.isSafeInteger(item.created) && item.created > 0
  );
}

export function personalNotesForSource(items, source = '') {
  const recent = (items || []).filter(item => !source || item.source === source).sort((a, b) => b.created - a.created);
  const selected = [];
  let length = 0;
  for (const item of recent) {
    if (selected.length >= 20 || length + item.quote.length + item.text.length > 6000) break;
    selected.push({ quote: item.quote, text: item.text });
    length += item.quote.length + item.text.length;
  }
  return selected.reverse();
}

export function personalNotesMarkdown(notes) {
  if (!notes?.length) return '';
  return `## 我的笔记\n\n${notes.map(note => `${note.quote ? `> 原文：${note.quote.replace(/\s+/g, ' ').trim()}\n\n` : ''}${note.text.trim()}`).join('\n\n')}`;
}
