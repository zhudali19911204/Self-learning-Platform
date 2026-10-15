import { validBlockContent } from './blocks.js';
import { validQualityId, validQualityReport } from './course-quality.js';
import { validGrounding } from './course-sources.js';

export const revisionTypes = Object.freeze(['reading', 'example', 'practice', 'quiz']);
export const revisionStatuses = { draft: '草稿', generating: '生成中／上次调用可能中断', reviewing: '复核中／上次调用可能中断', applied: '已应用', discarded: '已放弃', restored: '已恢复原版' };
export const revisionCheckLabels = { not_found: '复核未再发现', still_present: '仍需修订', needs_verification: '待核验' };
const str = (v, max, empty = false) => typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const revisionContent = unit => unit.type === 'quiz' ? { questions: structuredClone(unit.questions) } : { text: unit.text };
export const revisionText = (type, content) => type === 'quiz' ? JSON.stringify(content.questions, null, 2) : content.text;
export function revisionSnapshot(base, changes) {
  return { ...base, units: base.units.map(u => {
    const change = changes.find(c => c.unitId === u.id);
    return change ? { ...u, ...structuredClone(change.content) } : structuredClone(u);
  }) };
}
export function validRevisionChanges(changes, base, selected) {
  return Array.isArray(changes) && changes.length === selected.length && new Set(changes.map(c => c?.unitId)).size === selected.length && changes.every(c => {
    const u = base.units.find(u => u.id === c?.unitId);
    return u && !u.pending && selected.includes(u.id) && revisionTypes.includes(u.type) && validBlockContent(u.type, c.content) && str(c.note, 1000, true)
      && (u.type === 'quiz' ? Object.keys(c.content).every(k => k === 'questions') : Object.keys(c.content).every(k => k === 'text'));
  });
}
export function validRevisionJob(job) {
  if (!job || job.version !== 1 || !validQualityId(job.id) || !validQualityId(job.lessonId) || !validQualityId(job.planId) || !str(job.title, 160)
    || !Number.isSafeInteger(job.rev) || job.rev < 1 || !Number.isFinite(job.created) || !Number.isFinite(job.updated) || !Object.hasOwn(revisionStatuses, job.status)
    || !str(job.error, 2000, true) || !hash(job.baseFingerprint) || !validQualityReport(job.sourceReport) || job.sourceReport.scope !== 'lesson' || job.sourceReport.targetId !== job.lessonId || job.sourceReport.planId !== job.planId || job.sourceReport.fingerprint !== job.baseFingerprint) return false;
  const base = job.baseSnapshot;
  if (!base || base.scope !== 'lesson' || base.targetId !== job.lessonId || base.planId !== job.planId || !Array.isArray(base.units) || base.units.length > 80 || !Array.isArray(base.route) || !str(base.goal, 1000, true) || !str(base.title, 160)) return false;
  if (!base.units.every(u => u && validQualityId(u.id) && ['reading','example','practice','quiz','summary'].includes(u.type) && str(u.title,160) && str(u.objective,1000) && (u.pending === true || validBlockContent(u.type,revisionContent(u)))) || new Set(base.units.map(u => u.id)).size !== base.units.length) return false;
  if (!Array.isArray(job.issueIndexes) || !job.issueIndexes.length || job.issueIndexes.length > 100 || new Set(job.issueIndexes).size !== job.issueIndexes.length || !job.issueIndexes.every(i => Number.isInteger(i) && job.sourceReport.issues[i])) return false;
  const selected = [...new Set(job.issueIndexes.map(i => job.sourceReport.issues[i].unitId))];
  if (job.sourceGrounding !== undefined && (!job.sourceGrounding || Array.isArray(job.sourceGrounding) || typeof job.sourceGrounding !== 'object' || !Object.entries(job.sourceGrounding).every(([id, grounding]) => selected.includes(id) && validGrounding(grounding)))) return false;
  if (selected.length > 5 || !selected.every(id => base.units.some(u => u.id === id && !u.pending && revisionTypes.includes(u.type) && validBlockContent(u.type, revisionContent(u))))) return false;
  if (!Array.isArray(job.changes) || (job.changes.length && !validRevisionChanges(job.changes, base, selected))) return false;
  if (job.generator !== null && (!str(job.generator?.model, 200) || !str(job.generator?.provider, 200))) return false;
  if (job.review !== null && (!hash(job.review?.fingerprint) || !validQualityReport(job.review?.report) || job.review.report.fingerprint !== job.review.fingerprint || job.review.report.targetId !== job.lessonId || job.review.report.planId !== job.planId
    || !Array.isArray(job.review.checks) || job.review.checks.length !== job.issueIndexes.length || new Set(job.review.checks.map(c => c?.issueIndex)).size !== job.issueIndexes.length
    || !job.review.checks.every(c => c && job.issueIndexes.includes(c.issueIndex) && Object.hasOwn(revisionCheckLabels, c.status) && str(c.reason, 1000)))) return false;
  if (['applied', 'restored'].includes(job.status) && (!job.review || !hash(job.appliedFingerprint) || !Number.isFinite(job.appliedAt))) return false;
  return true;
}
export const validQualityDisposition = v => !!v && validQualityId(v.reportId) && validQualityId(v.lessonId) && validQualityId(v.planId) && Number.isInteger(v.issueIndex) && v.issueIndex >= 0 && v.issueIndex < 100 && ['pending', 'deferred', 'verify'].includes(v.status) && str(v.note, 1000, true) && Number.isFinite(v.updated);
export const validStoredProgress = p => !!p && typeof p.completed === 'boolean' && Number.isInteger(p.attempts) && p.attempts >= 0 && [p.lastScore, p.bestScore].every(n => Number.isInteger(n) && n >= 0 && n <= 100) && Array.isArray(p.lastAnswers) && p.lastAnswers.length <= 100 && p.lastAnswers.every(a => Number.isInteger(a) && a >= 0 && a < 4);
export const validQuizRecord = v => !!v && v.version === 1 && hash(v.currentFingerprint) && (v.progressFingerprint === null || hash(v.progressFingerprint)) && Array.isArray(v.history) && v.history.length <= 50
  && v.history.every(h => h && hash(h.fingerprint) && Number.isFinite(h.updated) && validStoredProgress(h.progress) && Array.isArray(h.questions) && h.questions.length <= 100 && h.questions.every(q => validBlockContent('quiz', { questions: [q] })));

// Bounded line comparison; large documents use common-prefix/suffix marking.
export function revisionDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n'), sameA = new Set(), sameB = new Set();
  if (a.length * b.length <= 80000) {
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) { if (a[i] === b[j]) { sameA.add(i++); sameB.add(j++); } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  } else {
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) { sameA.add(i); sameB.add(i++); }
    let x = a.length - 1, y = b.length - 1;
    while (x >= i && y >= i && a[x] === b[y]) { sameA.add(x--); sameB.add(y--); }
  }
  return { before: a.map((text, i) => ({ text, changed: !sameA.has(i) })), after: b.map((text, i) => ({ text, changed: !sameB.has(i) })) };
}
