// Shared, data-only course review contract. A score is not a correctness probability.
export const qualityRubricVersion = 'course-quality-v1';
export const qualityRubric = Object.freeze([
  { id: 'facts', label: '事实与适用边界', weight: 30 },
  { id: 'alignment', label: '需求与目标契合', weight: 20 },
  { id: 'clarity', label: '讲解与难度适配', weight: 15 },
  { id: 'practice', label: '案例与实践质量', weight: 15 },
  { id: 'quiz', label: '测验质量', weight: 10 },
  { id: 'coherence', label: '连贯与完整性', weight: 5 },
  { id: 'workload', label: '篇幅与时间适配', weight: 5 }
]);
export const qualityLabels = { reviewed: 'AI 已审查', needs_revision: '建议修订' };
export const qualityModelId = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/:latest$/, '') : '';
export function assertDistinctQualityModels(generator, reviewer) {
  if (qualityModelId(generator?.model) && qualityModelId(generator.model) === qualityModelId(reviewer?.model)) throw new Error('课程生成模型与评审模型必须不同；更换服务或接口地址不能让同一模型兼任两个角色。');
}
export const validQualityId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const str = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
const issueValid = issue => issue && validQualityId(issue.unitId) && ['critical', 'major', 'minor'].includes(issue.severity) && ['fact', 'missing', 'clarity', 'practice', 'quiz', 'coherence', 'workload'].includes(issue.kind) && str(issue.quote, 600, true) && str(issue.reason, 1000) && str(issue.suggestion, 1000) && ['rule', 'ai'].includes(issue.origin);
export function validQualityReport(report) {
  if (!report || !Array.isArray(report.dimensions) || !report.dimensions.every(d => d && typeof d === 'object')) return false;
  const expected = report.scope === 'route' ? ['alignment', 'clarity', 'coherence', 'workload'] : ['facts', 'alignment', 'clarity', 'coherence', 'workload'];
  const dimensionsValid = expected.every(id => report.dimensions.some(d => d.id === id)) && report.dimensions.every(d => expected.includes(d.id) || (report.scope === 'lesson' && ['practice', 'quiz'].includes(d.id)));
  const weights = report.dimensions.map(d => qualityRubric.find(r => r.id === d.id)?.weight || 0);
  const score = Math.round(report.dimensions.reduce((sum, d, i) => sum + d.rating / 4 * weights[i], 0) / weights.reduce((sum, w) => sum + w, 0) * 100);
  const weakCore = report.dimensions.some(d => ['facts', 'alignment', 'quiz'].includes(d.id) && d.rating < 3);
  const needsRevision = weakCore || score < 85 || (Array.isArray(report.issues) && report.issues.some(i => i && ['critical', 'major'].includes(i.severity)));
  return !!report && report.version === 1 && validQualityId(report.id) && ['route', 'lesson'].includes(report.scope) && validQualityId(report.targetId) && validQualityId(report.planId)
    && /^[a-f0-9]{64}$/.test(report.fingerprint) && report.rubricVersion === qualityRubricVersion && Number.isFinite(report.created) && report.created > 0
    && str(report.title, 160) && str(report.reviewer?.model, 200) && str(report.reviewer?.provider, 200) && str(report.generator?.model, 200, true) && str(report.generator?.provider, 200, true)
    && (!qualityModelId(report.generator.model) || qualityModelId(report.generator.model) !== qualityModelId(report.reviewer.model))
    && typeof report.partial === 'boolean' && report.verification === 'unverified' && report.status === (needsRevision ? 'needs_revision' : 'reviewed') && Number.isInteger(report.score) && report.score === score && str(report.summary, 2000)
    && dimensionsValid
    && Array.isArray(report.dimensions) && report.dimensions.length >= 1 && report.dimensions.length <= 7 && new Set(report.dimensions.map(d => d.id)).size === report.dimensions.length
    && report.dimensions.every(d => qualityRubric.some(r => r.id === d.id) && Number.isInteger(d.rating) && d.rating >= 0 && d.rating <= 4 && str(d.reason, 1000))
    && Array.isArray(report.issues) && report.issues.length <= 100 && report.issues.every(issueValid);
}
