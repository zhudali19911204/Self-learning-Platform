import test from 'node:test';
import assert from 'node:assert/strict';
import { withInlineCourseCitations } from '../course-inline-citations.mjs';
import { groundedContent, sourceCitationIssue, validGrounding, MAX_COURSE_CITATIONS, courseReferences } from '../public/course-sources.js';
import { createApp } from '../server.mjs';

const documents = [{ id: 'S1', url: 'https://docs.example.org/guide', publisher: 'docs.example.org', title: 'Primary documentation', retrievedAt: 1000,
  excerpts: [{ id: 'S1E1', text: 'A real extracted passage.' }, { id: 'S1E2', text: 'Another real extracted passage.' }] }];

test('inline citations derive actual passages, adjacent IDs and repeated evidence without copied claims', () => {
  for (const body of ['提交身份与认证不同。', '**提交身份与认证不同。**', '使用 `git config` 配置身份。', '前文。\r\n后文。', '长'.repeat(900) + '结论。']) {
    const value = { text: body + '[S1E1][S1E2]', citations: [{ excerptId: 'invented', claim: '改写的说明不再使用' }] };
    const prepared = withInlineCourseCitations('reading', value);
    assert.equal(prepared.text, value.text);
    assert.deepEqual(prepared.citations.map(c => c.excerptId), ['S1E1', 'S1E2']);
    assert.ok(prepared.citations.every(c => value.text.includes(c.claim) && c.claim.length <= 600));
    const grounding = groundedContent('reading', prepared, documents);
    assert.ok(validGrounding(grounding));
    assert.equal(grounding.citations[0].quote, documents[0].excerpts[0].text);
  }
  const result = withInlineCourseCitations('reading', { text: '- 第一条结论。[S1E1]\n- 第二条结论。[S1E2]\n\n> 引用段落。[S1E1]' });
  assert.deepEqual(result.citations.map(c => c.claim), ['第一条结论。', '第二条结论。', '引用段落。']);
});

test('code, HTML, destinations and escaped markers cannot supply prose evidence; invalid and orphan IDs fail', () => {
  for (const text of ['`[S1E1]`', '```text\n[S1E1]\n```', '    [S1E1]', '<div>[S1E1]</div>', '[link](https://example.org/[S1E1])', '\\[S1E1]']) {
    const output = withInlineCourseCitations('reading', { text });
    assert.ok(sourceCitationIssue('reading', output, documents), text);
  }
  assert.throws(() => withInlineCourseCitations('reading', { text: '[S1E1]' }), /缺少可对应/);
  assert.throws(() => withInlineCourseCitations('reading', { text: '先前段落。\n\n[S1E1]' }), /缺少可对应/);
  assert.match(sourceCitationIssue('reading', withInlineCourseCitations('reading', { text: '结论。[S9E1]' }), documents), /未提供/);
  const legacy = { text: '结论。', citations: [{ excerptId: 'S1E1', claim: '结论。' }] };
  assert.equal(withInlineCourseCitations('reading', legacy), legacy);
});

test('every quiz explanation needs its own inline evidence, even when explanations repeat', () => {
  assert.throws(() => withInlineCourseCitations('quiz', { questions: [{ explanation: '结论。[S1E1]' }, { explanation: '结论。' }] }), /部分测验/);
  const value = withInlineCourseCitations('quiz', { questions: [{ explanation: '结论。[S1E1]' }, { explanation: '另一个结论。[S1E2]' }] });
  assert.equal(sourceCitationIssue('quiz', value, documents), null);
});

test('many passages can cite the same source without losing evidence or bypassing validation', () => {
  const makeOutput = count => ({ text: Array.from({ length: count }, (_, i) => `第${i + 1}个知识结论。[S1E1]`).join('\n\n') });
  for (const count of [13, 24, MAX_COURSE_CITATIONS]) {
    const prepared = withInlineCourseCitations('reading', makeOutput(count));
    assert.equal(prepared.citations.length, count);
    const grounding = groundedContent('reading', prepared, documents);
    assert.ok(validGrounding(grounding));
    const references = courseReferences({ blocks: [{ title: '讲解', content: { ...prepared, grounding } }] });
    assert.equal(references.length, 1);
    assert.equal(references[0].evidence.length, count);
  }
  const duplicate = withInlineCourseCitations('reading', { text: '重复结论。[S1E1][S1E1]\n\n重复结论。[S1E1]' });
  assert.equal(duplicate.citations.length, 1);
  const bad = withInlineCourseCitations('reading', { text: makeOutput(24).text + '\n\n没有依据的结论。[S9E1]' });
  assert.match(sourceCitationIssue('reading', bad, documents), /未提供/);
  assert.throws(() => withInlineCourseCitations('reading', makeOutput(MAX_COURSE_CITATIONS + 1)), /异常过多/);
  const valid = groundedContent('reading', withInlineCourseCitations('reading', makeOutput(1)), documents);
  assert.equal(validGrounding({ ...valid, citations: Array(MAX_COURSE_CITATIONS + 1).fill(valid.citations[0]) }), false);
});

test('generation endpoint persists inline-derived evidence and rejects unknown IDs before saving', async t => {
  let output = { text: '**实际结论。**[S1E1]', citations: [{ excerptId: 'S1E1', claim: '并不存在的改写' }] };
  const server = createApp({ getLLM: () => ({ generate: async (_prompt, _input, validate) => { assert.equal(validate(output), true); return output; } }), courseSources: { prepare: async () => documents } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: '学习配置', level: '初学', title: '配置', objective: '理解身份', intro: '开始', block: { type: 'reading', title: '身份', objective: '配置身份' }, sourceSearch: { enabled: true, revision: 1 } }) });
  let response = await post();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.grounding.citations[0].claim, '**实际结论。**');
  assert.equal(body.grounding.citations[0].url, documents[0].url);
  output = { text: Array.from({ length: 24 }, (_, i) => `第${i + 1}个知识结论。[S1E1]`).join('\n\n') };
  response = await post(); assert.equal(response.status, 200);
  const expanded = await response.json();
  assert.equal(expanded.grounding.citations.length, 24);
  assert.equal(expanded.text, output.text);
  output = { text: '结论。[S9E1]' };
  response = await post(); assert.equal(response.status, 422); assert.match((await response.json()).error, /未提供/);
});
