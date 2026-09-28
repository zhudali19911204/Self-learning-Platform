import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLLM } from './llm.mjs';
import { blockTypes, validOutline, validBlockSpec, validBlockContent } from './public/blocks.js';

const publicDir = new URL('./public/', import.meta.url);
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/demo.js': ['demo.js', 'text/javascript'], '/blocks.js': ['blocks.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const str = (v, max = 20000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const strings = (v, max = 20) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(x => str(x, 5000));
export function validPlan(v) {
  return !!v && str(v.title, 160) && str(v.description, 2000) && Array.isArray(v.lessons) && v.lessons.length >= 3 && v.lessons.length <= 12 && v.lessons.every(l => str(l.title, 160) && str(l.objective, 1000) && str(l.phase, 80) && Number.isInteger(l.minutes) && l.minutes >= 5 && l.minutes <= 180 && strings(l.tags, 6) && l.tags.every(t => t.length <= 40));
}
export function validLesson(v) {
  return !!v && str(v.intro) && Array.isArray(v.sections) && v.sections.length >= 2 && v.sections.length <= 8 && v.sections.every(s => str(s.heading, 160) && str(s.body)) && str(v.example) && str(v.challenge) && strings(v.takeaways, 8) && Array.isArray(v.questions) && v.questions.length >= 2 && v.questions.length <= 5 && v.questions.every(q => str(q.prompt, 2000) && Array.isArray(q.options) && q.options.length === 4 && q.options.every(x => str(x, 2000)) && Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3 && str(q.explanation, 5000));
}
const validStudyLesson = value => validLesson(value) || (value?.kind === 'blocks' && typeof value.intro === 'string' && value.intro.length <= 20000 && Array.isArray(value.sections) && value.sections.length <= 1000 && value.sections.every(section => str(section.heading, 160) && str(section.body, 12000)) && typeof value.example === 'string' && value.example.length <= 120000 && typeof value.challenge === 'string' && value.challenge.length <= 120000 && Array.isArray(value.takeaways) && value.takeaways.length <= 1000 && value.takeaways.every(item => str(item, 12000)) && Array.isArray(value.questions) && value.questions.length <= 100 && value.questions.every(q => validBlockContent('quiz', { questions: [q] })));
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 512000) fail('内容过大，请减少笔记或课程内容。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('请求格式不正确。'); }
}
const planShape = '{"title":"路线名","description":"课程说明","lessons":[{"title":"课程名","objective":"具体学习目标","phase":"阶段名","minutes":25,"tags":["知识标签"]}]}';
const lessonShape = '{"intro":"引言","sections":[{"heading":"小标题","body":"详细讲解"}],"example":"完整示例（代码或具体情境）","challenge":"可独立完成的实践任务","questions":[{"prompt":"单选题","options":["选项A","选项B","选项C","选项D"],"answer":0,"explanation":"答案解析"}],"takeaways":["要点"]}';
const blockGuidance = {
  reading: '讲解块：先用一句易懂的话回答“这是什么、为什么要学”，再从学习者已有基础出发分 2–5 个短段落逐步解释。首次出现的术语要定义；加入一个贴近目标的小例子，指出一个常见误解并纠正。必要时使用类比，但要说明类比的局限。段落之间留空行，小标题简短，不堆砌术语。',
  example: '示例块：给一个与课程目标直接相关、可复现的完整例子。按“场景与输入 → 分步操作/推理 → 预期结果 → 为什么这样做”的顺序写；代码或公式逐步解释关键行，并说明前提与边界。只描述预期结果，不声称已经执行代码或验证外部系统。',
  practice: '实践块：给学习者一个可以独立完成的小任务，写清起点、操作步骤、完成标准和两个由浅入深的提示。任务应可在普通学习环境中完成，不依赖本应用执行代码。不要直接交出完整答案；提醒一个常见错误和自查方法。',
  summary: '总结块：用 3–5 条简短结论提炼本课已讲的知识，包含一个易错点和一个能迁移到新情境的判断方法。指出下一步可练习什么，不添加前文未解释的新概念。',
  quiz: '测验块：生成 2–4 道四选一单选题，覆盖概念理解与情境应用，不只考术语记忆。每题只能有一个明确正确答案；错误选项要对应常见误解，不用“以上皆是”。answer 必须是正确选项的 0–3 整数下标；explanation 要说明正确原因，并点出容易误选的原因。'
};
function planIssue(value, budget) {
  if (!value || !str(value.title, 160) || !str(value.description, 2000)) return '路线名称或说明缺失、为空或过长';
  if (!Array.isArray(value.lessons) || value.lessons.length < 3 || value.lessons.length > 12) return '课程数量必须为 3–12 节';
  const badIndex = value.lessons.findIndex(lesson => !lesson || !str(lesson.title, 160) || !str(lesson.objective, 1000) || !str(lesson.phase, 80) || !Number.isInteger(lesson.minutes) || lesson.minutes < 5 || lesson.minutes > 180 || !strings(lesson.tags, 6) || lesson.tags.some(tag => tag.length > 40));
  if (badIndex !== -1) return `第 ${badIndex + 1} 节课程的标题、目标、阶段、整数分钟数或标签不符合要求`;
  const total = value.lessons.reduce((sum, lesson) => sum + lesson.minutes, 0);
  if (total > budget) return `课程总时长 ${total} 分钟超过可用的 ${budget} 分钟`;
  return null;
}

