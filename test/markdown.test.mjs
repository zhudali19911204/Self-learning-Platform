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

test('local flow and architecture diagrams render from bounded Markdown fences', () => {
  for (const kind of ['flow', 'architecture']) {
    const source = `## 处理过程\n\n\`\`\`${kind}\n输入 -> 检查\n检查 -> 输出\n检查 -> 错误提示\n\`\`\`\n\n**解释**：检查后分支。`;
    const element = documentFor(source);
    assert.equal(element.querySelectorAll('.learning-flow svg rect').length, 4);
    assert.equal(element.querySelectorAll('.learning-flow svg path').length, 6);
    assert.match(element.querySelector('figcaption details').textContent, /检查 → 错误提示/);
    assert.match(element.textContent, /解释/);
    assert.equal(element.querySelector('script, img, a, foreignObject'), null);
  }
});

test('conditional branches, merges and more than eight nodes render as a diagram', () => {
  const approval = [
    '开始 -> 员工提交申请',
    '员工提交申请 -> 主管审批',
    '主管审批 -> 判断天数',
    '判断天数 ->|是（<=3天）| 主管批准',
    '判断天数 ->|否（>3天）| 部门经理审批',
    '主管批准 -> 结束1',
    '部门经理审批 -> 经理判断',
    '经理判断 ->|批准| 结束2',
    '经理判断 ->|驳回| 结束3'
  ].join('\n');
  const element = documentFor(`\`\`\`flow\n${approval}\n\`\`\``);
  assert.equal(element.querySelectorAll('.learning-flow .diagram-node').length, 10);
  assert.equal(element.querySelectorAll('.learning-flow .diagram-edge-label').length, 4);
  assert.match(element.querySelector('.learning-flow figcaption details').textContent, /是（<=3天）/);
  assert.match(element.querySelector('.learning-flow svg').getAttribute('aria-label'), /否（>3天）/);
  assert.equal(element.querySelector('.learning-flow pre'), null);
  assert.equal(element.querySelector('script, img, a, foreignObject'), null);
});

test('larger generic flows and retry cycles remain readable', () => {
  const large = Array.from({ length: 23 }, (_, index) => `步骤${index + 1} -> 步骤${index + 2}`).join('\n');
  assert.equal(documentFor(`\`\`\`architecture\n${large}\n\`\`\``).querySelectorAll('.diagram-node').length, 24);
  const cycle = documentFor('```flow\n提交 -> 审核\n审核 ->|退回修改| 提交\n审核 ->|通过| 结束\n```');
  assert.equal(cycle.querySelectorAll('.diagram-node').length, 3);
  assert.equal(cycle.querySelectorAll('.diagram-edge-label').length, 2);
  assert.equal(cycle.querySelector('.learning-flow pre'), null);
  assert.doesNotMatch(cycle.innerHTML, /NaN|undefined/);
});

test('bar, line and pie charts show source values and do not fetch assets', () => {
  for (const kind of ['bar', 'line', 'pie']) {
    const element = documentFor(`\`\`\`chart\ntype: ${kind}\ntitle: 示例收支\n收入 | 100\n支出 | 60\n\`\`\``);
    assert.ok(element.querySelector('.learning-chart svg'), kind);
    assert.match(element.querySelector('figcaption').textContent, /收入 100；支出 60/);
    assert.equal(element.querySelector('img, a, script'), null);
    if (kind === 'bar') assert.equal(element.querySelectorAll('svg rect').length, 2);
    if (kind === 'line') assert.equal(element.querySelectorAll('svg circle').length, 2);
    if (kind === 'pie') assert.equal(element.querySelectorAll('svg path').length, 2);
  }
});

test('invalid diagrams fall back to inert source text without active elements', () => {
  for (const source of [
    'A ->',
    'A -> <img src=x onerror=alert(1)>',
    Array.from({ length: 41 }, (_, i) => `节点${i} -> 节点${i + 1}`).join('\n'),
    Array.from({ length: 24 }, (_, i) => `节点${i} -> 节点${i + 1}`).join('\n')
  ]) {
    const element = documentFor(`\`\`\`flow\n${source}\n\`\`\``);
    assert.equal(element.querySelector('.learning-visual'), null);
    assert.ok(element.querySelector('pre code'));
    assert.match(element.querySelector('.visual-fallback').textContent, /图示暂时无法绘制/);
    assert.equal(element.querySelector('img, script, button, a'), null);
  }
  const badChart = documentFor('```chart\ntype: pie\ntitle: 错误数值\n收入 | -3\n支出 | 4\n```');
  assert.equal(badChart.querySelector('.learning-visual'), null);
  assert.ok(badChart.querySelector('pre code'));
  const hostileLabel = documentFor('```flow\n开始 ->|<img src=x onerror=alert(1)>| 结束\n```');
  assert.ok(hostileLabel.querySelector('.learning-flow'));
  assert.equal(hostileLabel.querySelector('img, script, button, a'), null);
  assert.match(hostileLabel.textContent, /<img src=x/);
});
