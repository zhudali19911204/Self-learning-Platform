import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCourseSources, readOfficialDocument, extractOfficialDocument, selectExcerpts, readSearchResponse } from '../course-sources.mjs';
import { officialSource, validGrounding, validLegacySourceBundle, sourceCitationIssue, groundedContent, courseReferences } from '../public/course-sources.js';
import { revisedContent, restoredContent } from '../public/blocks.js';
import { createApp } from '../server.mjs';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { validState } from '../desktop/local-store.mjs';
import { createCourseClaimMatcher } from '../course-claim-matching.mjs';
import { withInlineCourseCitations } from '../course-inline-citations.mjs';

const url = 'https://git-scm.com/docs/git-config';
const sourceText = 'The user.name and user.email variables determine what ends up in the author and committer fields of commit objects. These settings do not provide authentication to a remote repository.\n';
const documents = [{ id: 'S1', url, title: 'Git config', publisher: 'Git', retrievedAt: 1000, excerpts: [{ id: 'S1E1', text: sourceText }] }];
const generated = () => ({ text: '提交身份与远程认证不同。', citations: [{ excerptId: 'S1E1', claim: '提交身份与远程认证不同。' }] });
const configuration = { provider: 'qwen', model: 'qwen3.8-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-not-real-secret', timeoutMs: 1000, localOnly: false };

test('source exclusion policy accepts new public sites and rejects blocked domains and unsafe URLs', () => {
  for (const u of [url, 'https://docs.python.org/3/tutorial/index.html', 'https://developers.openai.com/codex/quickstart', 'https://platform.openai.com/docs/guides/tools', 'https://www.who.int/news-room/fact-sheets/detail/diabetes']) assert.ok(officialSource(u), u);
  for (const u of ['http://git-scm.com/docs/git-config', 'https://git-scm.com.evil.test/docs/git-config', 'https://git-scm.com@evil.test/docs/git-config', 'https://community.openai.com/t/example', 'https://learn.microsoft.com/en-us/answers/questions/example', 'https://sqlite.org/forum/forumpost/1', 'https://git-scm.com/docs/%2f..%2f/private', 'https://git-scm.com/docs/../community', 'https://git-scm.com/docs/%252e%252e/foo', 'https://git-scm.com/docs/foo?url=http://127.0.0.1', 'https://127.0.0.1/docs/x', 'https://[::1]/doc', 'https://2130706433/doc', 'https://server.internal/doc', 'https://localhost/doc', 'https://www.zhihu.com/question/123', 'https://blog.csdn.net/article/1', 'https://www.zhihu.com./question/1', 'https://news.reddit.com/anything', 'https://docs.example.org:8443/doc', 'https://docs.example.org/doc?redirect=https://example.com']) assert.equal(officialSource(u), null, u);
  assert.equal(officialSource(`${url}?utm_source=test#identity`).url, url);
  assert.equal(officialSource('https://learn.microsoft.com/en-us/%61nswers/questions/example'), null);
  for (const u of ['https://new-docs.example.org/guide', 'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5194907/content.html', 'https://www.chinatax.gov.cn/chinatax/notice/content.html', 'https://docs.example.org/reference?article=42&lang=zh', 'https://notzhihu.com/guide']) assert.ok(officialSource(u), u);
  assert.equal(officialSource('https://new-docs.example.org/guide').publisher, 'new-docs.example.org');
  assert.equal(officialSource('https://docs.example.org/reference?article=42&utm_source=test').url, 'https://docs.example.org/reference?article=42');
});

test('HTML extraction selects main content, excludes navigation, scripts, hidden text and comments', () => {
  const doc = extractOfficialDocument(`<html><head><title>Git &amp; config</title></head><body><nav>navigation</nav><main><h1>Identity</h1><p>${sourceText}</p><script>secret-instructions</script><div class="comments">untrusted-comment</div><div hidden>hidden-content</div></main><footer>footer-text</footer></body></html>`);
  assert.equal(doc.title, 'Git & config'); assert.match(doc.text, /user.email/);
  assert.doesNotMatch(doc.text, /navigation|secret-instructions|untrusted-comment|hidden-content|footer-text/);
  assert.throws(() => extractOfficialDocument('<main>Login</main>'), /正文不足/);
  assert.ok(extractOfficialDocument(`<main><p>${sourceText}</p><pre>if ready:\n    print('preserve indentation')</pre></main>`).text.includes("\n    print('preserve indentation')"));
  const long = sourceText.repeat(80); const excerpts = selectExcerpts(long, 'user.email', 'S1');
  assert.ok(excerpts.length <= 6); assert.ok(excerpts.every(e => long.includes(e.text) && e.text.length <= 1200));
});

