import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { withoutPriorCitationMarkers, cleanGenerationCitationContext } from '../course-citation-context.mjs';
import { blockGenerationContext } from '../public/blocks.js';
import { validTeachingContext } from '../public/teaching-context.js';

const markers = source => [...source.matchAll(/\[S\d+(?:E\d+)?\]/g)].map(m => ({ start:m.index,end:m.index+m[0].length }));
function onlyCitationCharactersChanged(before, after) {
  assert.equal(after.length,before.length);
  const ranges=markers(before);
  for(let i=0;i<before.length;i++)if(before[i]!==after[i]) {
    assert.equal(after[i],' '); assert.ok(ranges.some(r=>i>=r.start&&i<r.end),`non-citation character changed at ${i}`);
  }
}
const courseFor = (type,text) => ({intro:'课程导语。',blocks:[
  {id:'reading',type:'reading',title:'已有讲解',objective:'判断条件',content:{text}},
  {id:'target',type,title:'本次模块',objective:'应用已讲方法',content:null}
]});

test('regression: a 1000-character excerpt ending inside a Markdown list/code span is valid context, not invalid course content', () => {
  const head='讲解。\n\n'+'已有内容。'.repeat(180)+'\n\n';
  const text=head+' '.repeat(989-head.length)+'- `Just to confirm, do you mean Friday?`\n\n后续解释。';
  assert.equal(text.slice(989,1000),'- `Just to ');
  const c=courseFor('example',text),before=structuredClone(c),context=blockGenerationContext(c,'target');
  assert.equal(context.previous[0].excerpt.length,1000);
  const clean=cleanGenerationCitationContext(context,c);
  assert.equal(clean.previous[0].excerpt,context.previous[0].excerpt);
  assert.equal(clean.teachingContext.sources[0].spans[0].text,text);
  assert.equal(validTeachingContext(clean.teachingContext),true); assert.deepEqual(c,before);
});

test('no-marker fragments bypass Markdown parsing without modifying partial syntax or newlines', () => {
  for(const source of ['- `Just to ','> - **unfinished\t','```js\nconst x = ','[unfinished](https://example.test/','<span title="','😀\r\n\t- text ', '', null, undefined]) {
    assert.equal(withoutPriorCitationMarkers(source),source);
  }
});

test('historical prose IDs still mask safely when Marked synthesizes whitespace at the end of lists', () => {
  for(const source of ['结论。[S2E3]\n\n- `Just to ','- note[S1E1] ','1. **bold[S2E3]**\t\n\t- text[S3E2] ', '> - [x] line[S1E1]\n>   - next[S2E1]\t', ...['\u00a0','\u3000','\ufeff','\v','\f','\u2028'].map(space=>'- note[S1E1]'+space)]) {
    const clean=withoutPriorCitationMarkers(source); onlyCitationCharactersChanged(source,clean);
    assert.ok(!/\[S\d+(?:E\d+)?\]/.test(clean),JSON.stringify(source));
  }
  const literals='\t[S1E1]\n\n- prose[S2E3]\n\n  ```text\n  [S3E2]\n  ```\n';
  const clean=withoutPriorCitationMarkers(literals); onlyCitationCharactersChanged(literals,clean);
  assert.ok(clean.includes('\t[S1E1]')); assert.ok(clean.includes('  [S3E2]')); assert.ok(!clean.includes('prose[S2E3]'));
});

test('every prefix boundary in representative Markdown remains processable with citations and unchanged source offsets', () => {
  const samples=[
    '结论[S1E1]\n\n- `Just to confirm`\n- **粗体[S2E3]** \n\n> 说明[S3E2]\n',
    '- [x] 已做[S1E1]\n  - 内层[S2E1]\n\t- 列表[S3E1] \t\n\n1. 条件[S4E1]\n2. 下一项[S5E1]',
    '正文[S1E1]\n\n```js\nconst value = "[S2E1]";\n```\n\n> ```text\n> [S3E1]\n> ```\n',
    '前文[S1E1] <span>literal [S2E1]</span> 后文[S3E1]\n\n- [来源](https://example.test/[S4E1])\n',
    '| 条件 | 结论 |\n| --- | --- |\n| 明确[S1E1] | `字面[S2E1]` |\n\n😀强调 **结论[S3E1]**。'
  ];
  for(const sample of samples)for(const eol of ['\n','\r\n','\r']) {
    const text=sample.replace(/\n/g,eol);
    for(let end=0;end<=text.length;end++) {
      for (const fragment of [text.slice(0,end),text.slice(end)]) {
        const clean=withoutPriorCitationMarkers(fragment);
        onlyCitationCharactersChanged(fragment,clean);
      }
    }
  }
});

