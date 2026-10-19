import { Lexer } from 'marked';
import { MAX_COURSE_CITATIONS } from './public/course-sources.js';

const markerPattern = /\[(S\d+(?:E\d+)?)\]/g;
const reject = message => { throw Object.assign(new Error(message), { status: 422 }); };

// Read citation markers only from prose tokens, never code, HTML, images or
// link destinations. Raw text is retained for existing annotation/backup rules.
function inlineCitations(source) {
  const citations = [];
  const readInline = tokens => {
    const raw = tokens.map(token => token.raw || '').join('');
    const markers = [];
    const visit = (items, offset = 0) => {
      for (const token of items) {
        if (token.type === 'text') {
          for (const match of (token.raw || '').matchAll(markerPattern)) markers.push({ id: match[1], start: offset + match.index, end: offset + match.index + match[0].length });
        } else if (['strong', 'em', 'del'].includes(token.type) && token.tokens) {
          const inside = token.raw.indexOf(token.text);
          if (inside >= 0) visit(token.tokens, offset + inside);
        }
        offset += (token.raw || '').length;
      }
    };
    visit(tokens);
    let previousEnd = 0;
    for (let index = 0; index < markers.length;) {
      const first = markers[index], group = [first];
      while (index + 1 < markers.length && /^[ \t]*$/.test(raw.slice(markers[index].end, markers[index + 1].start))) group.push(markers[++index]);
      const prefix = raw.slice(previousEnd, first.start).trimEnd();
      // Retain the preceding passage including Markdown and punctuation. A long
      // passage uses its final 600 original characters, never a model summary.
      let claim = prefix.slice(-600).trim();
      // Marked normalizes CRLF and removes quote/list prefixes. Prefer the full
      // original passage; if prefixes split it, keep the final contiguous line.
      if (!source.includes(claim) && source.includes(claim.replace(/\n/g, '\r\n'))) claim = claim.replace(/\n/g, '\r\n').slice(-600).trim();
      while (!source.includes(claim) && claim.includes('\n')) claim = claim.slice(claim.indexOf('\n') + 1).trim();
      if (!/[\p{L}\p{N}]/u.test(claim) || !source.includes(claim)) reject('引用标记前缺少可对应的正文句段，请将引用标在相关句段末尾。正文未保存。');
      for (const marker of group) citations.push({ excerptId: marker.id, claim });
      previousEnd = group.at(-1).end;
      index++;
    }
  };
  const visitBlocks = blocks => {
    for (const block of blocks) {
      if (block.type === 'list') block.items.forEach(item => visitBlocks(item.tokens));
      else if (block.type === 'blockquote') visitBlocks(block.tokens);
      else if (block.type === 'table') [...block.header, ...block.rows.flat()].forEach(cell => readInline(cell.tokens));
      else if (['paragraph', 'text', 'heading'].includes(block.type) && block.tokens) readInline(block.tokens);
    }
  };
  visitBlocks(Lexer.lex(source, { gfm: true }));
  return citations;
}

export function withInlineCourseCitations(type, value) {
  if (!value || value.sourceInsufficient === true) return value;
  const bodies = type === 'quiz' ? value.questions?.map(q => q?.explanation) : [value.text];
  if (!Array.isArray(bodies) || bodies.some(body => typeof body !== 'string')) return value;
  const byBody = bodies.map(inlineCitations);
  if (!byBody.some(citations => citations.length)) return value; // Compatible with older claim-based responses.
  // A teaching-only explanation does not inherit another question's sources.
  // Collect real references where present; never fabricate one to fill a quota.
  const citations = byBody.flat().filter((citation, index, all) => all.findIndex(item => item.excerptId === citation.excerptId && item.claim === citation.claim) === index);
  if (citations.length > MAX_COURSE_CITATIONS) reject('模型返回的引用数量异常过多，正文未保存。');
  // Inline locations are authoritative; ignore separately paraphrased claims.
  return { ...value, citations };
}
