import test from 'node:test';
import assert from 'node:assert/strict';
import { citationPassages, completeMissingCourseCitations, needsCitationCompletion } from '../course-citation-repair.mjs';
import { withInlineCourseCitations } from '../course-inline-citations.mjs';
import { validGrounding } from '../public/course-sources.js';
import { createApp } from '../server.mjs';
import { generationAwait, currentGenerationSignal } from '../generation-cancellation.mjs';

const documents = [{ id: 'S1', url: 'https://docs.example.org/costs', title: '成本汇总说明', publisher: '示例资料', retrievedAt: 1000,
  excerpts: [{ id: 'S1E1', text: '先按相同口径归集仓储与运输成本，再将二者相加。' }, { id: 'S1E2', text: '汇总时应核对单位与期间。' }] }];
const plain = '## 成本汇总\n\n先按相同口径归集仓储与运输成本，再将二者相加。\n\n教学示例：仓储为1200元，运输为800元，总额为2000元。';
const input = { lessonId: 'cost-lesson', goal: '汇总成本', level: '零基础', title: '成本汇总', objective: '核对汇总口径', intro: '逐步核对',
  block: { type: 'example', title: '第二步：仓储与运输成本及总成本的汇总', objective: '按相同口径汇总成本' }, sourceSearch: { enabled: true, revision: 1 } };
const reply = passages => ({ citations: [{ passageId: passages[0].id, excerptIds: ['S1E1'] }] });

test('missing citations are distinguished from invalid IDs, legacy citations and optional quiz references', () => {
  for (const citations of [undefined, []]) assert.equal(needsCitationCompletion('example', { text: plain, citations }), true);
  for (const value of [{ text: plain, sourceInsufficient: true }, { text: plain, citations: 'invalid' }, withInlineCourseCitations('reading', { text: plain + '[S9E9]' }), { text: plain, citations: [{ excerptId: 'S1E1', claim: '旧格式' }] }]) assert.equal(needsCitationCompletion('reading', value), false);
  assert.equal(needsCitationCompletion('quiz', { questions: [] }), false);
});

test('repair anchors preserve original paragraphs, table cells, containers and CRLF while excluding literal and ambiguous text', () => {
  const text = '## 不把标题作为依据\n\n`纯代码中不应该插入引用`\n\n```text\n代码里面不应出现引用\n```\n\n<div>HTML内不应出现引用</div>\n\n[只含链接的文字不应作为引用](https://example.org)\n\n> 核对汇总单位与期间应当保持一致。\n\n- 明确归集成本的方法与适用边界。\n\n| 成本项目 | 汇总方法 |\n| --- | --- |\n| 仓储成本 | 按相同期间归集 |\n\n重复正文内容不应猜测引用位置。\n\n重复正文内容不应猜测引用位置。';
  for (const source of [text, text.replaceAll('\n', '\r\n')]) {
    const passages = citationPassages(source);
    assert.equal(passages.length, 3);
    assert.match(passages[0].text, /核对汇总/); assert.match(passages[1].text, /明确归集/); assert.match(passages[2].text, /仓储成本/);
    for (const passage of passages) assert.equal(source.slice(passage.end - passage.text.length, passage.end), passage.text);
  }
});

test('one citation-only request inserts validated known IDs and leaves every original character and value intact', async () => {
  const text = plain + '\n\n| 成本项目 | 汇总方法 |\n| --- | --- |\n| 仓储成本 | 按相同期间归集 |', draft = { text, imageProposal: { caption: '已有图注' } }, original = structuredClone(draft);
  let calls = 0;
  const completed = await completeMissingCourseCitations({ type: 'example', draft, documents, generate: async (prompt, sent, validate, options) => {
    calls++; assert.match(prompt, /不重新生成或改写正文/); assert.equal(options.stage, 'citing'); assert.equal(sent.draftText, text); assert.deepEqual(sent.officialDocuments, documents);
    assert.deepEqual(sent.passages.map(p => Object.keys(p)), sent.passages.map(() => ['id', 'text']));
    assert.equal(validate({ citations: sent.passages.filter(p => !p.text.includes('教学示例')).map(p => ({ passageId: p.id, excerptIds: ['S1E1', 'S1E2', 'S1E1'] })) }), true);
  } });
  assert.equal(calls, 1); assert.equal(completed.text.replace(/\[S\d+E\d+\]/g, ''), text); assert.deepEqual(draft, original);
  assert.equal(completed.citations.length, 4); assert.match(completed.text, /按相同期间归集\[S1E1\]\[S1E2\] \|/);
});