test('complete saved sources protect literals even when excerpt boundaries omit the opening Markdown syntax', () => {
  const text='前文。[S1E1]\r\n\r\n```text\r\nliteral [S2E1]\r\n```\r\n\r\n[来源](https://example.test/[S3E1]) 和 \\[S4E1]。\r\n\r\n后文。[S5E1]';
  const c=courseFor('example',text),full=withoutPriorCitationMarkers(text),before=structuredClone(c);
  const starts=[0,text.indexOf('[S1E1]'),text.indexOf('literal'),text.indexOf('[S2E1]'),text.indexOf('[S3E1]'),text.indexOf('[S4E1]')];
  for(const start of starts)for(const end of [Math.min(start+8,text.length),text.length]) {
    const context={intro:c.intro,teachingContext:{targetId:'target',sources:[{id:'reading',spans:[{start,end,text:text.slice(start,end)}]}]}};
    const clean=cleanGenerationCitationContext(context,c);
    assert.equal(clean.teachingContext.sources[0].spans[0].text,full.slice(start,end));
    assert.equal(clean.teachingContext.sources[0].spans[0].start,start); assert.equal(clean.teachingContext.sources[0].spans[0].end,end);
  }
  for(const end of [text.indexOf('```\r\n\r\n[来源]'),text.indexOf('[S3E1]')+6,text.indexOf('[S4E1]')+6]) {
    const context={intro:c.intro,previous:[{type:'reading',title:'已有讲解',excerpt:text.slice(0,end)}]};
    assert.equal(cleanGenerationCitationContext(context,c).previous[0].excerpt,full.slice(0,end));
  }
  assert.deepEqual(c,before);
});

test('intro, related cases and revision excerpts also project full-source literal protection without rewriting originals', () => {
  const text='正文[S9E1]\n\n`literal [S1E1]` 后文。',end=text.indexOf('[S1E1]')+6;
  const c={intro:text,blocks:[{id:'target',type:'practice',title:'任务',objective:'应用',content:{text}},
    {id:'case',type:'example',title:'配套案例',objective:'演示',content:{text}}]};
  const context={intro:text.slice(0,end),currentExcerpt:text.slice(0,end),related:[{type:'example',title:'配套案例',excerpt:text.slice(0,end)}],teachingContext:{targetId:'target',sources:[]}};
  const before=structuredClone(c),original=structuredClone(context),clean=cleanGenerationCitationContext(context,c),expected=withoutPriorCitationMarkers(text).slice(0,end);
  assert.equal(clean.intro,expected);assert.equal(clean.currentExcerpt,expected);assert.equal(clean.related[0].excerpt,expected);
  assert.ok(clean.intro.includes('[S1E1]'));assert.ok(!clean.intro.includes('[S9E1]'));assert.deepEqual(c,before);assert.deepEqual(context,original);
});

test('changed and ambiguous saved passages never substitute different content for a provided fragment', () => {
  const c=courseFor('example','旧正文[S1E1]');
  const context={intro:'不同导语[S2E1]',previous:[{type:'reading',title:'已有讲解',excerpt:'客户端节选[S3E1]'}],teachingContext:{targetId:'target',sources:[{id:'reading',spans:[{start:0,end:12,text:'实际提供的片段[S4E1]'}]}]}};
  const clean=cleanGenerationCitationContext(context,c);
  assert.equal(clean.previous[0].excerpt,withoutPriorCitationMarkers(context.previous[0].excerpt));
  assert.equal(clean.teachingContext.sources[0].spans[0].text,withoutPriorCitationMarkers(context.teachingContext.sources[0].spans[0].text));
  assert.ok(clean.intro.startsWith('不同导语'));
  const prefix='`[S1E1]', ambiguous={intro:'导语',blocks:[
    {id:'one',type:'reading',title:'同名讲解',content:{text:prefix+'`完整代码。'}},
    {id:'two',type:'reading',title:'同名讲解',content:{text:prefix+'未闭合代码。'}}
  ]};
  const ambiguousContext={intro:'导语',previous:[{type:'reading',title:'同名讲解',excerpt:prefix}]};
  assert.equal(cleanGenerationCitationContext(ambiguousContext,ambiguous).previous[0].excerpt,withoutPriorCitationMarkers(prefix));
});

