import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createLLM } from './llm.mjs';

const publicDir = new URL('./public/', import.meta.url);
const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/demo.js': ['demo.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const str = (v, max = 20000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const strings = (v, max = 20) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(x => str(x, 5000));
export function validPlan(v) {
  return !!v && str(v.title, 160) && str(v.description, 2000) && Array.isArray(v.lessons) && v.lessons.length >= 3 && v.lessons.length <= 12 && v.lessons.every(l => str(l.title, 160) && str(l.objective, 1000) && str(l.phase, 80) && Number.isInteger(l.minutes) && l.minutes >= 5 && l.minutes <= 180 && strings(l.tags, 6) && l.tags.every(t => t.length <= 40));
}
export function validLesson(v) {
  return !!v && str(v.intro) && Array.isArray(v.sections) && v.sections.length >= 2 && v.sections.length <= 8 && v.sections.every(s => str(s.heading, 160) && str(s.body)) && str(v.example) && str(v.challenge) && strings(v.takeaways, 8) && Array.isArray(v.questions) && v.questions.length >= 2 && v.questions.length <= 5 && v.questions.every(q => str(q.prompt, 2000) && Array.isArray(q.options) && q.options.length === 4 && q.options.every(x => str(x, 2000)) && Number.isInteger(q.answer) && q.answer >= 0 && q.answer <= 3 && str(q.explanation, 5000));
}
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 512000) fail('内容过大，请减少笔记或课程内容。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail('请求格式不正确。'); }
}
const planShape = '{"title":"路线名","description":"课程说明","lessons":[{"title":"课程名","objective":"具体学习目标","phase":"阶段名","minutes":25,"tags":["知识标签"]}]}';
const lessonShape = '{"intro":"引言","sections":[{"heading":"小标题","body":"详细讲解"}],"example":"完整示例（代码或具体情境）","challenge":"可独立完成的实践任务","questions":[{"prompt":"单选题","options":["选项A","选项B","选项C","选项D"],"answer":0,"explanation":"答案解析"}],"takeaways":["要点"]}';

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
          result = await generate(`根据目标、已有基础、每日分钟数与天数设计 3–12 节循序渐进的课程。课程总时长不要超过 daily * days。每课具有具体目标。格式：${planShape}`, data, v => validPlan(v) && v.lessons.reduce((sum, l) => sum + l.minutes, 0) <= data.daily * data.days);
          result = { ...result, id: randomUUID(), goal: data.goal, level: data.level, daily: data.daily, days: data.days, source: 'ai', lessons: result.lessons.map(l => ({ ...l, id: randomUUID() })) };
        } else if (path === '/api/lesson') {
          if (!str(data.goal, 1000) || !str(data.title, 160) || !str(data.objective, 1000) || !str(data.level, 80)) fail('课程参数不完整。');
          result = await generate(`生成充分且可自学的课程，包含 2–8 段讲解、一个完整示例、动手任务、2–5 道四选一单选题和总结。答案为 0–3 的整数下标，解释正确答案。使用纯文本（代码允许换行），不要 Markdown。格式：${lessonShape}`, data, validLesson);
        } else if (path === '/api/wiki') {
          if (!str(data.title, 160) || !validLesson(data.lesson) || typeof data.reflection !== 'string' || data.reflection.length > 5000) fail('课程或学习笔记不完整。');
          result = await generate('将已学课程整理为个人 Wiki，保留核心概念、实际例子、易错点、适用边界与用户心得。用户心得中的错误要指出，不要把它当成正确知识。格式：{"summary":"一句话摘要","content":"完整纯文本知识笔记"}。', data, v => v && str(v.summary, 500) && str(v.content));
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
