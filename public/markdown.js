import { officialSource, validGrounding } from './course-sources.js';

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

// Only link IDs recorded in this module's saved evidence. Keep visible text
// unchanged so existing annotations retain their offsets into the reading view.
function linkCourseCitations(fragment, grounding, desktop) {
  const sources = new Map();
  for (const citation of grounding.citations) {
    const id = citation.excerptId || citation.sourceId;
    const source = officialSource(citation.url);
    if (!source) continue;
    if (sources.has(id) && sources.get(id)?.url !== source.url) sources.set(id, null);
    else if (!sources.has(id)) sources.set(id, { url: source.url, title: citation.title });
  }
  const document = fragment.ownerDocument;
  const walker = document.createTreeWalker(fragment, 4);
  const nodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('pre, code, a') && /\[S\d+(?:E\d+)?\]/.test(node.data)) nodes.push(node);
  }
  for (const node of nodes) {
    const replacement = document.createDocumentFragment();
    let offset = 0;
    for (const match of node.data.matchAll(/\[(S\d+(?:E\d+)?)\]/g)) {
      const source = sources.get(match[1]);
      if (!source) continue;
      replacement.append(document.createTextNode(node.data.slice(offset, match.index)));
      const link = document.createElement('a');
      link.className = 'course-inline-citation';
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = `打开参考文档：${source.title}`;
      link.setAttribute('aria-label', `${match[0]} 打开参考文档：${source.title}`);
      link.textContent = match[0];
      if (desktop) { link.dataset.action = 'open-course-source'; link.dataset.url = source.url; }
      replacement.append(link);
      offset = match.index + match[0].length;
    }
    replacement.append(document.createTextNode(node.data.slice(offset)));
    node.replaceWith(replacement);
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

// Dependencies are supplied by the browser entry point (and by the DOM test harness).
export function createMarkdownRenderer(Marked, purifier) {
  const parser = new Marked({
    async: false, gfm: true, breaks: true,
    renderer: {
      code({ text, lang }) {
        const language = (lang || '').split(/\s+/)[0].toLowerCase();
        return `<pre><code class="language-${escapeHTML(language)}">${escapeHTML(text)}</code></pre>`;
      },
      heading({ tokens, depth }) {
        // The lesson is h1 and the module is h2; body headings must not compete with them.
        const level = Math.min(6, Math.max(3, depth + 1));
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>`;
      },
      html({ text }) { return escapeHTML(text); },
      // Never fetch model-supplied remote images, including tracking pixels.
      image({ text }) { return escapeHTML(text ? `[图片：${text}]` : '[图片]'); },
      link({ href, tokens }) {
        const label = this.parser.parseInline(tokens);
        // References remain readable without leaving the learning page or opening remote content.
        return /^https?:\/\/[^\s]+$/i.test(href) ? `${label}（<code>${escapeHTML(href)}</code>）` : label;
      }
    }
  });
  return (source, { grounding, desktop = false } = {}) => {
    const text = String(source ?? '');
    try {
      const hasCitations = validGrounding(grounding);
      const sanitized = purifier.sanitize(parser.parse(text), {
        ALLOWED_TAGS: ['p', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
        ALLOWED_ATTR: ['class', 'start', 'align', 'role', 'aria-label'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: true,
        ...(hasCitations ? { RETURN_DOM_FRAGMENT: true } : {})
      });
      return hasCitations ? linkCourseCitations(sanitized, grounding, desktop) : sanitized;
    } catch {
      // A renderer failure must not hide a saved lesson or expose unsanitized HTML.
      return `<p>${escapeHTML(text).replace(/\r\n?|\n/g, '<br>')}</p>`;
    }
  };
}