test('reference links and their definitions remain literal while unrelated prose IDs are hidden', () => {
  const text='[S1E1] 与 [来源][S2E1]。正文[S9E1]\n\n[S1E1]: https://example.test/one\n[S2E1]: https://example.test/[S3E1]\n';
  const clean=withoutPriorCitationMarkers(text);onlyCitationCharactersChanged(text,clean);
  assert.ok(clean.startsWith('[S1E1] 与 [来源][S2E1]。正文'));
  assert.ok(clean.includes('[S1E1]: https://example.test/one'));
  assert.ok(clean.includes('[S2E1]: https://example.test/[S3E1]'));
  assert.ok(!clean.includes('正文[S9E1]'));
});

test('empty list entries, loose lists and lazy quote continuations do not leave prose citation IDs behind', () => {
  for(const text of ['-\n  note[S1E1]','- \n  note[S1E1] ','- first[S1E1]\n\n  after[S2E1]\n\n-\n  end[S3E1]',
    '>\n> -\n>   note[S1E1]\n>\n> next[S2E1]\n>\n','- [ ]\n  note[S1E1]','> first[S1E1]\nlazy[S2E1]\n']) {
    const clean=withoutPriorCitationMarkers(text);onlyCitationCharactersChanged(text,clean);
    assert.ok(!/\[S\d+(?:E\d+)?\]/.test(clean),JSON.stringify(text));
  }
});

test('all generation types accept partial Markdown context without paid calls, automatic retries or weakened citation checks', async t => {
  let calls=0,searches=0,expectedCount=4;
  const text='讲解[S8E1]\n\n- `Just to ';
  const server=createApp({getLLM:()=>({generate:async(_instruction,input,validate)=>{
    calls++;assert.ok(!input.previous[0].excerpt.includes('[S8E1]'));
    const value=input.block.type==='quiz'?{questions:Array.from({length:input.questionCount},(_,i)=>({prompt:`条件${i+1}如何判断？`,options:['结合条件','忽略条件','猜测','跳过'],answer:0,explanation:'依据实际已讲内容判断。'}))}:{text:'## 教学示例\n\n结合条件作出判断。'};
    assert.equal(validate(value),true);if(input.block.type==='quiz')assert.equal(value.questions.length,expectedCount);return value;
  }}),courseSources:{prepare:async()=>{searches++;throw new Error('No search allowed');}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  for(const type of ['reading','example','practice','quiz','summary']) {
    const c=courseFor(type,text),context=blockGenerationContext(c,'target');
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goal:'判断条件',level:'零基础',title:'课程',objective:'应用方法',block:{type,title:'本次模块',objective:'应用已讲方法'},...context})});
    assert.equal(response.status,200,`${type}: ${JSON.stringify(await response.json())}`);
  }
  assert.equal(calls,5);assert.equal(searches,0);
});

test('the generation API uses saved full-source syntax for a span starting inside fenced code', async t => {
  const text='说明[S8E1]\n\n```text\nliteral [S7E2]\n```\n\n正文。',c=courseFor('practice',text),before=structuredClone(c);
  const context=blockGenerationContext(c,'target'),source=context.teachingContext.sources[0],start=text.indexOf('literal'),end=start+'literal [S7E2]'.length;
  source.spans=[{start,end,text:text.slice(start,end)}];source.includedCharacters=end-start;source.omitted=true;
  context.previous=[];context.teachingContext.coverage.excerpted=true;context.teachingContext.coverage.completeBefore=false;
  assert.equal(validTeachingContext(context.teachingContext),true);
  let calls=0;
  const server=createApp({getCourseBlockCourse:()=>c,getLLM:()=>({generate:async(_instruction,input,validate)=>{
    calls++;assert.equal(input.teachingContext.sources[0].spans[0].text,'literal [S7E2]');
    assert.equal(validTeachingContext(input.teachingContext),true);const value={text:'教学示例任务：独立核对条件。'};assert.equal(validate(value),true);return value;
  }})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/lesson-block`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({goal:'核对条件',level:'零基础',title:'课程',objective:'应用方法',lessonId:'lesson',block:{type:'practice',title:'本次模块',objective:'应用已讲方法'},...context})});
  assert.equal(response.status,200);assert.equal(calls,1);assert.deepEqual(c,before);
});
