import test from 'node:test';
import assert from 'node:assert/strict';
import { withInlineCourseCitations, normalizeCourseCitationLayout } from '../course-inline-citations.mjs';
import { Lexer } from 'marked';
import { groundedContent, sourceCitationIssue, validGrounding, MAX_COURSE_CITATIONS, courseReferences } from '../public/course-sources.js';
import { createApp } from '../server.mjs';

const documents = [{ id: 'S1', url: 'https://docs.example.org/guide', publisher: 'docs.example.org', title: 'Primary documentation', retrievedAt: 1000,
  excerpts: [{ id: 'S1E1', text: 'A real extracted passage.' }, { id: 'S1E2', text: 'Another real extracted passage.' }] }];

test('real-provider regression: a citation after an unterminated closing fence cannot swallow later prose', () => {
  for (const fence of ['```', '~~~~']) for (const eol of ['\n','\r\n','\r']) {
    const text=['公式说明：', '', fence, 'total = price * quantity', fence+' [S1E1]', '', '## 后续解释', '', '核对单位与数量。[S1E2]'].join(eol);
    const prepared=withInlineCourseCitations('reading',{text});
    assert.equal(prepared.text,text.replace(fence+' [S1E1]',fence+eol+eol+'[S1E1]'));
    assert.equal(prepared.citations.length,2);assert.equal(prepared.citations[0].claim,'total = price * quantity');assert.equal(prepared.citations[1].claim,'核对单位与数量。');
    assert.equal(sourceCitationIssue('reading',prepared,documents),null);assert.equal(validGrounding(groundedContent('reading',prepared,documents)),true);
    const blocks=Lexer.lex(prepared.text);assert.equal(blocks.filter(b=>b.type==='code').length,1);assert.ok(blocks.some(b=>b.type==='heading'&&b.text==='后续解释'));
    assert.equal(normalizeCourseCitationLayout(prepared.text),prepared.text,'format normalization is idempotent');
  }
});

test('explicit references immediately after fenced formulas cite that exact code, while ordinary orphan markers still fail',()=>{
  for(const tail of ['\n[S1E1]','\n\n[S1E1]，[S1E2]','\n\n**[S1E1]**']){
    const text='```text\ntotal = price * quantity\n```'+tail, result=withInlineCourseCitations('reading',{text});
    assert.equal(result.text,text);assert.ok(result.citations.every(c=>c.claim==='total = price * quantity'));assert.equal(sourceCitationIssue('reading',result,documents),null);
  }
  for(const text of ['说明。\n\n[S1E1]','```\nx = 2\n```\n\n## 新标题\n\n[S1E1]','```\nx = 2\n```\n\n---\n\n[S1E1]','```\n\n```\n\n[S1E1]'])assert.throws(()=>withInlineCourseCitations('reading',{text}),/缺少可对应/);
  assert.match(sourceCitationIssue('reading',withInlineCourseCitations('reading',{text:'```\nx = 2\n``` [S9E9]'}),documents),/未提供/);
});

test('fence layout normalization never reinterprets literals in closed or Markdown-example code blocks',()=>{
  for(const text of ['````md\n``` [S1E1]\n````','```text\n``` [S1E1]\nstill literal\n```','```markdown\n``` [S1E1]\nstill literal','<div>\n\n```\nvalue\n``` [S1E1]\n</div>','```\nvalue [S1E1]\n```','```\nvalue\n``` [S1E1] extra words']){
    assert.equal(normalizeCourseCitationLayout(text),text,text);
  }
});

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
  for (const text of ['`[S1E1]`', '```text\n[S1E1]\n```', '    [S1E1]', '<div>[S1E1]</div>', '结论。<span>[S1E1]</span>', '结论。<code><strong>[S1E1]</strong></code>', '[link](https://example.org/[S1E1])', '\\[S1E1]']) {
    const output = withInlineCourseCitations('reading', { text });
    assert.ok(sourceCitationIssue('reading', output, documents), text);
  }
  assert.throws(() => withInlineCourseCitations('reading', { text: '[S1E1]' }), /缺少可对应/);
  assert.throws(() => withInlineCourseCitations('reading', { text: '先前段落。\n\n[S1E1]' }), /缺少可对应/);
  assert.match(sourceCitationIssue('reading', withInlineCourseCitations('reading', { text: '结论。[S9E1]' }), documents), /未提供/);
  const legacy = { text: '结论。', citations: [{ excerptId: 'S1E1', claim: '结论。' }] };
  assert.equal(withInlineCourseCitations('reading', legacy), legacy);
});

test('a table source column binds to actual facts on the same original row, including escaped pipes and nested containers',()=>{
  const table='| 成本项目 | 教学示例金额 | 来源 |\n| --- | --- | --- |\n| 仓储成本 | 1200 元 | [S1E1] |\n| 运输成本 | 800 元 | **[S1E2]** |';
  for(const text of [table,table.replaceAll('\n','\r\n'),table.split('\n').map(line=>'> '+line).join('\n'),table.split('\n').map(line=>line.slice(1,-1)).join('\n')]){
    const result=withInlineCourseCitations('example',{text});assert.equal(result.text,text);assert.equal(result.citations.length,2);
    assert.match(result.citations[0].claim,/仓储成本.*1200/);assert.ok(!result.citations[0].claim.includes('运输成本'));
    assert.match(result.citations[1].claim,/运输成本.*800/);assert.ok(!result.citations[1].claim.includes('仓储成本'));
    assert.ok(result.citations.every(c=>text.includes(c.claim)));assert.equal(sourceCitationIssue('example',result,documents),null);
    const grounding=groundedContent('example',result,documents);assert.equal(validGrounding(grounding),true);assert.equal(grounding.citations[1].quote,documents[0].excerpts[1].text);
  }
  const escaped='| 项目 | 格式说明 |\n| --- | --- |\n| 字段分隔 | 使用 a\\|b 格式。[S1E1] |';
  const result=withInlineCourseCitations('reading',{text:escaped});assert.match(result.citations[0].claim,/a\\\|b/);assert.ok(escaped.includes(result.citations[0].claim));
});