function responseRequest({ status = 200, body = `<main>${sourceText}</main>`, headers = {} }, observe = () => {}) {
  return (target, options, callback) => {
    observe(target, options); const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = status; res.headers = { 'content-type': 'text/html', ...headers }; res.destroy = () => {};
      callback(res); res.emit('data', Buffer.from(body)); res.emit('end');
    }); return req;
  };
}
test('document reader checks DNS and redirects, pins the socket, omits cookies and credentials', async () => {
  let requests = 0;
  await assert.rejects(readOfficialDocument(url, { resolve: async () => [{ address: '127.0.0.1', family: 4 }], request: () => requests++ }), /内网/);
  assert.equal(requests, 0);
  const resolve = async () => [{ address: '8.8.8.8', family: 4 }];
  const doc = await readOfficialDocument(url, { resolve, request: responseRequest({}, (_target, options) => {
    requests++; assert.equal(options.rejectUnauthorized, true); assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined);
    options.lookup('git-scm.com', { all: true }, (_error, addresses) => assert.equal(addresses[0].address, '8.8.8.8'));
  }) });
  assert.equal(doc.url, url); assert.match(doc.text, /author/);
  await assert.rejects(readOfficialDocument(url, { resolve, request: responseRequest({ status: 302, headers: { location: 'https://www.zhihu.com/question/1' } }, () => requests++) }), /被排除/);
  assert.equal(requests, 2, 'untrusted redirect never fetched');
});

test('search uses actual completed tool sources and filters before reading; no retries on failures', async () => {
  let calls = 0; const reads = [];
  const service = createCourseSources({ getConfig: () => configuration, fetchImpl: async (target, options) => {
    calls++; assert.equal(target, configuration.baseUrl + '/responses'); assert.equal(options.redirect, 'error');
    const payload = JSON.parse(options.body); assert.deepEqual(payload.tools, [{ type: 'web_search' }]); assert.equal(payload.tool_choice, undefined);
    return Response.json({ output: [
      { type: 'message', content: [{ text: 'https://docs.python.org/3/tutorial/' }] },
      { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://blog.example.test/article' }, { url }, { url: url + '#test' }] } },
    ] });
  }, read: async value => { reads.push(value); return { url: value, title: '实际读取标题', text: sourceText, retrievedAt: 1234 }; } });
  const docs = await service.prepare('Git 提交身份');
  assert.equal(calls, 1); assert.deepEqual(reads, [url]); assert.equal(docs[0].title, '实际读取标题');
  assert.ok(docs[0].excerpts.every(e => sourceText.includes(e.text)));
  const failure = createCourseSources({ getConfig: () => configuration, fetchImpl: async () => { calls++; return new Response('', { status: 400 }); } });
  await assert.rejects(failure.prepare('Git 提交身份'), /HTTP 400/); assert.equal(calls, 2);
  const unsupported = createCourseSources({ getConfig: () => ({ ...configuration, baseUrl: 'https://example.test/v1' }), fetchImpl: async () => calls++ });
  await assert.rejects(unsupported.prepare('Git 身份'), /不支持/); assert.equal(calls, 2);
});

test('streaming tool results are decoded; messages alone cannot produce evidence', async () => {
  const event = { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', status: 'completed', action: { sources: [{ url }] } } };
  const response = new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await readSearchResponse(response)).output[0].action.sources[0].url, url);
  let reads = 0;
  const service = createCourseSources({ getConfig: () => configuration, fetchImpl: async () => Response.json({ output: [{ type: 'message', content: [{ text: url }] }] }), read: () => reads++ });
  await assert.rejects(service.prepare('Git 身份'), /没有有效资料链接/); assert.equal(reads, 0);
});

