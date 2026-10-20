import { Lexer } from 'marked';
const reject = message => { throw Object.assign(new Error(message), { status: 422 }); };

// IDs belong to one generation's documents. Mask historical prose markers in
// the input copy while preserving offsets, Markdown literals and stored text.
export function withoutPriorCitationMarkers(source) {
  if (typeof source !== 'string') return source;
  const units = [];
  for (let i = 0; i < source.length; i++) {
    const raw = source[i] === '\r' && source[i + 1] === '\n' ? source.slice(i, ++i + 1) : source[i];
    units.push({ raw, value: raw[0] === '\r' ? '\n' : raw });
  }
  source = units.map(u => u.value).join('');
  const output = source.split('');
  const inline = (raw, positions) => {
    let offset = 0;
    const htmlTags = [];
    for (const token of Lexer.lexInline(raw, { gfm: true })) {
      const text = token.raw;
      if (token.type === 'html') {
        const tag = /^<(\/?)([a-z][\w:-]*)\b[^>]*>$/i.exec(text);
        if (tag) {
          const name = tag[2].toLowerCase();
          if (tag[1]) { const index = htmlTags.lastIndexOf(name); if (index >= 0) htmlTags.length = index; }
          else if (!/\/\s*>$/.test(text) && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(name)) htmlTags.push(name);
        }
      } else if (token.type === 'text' && !htmlTags.length) for (const match of text.matchAll(/\[S\d+(?:E\d+)?\]/g)) {
        for (let i = 0; i < match[0].length; i++) output[positions[offset + match.index + i]] = ' ';
      }
      else if (!htmlTags.length && ['strong', 'em', 'del'].includes(token.type) && token.tokens) {
        const inside = text.indexOf(token.text);
        if (inside >= 0) inline(token.text, positions.slice(offset + inside, offset + inside + token.text.length));
      }
      offset += text.length;
    }
  };
  // Marked removes list/quote prefixes when tokenizing their children. Map each
  // child line back to the original suffix, removing only container prefixes;
  // never flatten a nested literal block into prose and erase its markers.
  const childPositions = (raw, positions, text) => {
    const lines = raw.split('\n'), children = text.split('\n'), result = [];
    if (children.length > lines.length) return null;
    let offset = 0;
    for (let i = 0; i < children.length; i++) {
      const line = lines[i], child = children[i], prefix = line.slice(0, line.length - child.length);
      const containerPrefix = /^[\s>]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:\[[ xX]\][ \t]+)?[\s>]*$/;
      if (line.endsWith(child) && containerPrefix.test(prefix)) result.push(...positions.slice(offset + prefix.length, offset + line.length));
      else {
        // A tab can become multiple indentation spaces in Marked's child text.
        // Only that indentation is virtual; all actual marker characters keep
        // their original positions and literal code blocks remain untouched.
        const indentation = /^[ \t]*/.exec(child)[0], tail = child.slice(indentation.length), actualPrefix = line.slice(0, line.length - tail.length);
        if (!indentation || !actualPrefix.includes('\t') || !line.endsWith(tail) || !containerPrefix.test(actualPrefix)) return null;
        result.push(...Array.from({ length: indentation.length }, () => positions[offset + actualPrefix.length - 1]), ...positions.slice(offset + actualPrefix.length, offset + line.length));
      }
      if (i < children.length - 1) result.push(positions[offset + line.length]);
      offset += line.length + 1;
    }
    return lines.slice(children.length).every(line => !line.trim()) && result.length === text.length ? result : null;
  };
  const blocks = (rawSource, positions, tokens = Lexer.lex(rawSource, { gfm: true })) => {
    let offset = 0;
    for (const block of tokens) {
      const raw = block.raw, places = positions.slice(offset, offset + raw.length);
      if (rawSource.slice(offset, offset + raw.length) !== raw) reject('教学前文的 Markdown 片段无法安全处理，请检查正文格式。');
      if (block.type === 'list') {
        let cursor = 0;
        for (const item of block.items) {
          const start = raw.indexOf(item.raw, cursor);
          if (start < 0) reject('教学前文的列表片段无法安全处理，请检查正文格式。');
          const child = childPositions(item.raw, places.slice(start, start + item.raw.length), item.text);
          if (child) blocks(item.text, child, item.tokens.filter(token => token.type !== 'checkbox'));
          cursor = start + item.raw.length;
        }
      } else if (block.type === 'blockquote') {
        const child = childPositions(raw, places, block.text);
        if (child) blocks(block.text, child, block.tokens);
      } else if (!['code', 'html'].includes(block.type)) inline(raw, places);
      offset += raw.length;
    }
    if (offset !== rawSource.length) reject('教学前文不完整，未发起生成。');
  };
  blocks(source, Array.from({ length: source.length }, (_, i) => i));
  return units.map((unit, i) => output[i] === source[i] ? unit.raw : output[i]).join('');
}

export function cleanGenerationCitationContext(context) {
  return { ...context, intro: withoutPriorCitationMarkers(context.intro),
    ...(context.currentExcerpt === undefined ? {} : { currentExcerpt: withoutPriorCitationMarkers(context.currentExcerpt) }),
    ...(context.previous ? { previous: context.previous.map(p => ({ ...p, excerpt: withoutPriorCitationMarkers(p.excerpt) })) } : {}),
    ...(context.related ? { related: context.related.map(p => ({ ...p, excerpt: withoutPriorCitationMarkers(p.excerpt) })) } : {}),
    ...(context.teachingContext ? { teachingContext: { ...context.teachingContext, sources: context.teachingContext.sources.map(source => ({ ...source,
      spans: source.spans.map(span => ({ ...span, text: withoutPriorCitationMarkers(span.text) })) })) } } : {}) };
}

export function generationCitationContextGuidance(documents) {
  return 'intro、previous、related、teachingContext 和 currentExcerpt 中普通文本的历史引用标记已在本次输入副本中隐藏，课程原文未改动。代码、转义文本、HTML或链接里的标记仅是字面内容，不能据此沿用编号或猜测网址。'
    + (documents
      ? `本次可用资料片段编号仅为 ${JSON.stringify(documents.flatMap(d => d.excerpts.map(e => e.id)))}。引用只使用 officialDocuments.excerpts 中实际存在且支持当前知识结论的编号，不沿用前文、旧稿或其他模块的编号。实践任务的自拟场景、数据应明确标为教学示例，不给每条任务指令硬凑资料引用；其中的实际知识结论仍按提供资料标注依据。`
      : '本次没有提供外部资料片段，不输出资料引用标记、来源链接或 citations，不声称已联网验证。');
}
