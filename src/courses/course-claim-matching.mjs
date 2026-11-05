import { Lexer } from 'marked';

// Keep offsets into the original Markdown so accepted claims are saved as real
// source substrings. Only presentation delimiters are removed; words, numbers,
// punctuation, links, math operators and fenced code are never rewritten.
function projectedMarkdown(source) {
  const characters = [];
  const copy = (start, end, literal = false) => { for (let i = start; i < end; i++) characters.push({ value: source[i], start: i, end: i + 1, literal }); };
  const inline = (tokens, offset) => {
    for (const token of tokens) {
      const raw = token.raw || '', end = offset + raw.length;
      if (['strong', 'em'].includes(token.type) && token.tokens && typeof token.text === 'string') {
        const inside = raw.indexOf(token.text);
        if (inside >= 0 && token.tokens.map(t => t.raw).join('') === token.text) {
          const first = characters.length; inline(token.tokens, offset + inside);
          if (characters.length > first) { characters[first].start = offset; characters.at(-1).end = end; }
        }
        else copy(offset, end);
      } else if (token.type === 'codespan') {
        const delimiter = /^`+/.exec(raw)?.[0];
        if (delimiter && raw.endsWith(delimiter) && raw.length > delimiter.length * 2) {
          const first = characters.length; copy(offset + delimiter.length, end - delimiter.length, true);
          characters[first].start = offset; characters.at(-1).end = end;
        }
        else copy(offset, end);
      } else copy(offset, end);
      offset = end;
    }
  };
  let offset = 0;
  for (const block of Lexer.lex(source, { gfm: true })) {
    const raw = block.raw || '';
    if (source.slice(offset, offset + raw.length) !== raw) return null;
    if (['code', 'html'].includes(block.type)) copy(offset, offset + raw.length, true);
    else {
      const tokens = Lexer.lexInline(raw, { gfm: true });
      if (tokens.map(t => t.raw).join('') !== raw) return null;
      inline(tokens, offset);
    }
    offset += raw.length;
  }
  if (offset !== source.length) return null;
  return characters;
}

function normalized(characters) {
  const result = [];
  for (const character of characters) {
    if (!character.literal && /\s/u.test(character.value)) {
      if (result.at(-1)?.value === ' ' && !result.at(-1).literal) result.at(-1).end = character.end;
      else result.push({ ...character, value: ' ' });
    } else result.push(character);
  }
  return { text: result.map(c => c.value).join(''), positions: result };
}

export function createCourseClaimMatcher() {
  const cache = new Map();
  const projection = source => {
    if (!cache.has(source)) {
      try { const characters = projectedMarkdown(source); cache.set(source, characters ? normalized(characters) : null); }
      catch { cache.set(source, null); }
    }
    return cache.get(source);
  };
  return (body, claim) => {
    if (typeof body !== 'string' || typeof claim !== 'string' || !claim.trim() || claim.length > 600) return null;
    if (body.includes(claim)) return claim;
    const bodyView = projection(body), claimView = projection(claim);
    const needle = claimView?.text.trim();
    if (!bodyView || !needle) return null;
    const index = bodyView.text.indexOf(needle);
    if (index < 0) return null;
    const start = bodyView.positions[index].start, end = bodyView.positions[index + needle.length - 1].end;
    const original = body.slice(start, end);
    // Bounds remain compatible with stored/backup citation contracts.
    return original.length <= 600 ? original : null;
  };
}
