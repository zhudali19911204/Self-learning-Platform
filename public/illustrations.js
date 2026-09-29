const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export const validImageId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export const validImageProposal = value => !!value && text(value.prompt, 4000) && text(value.caption, 500);
export const validIllustration = value => validImageProposal(value) && validImageId(value.id) && text(value.model, 200) && Number.isFinite(value.created);
export const validImageSuggestion = value => !!value && typeof value.needed === 'boolean' && text(value.reason, 500) && (!value.needed || validImageProposal(value));
export function referencedImages(state) {
  const ids = new Set();
  for (const course of Object.values(state.blockCourses || {})) for (const block of course.blocks) {
    for (const content of [block.content, ...(block.content?.revisions || [])]) if (content?.illustration) ids.add(content.illustration.id);
  }
  return [...ids];
}
