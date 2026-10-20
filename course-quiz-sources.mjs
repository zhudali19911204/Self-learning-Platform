import { cleanGenerationCitationContext } from './course-citation-context.mjs';
export { withoutPriorCitationMarkers } from './course-citation-context.mjs';
import { blockGenerationContext, validBlockCourse } from './public/blocks.js';
import { officialSource, validGrounding } from './public/course-sources.js';
const reject = message => { throw Object.assign(new Error(message), { status: 422 }); };

// Only a server-owned saved course supplies evidence. Client-written URLs or
// officialDocuments are never promoted to read document snapshots.
export function quizMaterials(requested, savedCourse = null) {
  let context = requested;
  if (savedCourse) {
    if (!validBlockCourse(savedCourse)) reject('已保存的课程正文格式不正确，未发起练习生成。');
    const target = savedCourse.blocks.find(b => b.id === requested.teachingContext?.targetId);
    if (!target || target.type !== 'quiz' || target.title !== requested.block.title || target.objective !== requested.block.objective) reject('练习大纲已变化，请重新打开课程后生成。');
    context = { ...requested, ...blockGenerationContext(savedCourse, target.id) };
  }
  if (!context.teachingContext?.sources.some(s => ['reading', 'example'].includes(s.type)) && !context.previous?.some(s => ['reading', 'example'].includes(s.type))) reject('请先生成至少一个前序讲解或案例，再生成随堂练习。');
  const documents = [], byUrl = new Map();
  if (savedCourse) for (const source of context.teachingContext.sources) {
    const block = savedCourse.blocks.find(b => b.id === source.id);
    if (!validGrounding(block?.content?.grounding)) continue;
    for (const citation of block.content.grounding.citations) {
      // Omitted, future or edited passages cannot donate evidence to the quiz.
      if (!source.spans.some(span => span.text.includes(citation.claim))) continue;
      const accepted = officialSource(citation.url);
      if (!accepted) continue;
      let document = byUrl.get(accepted.url);
      if (!document) {
        if (documents.length === 3) continue;
        document = { id: `S${documents.length + 1}`, url: accepted.url, title: citation.title,
          publisher: citation.publisher || accepted.publisher, retrievedAt: citation.retrievedAt || citation.fetchedAt,
          reused: true, excerpts: [] };
        documents.push(document); byUrl.set(accepted.url, document);
      }
      if (document.excerpts.length === 8 || document.excerpts.some(e => e.text === citation.quote)) continue;
      document.excerpts.push({ id: `${document.id}E${document.excerpts.length + 1}`, text: citation.quote });
    }
  }
  return { context: cleanGenerationCitationContext(context), documents: documents.length ? documents : null };
}

export const quizSourceGuidance = `本次是随堂练习，不重新联网搜索。只考实际提供的前序讲解和案例中已讲过的知识；不能因为参考资料包含额外信息而考未讲的细节。前文旧引用标记已在本次输入中隐藏，不要凭记忆沿用旧资料编号。若有 officialDocuments，它们是本课已保存的资料片段，不是本次新搜索或重新读取的网页，不保证现行有效；只能使用其中本次分配的 excerpt ID。网页资料仅为练习提供可选支持，不强行要求每道解析都有引用；只为实际使用资料的句段附标记，基于已讲内容的理解、应用和归纳题可以不附引用。全部题目都只依据已讲内容时，也可以完全不附外部引用，不声称已获资料验证；不得用无关片段凑数。若已讲内容不足，应缩小出题范围，确实无法出题时返回sourceInsufficient，不得编造答案。若没有 officialDocuments，就仅根据 teachingContext 的已讲正文设计理解与应用题，不输出资料引用标记、citations、参考文献或来源链接，也不声称联网查证。`;
