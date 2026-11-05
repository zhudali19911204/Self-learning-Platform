// Loaded only by the explicit isolated --smoke-test --sources-only mode.
import { createCourseSources } from '../course-sources.mjs';
export function sourcesFixture() {
  const counts = { searches: 0, reads: 0, generations: 0 };
  let tableCitations=false, missingCitations=false, fencedCitations=false;
  const source = 'The user.name and user.email variables determine what ends up in the author and committer fields of commit objects. These settings do not provide authentication to a remote repository.';
  const courseSources = createCourseSources({ getConfig: () => ({ provider: 'qwen', model: 'qwen3.8-max', apiKey: 'sources-smoke-not-real', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', timeoutMs: 1000 }),
    fetchImpl: async () => { counts.searches++; return Response.json({ output: [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://www.zhihu.com/question/123' }, { url: 'https://git-scm.com/docs/git-config' }] } }] }); },
    read: async url => { counts.reads++; return { url, title: 'Git - git-config Documentation', text: source, retrievedAt: Date.now() }; }
  });
  const llm = { status: () => ({ mode: 'ai', model: 'source-smoke-model', providerLabel: '隔离测试', timeoutMs: 1000 }), generate: async (_instruction, input, validate) => {
    counts.generations++;
    if (input.task === 'complete-course-citations') {
      const result={citations:[{passageId:input.passages[0].id,excerptIds:[input.officialDocuments[0].excerpts[0].id]}]};
      if(!validate(result))throw Error('Smoke citation completion rejected');return result;
    }
    if (input.block.type === 'practice') {
      const prose = [input.intro, input.currentExcerpt, ...(input.previous || []).map(p => p.excerpt), ...(input.teachingContext?.sources || []).flatMap(s => s.spans.map(p => p.text))].filter(Boolean).join('\n');
      if (/\[S\d+(?:E\d+)?\]/.test(prose)) throw new Error('Historical citation IDs leaked into practice input');
      const id = input.officialDocuments?.[0]?.excerpts[0].id;
      const result = { text: '## 教学示例任务\n\n提交身份与远程认证不同。' + (id ? `[${id}]` : '') + '\n\n' + (input.revisionRequest ? '先分步核对用户名，再核对邮箱；写出判断依据。' : '请独立核对用户名与邮箱，写出它们与远程认证的区别。') };
      if (!validate(result)) throw new Error('Smoke practice output rejected'); return result;
    }
    if (input.block.type === 'quiz') {
      if (!_instruction.includes('不重新联网搜索')) throw new Error('Quiz scope instruction missing');
      const id = input.officialDocuments?.[0]?.excerpts[0].id;
      const result = { questions: ['提交身份是否就是远程登录？', '应如何核对提交身份？', '提交邮箱能否代替远程认证？', '哪个字段记录提交作者？'].map((prompt, index) => ({ prompt,
        options: ['身份与认证应区分', '只看密码', '删除配置即可', '无需核对'], answer: 0,
        explanation: '提交身份与远程认证不同。' + (id && index === 0 ? `[${id}]` : '') })) };
      if (!validate(result)) throw new Error('Smoke quiz output rejected'); return result;
    }
    if (fencedCitations && input.officialDocuments) {
      const id=input.officialDocuments[0].excerpts[0].id;
      const result={text:`## 核对配置\n\n\`\`\`sh\ngit config --get user.name\ngit config --get user.email\n\`\`\` [${id}]\n\n## 判断用途\n\n这两项配置用于提交身份，不代替远程仓库认证。[${id}]`};
      if(!validate(result))throw Error('Smoke fenced citation rejected');return result;
    }
    if (missingCitations && input.officialDocuments) {
      const result={text:'## 配置与认证\n\n提交身份与远程认证不同，提交作者配置不能代替远程仓库认证。\n\n教学示例：先检查身份配置，再独立检查认证方式。'};
      if(!validate(result))throw Error('Smoke uncited draft rejected before completion');return result;
    }
    if (tableCitations && input.officialDocuments) {
      const id=input.officialDocuments[0].excerpts[0].id;
      const result={text:`## 配置与认证对照\n\n| 项目 | 用途 | 来源 |\n| --- | --- | --- |\n| user.name 与 user.email | 记录提交作者与提交者 | [${id}] |\n| 提交身份与远程认证 | 两者应区分 | **[${id}]**，**[${id}]** |`};
      if(!validate(result))throw Error('Smoke table citations rejected');return result;
    }
    const text = input.officialDocuments ? '## 提交身份\n\n提交身份与远程认证不同。\n\n配置 user.name 和 user.email，用于记录提交的作者与提交者。它们不代替远程仓库的认证。' : '## 教学示例\n\n关闭联网搜索后使用模型生成，此模块没有官方资料引用。';
    const result = { text: input.officialDocuments ? text.replace('提交身份与远程认证不同。', `提交身份与远程认证不同。[${input.officialDocuments[0].excerpts[0].id}]`) : text };
    if (!validate(result)) throw new Error('Smoke output rejected'); return result;
  } };
  return { llm, courseSources, counts, setTableCitations:value=>{tableCitations=!!value;}, setMissingCitations:value=>{missingCitations=!!value;}, setFencedCitations:value=>{fencedCitations=!!value;} };
}
