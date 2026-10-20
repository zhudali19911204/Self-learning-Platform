import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { blockGenerationContext } from '../public/blocks.js';
import { validTeachingContext } from '../public/teaching-context.js';
import { cleanGenerationCitationContext, withoutPriorCitationMarkers } from '../course-citation-context.mjs';

const documents = [{ id: 'S1', url: 'https://git-scm.com/docs/git-config', title: 'Git config', publisher: 'Git', retrievedAt: 1000,
  excerpts: [{ id: 'S1E1', text: 'The user.name and user.email variables determine the identity in commit objects, not remote authentication.' }] }];
const inputFor = (type, revising = false) => {
  const course = { intro: '根据前序内容学习。[S3E7]', blocks: [
    { id: 'reading', type: 'reading', title: '身份与认证', objective: '区分提交身份与认证', content: { text: '提交身份与远程认证不同。[S3E7]\n\n代码中的标记只是示例：`[S2E8]`。' } },
    { id: 'example', type: 'example', title: '身份示例', objective: '核对身份配置', content: { text: '先核对用户名与邮箱。[S2E8]' } },
    { id: 'target', type, title: '独立核对身份', objective: '独立核对提交身份与远程认证', content: null }
  ] };
  return { goal: '正确理解 Git 身份', level: '零基础', title: '提交身份', objective: '区别身份和认证',
    block: { type, title: course.blocks[2].title, objective: course.blocks[2].objective },
    ...blockGenerationContext(course, 'target'),
    ...(revising ? { revisionRequest: '降低难度，分步说明任务。', currentExcerpt: '原实践内容。[S2E8]\n\n`[S3E7]` 是代码里的字面量。' } : {}) };
};
async function serve(t) {
  const sent = []; let searches = 0, forced, materials = documents;
  const server = createApp({ getLLM: () => ({ generate: async (instruction, input, validate) => {
    sent.push({ instruction, input: structuredClone(input) });
    // Reproduce a model copying stale context IDs when both generations' IDs
    // are present. No repair or retry is simulated by this mock.
    const stale = input.currentExcerpt?.split('\n\n')[0].match(/\[(S\d+E\d+)\]/)?.[1]
      || input.previous[0].excerpt.split('\n\n')[0].match(/\[(S\d+E\d+)\]/)?.[1];
    const id = stale || input.officialDocuments?.[0].excerpts[0].id;
    const result = forced || { text: '## 教学示例任务\n\n提交身份与远程认证不同。' + (id ? `[${id}]` : '') + '\n\n请独立核对配置并说明理由。' };
    assert.ok(validate(result)); return result;
  } }), courseSources: { prepare: async () => { searches++; return structuredClone(materials); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { post, sent, searches: () => searches, output: value => { forced = value; }, materials: value => { materials = value; } };
}

test('practice and other teaching blocks isolate previous citation IDs from the current search documents', async t => {
  const f = await serve(t);
  for (const type of ['practice', 'reading', 'example', 'summary']) {
    const input = { ...inputFor(type), sourceSearch: { enabled: true, revision: 1 } }, before = structuredClone(input);
    const response = await f.post(input);
    assert.equal(response.status, 200, type);
    const value = await response.json(), sent = f.sent.at(-1);
    assert.equal(value.grounding.citations.length, 1);
    assert.equal(value.grounding.citations[0].excerptId, 'S1E1');
    assert.equal(value.grounding.citations[0].url, documents[0].url);
    assert.ok(!sent.input.intro.includes('[S3E7]'));
    assert.ok(!sent.input.previous[0].excerpt.split('\n\n')[0].includes('[S3E7]'));
    assert.ok(sent.input.previous[0].excerpt.includes('`[S2E8]`'), 'literal code is not rewritten');
    assert.equal(validTeachingContext(sent.input.teachingContext), true, 'masking preserves source offsets and lengths');
    assert.ok(sent.input.teachingContext.sources.every(s => s.spans.every(p => !p.text.split('\n\n')[0].includes('[S3E7]') && !p.text.includes('用户名与邮箱。[S2E8]'))));
    assert.match(sent.instruction, /本次可用资料片段编号/);
    assert.ok(sent.instruction.includes('["S1E1"]'));
    assert.deepEqual(sent.input.officialDocuments, documents);
    assert.deepEqual(input, before, 'the actual course request/original content is not rewritten');
  }
  assert.equal(f.searches(), 4); assert.equal(f.sent.length, 4);
});

test('task revision isolates current-excerpt citations too, while offline generation does not gain sources', async t => {
  const f = await serve(t);
  for (const enabled of [true, false]) {
    const input = { ...inputFor('practice', true), sourceSearch: { enabled, revision: 1 } };
    const response = await f.post(input);
    assert.equal(response.status, 200);
    const sent = f.sent.at(-1).input, value = await response.json();
    assert.ok(!sent.currentExcerpt.split('\n\n')[0].includes('[S2E8]'));
    assert.ok(sent.currentExcerpt.includes('`[S3E7]`'));
    assert.equal(sent.currentExcerpt.length, input.currentExcerpt.length);
    assert.equal(sent.revisionRequest, input.revisionRequest);
    assert.equal(Boolean(sent.officialDocuments), enabled);
    assert.equal(Boolean(value.grounding), enabled);
  }
  assert.equal(f.sent.length, 2); assert.equal(f.searches(), 1);
});

test('practice still rejects fabricated IDs, uncited online claims and excluded source URLs without retries', async t => {
  const f = await serve(t), input = { ...inputFor('practice'), sourceSearch: { enabled: true, revision: 1 } };
  for (const text of ['提交身份与远程认证不同。[S3E7]', '提交身份与远程认证不同。[S1E1][S9E9]', '提交身份与远程认证不同。']) {
    f.output({ text }); const response = await f.post(input);
    assert.equal(response.status, 422); assert.match((await response.json()).error, /引用|资料/);
  }
  assert.equal(f.sent.length, 3); assert.equal(f.searches(), 3);
  f.materials([{ ...documents[0], url: 'https://zhihu.com/unreliable' }]);
  f.output({ text: '提交身份与远程认证不同。[S1E1]' });
  const excluded = await f.post(input);
  assert.equal(excluded.status, 422); assert.match((await excluded.json()).error, /排除/);
  assert.equal(f.sent.length, 4); assert.equal(f.searches(), 4);
});

test('shared citation masking preserves nested literal blocks, related context, CRLF and original revision text', () => {
  const source = '- 段落。[S2E3]\n\n  - 内层段落。[S3E2]\n\n        [S1E1]\n\n> 另一段。[S2E1]\n>\n> ```text\n> [S1E1]\n> ```\n\n- <div>[S1E1]</div>\n';
  const masked = withoutPriorCitationMarkers(source);
  assert.equal(masked.length, source.length);
  for (const literal of ['        [S1E1]', '> [S1E1]', '<div>[S1E1]</div>']) assert.ok(masked.includes(literal), literal);
  for (const prose of ['段落。[S2E3]', '段落。[S3E2]', '另一段。[S2E1]']) assert.ok(!masked.includes(prose), prose);
  for (const value of ['- [x] alpha[S1E1]\n- [ ] beta[S2E1]', '- alpha[S1E1]\n\t- beta[S2E1]']) {
    const result = withoutPriorCitationMarkers(value);
    assert.equal(result.length, value.length); assert.ok(!result.includes('[S1E1]')); assert.ok(!result.includes('[S2E1]'));
  }
  assert.equal(withoutPriorCitationMarkers('前文。[S3E2] <span>literal [S1E1]</span> 后文。[S2E1]'), '前文。       <span>literal [S1E1]</span> 后文。      ');
  const context = { intro: '导语。[S1]', currentExcerpt: '旧稿。[S2E8]\r\n\r\n```text\r\n[S1E1]\r\n```', related: [{ type: 'example', title: '案例', excerpt: '案例结论。[S3E7]' }], officialDocuments: documents };
  const original = structuredClone(context), clean = cleanGenerationCitationContext(context);
  assert.deepEqual(context, original); assert.deepEqual(clean.officialDocuments, documents);
  assert.equal(clean.currentExcerpt.length, context.currentExcerpt.length);
  assert.ok(clean.currentExcerpt.includes('```text\r\n[S1E1]\r\n```'));
  assert.ok(!clean.currentExcerpt.includes('旧稿。[S2E8]'));
  assert.ok(!clean.related[0].excerpt.includes('[S3E7]'));
  assert.ok(!clean.intro.includes('[S1]'));
});
