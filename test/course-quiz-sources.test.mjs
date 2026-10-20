import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { quizMaterials, withoutPriorCitationMarkers } from '../course-quiz-sources.mjs';
import { blockGenerationContext } from '../public/blocks.js';
import { validTeachingContext } from '../public/teaching-context.js';
import { validGrounding } from '../public/course-sources.js';

const citation = (url, claim, quote, excerptId = 'S1E1') => ({ excerptId, url, claim, quote, title: '原始资料', publisher: '资料站', retrievedAt: 1000 });
const course = () => ({ intro: '已讲内容为练习范围。', blocks: [
  { id: 'r1', type: 'reading', title: '任务与条件', objective: '区分任务与条件', content: { text: '先明确任务和条件。[S1E6]', grounding: { version: 1, citations: [citation('https://docs.example.org/tasks', '先明确任务和条件。', 'Specify the task and conditions.', 'S1E6')] } } },
  { id: 'e1', type: 'example', title: '输出模板', objective: '指定输出形式', content: { text: '再确定输出形式。[S1E6]', grounding: { version: 1, citations: [citation('https://docs.example.org/output', '再确定输出形式。', 'Specify the output format.', 'S1E6')] } } },
  { id: 'q1', type: 'quiz', title: '提示词结构', objective: '判断结构与误区', content: null },
  { id: 'future', type: 'reading', title: '后续知识', objective: '不能提前考', content: { text: '后续知识。', grounding: { version: 1, citations: [citation('https://docs.example.org/future', '后续知识。', 'Not part of prior teaching.')] } } }
] });
const request = c => ({ goal: '编写提示词模板', level: '零基础', title: '提示词', objective: '设计结构清晰的提示词', lessonId: 'lesson1',
  block: { type: 'quiz', title: c.blocks[2].title, objective: c.blocks[2].objective }, ...blockGenerationContext(c, 'q1') });
const questions = ids => ({ questions: ['如何明确任务？', '如何确定输出形式？', '如何判断条件完整？', '哪种写法符合要求？'].map((prompt, i) => ({ prompt, options: ['明确条件和输出', '忽略条件', '不写目标', '只写无关内容'], answer: 0,
  explanation: ['先明确任务和条件。', '再确定输出形式。', '依据已讲材料先核对条件。', '依据已讲材料明确所需输出。'][i] + (ids?.[i] ? `[${ids[i]}]` : '') })) });

test('saved evidence is deduplicated and renumbered across modules while old inline IDs are hidden only in the input', () => {
  const c = course(), before = JSON.stringify(c), value = quizMaterials(request(c), c);
  assert.deepEqual(value.documents.map(d => d.excerpts.map(e => e.id)), [['S1E1'], ['S2E1']]);
  assert.deepEqual(value.documents.map(d => d.url), ['https://docs.example.org/tasks', 'https://docs.example.org/output']);
  assert.ok(value.documents.every(d => d.reused && d.retrievedAt === 1000));
  assert.ok(!JSON.stringify(value.context).includes('[S1E6]'));
  assert.equal(validTeachingContext(value.context.teachingContext), true);
  assert.equal(JSON.stringify(c), before);
});

test('prose citation hiding preserves code, escaped literals, links, original offsets and CRLF', () => {
  const source = '结论。[S1E1]\r\n\r\n- 条件。[S2E3]\r\n\r\n**补充。[S1E6]**\r\n\r\n`[S1E1]` 与 \\[S1E1] [来源](https://docs.example.org/[S1E1])\r\n\r\n```python\r\nprint("[S1E1]")\r\n```\r\n\r\n<div>[S1E1]</div>\r\n';
  const result = withoutPriorCitationMarkers(source);
  assert.equal(result.length, source.length);
  assert.ok(result.startsWith('结论。      '));
  assert.ok(!result.includes('条件。[S2E3]')); assert.ok(!result.includes('补充。[S1E6]'));
  for (const literal of ['`[S1E1]`', '\\[S1E1]', '(https://docs.example.org/[S1E1])', 'print("[S1E1]")', '<div>[S1E1]</div>']) assert.ok(result.includes(literal), literal);
  assert.equal((result.match(/\r\n/g) || []).length, (source.match(/\r\n/g) || []).length);
  assert.equal(withoutPriorCitationMarkers('line\rtext[S1E1]'), 'line\rtext      ');
});