test('model selects excerpt IDs, while program fills exact quotes and links; revisions preserve provenance', () => {
  const output = { ...generated(), quote: 'invented', url: 'https://evil.test' };
  const grounding = groundedContent('reading', output, documents);
  assert.equal(grounding.citations[0].quote, sourceText); assert.equal(grounding.citations[0].url, url); assert.ok(validGrounding(grounding));
  assert.match(sourceCitationIssue('reading', { ...output, citations: [{ excerptId: 'S3E8', claim: output.text }] }, documents), /未提供/);
  assert.match(sourceCitationIssue('reading', { ...output, citations: [{ excerptId: 'S1E1', claim: '正文中不存在' }] }, documents), /不对应/);
  assert.match(sourceCitationIssue('reading', { sourceInsufficient: true }, documents), /不足/);
  const before = { text: output.text, grounding };
  const after = revisedContent('reading', before, { text: '关闭搜索后的新正文' });
  assert.equal(after.grounding, undefined); assert.deepEqual(restoredContent('reading', after).grounding, grounding);
  const course = { blocks: [{ title: '讲解', content: before }, { title: '案例', content: before }, { title: '关闭搜索', content: after }] };
  const refs = courseReferences(course); assert.equal(refs.length, 1); assert.deepEqual(refs[0].blocks, ['讲解', '案例']);
});

test('claim matching tolerates presentation markup and prose whitespace but preserves meaning and code', () => {
  const match = createCourseClaimMatcher();
  for (const [body, claim] of [
    ['**提交身份**与远程认证不同。', '提交身份与远程认证不同。'],
    ['使用 `git config` 配置身份。', '使用 git config 配置身份。'],
    ['- **先配置**用户名，再提交。', '先配置用户名，再提交。'],
    ['## 提交身份\n\nGit   配置\n身份。', 'Git 配置 身份。'],
    ['提交身份与远程认证不同。', '**提交身份**与远程认证不同。'],
    ['***提交身份***与远程认证不同。', '提交身份与远程认证不同。'],
  ]) { const found = match(body, claim); assert.ok(found, JSON.stringify({ body, claim })); assert.ok(body.includes(found)); }
  for (const [body, claim] of [
    ['Git 不是密码。', 'Git 是密码。'], ['最多 3 次。', '最多 5 次。'],
    ['a * b * c', 'a b c'], ['user_name', 'username'], ['x != y', 'x = y'],
    ['提交前配置身份。', '先填写姓名就可以登录。'],
    ['A。\n\n其他段落。\n\nB。', 'A。B。'],
    ['`print("a  b")`', 'print("a b")'], ['```python\nprint("a  b")\n```', 'print("a b")'],
    ['```python\nx = a ** b\n```', 'x = a b'],
    ['[官网](https://git-scm.com/docs/git-config)', '官网(https://evil.test)'],
  ]) assert.equal(match(body, claim), null, JSON.stringify({ body, claim }));
  const output = { text: '**提交身份**与远程认证不同。', citations: generated().citations };
  assert.equal(sourceCitationIssue('reading', output, documents, match), null);
  const grounding = groundedContent('reading', output, documents, match);
  assert.equal(grounding.citations[0].claim, output.text);
  assert.equal(grounding.citations[0].quote, sourceText);
  assert.ok(validGrounding(grounding));
  const quiz = { questions: [{ explanation: '**提交身份**与远程认证不同。' }, { explanation: '另一个结论。' }], citations: generated().citations };
  assert.match(sourceCitationIssue('quiz', quiz, documents, match), /部分测验/);
});

const blockRequest = { goal: '学习Git', level: '零基础', title: 'Git 身份', objective: '区分身份与认证', intro: '导语', block: { type: 'reading', title: '身份字段', objective: '配置用户名与邮箱' } };
async function serve(t, config) {
  const server = createApp(config); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return body => fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
test('generation switch gates searches, enforces citations, strips untrusted metadata, fails closed', async t => {
  let searches = 0, generations = 0, output = generated(), failSearch = false, input;
  const post = await serve(t, { getLLM: () => ({ generate: async (_prompt, request, validate) => { generations++; input = request; if (!validate(output)) throw new Error('invalid output'); return output; } }),
    courseSources: { prepare: async () => { searches++; if (failSearch) throw new Error('没有官方文档'); return documents; } } });
  let response = await post({ ...blockRequest, sourceSearch: { enabled: true, revision: 1 }, officialDocuments: [{ url: 'https://evil.test' }] });
  assert.equal(response.status, 200); assert.ok((await response.json()).grounding); assert.equal(input.officialDocuments[0].url, url);
  output = { ...generated(), text: '**提交身份**与远程认证不同。' };
  response = await post({ ...blockRequest, sourceSearch: { enabled: true, revision: 1 } });
  assert.equal(response.status, 200); const saved = await response.json();
  assert.equal(saved.grounding.citations[0].claim, saved.text);
  output = generated();
  response = await post({ ...blockRequest, sourceSearch: { enabled: false, revision: 2 } });
  assert.deepEqual(await response.json(), { text: generated().text }); assert.equal(input.officialDocuments, undefined); assert.equal(searches, 2);
  output = { text: '无引用' }; response = await post({ ...blockRequest, sourceSearch: { enabled: true, revision: 3 } });
  assert.equal(response.status, 422); assert.match((await response.json()).error, /引用/);
  failSearch = true; response = await post({ ...blockRequest, sourceSearch: { enabled: true, revision: 3 } });
  assert.notEqual(response.status, 200); assert.equal(generations, 4, 'failed search never falls back to model generation');
});
test('desktop stored preference is authoritative and changed revisions cancel before generation', async t => {
  let preference = { enabled: true, revision: 1 }, generations = 0;
  const post = await serve(t, { getCourseSourceSearch: () => preference, getLLM: () => ({ generate: async () => { generations++; return generated(); } }),
    courseSources: { prepare: async () => { preference = { enabled: false, revision: 2 }; return documents; } } });
  const response = await post({ ...blockRequest, lessonId: 'lesson-1', sourceSearch: preference });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /设置已变化/); assert.equal(generations, 0);
});

