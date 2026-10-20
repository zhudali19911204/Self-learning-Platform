import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { blockGenerationContext } from '../public/blocks.js';
import { validGeneratedBlock } from '../course-generation.mjs';
const question = n => ({ prompt: `如何判断情境${n}？`, options: ['核对任务与条件', '跳过条件', '只看题目长度', '忽略实际材料'], answer: 0, explanation: '按已讲方法核对任务与条件。' });
const course = () => ({ intro: '仅依据已讲内容出题。', blocks: [
  { id: 'r1', type: 'reading', title: '判断方法', objective: '核对任务与条件', content: { text: '先核对任务和条件，再判断方法是否适用。' } },
  { id: 'q1', type: 'quiz', title: '初次练习', objective: '理解方法', content: { questions: [question(1), question(2)] } },
  { id: 'q2', type: 'quiz', title: '补充练习', objective: '迁移判断', content: null }
] });
const request = c => ({ goal: '理解判断方法', level: '零基础', title: '条件判断', objective: '根据条件判断适用范围', lessonId: 'p1', block: { type: 'quiz', title: '补充练习', objective: '迁移判断' }, ...blockGenerationContext(c, 'q2') });
async function serve(t, c) {
  const sent = []; let output, searches = 0;
  const server = createApp({ getCourseBlockCourse: () => c, getLLM: () => ({ generate: async (instruction, input, validate) => {
    sent.push({ instruction, input }); const value = output || { questions: Array.from({ length: input.questionCount }, (_, i) => question(10 + i)) };
    assert.ok(validate(value)); return structuredClone(value);
  } }), courseSources: { prepare: async () => { searches++; throw new Error('Appended quizzes must not search'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { sent, searches: () => searches, output: value => { output = value; }, post: input => fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) };
}

test('users can request exactly 1 to 5 additional questions without replacing old questions or searching', async t => {
  const c = course(), before = structuredClone(c), f = await serve(t, c);
  for (const count of [1, 3, 5]) {
    const response = await f.post({ ...request(c), questionCount: count, existingQuestions: ['客户端假题目'], sourceSearch: { enabled: true, revision: 1 } });
    assert.equal(response.status, 200); assert.equal((await response.json()).questions.length, count);
    assert.deepEqual(f.sent.at(-1).input.existingQuestions, c.blocks[1].content.questions.map(q => q.prompt), 'use server-owned questions instead of trusting client exclusions');
    assert.equal(f.sent.at(-1).input.questionCount, count); assert.match(f.sent.at(-1).instruction, /恰好生成该数量/);
  }
  assert.equal(f.searches(), 0); assert.equal(f.sent.length, 3); assert.deepEqual(c, before);
  assert.equal(validGeneratedBlock('quiz', { questions: [question(1)] }), false, 'initial generation keeps its existing default');
  assert.equal(validGeneratedBlock('quiz', { questions: [question(1)] }, { questionCount: 1 }), true);
});
test('initial quizzes are always four, overriding old five-question objectives without rewriting saved courses', async t => {
  const c = course(); c.blocks[2].objective = '完成5道选择题，检验指向性判断。';
  const before = structuredClone(c), f = await serve(t,c), input = request(c); input.block.objective = c.blocks[2].objective;
  const response = await f.post(input); assert.equal(response.status,200); assert.equal((await response.json()).questions.length,4);
  assert.equal(f.sent[0].input.questionCount,4); assert.equal(f.sent[0].input.quizMode,'initial');
  assert.equal(f.sent[0].input.block.objective,c.blocks[2].objective);
  assert.match(f.sent[0].instruction,/即使旧大纲、目标或前文要求其他题数/);
  for (const count of [1,2,3,5]) {
    const questions = Array.from({length:count},(_,i)=>question(20+i));
    assert.equal(validGeneratedBlock('quiz',{questions}),false);
    f.output({questions}); const rejected=await f.post(input);
    assert.equal(rejected.status,422); assert.match((await rejected.json()).error,new RegExp(`首次生成固定4题，模型返回${count}题`));
  }
  assert.equal(f.searches(),0); assert.equal(f.sent.length,5); assert.deepEqual(c,before);
});
test('malformed option counts and answer fields identify the exact question without deleting options or retrying', async t => {
  const c=course(),before=structuredClone(c),f=await serve(t,c),input=request(c);
  const output={questions:Array.from({length:4},(_,i)=>question(30+i))}; output.questions[0].options.push('不能擅自删除的第五选项');
  f.output(output); let response=await f.post(input);
  assert.equal(response.status,422); assert.match((await response.json()).error,/第1题须有4个选项，实际返回5个/);
  assert.equal(output.questions[0].options.length,5); assert.equal(f.sent.length,1);
  output.questions[0].options.pop(); output.questions[2].answer='A'; f.output(output); response=await f.post(input);
  assert.equal(response.status,422); assert.match((await response.json()).error,/第3题的answer必须为0–3的整数/);
  assert.equal(f.sent.length,2); assert.equal(f.searches(),0); assert.deepEqual(c,before);
});

test('invalid counts, non-quiz counts and the 100-question cap are rejected before calling the model', async t => {
  const c = course(), f = await serve(t, c), input = request(c);
  for (const questionCount of [0, 6, 1.5, '3', null]) assert.notEqual((await f.post({ ...input, questionCount })).status, 200);
  assert.notEqual((await f.post({ ...input, block: { ...input.block, type: 'practice' }, questionCount: 3 })).status, 200);
  c.blocks.splice(2, 0, ...Array.from({ length: 19 }, (_, i) => ({ id: `old-${i}`, type: 'quiz', title: '已有练习', objective: '理解', content: { questions: Array.from({ length: 5 }, (_, n) => question(100 + i * 5 + n)) } })));
  const response = await f.post({ ...request(c), questionCount: 4 });
  assert.notEqual(response.status, 200); assert.match((await response.json()).error, /最多保留100/);
  assert.equal(f.sent.length, 0); assert.equal(f.searches(), 0);
});

test('wrong counts or repeated old questions fail without saving or automatic retries', async t => {
  const c = course(), f = await serve(t, c), input = { ...request(c), questionCount: 1 };
  f.output({ questions: [question(3), question(4)] });
  let response = await f.post(input); assert.equal(response.status, 422); assert.match((await response.json()).error, /要求新增1题/);
  f.output({ questions: [question(1)] });
  response = await f.post(input); assert.equal(response.status, 422); assert.match((await response.json()).error, /重复/);
  assert.equal(f.sent.length, 2); assert.equal(f.searches(), 0); assert.equal(c.blocks[2].content, null);
});