test('only valid saved citations for actually provided teaching passages can supply references', () => {
  const c = course();
  c.blocks[0].content.grounding.citations.push(citation('https://docs.example.org/unrelated', '不存在于已讲正文的结论。', 'Unrelated source.'));
  c.blocks[1].content.grounding.citations[0].url = 'https://zhihu.com/unreliable';
  const value = quizMaterials(request(c), c);
  assert.equal(value.documents.length, 1); assert.equal(value.documents[0].url, 'https://docs.example.org/tasks');
  const same = course(); same.blocks[1].content.grounding.citations[0] = { ...same.blocks[0].content.grounding.citations[0], claim: '再确定输出形式。' };
  assert.equal(quizMaterials(request(same), same).documents[0].excerpts.length, 1);
});

test('evidence remains bounded to 3 documents and 8 excerpts each without collisions', () => {
  const c = course();
  c.blocks[0].content.text = Array.from({ length: 40 }, (_, i) => `知识${i}。[S1E1]`).join('\n\n');
  c.blocks[0].content.grounding.citations = Array.from({ length: 40 }, (_, i) => citation(`https://docs.example.org/doc${Math.floor(i / 10)}`, `知识${i}。`, `Source excerpt ${i}.`));
  c.blocks[1].content.grounding = undefined;
  const docs = quizMaterials(request(c), c).documents;
  assert.equal(docs.length, 3); assert.ok(docs.every(d => d.excerpts.length === 8));
  assert.equal(new Set(docs.flatMap(d => d.excerpts.map(e => e.id))).size, 24);
});

async function serve(t, c, { saved = true } = {}) {
  let output = questions(['S1E1', 'S2E1']);
  const sent = [], stages = []; let searches = 0;
  const server = createApp({ getLLM: () => ({ generate: async (instruction, input, validate) => {
    sent.push({ instruction, input: structuredClone(input) }); if (!validate(output)) throw new Error('Invalid generated quiz'); return structuredClone(output);
  } }), ...(saved ? { getCourseBlockCourse: () => c } : {}),
    courseSources: { prepare: async () => { searches++; throw new Error('Quiz must not search'); } },
    onGenerationProgress: (_id, stage) => stages.push(stage) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = input => fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Learnflow-Progress': 'generation-quiz' }, body: JSON.stringify(input) });
  return { post, sent, stages, searches: () => searches, output: value => { output = value; } };
}

test('quiz generation reuses server-owned references with either search switch value, never searches or retries', async t => {
  const c = course(), before = JSON.stringify(c), f = await serve(t, c);
  for (const enabled of [true, false]) {
    const response = await f.post({ ...request(c), sourceSearch: { enabled, revision: 1 }, officialDocuments: [{ url: 'https://fabricated.example/evil' }] });
    assert.equal(response.status, 200); const value = await response.json();
    assert.ok(validGrounding(value.grounding)); assert.equal(value.questions.length, 4);
    assert.equal(value.grounding.citations[0].url, c.blocks[0].content.grounding.citations[0].url);
    assert.equal(value.grounding.citations[1].quote, 'Specify the output format.');
    assert.equal(f.searches(), 0);
    assert.ok(!JSON.stringify(f.sent.at(-1).input).includes('[S1E6]'));
    assert.match(f.sent.at(-1).instruction, /不重新联网搜索/);
  }
  assert.equal(f.sent.length, 2); assert.ok(!f.stages.includes('searching')); assert.equal(JSON.stringify(c), before);
});

test('a quiz without saved evidence uses only actual teaching, not new search or client-invented sources', async t => {
  const c = course(); for (const b of c.blocks) if (b.content) delete b.content.grounding;
  const f = await serve(t, c); f.output(questions());
  const response = await f.post({ ...request(c), sourceSearch: { enabled: true, revision: 1 }, officialDocuments: [{ url: 'https://evil.example' }] });
  assert.equal(response.status, 200); assert.equal((await response.json()).grounding, undefined);
  assert.equal(f.searches(), 0); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].input.officialDocuments, undefined);
  assert.match(f.sent[0].instruction, /不输出资料引用标记/);
  f.output(questions(['S1E1', 'S2E1']));
  const invalid = await f.post({ ...request(c), sourceSearch: { enabled: true, revision: 1 } });
  assert.equal(invalid.status, 422); assert.match((await invalid.json()).error, /未经提供的引用/);
  assert.equal(f.sent.length, 2); assert.equal(f.searches(), 0);
});

