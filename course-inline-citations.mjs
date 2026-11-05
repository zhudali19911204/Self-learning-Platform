import { Lexer } from 'marked';
import { MAX_COURSE_CITATIONS } from './public/course-sources.js';

const markerPattern = /\[(S\d+(?:E\d+)?)\]/g;
const reject = message => { throw Object.assign(new Error(message), { status: 422 }); };
const adjacentMarkers = separator => /^[\s,，、;；:：.。!！?？()（）\[\]【】*_~|]*$/u.test(separator.replace(/\\\r?\n/g,'\n').replace(/&(?:nbsp|#160|#xa0);/gi,' '));
export const inlineCitationPlacementGuidance = '引用须紧跟对应的事实句段，不能单独成段或放在句段开头。表格中的引用应跟在相关单元格文字之后，或放在同一行末尾的来源列；不放在空行或分隔行。公式或代码的来源引用写在代码块前的说明句末尾；结束围栏必须独占一行，不能在结束围栏同一行追加引用。多个编号优先连续写成 [S1E1][S1E2]。自拟案例数据注明为教学示例，不把其数值冒充资料事实。';
export const requiredTeachingCitationGuidance = '本次非测验模块必须有本次资料支持的主要知识性结论，并在正文相应句段末尾写至少一处有效片段标记；只有教学示例、计算过程或操作要求而没有依据标记不算完成。案例、实践和总结也需要标注其所依据的知识或方法，不为自拟数值硬凑来源。输出前核对 text 中确实存在所用片段的 [S编号E编号]；有资料但没有可支持的主要结论时返回 {"sourceInsufficient":true}，不返回无引用正文。';

// A real provider returned a formula ending in "``` [S1E8]". That is not a
// closing fence in Markdown, so all subsequent prose becomes literal code.
// Repair only this narrow, unterminated-fence layout; never edit code contents,
// invent IDs or reinterpret a literal in an already properly closed block.
export function normalizeCourseCitationLayout(source) {
  if (!/\[S\d+(?:E\d+)?\]/.test(source)) return source;
  for (let round = 0; round < 20; round++) {
    let normalized = '', positions = [];
    for (let i = 0; i < source.length; i++) {
      positions.push(i);
      if (source[i] === '\r') { normalized += '\n'; if (source[i + 1] === '\n') i++; }
      else normalized += source[i];
    }
    positions.push(source.length);
    let replacement;
    const htmlTags = [];
    for (const block of Lexer.lex(normalized, { gfm: true })) {
      if (block.type === 'html') for (const tag of block.raw.matchAll(/<\s*(\/?)\s*([a-z][\w:-]*)\b[^>]*>/gi)) {
        const name = tag[2].toLowerCase();
        if (tag[1]) { const index = htmlTags.lastIndexOf(name); if (index >= 0) htmlTags.length = index; }
        else if (!/\/\s*>$/.test(tag[0]) && !['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'].includes(name)) htmlTags.push(name);
      }
      if (htmlTags.length) continue;
      if (block.type !== 'code') continue;
      const lines = block.raw.split('\n'), opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(lines[0]);
      if (!opening || /^(?:md|markdown)\b/i.test(opening[2].trim())) continue;
      const fence = opening[1], closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`);
      if (lines.slice(1).some(line => closing.test(line))) continue;
      const start = normalized.indexOf(block.raw);
      if (start < 0 || normalized.indexOf(block.raw, start + 1) >= 0) continue;
      let offset = lines[0].length + 1;
      for (const line of lines.slice(1)) {
        const match = /^( {0,3})(`{3,}|~{3,})([ \t]+)(.+)$/.exec(line);
        if (match && match[2][0] === fence[0] && match[2].length >= fence.length
          && /\[S\d+(?:E\d+)?\]/.test(match[4]) && adjacentMarkers(match[4].replace(markerPattern, ''))) {
          const from = positions[start + offset + match[1].length + match[2].length];
          const to = positions[start + offset + match[1].length + match[2].length + match[3].length];
          const eol = /\r\n/.test(source) ? '\r\n' : /\r/.test(source) ? '\r' : '\n';
          replacement = source.slice(0, from) + eol + eol + match[1] + source.slice(to);
          break;
        }
        offset += line.length + 1;
      }
      if (replacement) break;
    }
    if (!replacement) return source;
    source = replacement;
  }
  return source;
}

// Read citation markers only from prose tokens, never code, HTML, images or
// link destinations. Raw text is retained for existing annotation/backup rules.
function inlineCitations(source) {
  const citations = [];
  const readInline = (tokens, precedingCode = null) => {
    const raw = tokens.map(token => token.raw || '').join('');
    const markers = [];
    const htmlTags = [];
    const visit = (items, offset = 0) => {
      for (const token of items) {
        if (token.type === 'html') {
          const tag=/^<\s*(\/?)\s*([a-z][\w:-]*)\b/i.exec(token.raw || '');
          if (tag) {
            const name=tag[2].toLowerCase();
            if(tag[1]) {const index=htmlTags.lastIndexOf(name);if(index>=0)htmlTags.length=index;}
            else if(!/\/\s*>$/.test(token.raw) && !['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'].includes(name))htmlTags.push(name);
          }
        } else if (token.type === 'text' && !htmlTags.length) {
          for (const match of (token.raw || '').matchAll(markerPattern)) markers.push({ id: match[1], start: offset + match.index, end: offset + match.index + match[0].length });
        } else if (!htmlTags.length && ['strong', 'em', 'del'].includes(token.type) && token.tokens) {
          const inside = token.raw.indexOf(token.text);
          if (inside >= 0) visit(token.tokens, offset + inside);
        }
        offset += (token.raw || '').length;
      }
    };
    visit(tokens);
    const codeReference = precedingCode && markers.length && adjacentMarkers(raw.replace(markerPattern, ''));
    let previousEnd = 0;
    for (let index = 0; index < markers.length;) {
      const first = markers[index], group = [first];
      while (index + 1 < markers.length && adjacentMarkers(raw.slice(markers[index].end, markers[index + 1].start))) group.push(markers[++index]);
      const prefix = raw.slice(previousEnd, first.start).trimEnd();
      // Retain the preceding passage including Markdown and punctuation. A long
      // passage uses its final 600 original characters, never a model summary.
      let claim = prefix.slice(-600).trim();
      // A marker immediately outside a fenced block explicitly cites that
      // block, not a guessed earlier paragraph. Markers inside code stay literal.
      if (codeReference) claim = precedingCode.slice(-600).trim();
      // Marked normalizes CRLF and removes quote/list prefixes. Prefer the full
      // original passage; if prefixes split it, keep the final contiguous line.
      if (!source.includes(claim) && source.includes(claim.replace(/\n/g, '\r\n'))) claim = claim.replace(/\n/g, '\r\n').slice(-600).trim();
      while (!source.includes(claim) && claim.includes('\n')) claim = claim.slice(claim.indexOf('\n') + 1).trim();
      if (!/[\p{L}\p{N}]/u.test(claim) || !source.includes(claim)) reject('引用标记缺少可对应的正文内容（如单独成段、行首或空表格行），本次正文未保存，请重新生成该模块。');
      for (const marker of group) citations.push({ excerptId: marker.id, claim });
      previousEnd = group.at(-1).end;
      index++;
    }
  };
  const visitBlocks = blocks => {
    let precedingCode = null;
    for (const block of blocks) {
      if (block.type === 'list') block.items.forEach(item => visitBlocks(item.tokens));
      else if (block.type === 'blockquote') visitBlocks(block.tokens);
      // A row is the citation boundary: a dedicated source cell refers to its
      // preceding facts in that row, never another row. Lexing original rows
      // also retains escaped pipes that Marked normalizes in cell tokens.
      else if (block.type === 'table') block.raw.split(/\r?\n/).filter(Boolean).forEach(row => readInline(Lexer.lexInline(row, {gfm:true})));
      else if (['paragraph', 'text', 'heading'].includes(block.type) && block.tokens) readInline(block.tokens, block.type === 'heading' ? null : precedingCode);
      if (block.type !== 'space') precedingCode = block.type === 'code' && /^ {0,3}(?:`{3,}|~{3,})/.test(block.raw) ? block.text : null;
    }
  };
  visitBlocks(Lexer.lex(source, { gfm: true }));
  return citations;
}

export function withInlineCourseCitations(type, value) {
  if (!value || value.sourceInsufficient === true) return value;
  const bodies = type === 'quiz' ? value.questions?.map(q => q?.explanation) : [value.text];
  if (!Array.isArray(bodies) || bodies.some(body => typeof body !== 'string')) return value;
  const normalized = bodies.map(normalizeCourseCitationLayout);
  if (normalized.some((text, i) => text !== bodies[i])) value = type === 'quiz'
    ? { ...value, questions: value.questions.map((q, i) => ({ ...q, explanation: normalized[i] })) }
    : { ...value, text: normalized[0] };
  const byBody = normalized.map(inlineCitations);
  if (!byBody.some(citations => citations.length)) return value; // Compatible with older claim-based responses.
  // A teaching-only explanation does not inherit another question's sources.
  // Collect real references where present; never fabricate one to fill a quota.
  const citations = byBody.flat().filter((citation, index, all) => all.findIndex(item => item.excerptId === citation.excerptId && item.claim === citation.claim) === index);
  if (citations.length > MAX_COURSE_CITATIONS) reject('模型返回的引用数量异常过多，正文未保存。');
  // Inline locations are authoritative; ignore separately paraphrased claims.
  return { ...value, citations };
}