export function createApp(config = {}) {
  const defaultLLM = config.getLLM ? null : createLLM(config);
  return http.createServer(async (req, res) => {
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(403, { error: '仅支持本机访问。' });
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(403, { error: '不允许跨站请求。' });
      const path = new URL(req.url, `http://${host}`).pathname;
      if (path.startsWith('/api/') && config.apiToken && req.headers['x-learnflow-token'] !== config.apiToken) return send(403, { error: '桌面接口仅供应用内部调用。' });
      const llm = config.getLLM ? config.getLLM() : defaultLLM;
      const generate = llm.generate;
      if (path === '/api/status' && req.method === 'GET') return send(200, llm.status());
      if (path.startsWith('/api/') && req.method === 'POST') {
        const data = await body(req);
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail('请求内容不正确。');
        if (path === '/api/test-connection') return send(200, await llm.testConnection());
        let result;
        if (path === '/api/plan') {
          if (!str(data.goal, 1000) || !['零基础', '有一点基础', '希望进阶'].includes(data.level) || !Number.isInteger(data.daily) || data.daily < 10 || data.daily > 120 || !Number.isInteger(data.days) || data.days < 7 || data.days > 90) fail('请填写目标、基础、每日时长与学习周期。');
          const budget = data.daily * data.days;
          const instruction = `根据目标、已有基础、每日分钟数与天数设计 3–12 节循序渐进的课程。严格返回 JSON 对象，包含非空 title、description 和 lessons。lessons 必须有 3–12 个对象，不能只按下面的单节字段示例生成一节。每节都需要非空 title、objective、phase，以及 5–180 之间的整数 minutes、1–6 个非空字符串 tags（每个不超过 40 字）。全部课程分钟数之和必须不超过 ${budget}，不要把天数误认为单节时长。字段示例：${planShape}`;
          let issue = null;
          const validate = value => { issue = planIssue(value, budget); return issue === null; };
          try { result = await generate(instruction, data, validate); }
          catch (error) {
            if (!issue) throw error;
            const firstIssue = issue;
            issue = null;
            try { result = await generate(`${instruction} 上次生成未通过校验，原因：${firstIssue}。请重新规划并逐项核对所有字段与总时长；只返回修正后的完整 JSON。`, data, validate); }
            catch (retryError) {
              if (!issue) throw retryError;
              fail(`路线生成两次仍未符合要求：${issue}。可缩短目标描述或调整学习周期后重试。`, 502);
            }
          }
          result = { ...result, id: randomUUID(), goal: data.goal, level: data.level, daily: data.daily, days: data.days, source: 'ai', lessons: result.lessons.map(l => ({ ...l, id: randomUUID() })) };
        } else if (path === '/api/lesson-outline') {
          if (!str(data.goal, 1000) || !str(data.title, 160) || !str(data.objective, 1000) || !str(data.level, 80)) fail('课程参数不完整。');
          if (data.route !== undefined && (!Array.isArray(data.route) || data.route.length < 1 || data.route.length > 12 || !data.route.every(lesson => lesson && str(lesson.title, 160) && str(lesson.objective, 1000)))) fail('路线课程上下文不正确。');
          if (data.lessonPosition !== undefined && (!Number.isInteger(data.lessonPosition) || data.lessonPosition < 1 || data.lessonPosition > (data.route?.length || 12))) fail('当前课程顺序不正确。');
          const outlineRequest = { goal: data.goal, level: data.level, title: data.title, objective: data.objective, ...(data.route === undefined ? {} : { route: data.route.map(({ title, objective }) => ({ title, objective })) }), ...(data.lessonPosition === undefined ? {} : { lessonPosition: data.lessonPosition }) };
          result = await generate('请为这一节自学课程设计清晰、循序渐进的大纲。route 是整条学习路线，lessonPosition 是本课位置：衔接前面的课程，避免重复已学内容，并为后续课程留出空间。先确定学习者已知什么、结束后能做什么，再按“核心概念 → 具体示例 → 自己动手 → 检验理解 → 提炼要点”的学习顺序安排模块；可按主题灵活调整，不要为凑数量重复。模块类型：reading 讲解、example 示例、practice 实践、quiz 测验、summary 总结。至少包含一个 reading 和一个 quiz，尽量包含示例与实践。每块的 objective 要写成可观察的学习成果，不要只是重复标题。intro 用 2–3 句说明本课价值、前置知识和达成目标。这里只规划大纲，不写正文。返回 JSON：{"intro":"课程导语","blocks":[{"type":"reading","title":"明确的模块标题","objective":"本块学完能做到什么"}]}。模块共 2–20 个，通常 4–8 个。', outlineRequest, validOutline);
        } else if (path === '/api/lesson-block') {
          if (!str(data.goal, 1000) || !str(data.title, 160) || !str(data.objective, 1000) || !str(data.level, 80) || !validBlockSpec(data.block) || typeof data.intro !== 'string' || data.intro.length > 20000) fail('内容块参数不完整。');
          if (data.minutes !== undefined && (!Number.isInteger(data.minutes) || data.minutes < 5 || data.minutes > 180)) fail('课程时长不正确。');
          if (data.outline !== undefined && (!Array.isArray(data.outline) || data.outline.length < 1 || data.outline.length > 25 || !data.outline.every(validBlockSpec))) fail('课程大纲上下文不正确。');
          if (data.previous !== undefined && (!Array.isArray(data.previous) || data.previous.length > 3 || !data.previous.every(item => item && blockTypes.includes(item.type) && str(item.title, 160) && str(item.excerpt, 1000)))) fail('前文上下文不正确。');
          if (data.sequence !== undefined && (!data.sequence || !Number.isInteger(data.sequence.position) || !Number.isInteger(data.sequence.total) || data.sequence.position < 1 || data.sequence.total > 1000 || data.sequence.position > data.sequence.total)) fail('模块顺序不正确。');
          const requested = { goal: data.goal, level: data.level, title: data.title, objective: data.objective, intro: data.intro, block: { type: data.block.type, title: data.block.title, objective: data.block.objective }, ...(data.minutes === undefined ? {} : { minutes: data.minutes }), ...(data.outline === undefined ? {} : { outline: data.outline.map(({ type, title, objective }) => ({ type, title, objective })) }), ...(data.previous === undefined ? {} : { previous: data.previous.map(({ type, title, excerpt }) => ({ type, title, excerpt })) }), ...(data.sequence === undefined ? {} : { sequence: { position: data.sequence.position, total: data.sequence.total } }) };
          const instructions = `你只负责生成当前内容块，不要重写整节课。根据 level 调整起点与术语密度，根据本课 objective 与 block.objective 控制深度；参考 minutes 控制篇幅，短课不要写成大段教材。outline 是附近模块顺序，previous 是已生成内容的节选：承接前文，不重复已经讲过的定义，也不要提前讲完后续模块。内容必须准确、具体、可让学习者照着理解或实践；遇到依赖版本或无法确定的事实，明确说明条件，不编造。${blockGuidance[data.block.type]}${data.block.type === 'quiz' ? '返回 JSON：{"questions":[{"prompt":"题目","options":["选项A","选项B","选项C","选项D"],"answer":0,"explanation":"正确原因与易错点"}]}。' : '使用清楚的短段落和必要的小标题，文本中用换行分隔，不要 Markdown 代码围栏。返回 JSON：{"text":"当前模块的完整纯文本内容"}。'}`;
          result = await generate(instructions, requested, value => validBlockContent(data.block.type, value));
        } else if (path === '/api/lesson') {
          if (!str(data.goal, 1000) || !str(data.title, 160) || !str(data.objective, 1000) || !str(data.level, 80)) fail('课程参数不完整。');
          result = await generate(`生成充分且可自学的课程，包含 2–8 段讲解、一个完整示例、动手任务、2–5 道四选一单选题和总结。答案为 0–3 的整数下标，解释正确答案。使用纯文本（代码允许换行），不要 Markdown。格式：${lessonShape}`, data, validLesson);
        } else if (path === '/api/wiki') {
          if (!str(data.title, 160) || !validStudyLesson(data.lesson) || typeof data.reflection !== 'string' || data.reflection.length > 5000) fail('课程或学习笔记不完整。');
          result = await generate('将已学课程整理为个人 Wiki，保留核心概念、实际例子、易错点、适用边界与用户心得。用户心得中的错误要指出，不要把它当成正确知识。格式：{"summary":"一句话摘要","content":"完整纯文本知识笔记"}。', data, v => v && str(v.summary, 500) && str(v.content));
        } else if (path === '/api/lesson-ask') {
          if (!str(data.title, 160) || !str(data.objective, 1000) || !validStudyLesson(data.lesson) || !str(data.question, 1000) || !Array.isArray(data.history) || data.history.length > 12 || !data.history.every(item => item && ['user', 'assistant'].includes(item.role) && str(item.content, item.role === 'user' ? 1000 : 12000))) fail('请提供当前课程、问题和最多 12 条有效对话记录。');
          result = await generate('你正在辅导用户学习当前课程。根据 lesson 的讲解、示例、练习和上下文 history 回答当前 question；可以用通用知识补充，但要区分课程已有内容与补充说明。先直接回答，再用简短例子或思路帮助理解。若用户问练习题，优先提示解题思路，避免直接代答。不要编造已经执行的操作。格式：{"answer":"清晰、具体的中文答复"}。', data, v => v && str(v.answer, 12000));
        } else if (path === '/api/ask') {
          if (!str(data.question, 1000) || !Array.isArray(data.notes) || data.notes.length > 30 || !data.notes.length || !data.notes.every(n => str(n.id, 160) && str(n.title, 160) && str(n.content))) fail('请提供问题和最多 30 篇有效知识笔记。');
          result = await generate('只根据提供的 notes 回答问题。资料不足就明确说明不足，不得补充无依据的知识。返回实际支撑答案的笔记 id；引用只能使用所给 id。格式：{"answer":"回答","citations":["笔记id"]}。', data, v => v && str(v.answer) && Array.isArray(v.citations) && v.citations.every(id => data.notes.some(n => n.id === id)));
        } else return send(404, { error: '接口不存在。' });
        return send(200, result);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: '请求方法不支持。' });
      const asset = assets[path];
      if (!asset) return send(404, { error: '页面不存在。' });
      const content = await readFile(new URL(asset[0], publicDir));
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (e) { send(e.status || 500, { error: e.status ? e.message : '服务发生错误，请稍后重试。' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, '127.0.0.1', () => console.log(`知行 Learnflow: http://localhost:${port}`));
}