test('unsupported draft, invented anchors, invalid IDs and text rewriting cannot bypass citation checks or trigger another attempt', async () => {
  for (const value of [{ sourceInsufficient: true }, { citations: [] }, { text: 'changed', ...reply([{ id: 'P1' }]) }, { citations: [{ passageId: 'P999', excerptIds: ['S1E1'] }] }, { citations: [{ passageId: 'P1', excerptIds: ['S9E9'] }] }]) {
    let calls = 0;
    await assert.rejects(completeMissingCourseCitations({ type: 'example', draft: { text: plain }, documents, generate: async (_prompt, _sent, validate) => { calls++; validate(value); } }), error => error.status === 422 && /未保存/.test(error.message));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(completeMissingCourseCitations({ type: 'reading', draft: { text: '```text\n只有代码不作为依据\n```' }, documents, generate: async () => { calls++; } }), /没有可安全关联/);
  assert.equal(calls, 0);
  for (const text of ['`'+'字面内容'.repeat(200)+'`', '**<span>HTML内不应出现引用</span>**', '[只有链接不作为引用](https://example.org/'+ 'a'.repeat(800)+')']) assert.deepEqual(citationPassages(text), []);
});

test('completion honours changed settings and cancellation before sending another paid request', async () => {
  let calls = 0;
  await assert.rejects(completeMissingCourseCitations({ type: 'reading', draft: { text: plain }, documents,
    beforeComplete: () => { throw Object.assign(new Error('联网搜索设置已变化'), { status: 422 }); }, generate: async () => { calls++; } }), /设置已变化/);
  assert.equal(calls, 0);
});

async function serve(t, { output = { text: plain }, correction, local = false, beforeGenerate = () => {} } = {}) {
  let calls = 0, searches = 0; const stages = [], requests = [];
  const material = { version: 1, id: 'a'.repeat(64), name: '成本汇总.md', type: 'md', bytes: 200, importedAt: 1000, parts: [{ id: 'part-1', location: '第1行', text: documents[0].excerpts[0].text }] };
  const server = createApp({ ...(local ? { getCourseMaterials: () => [material] } : {}), onGenerationProgress: (_id, stage) => stages.push(stage),
    courseSources: { prepare: async () => { searches++; return documents; } }, getLLM: () => ({ generate: async (prompt, sent, validate) => {
      calls++; requests.push(structuredClone(sent)); await beforeGenerate(sent);
      if (sent.task !== 'complete-course-citations' && sent.officialDocuments) assert.match(prompt, /非测验模块必须/);
      const value = sent.task === 'complete-course-citations' ? correction || reply(sent.passages) : structuredClone(output);
      if (!validate(value)) throw Object.assign(new Error('模型返回的内容不完整或格式不符合要求，请重试生成。'), { status: 502 });
      return value;
    } }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { post: (body = input, signal) => fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Learnflow-Progress': 'generation-citation-completion' }, body: JSON.stringify(body) }),
    counts: () => ({ calls, searches }), stages, requests };
}

test('reported missing-citation failure completes safely through the endpoint for both imported and online documents', async t => {
  for (const local of [false, true]) {
    const f = await serve(t, { local }), response = await f.post(); assert.equal(response.status, 200);
    const value = await response.json(); assert.equal(value.text.replace('[S1E1]', ''), plain); assert.equal(validGrounding(value.grounding), true);
    assert.equal(value.grounding.citations[0].quote, documents[0].excerpts[0].text);
    assert.equal(value.grounding.citations[0].url, local ? `learnflow-material:${'a'.repeat(64)}` : documents[0].url);
    assert.deepEqual(f.counts(), { calls: 2, searches: local ? 0 : 1 });
    assert.deepEqual(f.stages, [...(local ? [] : ['searching']), 'generating', 'validating', 'citing', 'validating']);
    assert.equal(f.requests[1].goal, undefined, 'no notes, chats or unnecessary course history sent for completion');
  }
});

test('valid citations, unknown IDs, insufficient sources and offline generation do not start citation completion', async t => {
  for (const [output, enabled, status] of [[{ text: plain + '[S1E1]' }, true, 200], [{ text: plain + '[S9E9]' }, true, 422], [{ sourceInsufficient: true }, true, 422], [{ text: plain }, false, 200]]) {
    const f = await serve(t, { output }); const response = await f.post({ ...input, sourceSearch: { enabled, revision: 1 } });
    assert.equal(response.status, status); assert.deepEqual(f.counts(), { calls: 1, searches: enabled ? 1 : 0 });
  }
});

test('a citation completion failure is reported without returning a draft or retrying', async t => {
  for (const correction of [{ sourceInsufficient: true }, { citations: [] }, { citations: [{ passageId: 'P1', excerptIds: ['S9E9'] }] }]) {
    const f = await serve(t, { correction }), response = await f.post(), value = await response.json();
    assert.equal(response.status, 422); assert.match(value.error, /未保存/); assert.equal(value.text, undefined); assert.equal(value.grounding, undefined);
    assert.deepEqual(f.counts(), { calls: 2, searches: 1 });
  }
});

test('citation completion cannot push an otherwise valid draft past the saved content length limit', async t => {
  const ending = '核对成本归集的口径与归集期间。', text = 'x'.repeat(11999 - ending.length) + ending;
  const f = await serve(t, { output: { text } }), response = await f.post();
  assert.equal(response.status, 422); assert.match((await response.json()).error, /超过长度限制/);
  assert.deepEqual(f.counts(), { calls: 2, searches: 1 });
});

test('cancelling during citation completion stops the request and does not return draft content', async t => {
  let entered, stopped; const started = new Promise(resolve => { entered = resolve; }), ended = new Promise(resolve => { stopped = resolve; }); let completed = false;
  const f = await serve(t, { beforeGenerate: async sent => {
    if (sent.task === 'complete-course-citations') { entered(currentGenerationSignal()); try { await generationAwait(new Promise(() => {})); completed = true; } finally { stopped(); } }
  } });
  const controller = new AbortController(), response = f.post(input, controller.signal);
  const rejected = assert.rejects(response, error => error.name === 'AbortError'); const signal = await started;
  controller.abort(); await rejected; await ended;
  assert.equal(signal.aborted, true); assert.equal(completed, false); assert.deepEqual(f.counts(), { calls: 2, searches: 1 });
});