test('SQLite persists preferences and evidence through restart, export/import and course deletion', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'learnflow-course-sources-'));
  assert.ok(path.resolve(folder).startsWith(path.resolve(tmpdir()) + path.sep));
  let store; t.after(async () => { store?.close(); await rm(folder, { recursive: true, force: true }); });
  store = await createSqliteStore(folder);
  assert.deepEqual(store.getLesson('p1').sourceSearch, { enabled: false, revision: 0 });
  store.setSourceSearch('p1', true);
  const course = store.saveOutline('p1', { intro: '测试', blocks: [{ type: 'reading', title: '讲解', objective: '配置' }, { type: 'quiz', title: '测试', objective: '检验' }] });
  const many = withInlineCourseCitations('reading', { text: Array.from({ length: 24 }, (_, i) => `配置知识第${i + 1}条。[S1E1]`).join('\n\n') });
  store.saveBlock('p1', course.blocks[0].id, { text: many.text, grounding: groundedContent('reading', many, documents) });
  const backup = store.exportState(); assert.ok(validState(backup)); assert.equal(backup.sourceSearch.p1.enabled, true);
  store.close(); store = await createSqliteStore(folder);
  assert.equal(store.getLesson('p1').blockCourse.blocks[0].content.grounding.citations.length, 24);
  await store.replaceState(backup);
  assert.equal(store.getLesson('p1').blockCourse.blocks[0].content.grounding.citations.length, 24);
  const legacy = { version: 1, verification: 'quotes_checked', revision: 1, citations: [{ sourceId: 'S1', quote: sourceText, claim: generated().text, url, title: '旧版 Git 文档', hash: 'a'.repeat(64), fetchedAt: 1000 }] };
  const legacyBundle = { version: 1, enabled: true, revision: 1, confirmedAt: 1000, documents: [{ id: 'S1', url, title: '旧版 Git 文档', text: sourceText, hash: 'a'.repeat(64), fetchedAt: 1000, truncated: false }] };
  assert.ok(validGrounding(legacy)); assert.ok(validLegacySourceBundle(legacyBundle));
  backup.blockCourses.p1.blocks[0].content.grounding = legacy;
  backup.sourceBundles = { p1: legacyBundle };
  await store.replaceState(backup);
  store.close(); store = await createSqliteStore(folder);
  assert.equal(store.getLesson('p1').sourceSearch.enabled, true); assert.deepEqual(store.getLesson('p1').blockCourse.blocks[0].content.grounding, legacy);
  assert.deepEqual(store.exportState().sourceBundles.p1, legacyBundle);
  assert.equal(courseReferences(store.getLesson('p1').blockCourse)[0].retrievedAt, 1000);
  store.setSourceSearch('p1', false); await store.replaceState(backup);
  assert.equal(store.getLesson('p1').sourceSearch.enabled, true);
  const plan = structuredClone(backup.plans[0]); plan.id = 'another-plan'; plan.lessons.forEach((l, i) => l.id = `another-${i}`); store.savePlan(plan);
  await store.deletePlan(backup.plans[0].id);
  const after = store.exportState(); assert.equal(after.sourceSearch?.p1, undefined); assert.equal(after.sourceBundles?.p1, undefined); assert.equal(after.blockCourses?.p1, undefined); assert.ok(validState(after));
});
