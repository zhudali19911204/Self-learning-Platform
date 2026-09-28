const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

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
  return source => {
    const text = String(source ?? '');
    try {
      return purifier.sanitize(parser.parse(text), {
        ALLOWED_TAGS: ['p', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
        ALLOWED_ATTR: ['class', 'start', 'align', 'role', 'aria-label'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: true
      });
    } catch {
      // A renderer failure must not hide a saved lesson or expose unsanitized HTML.
      return `<p>${escapeHTML(text).replace(/\r\n?|\n/g, '<br>')}</p>`;
    }
  };
}
