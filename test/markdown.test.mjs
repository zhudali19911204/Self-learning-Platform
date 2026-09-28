import test from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer } from '../public/markdown.js';

const window = new JSDOM('').window;
const render = createMarkdownRenderer(Marked, createDOMPurify(window));
const documentFor = text => {
  const element = window.document.createElement('div');
  element.innerHTML = render(text);
  return element;
};

test('Markdown renders readable hierarchy, emphasis, lists, quotes, tables and fenced code', () => {
  const element = documentFor([
    '## 核心概念', '', '**关键定义**与*补充解释*。', '',
    '### 计算步骤', '', '1. 找到收入', '2. 减去支出', '   - 检查单位', '',
    '> 提示：不要重复计算。', '',
    '| 项目 | 金额 |', '| --- | ---: |', '| 收入 | 100 |', '| 支出 | 60 |', '',
    '```python', 'balance = 100 - 60', 'print(balance)', '```'
  ].join('\n'));
  assert.equal(element.querySelector('h3').textContent, '核心概念');
  assert.equal(element.querySelector('h4').textContent, '计算步骤');
  assert.equal(element.querySelector('strong').textContent, '关键定义');
  assert.equal(element.querySelector('em').textContent, '补充解释');
  assert.equal(element.querySelectorAll('ol > li').length, 2);
  assert.ok(element.querySelector('ol ul li'));
  assert.match(element.querySelector('blockquote').textContent, /不要重复计算/);
  assert.equal(element.querySelectorAll('tbody tr').length, 2);
  assert.equal(element.querySelector('pre code').className, 'language-python');
  assert.match(element.querySelector('pre code').textContent, /balance = 100 - 60\nprint\(balance\)/);
  assert.equal(element.querySelector('h1, h2'), null, 'body headings must not compete with the lesson or module');
});

test('plain text and line breaks stay readable without rewriting stored content', () => {
  const source = '什么是现金流\n\n收入 100 元，支出 60 元。\n剩余现金 40 元。\n\n2 < 3，3 > 2，A & B。';
  const element = documentFor(source);
  assert.equal(element.querySelectorAll('p').length, 3);
  assert.equal(element.querySelectorAll('br').length, 1);
  assert.match(element.textContent, /2 < 3，3 > 2，A & B/);
  assert.ok(source.includes('\n剩余现金'), 'the renderer accepts a source string and never rewrites persisted records');
});

test('model HTML, JavaScript URLs, tracking images and delegated actions cannot become active DOM', () => {
  const attacks = [
    '<script>window.stolen = true</script>',
    '<img src="https://tracker.invalid/pixel" onerror="alert(1)">',
    '<svg onload="alert(1)"><a href="javascript:alert(1)">SVG</a></svg>',
    '<button data-action="delete-plan" data-id="my-plan">删除</button>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<style>body{display:none}</style><form action="https://tracker.invalid">form</form>',
    '[恶意链接](javascript:alert%281%29)',
    '[文件链接](file:///C:/secret)',
    '![远程图片](https://tracker.invalid/pixel)',
    '<a href="https://tracker.invalid" data-page="settings" id="app">link</a>',
    '```html\n</code><script>alert(1)</script>\n```'
  ];
  for (const source of attacks) {
    const element = documentFor(source);
    assert.equal(element.querySelector('script, img, svg, iframe, button, form, style, input, a'), null, source);
    assert.equal(element.querySelector('[data-action], [data-page], [id], [onerror], [onload]'), null, source);
  }
  assert.equal(window.stolen, undefined);
});

test('Markdown references remain readable without initiating remote navigation', () => {
  const element = documentFor('[参考文档](https://example.com/doc)');
  assert.match(element.textContent, /参考文档（https:\/\/example.com\/doc）/);
  assert.equal(element.querySelector('a'), null);
  assert.equal(element.querySelector('code').textContent, 'https://example.com/doc');
});

test('a renderer failure falls back to escaped text instead of raw HTML or a blank lesson', () => {
  const fallback = createMarkdownRenderer(Marked, { sanitize() { throw new Error('test failure'); } });
  const element = window.document.createElement('div');
  element.innerHTML = fallback('<img src=x onerror=alert(1)>\n保留正文');
  assert.equal(element.querySelector('img'), null);
  assert.match(element.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(element.querySelectorAll('br').length, 1);
});