test('stateless quiz callers cannot turn supplied URLs into verified documents; legacy teaching input still works', async t => {
  const c = course(), f = await serve(t, c, { saved: false }); f.output(questions());
  let response = await f.post({ ...request(c), sourceSearch: { enabled: true, revision: 1 } });
  assert.equal(response.status, 200); assert.equal(f.sent[0].input.officialDocuments, undefined); assert.equal(f.searches(), 0);
  const legacy = { ...request(c), teachingContext: undefined, previous: [{ type: 'reading', title: '任务说明', excerpt: '先明确任务和条件。[S1E6]' }] };
  response = await f.post(legacy); assert.equal(response.status, 200); assert.ok(!JSON.stringify(f.sent[1].input).includes('[S1E6]'));
});

test('mixed quiz references and teaching-only explanations succeed without fabricating citations or searching', async t => {
  const c = course(), before = JSON.stringify(c), f = await serve(t, c);
  for (const enabled of [true, false]) {
    const mixed = questions(['S1E1', 'S2E1']);
    mixed.questions[1].explanation = '根据本课案例，应先确定所需输出形式。';
    f.output(mixed);
    let response = await f.post({ ...request(c), sourceSearch: { enabled, revision: 1 } });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.questions, mixed.questions);
    assert.equal(value.grounding.citations.length, 1);
    assert.equal(value.grounding.citations[0].url, c.blocks[0].content.grounding.citations[0].url);
    assert.equal(value.grounding.citations[0].retrievedAt, 1000);
    for (const citations of [undefined, []]) {
      const plain = { ...questions(), ...(citations ? { citations } : {}) }; f.output(plain);
      response = await f.post({ ...request(c), sourceSearch: { enabled, revision: 1 } });
      assert.equal(response.status, 200);
      const noRefs = await response.json();
      assert.deepEqual(noRefs.questions, plain.questions);
      assert.equal(noRefs.grounding, undefined);
    }
    assert.match(f.sent.at(-1).instruction, /不强行/);
    assert.ok(!f.sent.at(-1).instruction.includes('每道题的explanation内标注至少一处引用'));
  }
  assert.equal(f.sent.length, 6); assert.equal(f.searches(), 0);
  assert.equal(JSON.stringify(c), before);
});

test('unknown, excluded or mismatched quiz evidence is still rejected even with a teaching-only explanation', async t => {
  const c = course(), f = await serve(t, c);
  const invalids = [questions(['S1E6', 'S2E1']), questions(['S1E1', 'S9E9']),
    { ...questions(), citations: [{ excerptId: 'S1E1', claim: '解析中不存在的说明。' }] },
    { ...questions(), citations: 'invalid' }, { sourceInsufficient: true }];
  invalids[0].questions[1].explanation = '根据本课案例推理，不额外引用资料。';
  for (const invalid of invalids) {
    f.output(invalid);
    const response = await f.post({ ...request(c), sourceSearch: { enabled: true, revision: 1 } });
    assert.equal(response.status, 422); assert.match((await response.json()).error, /引用|资料/);
  }
  assert.equal(f.searches(), 0); assert.equal(f.sent.length, invalids.length);
});

test('empty or changed saved teaching cannot be bypassed with a stale client context', async t => {
  const c = course(), stale = request(c), f = await serve(t, c);
  c.blocks[0].content = null; c.blocks[1].content = null;
  let response = await f.post(stale); assert.notEqual(response.status, 200); assert.equal(f.sent.length, 0);
  c.blocks[2].title = '大纲已变化'; response = await f.post(stale); assert.notEqual(response.status, 200); assert.equal(f.searches(), 0);
});