test('punctuation, line breaks and emphasis between adjacent citation IDs share the real preceding passage without rewriting it',()=>{
  for(const suffix of ['[S1E1]，[S1E2]','[S1E1]、[S1E2]','[S1E1]; [S1E2]','[S1E1]\n[S1E2]','[S1E1]  \r\n[S1E2]','[S1E1]\\\n[S1E2]','**[S1E1]** **[S1E2]**','*[S1E1]*，*[S1E2]*','[S1E1]&nbsp;[S1E2]']){
    const text='总成本为两项成本之和。'+suffix,result=withInlineCourseCitations('summary',{text});
    assert.equal(result.text,text);assert.equal(result.citations.length,2,suffix);assert.equal(result.citations[0].claim,result.citations[1].claim,suffix);
    assert.match(result.citations[0].claim,/总成本为两项成本之和/);assert.ok(text.includes(result.citations[0].claim));assert.equal(sourceCitationIssue('summary',result,documents),null);
  }
});

test('format tolerance never attaches an empty row or another paragraph, and still rejects unknown IDs',()=>{
  for(const text of ['**[S1E1]**，[S1E2]','已有结论。\n\n[S1E1]','| 项目 | 来源 |\n| --- | --- |\n| 仓储成本 | [S1E1] |\n| | [S1E2] |','| 项目 | 来源 |\n| --- | --- |\n| [S1E1] | 事实写在引用后面 |'])assert.throws(()=>withInlineCourseCitations('reading',{text}),/缺少可对应/,text);
  for(const text of ['结论。[S1E1]，[S9E9]','| 项目 | 来源 |\n| --- | --- |\n| 结论 | [S9E9] |'])assert.match(sourceCitationIssue('example',withInlineCourseCitations('example',{text}),documents),/未提供/);
  const text='| 项目 | 说明 |\n| --- | --- |\n| 字面量 | `[S9E9]` 和 <span>[S8E8]</span> 不是正文引用 |\n| 身份配置 | 核对身份。[S1E1] |';
  const value=withInlineCourseCitations('example',{text});assert.equal(value.citations.length,1);assert.equal(value.citations[0].excerptId,'S1E1');
});

test('quiz explanations cite external passages only where used, without inventing evidence for teaching-only answers', () => {
  const mixed = withInlineCourseCitations('quiz', { questions: [{ explanation: '结论。[S1E1]' }, { explanation: '结论。' }] });
  assert.equal(mixed.citations.length, 1);
  assert.equal(sourceCitationIssue('quiz', mixed, documents), null);
  assert.equal(groundedContent('quiz', mixed, documents).citations.length, 1);
  const value = withInlineCourseCitations('quiz', { questions: [{ explanation: '结论。[S1E1]' }, { explanation: '另一个结论。[S1E2]' }] });
  assert.equal(sourceCitationIssue('quiz', value, documents), null);
  for (const citations of [undefined, []]) {
    const plain = withInlineCourseCitations('quiz', { questions: [{ explanation: '根据本课方法，先核对任务条件。' }], ...(citations ? { citations } : {}) });
    assert.equal(sourceCitationIssue('quiz', plain, documents), null);
    assert.equal(groundedContent('quiz', plain, documents), undefined, 'unused documents are not reported as quiz references');
  }
  assert.match(sourceCitationIssue('quiz', { questions: [], citations: 'invalid' }, documents), /引用/);
  assert.match(sourceCitationIssue('quiz', { questions: [], sourceInsufficient: true }, documents), /不足/);
  assert.match(sourceCitationIssue('reading', { text: '无引用结论。' }, documents), /缺少/);
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

test('formatted citations pass the actual generation endpoint for both saved materials and online sources with one model call each',async t=>{
  const text='教学示例：以下仅展示汇总结构。\n\n| 汇总步骤 | 说明 | 来源 |\n| --- | --- | --- |\n| 仓储成本 | 分项列示成本 | [S1E1] |\n| 合并汇总 | 归并项目。**[S1E1]**，**[S1E1]** |';
  const material={version:1,id:'a'.repeat(64),name:'汇总操作.md',type:'md',bytes:100,importedAt:1000,parts:[{id:'part-1',location:'第 1 行',text:'按项目分别列示已经提供的数据，核对口径后再进行合并汇总。'}]};
  for(const local of [false,true]) {
    let calls=0,searches=0;const server=createApp({...(local?{getCourseMaterials:()=>[material]}:{}),getLLM:()=>({generate:async(prompt,input,validate)=>{calls++;assert.match(prompt,/同一行末尾的来源列/);const value={text};assert.equal(validate(value),true);return value;}}),courseSources:{prepare:async()=>{searches++;return documents;}}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lessonId:'cost-lesson',goal:'学习汇总方法',level:'零基础',title:'成本汇总',objective:'理解分项汇总',intro:'按项目核对',block:{type:'example',title:'仓储与运输成本及总成本的汇总',objective:'核对汇总步骤'},sourceSearch:{enabled:true,revision:1}})});
    assert.equal(response.status,200);const result=await response.json();assert.equal(result.text,text);assert.equal(result.grounding.citations.length,2);assert.equal(validGrounding(result.grounding),true);
    assert.equal(result.grounding.citations[0].url,local?`learnflow-material:${material.id}`:documents[0].url);assert.equal(calls,1);assert.equal(searches,local?0:1);
  }
});
