// Loaded only by the explicit isolated --smoke-test --sources-only mode.
import { createCourseSources } from '../course-sources.mjs';
export function sourcesFixture() {
  const counts = { searches: 0, reads: 0, generations: 0 };
  const source = 'The user.name and user.email variables determine what ends up in the author and committer fields of commit objects. These settings do not provide authentication to a remote repository.';
  const courseSources = createCourseSources({ getConfig: () => ({ provider: 'qwen', model: 'qwen3.8-max', apiKey: 'sources-smoke-not-real', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', timeoutMs: 1000 }),
    fetchImpl: async () => { counts.searches++; return Response.json({ output: [{ type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://www.zhihu.com/question/123' }, { url: 'https://git-scm.com/docs/git-config' }] } }] }); },
    read: async url => { counts.reads++; return { url, title: 'Git - git-config Documentation', text: source, retrievedAt: Date.now() }; }
  });
  const llm = { status: () => ({ mode: 'ai', model: 'source-smoke-model', providerLabel: '隔离测试', timeoutMs: 1000 }), generate: async (_instruction, input, validate) => {
    counts.generations++;
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
    const text = input.officialDocuments ? '## 提交身份\n\n提交身份与远程认证不同。\n\n配置 user.name 和 user.email，用于记录提交的作者与提交者。它们不代替远程仓库的认证。' : '## 教学示例\n\n关闭联网搜索后使用模型生成，此模块没有官方资料引用。';
    const result = { text: input.officialDocuments ? text.replace('提交身份与远程认证不同。', `提交身份与远程认证不同。[${input.officialDocuments[0].excerpts[0].id}]`) : text };
    if (!validate(result)) throw new Error('Smoke output rejected'); return result;
  } };
  return { llm, courseSources, counts };
}
