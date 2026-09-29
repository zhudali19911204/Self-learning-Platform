const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export const validImageId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export const validImageProposal = value => !!value && text(value.prompt, 4000) && text(value.caption, 500);
export const validIllustration = value => !!value && validImageId(value.id) && text(value.caption, 500) && Number.isFinite(value.created) && (value.source === 'commons'
  ? text(value.title, 240) && text(value.author, 300) && text(value.license, 120) && typeof value.sourceUrl === 'string' && /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/.test(value.sourceUrl) && value.sourceUrl.length <= 1000 && (value.licenseUrl === '' || (typeof value.licenseUrl === 'string' && /^https:\/\//.test(value.licenseUrl) && value.licenseUrl.length <= 1000))
  : value.source === 'web' ? text(value.title, 240) && text(value.author, 300) && text(value.license, 120) && typeof value.sourceUrl === 'string' && /^https:\/\//.test(value.sourceUrl) && value.sourceUrl.length <= 8000 && value.licenseUrl === '' && Number.isFinite(value.retrieved)
  : validImageProposal(value) && text(value.model, 200) && (value.source === undefined || value.source === 'ai_generated'));
export const validImageSuggestion = value => !!value && typeof value.needed === 'boolean' && text(value.reason, 500) && (!value.needed || validImageProposal(value));
export function referencedImages(state) {
  const ids = new Set();
  for (const course of Object.values(state.blockCourses || {})) for (const block of course.blocks) {
    for (const content of [block.content, ...(block.content?.revisions || [])]) if (content?.illustration) ids.add(content.illustration.id);
  }
  return [...ids];
}
