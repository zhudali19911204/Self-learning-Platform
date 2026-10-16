import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { normalizeOutline, inspectOutline, mergeOutlineExamples, validGeneratedOutline } from '../course-generation.mjs';

const spec = (type, title) => ({ type, title, objective: `能解释或完成：${title}` });
// Same structural failure as the paid diagnostic: the fifth reading precedes practice.
const draft = { intro: '学习目标、撤离风险与时间决策。', blocks: [
  spec('reading', '目标与胜负'), spec('example', '成功撤离案例'),
  spec('reading', '死亡惩罚'), spec('example', '风险对比案例'),
  spec('reading', '单局时间限制'), spec('practice', '局势研判'),
  spec('quiz', '规则检验'), spec('summary', '生存法则')
] };
const addition = { afterPosition: 5, block: spec('example', '剩余时间与撤离路线推演') };
const request = { goal: '学会判断撤离时机', level: '零基础', title: '规则解析', objective: '解释规则并判断风险', minutes: 25 };
async function serve(t, outputs) {
  const sent = [];
  const server = createApp({ env: {}, model: 'synthetic-test', fetchImpl: async (_url, init) => {
    sent.push(JSON.parse(init.body));
    const value = outputs.shift();
    return value instanceof Response ? value : Response.json({ message: { content: JSON.stringify(value) } });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { sent, post: async data => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/lesson-outline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return { status: r.status, body: await r.json() };
  } };
}

test('missing example repair preserves the reproduced draft and only inserts the required example', async t => {
  const app = await serve(t, [draft, { additions: [addition] }]);
  const initial = await app.post(request);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.status, 'needs_examples');
  assert.deepEqual(initial.body.draft, draft);
  assert.deepEqual(initial.body.missingExamples, [{ afterPosition: 5, title: '单局时间限制' }]);
  assert.equal(app.sent.length, 1);
  const fixed = await app.post({ ...request, repairDraft: initial.body.draft });
  assert.equal(fixed.status, 200);
  assert.equal(validGeneratedOutline(fixed.body), true);
  assert.deepEqual(fixed.body.blocks.filter((_, i) => i !== 5), draft.blocks);
  assert.deepEqual(fixed.body.blocks[5], addition.block);
  assert.equal(fixed.body.blocks[6].type, 'practice');
  assert.equal(fixed.body.intro, draft.intro);
  assert.equal(app.sent.length, 2);
  const input = JSON.parse(app.sent[1].messages[1].content);
  assert.deepEqual(input.draft, draft); assert.equal(input.minutes, 25);
  assert.match(app.sent[1].messages[0].content, /只补充/);
  assert.match(app.sent[1].messages[0].content, /整课总学习时间预算/);
});

test('only harmless whitespace and type capitalization normalize; semantic defects get specific errors', async t => {
  const valid = mergeOutlineExamples(draft, { additions: [addition] });
  const raw = { intro: ` ${valid.intro} `, blocks: valid.blocks.map(b => ({ type: ` ${b.type.toUpperCase()} `, title: ` ${b.title} `, objective: ` ${b.objective} ` })) };
  assert.deepEqual(normalizeOutline(raw), valid);
  const bad = structuredClone(draft); delete bad.blocks[4].objective;
  const app = await serve(t, [raw, bad]);
  assert.deepEqual((await app.post(request)).body, valid);
  const failed = await app.post(request);
  assert.equal(failed.status, 502); assert.match(failed.body.error, /第 5 个模块的 objective/);
  assert.equal(app.sent.length, 2);
  assert.ok(inspectOutline({ intro: '导语', blocks: [null, null] }).issues.length);
  const duplicate = structuredClone(valid); duplicate.blocks[1].objective = duplicate.blocks[0].objective;
  assert.ok(inspectOutline(duplicate).issues.includes('第 2 个模块的学习目标重复'));
});

test('repair rejects omissions, wrong positions, relabeled practices and duplicate objectives without retries', async t => {
  const invalids = [ {}, { additions: [] }, { additions: [addition, addition] },
    { additions: [{ ...addition, afterPosition: 6 }] },
    { additions: [{ ...addition, block: { ...addition.block, type: 'practice' } }] },
    { additions: [{ ...addition, block: { ...addition.block, objective: draft.blocks[0].objective } }] },
    { additions: [{ ...addition, block: { type: 'example', title: '缺少目标' } }] }
  ];
  const app = await serve(t, [...invalids]);
  for (const [i] of invalids.entries()) {
    const response = await app.post({ ...request, repairDraft: draft });
    assert.equal(response.status, 502); assert.equal(app.sent.length, i + 1);
    assert.match(response.body.error, /案例|模块/);
  }
});

test('malformed or overflowing repair drafts cause no model calls; invalid initial drafts are not silently trimmed', async t => {
  const crowded = { ...draft, blocks: [...draft.blocks, ...Array.from({ length: 12 }, (_, i) => spec('practice', `实践 ${i}`))] };
  const app = await serve(t, [crowded]);
  for (const repairDraft of [null, {}, crowded, mergeOutlineExamples(draft, { additions: [addition] })]) {
    assert.equal((await app.post({ ...request, repairDraft })).status, 400);
  }
  assert.equal(app.sent.length, 0);
  const response = await app.post(request);
  assert.equal(response.status, 502); assert.match(response.body.error, /超过 20/);
  assert.equal(app.sent.length, 1);
});

test('multiple missing examples use original positions and preserve consecutive readings', () => {
  const original = { intro: '两种方法', blocks: [spec('reading', '方法一'), spec('reading', '方法二'), spec('quiz', '应用判断')] };
  const response = { additions: [ { afterPosition: 2, block: spec('example', '案例二') }, { afterPosition: 1, block: spec('example', '案例一') } ] };
  const merged = mergeOutlineExamples(original, response);
  assert.deepEqual(merged.blocks.map(b => b.title), ['方法一', '案例一', '方法二', '案例二', '应用判断']);
  assert.equal(validGeneratedOutline(merged), true);
  assert.throws(() => mergeOutlineExamples(original, { additions: [response.additions[0], response.additions[0]] }), /重复/);
});

test('provider failure on explicit repair makes just one request', async t => {
  const app = await serve(t, [new Response('unavailable', { status: 503 })]);
  assert.equal((await app.post({ ...request, repairDraft: draft })).status, 502);
  assert.equal(app.sent.length, 1);
});
