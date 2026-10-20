import { validBlockContent } from './blocks.js';

export const factCheckVersion = 'facts-v1';
export const factCheckLabels = { clear: '未发现明显问题', corrected: '已自动修正', edited: '已按选择修正 · 待重新核查', uncertain: '有待核实项', failed: '核查未完成' };
const text = (v, max, empty = false) => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0);
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function factContent(content) {
  if (!content) return null;
  const pick = (v, keys) => Object.fromEntries(keys.filter(key => v[key] !== undefined).map(key => [key, v[key]]));
  const grounding = content.grounding ? { ...pick(content.grounding, ['version', 'verification', 'revision']), citations: content.grounding.citations.map(c => pick(c, ['excerptId', 'sourceId', 'url', 'title', 'publisher', 'retrievedAt', 'hash', 'fetchedAt', 'claim', 'quote'])) } : null;
  return { ...(Array.isArray(content.questions) ? { questions: content.questions.map(q => ({ prompt: q.prompt, options: [...q.options], answer: q.answer, explanation: q.explanation })) } : { text: content.text }), ...(grounding ? { grounding } : {}) };
}
export const sameFactContent = (a, b) => JSON.stringify(factContent(a)) === JSON.stringify(factContent(b));
export function validFactCheck(record) {
  const source = s => s && /^R\d{1,2}$/.test(s.id) && text(s.url, 2048) && (() => { try { const u = new URL(s.url); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } })() && text(s.title, 240) && text(s.quote, 1200);
  return !!record && record.version === 1 && record.ruleVersion === factCheckVersion && id(record.id) && id(record.lessonId) && id(record.blockId)
    && Object.hasOwn(factCheckLabels, record.status) && hash(record.inputFingerprint) && Number.isFinite(record.created) && record.created > 0
    && text(record.reviewer?.model, 200, true) && text(record.reviewer?.provider, 200, true)
    && text(record.summary, 2000) && text(record.error, 2000, true) && validBlockContent(record.type, record.content)
    && (record.beforeContent === undefined || validBlockContent(record.type, record.beforeContent))
    && (!['corrected', 'edited'].includes(record.status) || !!record.beforeContent)
    && (record.status !== 'edited' || (id(record.sourceRecordId) && Array.isArray(record.selectedIssueIndexes) && record.selectedIssueIndexes.length > 0 && record.selectedIssueIndexes.length <= 24 && new Set(record.selectedIssueIndexes).size === record.selectedIssueIndexes.length && record.selectedIssueIndexes.every(i => Number.isInteger(i) && i >= 0 && i < 24) && text(record.editor?.provider, 200, true) && text(record.editor?.model, 200)))
    && Array.isArray(record.sources) && record.sources.length <= 24 && record.sources.every(source) && new Set(record.sources.map(s => s.id)).size === record.sources.length
    && Array.isArray(record.issues) && record.issues.length <= 24 && record.issues.every(i => i && ['error', 'uncertain'].includes(i.certainty) && ['fact', 'scope', 'source', 'quiz'].includes(i.kind)
      && text(i.quote, 600) && text(i.reason, 1000) && text(i.suggestion, 1000) && Array.isArray(i.evidence) && i.evidence.length <= 6 && i.evidence.every(e => record.sources.some(s => s.id === e.id && text(e.quote, 1200) && s.quote.includes(e.quote)))
      && (i.unlocated === undefined || (i.unlocated === true && i.certainty === 'uncertain' && i.evidence.length === 0)));
}
