import { demoPlan, demoLessons } from './demo.js';
import { lessonFromBlocks, validOutline, validBlockContent, validBlockSpec } from './blocks.js';

const $ = s => document.querySelector(s);
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  route: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M8 5h7a4 4 0 0 1 0 8H9a3 3 0 0 0 0 6h7"/>',
  book: '<path d="M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1zm0 0v15"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
  brain: '<path d="M12 5c-3-5-8-1-7 2-5 1-4 7-1 8-1 5 5 8 8 4 3 4 9 1 8-4 3-1 4-7-1-8 1-3-4-7-7-2zm0 0v14M5 7l3 2m-4 6 4-2m11-6-3 2m4 6-4-2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  leaf: '<path d="M5 19C-1 6 13 2 21 3c0 12-3 18-12 16M4 21 16 9"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>'
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
const desktop = window.learnflowDesktop;
let desktopSettings = null, dataDirectory = '', pendingSave = Promise.resolve();
const key = 'learnflow.v1';
const fresh = () => ({ version: 1, plans: [structuredClone(demoPlan)], active: demoPlan.id, lessons: {}, blockCourses: {}, progress: {}, notes: [], reflections: {}, chats: {} });
let storageWarning = '';
let state = fresh();
try {
  const stored = desktop ? null : localStorage.getItem(key);
  if (stored) {
    const value = JSON.parse(stored);
    if (value.version !== 1 || !Array.isArray(value.plans) || !value.plans.length || !value.plans.every(p => typeof p.id === 'string' && Array.isArray(p.lessons) && p.lessons.length) || !Array.isArray(value.notes) || !value.lessons || !value.progress || !value.reflections) throw new Error('invalid');
    state = value;
  }
} catch { storageWarning = '本地记录暂时无法读取；当前以临时会话打开，不会覆盖旧记录。可导出新记录备份。'; }
let page = 'home', activeLesson = null, activeNote = null, lessonTab = 'read', query = '', answer = null;
let status = { mode: 'loading' };
let connectionResult = '';
const plan = () => state.plans.find(p => p.id === state.active) || state.plans[0];
const progress = id => state.progress[id] || {};
const completed = () => plan().lessons.filter(l => progress(l.id).completed).length;
const percent = () => Math.round(completed() / plan().lessons.length * 100);
const nextLesson = () => plan().lessons.find(l => !progress(l.id).completed) || plan().lessons[0];
const contentFor = id => state.blockCourses?.[id] ? lessonFromBlocks(state.blockCourses[id]) : state.lessons[id] || demoLessons[id];
const lessonById = id => state.plans.flatMap(p => p.lessons).find(l => l.id === id);
const chatFor = id => state.chats?.[id] || [];
function save() {
  if (storageWarning) return;
  if (desktop) throw new Error('桌面数据必须按条目保存。');
  try { localStorage.setItem(key, JSON.stringify(state)); }
  catch { storageWarning = '浏览器存储不可用或已满。当前更改只保留在本次会话，请导出备份。'; toast(storageWarning); }
}
function persist(method, ...args) {
  if (!desktop) return save();
  if (storageWarning) return pendingSave;
  const operation = pendingSave.then(() => desktop[method](...args));
  pendingSave = operation.catch(error => { storageWarning = error.message; toast('本地保存失败：' + error.message); });
  return pendingSave;
}
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
async function api(path, body) {
  if (desktop) return desktop.request(path, body);
  const r = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout((Number.isInteger(status.timeoutMs) && status.timeoutMs >= 1000 && status.timeoutMs <= 600000 ? status.timeoutMs : 120000) + 10000) });
  const value = await r.json(); if (!r.ok) throw new Error(value.error || '请求失败，请重试。'); return value;
}
const pill = (text, cls = '') => `<span class="pill ${cls}">${escape(text)}</span>`;
const button = (text, action, cls = 'primary', attrs = '', symbol = 'arrow') => `<button class="btn ${cls}" data-action="${action}" ${attrs}>${escape(text)}${symbol ? icon(symbol) : ''}</button>`;
const date = timestamp => new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
function navigate(target) { page = target; answer = null; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function render() {
  const titles = { home: '学习概览', routes: '我的学习路线', study: '学习工作台', practice: '练习与巩固', wiki: '我的知识库', settings: '设置与数据' };
  $('#app').innerHTML = `<aside class="sidebar">
    <a class="brand" href="#" data-page="home"><img src="/favicon.svg" alt="" width="38" height="38"><span>知行 <small>Learnflow</small></span></a>
    <div class="workspace-label">个人学习空间 <span>PERSONAL</span></div>
    <nav aria-label="主导航">${[['home', 'grid', '学习概览'], ['routes', 'route', '学习路线'], ['study', 'book', '学习工作台'], ['practice', 'bolt', '练习与巩固'], ['wiki', 'brain', '我的知识库']].map(([id, symbol, label]) => `<button class="nav-item ${page === id ? 'active' : ''}" data-page="${id}" ${page === id ? 'aria-current="page"' : ''}>${icon(symbol)}${label}${id === 'wiki' ? `<span class="nav-count">${state.notes.length}</span>` : ''}</button>`).join('')}</nav>
    <div class="sidebar-grow"><div class="grow-icon">${icon('leaf')}</div><strong>每一步，都算数。</strong><p>让好奇心成为起点，<br>让知识成为你的底气。</p><div class="tiny-line"><span></span><span></span><span></span></div></div>
    <div class="sidebar-bottom"><button class="nav-item ${page === 'settings' ? 'active' : ''}" data-page="settings">${icon('settings')}设置与数据</button><div class="profile"><div class="avatar">知</div><div><strong>终身学习者</strong><small>保持好奇，持续生长</small></div><span class="online-dot"></span></div></div>
  </aside>
  <div class="workspace"><header class="topbar"><div class="breadcrumb">我的空间 <span>/</span> <strong>${titles[page]}</strong></div><div class="topbar-right"><span class="mode"><i class="${status.mode === 'ai' ? 'live' : ''}"></i>${status.mode === 'ai' ? escape((status.providerLabel || 'AI') + ' 已配置') : status.mode === 'loading' ? '正在连接' : status.mode === 'offline' ? '服务未连接' : status.mode === 'error' ? '模型配置需检查' : '示例体验模式'}</span><button class="icon-button" data-page="wiki" aria-label="搜索知识库">${icon('search')}</button><div class="avatar small">知</div></div></header>
  <main id="main">${storageWarning ? `<div class="notice error">${escape(storageWarning)}</div>` : ''}${({ home, routes, study, practice, wiki, settings }[page])()}</main><footer>知行 Learnflow <span>从知道，到做到。</span></footer></div>`;
}
function home() {
  const p = plan(), next = nextLesson();
  const allCompleted = Object.values(state.progress).filter(v => v.completed).length;
  const attempts = Object.values(state.progress).reduce((n, v) => n + (v.attempts || 0), 0);
  return `<section class="page-intro"><div><div class="eyebrow">A LITTLE BETTER, EVERY DAY</div><h1>让每一次好奇，都有回响<span class="title-dot">.</span></h1><p>从一个学习目标开始，构建属于你的知识世界。</p></div>${button('开启新的学习', 'planner', 'primary', '', 'plus')}</section>
  <section class="hero"><div class="hero-copy">${pill('你的 AI 学习伙伴', 'hero-pill')}<h2>不止学会，<br>更要成为自己的知识。</h2><p>为你规划路径，陪你练习思考，<br>将每一次收获，连接成你的第二大脑。</p>${button('探索我的学习路线', 'routes', 'dark')}<div class="hero-caption"><span class="mini-dot"></span>目标驱动 <span>·</span> 学练结合 <span>·</span> 知识沉淀</div></div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orb-center">${icon('brain')}<span>我的知识宇宙</span></div><div class="float-card float-top"><span class="float-icon lavender">${icon('route')}</span><div><small>找到你的方向</small><strong>个性化学习路线</strong></div><b>↗</b></div><div class="float-card float-left"><span class="float-icon peach">${icon('bolt')}</span><div><small>在实践中理解</small><strong>让知识发生</strong></div></div><div class="float-card float-bottom"><span class="float-icon green">${icon('book')}</span><div><small>连接每一次收获</small><strong>你的第二大脑</strong></div><span class="check-bubble">✓</span></div><span class="star star-one">✦</span><span class="star star-two">✧</span><span class="orb-dot dot-one"></span><span class="orb-dot dot-two"></span></div></section>
  <section class="stats" aria-label="学习统计">${[['route', '学习路线', state.plans.length, '条探索中的路径', 'lavender'], ['check', '已完成课程', allCompleted, '次从不懂到掌握', 'green'], ['bolt', '练习提交', attempts, '次认真思考', 'peach'], ['brain', '知识卡片', state.notes.length, '份属于你的积累', 'blue']].map(([symbol, label, value, detail, color]) => `<div class="stat"><div class="stat-top"><span>${label}</span><span class="stat-icon ${color}">${icon(symbol)}</span></div><strong>${value}<small>${label === '学习路线' ? '条' : label === '知识卡片' ? '张' : '次'}</small></strong><p>${detail}</p></div>`).join('')}</section>
  <div class="dashboard-columns"><section><div class="section-heading"><h2>继续你的学习<span>KEEP GOING</span></h2><button class="text-button" data-page="routes">全部路线 ${icon('arrow')}</button></div><article class="course-card"><div class="course-top"><span class="course-icon">Py<span>✦</span></span><div>${pill(p.source === 'demo' ? '示例课程' : 'AI 定制', 'purple')} ${pill(p.level)}</div><button class="icon-button" data-page="routes" aria-label="查看课程路线">${icon('arrow')}</button></div><h3>${escape(p.title)}</h3><p>${escape(p.description)}</p><div class="progress-label"><span>学习进度</span><strong>${completed()} / ${p.lessons.length} 节</strong></div><div class="progress-bar"><span style="width:${percent()}%"></span></div><div class="next-up"><span class="next-marker">${icon('book')}</span><div><small>${completed() === p.lessons.length ? '回顾所学' : '接下来学习'}</small><strong>${escape(next.title)}</strong></div><span>${next.minutes} 分钟</span></div>${button(completed() ? '继续学习' : '开始第一课', 'open-lesson', 'primary full', `data-id="${next.id}"`)}</article></section>
  <section><div class="section-heading"><h2>知识在这里生长<span>YOUR SECOND BRAIN</span></h2></div><article class="knowledge-preview">${state.notes.length ? `<div class="knowledge-heading">${icon('brain')}最近收获</div>${state.notes.slice(-3).reverse().map(n => `<button class="note-preview" data-action="open-note" data-id="${n.id}"><span class="note-glyph">${icon('book')}</span><div><strong>${escape(n.title)}</strong><small>${escape(n.tags.slice(0, 2).join(' · '))} · ${date(n.updated)}</small></div>${icon('arrow')}</button>`).join('')}` : `<div class="seed-illustration">${icon('leaf')}<span>+ 第一颗知识种子</span></div><h3>学过的，不再只是路过。</h3><p>完成课程后，将概念、实践和心得<br>整理成可以反复使用的知识卡片。</p><div class="sample-note"><span>未来的知识卡片</span><strong>核心概念 + 实践经验 + 我的思考</strong><div>${pill('可编辑')} ${pill('可关联')} ${pill('可检索')}</div></div>`}<button class="text-button purple-text" data-page="wiki">打开我的知识库 ${icon('arrow')}</button></article></section></div>
  <div class="bottom-note">${icon('spark')} 学习的终点，不是记住答案，而是拥有解决问题的能力。</div>`;
}
function routes() {
  const p = plan();
  return `<section class="page-intro"><div><div class="eyebrow">YOUR LEARNING JOURNEY</div><h1>每个目标，都有一条路。</h1><p>把远处的目标，拆解为今天可以迈出的一步。</p></div>${button('新建学习路线', 'planner', 'primary', '', 'plus')}</section>
  <div class="route-switch">${state.plans.map(p => `<button class="route-chip ${p.id === state.active ? 'selected' : ''}" data-action="switch-plan" data-id="${p.id}">${icon('route')}${escape(p.title)}</button>`).join('')}</div>
  <section class="route-overview"><div>${pill(p.source === 'demo' ? '精选示例 · 非 AI 生成' : 'AI 定制路线', 'purple')}<h2>${escape(p.title)}</h2><p>${escape(p.goal)}</p><div class="metadata">${icon('clock')}每天 ${p.daily} 分钟 <span>·</span>计划 ${p.days} 天 <span>·</span>${escape(p.level)}</div></div><div class="progress-ring" style="--progress:${percent()}%"><div><strong>${percent()}<small>%</small></strong><span>已完成</span></div></div></section>
  <div class="route-layout"><section class="timeline">${p.lessons.map((l, i) => `${i === 0 || l.phase !== p.lessons[i - 1].phase ? `<h3 class="phase">${escape(l.phase)}</h3>` : ''}<article class="lesson-row ${progress(l.id).completed ? 'complete' : ''}"><div class="step-number">${progress(l.id).completed ? icon('check') : String(i + 1).padStart(2, '0')}</div><div class="lesson-row-main"><div class="lesson-title"><h3>${escape(l.title)}</h3>${progress(l.id).completed ? pill('已掌握', 'success') : l.id === nextLesson().id ? pill('推荐下一步', 'purple') : ''}</div><p>${escape(l.objective)}</p><div class="lesson-meta">${icon('clock')}${l.minutes} 分钟<span>·</span>${escape(l.tags.join(' / '))}</div></div>${button(progress(l.id).completed ? '复习' : '进入课程', 'open-lesson', 'secondary', `data-id="${l.id}"`)}</article>`).join('')}</section><aside class="tip-card"><span class="float-icon lavender">${icon('target')}</span><h3>按自己的节奏前进</h3><p>路线是一张地图。你可以先预览任意课程，再根据自己的基础选择起点。</p><hr><strong>掌握比完成更重要</strong><p>每节课通过全部测验后会记录为已掌握。答错时，读一读解析，再试一次。</p>${button('去练习与巩固', 'practice', 'secondary full', '', 'bolt')}</aside></div>`;
}
function study() {
  const p = plan(); const meta = p.lessons.find(l => l.id === activeLesson) || nextLesson(); activeLesson = meta.id;
  const lesson = contentFor(meta.id), record = progress(meta.id);
  if (state.blockCourses?.[meta.id]) return studyBlocks(meta, p, record);
  return `<div class="study-top"><button class="text-button" data-page="routes">${icon('back')}返回学习路线</button>${pill(p.source === 'demo' ? '示例课程' : 'AI 生成 · 请核验重要知识', 'purple')}</div>
  <div class="study-layout"><aside class="syllabus"><div class="syllabus-heading">课程目录 <span>${completed()}/${p.lessons.length}</span></div>${p.lessons.map((l, i) => `<button class="syllabus-item ${l.id === meta.id ? 'selected' : ''}" data-action="open-lesson" data-id="${l.id}"><span>${progress(l.id).completed ? icon('check') : String(i + 1).padStart(2, '0')}</span><strong>${escape(l.title)}</strong></button>`).join('')}<div class="syllabus-bottom">${icon('leaf')} 慢慢来，也是在前进。</div></aside>
  <section class="lesson-content"><div class="eyebrow">LESSON ${String(p.lessons.indexOf(meta) + 1).padStart(2, '0')}</div><h1>${escape(meta.title)}</h1><p class="lesson-objective">${escape(meta.objective)}</p><div class="metadata">${icon('clock')}${meta.minutes} 分钟 <span>·</span>${escape(meta.tags.join(' / '))}</div>
  <div class="tabs" role="tablist" aria-label="课程内容">${[['read', 'book', '学习内容'], ['quiz', 'bolt', `随堂练习${record.completed ? ' ✓' : ''}`], ['chat', 'spark', 'AI 答疑'], ['notes', 'brain', '学习笔记']].map(([tab, symbol, label]) => `<button role="tab" aria-selected="${lessonTab === tab}" class="${lessonTab === tab ? 'active' : ''}" data-action="lesson-tab" data-tab="${tab}">${icon(symbol)}${label}</button>`).join('')}</div>
  ${!lesson ? `<div class="empty-state">${icon('spark')}<h3>为你展开这一课</h3><p>根据你的目标与基础，生成讲解、示例和随堂练习。</p>${button('生成课程内容', 'generate-lesson', 'primary', `data-id="${meta.id}"`, 'spark')}</div>` : lessonTab === 'read' ? `<div class="lesson-intro">${escape(lesson.intro)}</div>${lesson.sections.map(s => `<section class="reading-section"><h2>${escape(s.heading)}</h2><p>${escape(s.body)}</p></section>`).join('')}<div class="code-block"><div>具体示例 <span>阅读与推演</span></div><pre><code>${escape(lesson.example)}</code></pre></div><div class="challenge"><h3>${icon('bolt')}动手试一试</h3><p>${escape(lesson.challenge)}</p><small>请在你自己的工具或编程环境中完成。这里不执行代码。</small></div><div class="lesson-actions"><span>理解之后，用练习检验一下。</span>${button('开始随堂练习', 'quiz', 'primary')}</div>` : lessonTab === 'quiz' ? quiz(meta, lesson) : lessonTab === 'chat' ? studyChat(meta) : `<section class="reflection"><h2>用自己的话，重新理解一次。</h2><p>哪些内容让你豁然开朗？你会把它用在哪里？</p><label class="sr-only" for="reflection">我的学习心得</label><textarea id="reflection" data-reflection="${meta.id}" maxlength="5000" placeholder="我的理解、实践结果，或仍然困惑的问题……">${escape(state.reflections[meta.id] || '')}</textarea><span class="field-hint">自动保存在${desktop ? '本机' : '当前浏览器'} · 最多 5000 字</span><div class="takeaways"><h3>本课关键收获</h3>${lesson.takeaways.map(t => `<p>${icon('check')}${escape(t)}</p>`).join('')}</div>${record.completed ? button(state.notes.some(n => n.lessonId === meta.id) ? '查看本课知识卡片' : '沉淀到我的 Wiki', 'create-note', 'primary', `data-id="${meta.id}"`, 'brain') : `<div class="notice">通过随堂练习后，即可将本课和心得整理为 Wiki 知识卡片。</div>${button('去完成练习', 'quiz', 'secondary')}`}</section>`}</section></div>`;
}
function studyBlocks(meta, p, record) {
  const course = state.blockCourses[meta.id], lesson = lessonFromBlocks(course);
  const labels = { reading: '讲解', example: '示例', practice: '实践', quiz: '练习', summary: '总结' };
  const read = `<div class="lesson-intro">${escape(course.intro)}</div><div class="block-sequence">${course.blocks.map((block, index) => `<section class="reading-section content-block"><div class="block-heading"><span class="pill purple">${String(index + 1).padStart(2, '0')} · ${labels[block.type]}</span><h2>${escape(block.title)}</h2></div><p class="block-objective">${escape(block.objective)}</p>${block.content ? block.type === 'quiz' ? `<p>已生成 ${block.content.questions.length} 道练习题。${button('去练习', 'quiz', 'secondary')}</p>` : `<p class="block-text">${escape(block.content.text)}</p>` : `<div class="block-pending"><span>此模块尚未生成，可以按需展开。</span>${button('生成这一块', 'generate-block', 'secondary', `data-id="${meta.id}" data-block="${block.id}"`, 'spark')}</div>`}</section>`).join('')}</div><form id="append-block-form" data-id="${meta.id}" class="append-block-form"><h3>继续扩展本课</h3><div class="form-row"><div><label for="block-type">内容类型</label><select id="block-type" name="type">${Object.entries(labels).map(([type, label]) => `<option value="${type}">${label}</option>`).join('')}</select></div><div><label for="block-title">模块标题</label><input id="block-title" name="title" required maxlength="160" placeholder="例如：更多实际案例"></div></div><label for="block-objective">本块的学习目标</label><input id="block-objective" name="objective" required maxlength="1000" placeholder="你想在这里学会什么？"><button class="btn secondary" type="submit">添加内容块 ${icon('plus')}</button></form>`;
  const notes = `<section class="reflection"><h2>用自己的话，重新理解一次。</h2><label class="sr-only" for="reflection">我的学习心得</label><textarea id="reflection" data-reflection="${meta.id}" maxlength="5000" placeholder="我的理解、实践结果，或仍然困惑的问题……">${escape(state.reflections[meta.id] || '')}</textarea><span class="field-hint">自动保存在${desktop ? '本机' : '当前浏览器'}</span><div class="takeaways"><h3>本课总结</h3>${lesson.takeaways.map(t => `<p>${icon('check')}${escape(t)}</p>`).join('')}</div>${record.completed ? button(state.notes.some(n => n.lessonId === meta.id) ? '查看本课知识卡片' : '沉淀到我的 Wiki', 'create-note', 'primary', `data-id="${meta.id}"`, 'brain') : `<div class="notice">生成练习内容并全部答对后，可整理为 Wiki 知识卡片。</div>${button('去完成练习', 'quiz', 'secondary')}`}</section>`;
  const quizBody = lesson.questions.length ? quiz(meta, lesson) : `<div class="empty-state"><h3>练习尚未生成</h3><p>请先在“学习内容”里生成练习模块。</p>${button('查看内容块', 'read-tab', 'secondary')}</div>`;
  return `<div class="study-top"><button class="text-button" data-page="routes">${icon('back')}返回学习路线</button>${pill('分步课程 · 可扩展', 'purple')}</div><div class="study-layout"><aside class="syllabus"><div class="syllabus-heading">课程目录 <span>${completed()}/${p.lessons.length}</span></div>${p.lessons.map((l, i) => `<button class="syllabus-item ${l.id === meta.id ? 'selected' : ''}" data-action="open-lesson" data-id="${l.id}"><span>${progress(l.id).completed ? icon('check') : String(i + 1).padStart(2, '0')}</span><strong>${escape(l.title)}</strong></button>`).join('')}</aside><section class="lesson-content"><div class="eyebrow">LESSON ${String(p.lessons.indexOf(meta) + 1).padStart(2, '0')}</div><h1>${escape(meta.title)}</h1><p class="lesson-objective">${escape(meta.objective)}</p><div class="tabs" role="tablist" aria-label="课程内容">${[['read', 'book', '学习内容'], ['quiz', 'bolt', `随堂练习${record.completed ? ' ✓' : ''}`], ['chat', 'spark', 'AI 答疑'], ['notes', 'brain', '学习笔记']].map(([tab, symbol, label]) => `<button role="tab" aria-selected="${lessonTab === tab}" class="${lessonTab === tab ? 'active' : ''}" data-action="lesson-tab" data-tab="${tab}">${icon(symbol)}${label}</button>`).join('')}</div>${lessonTab === 'read' ? read : lessonTab === 'quiz' ? quizBody : lessonTab === 'chat' ? studyChat(meta) : notes}</section></div>`;
}
function studyChat(meta) {
  const messages = chatFor(meta.id);
  return `<section class="study-chat"><div class="study-chat-heading"><span class="float-icon lavender">${icon('spark')}</span><div><h2>学习中遇到疑问？</h2><p>AI 会参考《${escape(meta.title)}》的讲解与最近对话，帮你理解概念和练习思路。</p></div></div>
    <div class="chat-history" aria-label="本课答疑记录">${messages.length ? messages.map(message => `<div class="chat-message ${message.role === 'user' ? 'from-user' : 'from-ai'}"><strong>${message.role === 'user' ? '你' : 'AI 学习助手'}</strong><p>${escape(message.content)}</p></div>`).join('') : '<p class="chat-empty">例如：“这一步为什么这样做？”或“能再举一个例子吗？”</p>'}</div>
    ${status.mode === 'ai' ? `<form id="lesson-ask-form" data-id="${meta.id}"><label class="sr-only" for="lesson-question">向 AI 提问</label><textarea id="lesson-question" name="question" required maxlength="1000" placeholder="输入你对本课的疑问…"></textarea><div class="chat-compose"><small>对话保存在${desktop ? '本机' : '当前浏览器'}，回答可能有误，请结合课程核对。</small><button class="btn primary" type="submit">发送问题 ${icon('arrow')}</button></div></form>` : `<div class="notice">先在设置中连接 AI 模型，即可就本课内容提问。</div>`}
    <p id="lesson-ask-error" class="inline-error" role="alert"></p></section>`;
}
function quiz(meta, lesson) {
  const record = progress(meta.id);
  return `<div class="quiz-intro"><h2>让理解，在练习中发生。</h2><p>共 ${lesson.questions.length} 道单选题，全部答对即可掌握本课。可以反复练习。</p></div><form id="quiz-form" data-id="${meta.id}">${lesson.questions.map((q, i) => `<fieldset class="question"><legend><span>${String(i + 1).padStart(2, '0')}</span>${escape(q.prompt)}</legend>${q.options.map((o, j) => `<label class="quiz-option"><input type="radio" name="q${i}" value="${j}" required><span class="option-letter">${String.fromCharCode(65 + j)}</span><span>${escape(o)}</span></label>`).join('')}</fieldset>`).join('')}<button class="btn primary" type="submit">提交并查看解析 ${icon('check')}</button></form>${record.lastAnswers?.length === lesson.questions.length ? `<section class="quiz-result ${record.lastScore === 100 ? 'passed' : ''}" aria-live="polite"><h3>${record.lastScore === 100 ? '做得好，本课已掌握！' : '发现盲点，就是进步的开始。'}<span>${record.lastScore} 分</span></h3><p>上次提交 · 已练习 ${record.attempts} 次 · 最高 ${record.bestScore} 分</p>${lesson.questions.map((q, i) => `<div class="answer-review"><strong>${record.lastAnswers[i] === q.answer ? '✓ 回答正确' : '↻ 再想一想'} · 第 ${i + 1} 题</strong><p>你的答案：${escape(q.options[record.lastAnswers[i]])}<br>正确答案：${escape(q.options[q.answer])}</p><p>${escape(q.explanation)}</p></div>`).join('')}${record.completed ? button('整理本课知识', 'notes-tab', 'primary', '', 'brain') : `<p>结合解析回到上方重新作答，或切换到学习内容复习。</p>`}</section>` : ''}`;
}
function practice() {
  const p = plan(), reviewed = p.lessons.filter(l => progress(l.id).attempts), weak = reviewed.filter(l => progress(l.id).lastScore < 100);
  return `<section class="page-intro"><div><div class="eyebrow">LEARN BY DOING</div><h1>练过，才真正属于你。</h1><p>从错题中发现盲点，在回顾中巩固理解。</p></div>${pill('当前路线 · ' + p.lessons.length + ' 节', 'purple')}</section><div class="practice-banner"><div class="float-icon peach">${icon('bolt')}</div><div><h2>${weak.length ? `${weak.length} 节课程值得再练一次` : reviewed.length ? '保持手感，继续巩固' : '从你的第一次练习开始'}</h2><p>${weak.length ? '根据最近一次测验，优先回顾这些课程。' : '先学习一小段，再用问题检验理解。每次提交都会保留进度。'}</p></div></div><div class="practice-grid">${[...weak, ...p.lessons.filter(l => !weak.includes(l))].map(l => { const r = progress(l.id); return `<article class="practice-card"><div class="practice-card-top"><span class="float-icon ${r.completed ? 'green' : 'lavender'}">${icon(r.completed ? 'check' : 'bolt')}</span>${pill(r.attempts ? `最近 ${r.lastScore} 分` : '尚未练习', r.completed ? 'success' : '')}</div><h3>${escape(l.title)}</h3><p>${escape(l.objective)}</p><div class="practice-card-bottom"><small>${r.attempts || 0} 次练习${r.attempts ? ` · 最高 ${r.bestScore} 分` : ''}</small>${button(r.attempts ? '再次练习' : '去练习', 'open-quiz', 'secondary', `data-id="${l.id}"`, 'arrow')}</div></article>`; }).join('')}</div>`;
}
function wiki() {
  if (activeNote) {
    const n = state.notes.find(n => n.id === activeNote); if (n) return noteEditor(n); activeNote = null;
  }
  const filtered = state.notes.filter(n => `${n.title} ${n.content} ${n.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return `<section class="page-intro"><div><div class="eyebrow">YOUR PERSONAL KNOWLEDGE GARDEN</div><h1>把所学，连成自己的世界。</h1><p>积累不只是收藏。让每个概念，都能被再次找到和使用。</p></div>${button('导出知识库', 'export-wiki', 'secondary', state.notes.length ? '' : 'disabled', 'export')}</section><section class="wiki-banner"><div><span class="eyebrow">MY SECOND BRAIN</span><h2>你的第二大脑，从 ${state.notes.length} 张卡片生长。</h2><p>课程要点、实践经验、个人思考，都在这里相遇。</p></div>${icon('brain')}</section><div class="wiki-toolbar"><label class="search-field">${icon('search')}<input id="wiki-search" type="search" placeholder="搜索标题、正文或标签…" value="${escape(query)}" aria-label="搜索知识库"></label><span>共 ${state.notes.length} 张卡片</span></div><div class="wiki-layout"><section id="note-results">${noteList(filtered)}</section><aside class="ask-panel"><div class="ask-heading">${icon('spark')}和你的知识对话</div><p>${status.mode === 'ai' ? 'AI 会阅读你的笔记，基于已有内容回答，并列出引用。' : '示例模式可检索相关笔记；接入云端或本地 LLM 后可基于知识库问答。'}</p><form id="ask-form"><label class="sr-only" for="wiki-question">向知识库提问</label><textarea id="wiki-question" name="question" required maxlength="1000" placeholder="例如：变量和字符串有什么区别？" ${state.notes.length ? '' : 'disabled'}></textarea><button type="submit" class="btn primary full" ${state.notes.length ? '' : 'disabled'}>${status.mode === 'ai' ? '向知识库提问' : '检索相关笔记'} ${icon('arrow')}</button></form><div id="wiki-answer" aria-live="polite">${answerHTML()}</div><div class="ask-footnote">${icon('book')}${state.notes.length ? '回答依据来自你保存的知识卡片。' : '完成一节课并生成卡片后，即可开始。'}</div></aside></div>`;
}
function noteList(notes) {
  return notes.length ? `<div class="note-grid">${notes.map(n => `<button class="wiki-card" data-action="open-note" data-id="${n.id}"><div class="wiki-card-top"><span class="note-glyph">${icon('book')}</span><small>${date(n.updated)}</small></div><h3>${escape(n.title)}</h3><p>${escape(n.summary)}</p><div class="tags">${n.tags.map(t => pill(t)).join('')}</div><div class="wiki-card-bottom">来自课程学习 ${icon('arrow')}</div></button>`).join('')}</div>` : `<div class="empty-state"><div class="empty-icon">${icon(query ? 'search' : 'leaf')}</div><h3>${query ? '还没有找到匹配的知识' : '给未来的自己，留下一份收获。'}</h3><p>${query ? '试试更短的关键词，或搜索一个知识标签。' : '学完一节课、完成练习，就能生成你的第一张知识卡片。'}</p>${query ? '' : button('开始学习', 'start', 'primary')}</div>`;
}
function answerHTML() {
  if (!answer) return '';
  return `<div class="grounded-answer"><strong>${answer.demo ? '关键词检索结果' : '基于你的知识库'}</strong><p>${escape(answer.answer)}</p>${answer.citations.map(id => { const n = state.notes.find(n => n.id === id); return n ? `<button class="citation" data-action="open-note" data-id="${id}">${icon('book')}${escape(n.title)}</button>` : ''; }).join('')}</div>`;
}
function noteEditor(n) {
  const related = state.notes.filter(o => o.id !== n.id && o.tags.some(t => n.tags.includes(t))).slice(0, 5);
  return `<div class="study-top"><button class="text-button" data-action="close-note">${icon('back')}全部知识卡片</button>${pill(n.source === 'ai' ? 'AI 整理 · 可编辑' : '课程要点整理', 'purple')}</div><div class="note-editor-layout"><form id="note-form" data-id="${n.id}" class="note-editor"><div class="eyebrow">A NOTE TO YOUR FUTURE SELF</div><label for="note-title">标题</label><input id="note-title" name="title" value="${escape(n.title)}" maxlength="160" required><label for="note-summary">一句话摘要</label><textarea id="note-summary" name="summary" maxlength="500" required>${escape(n.summary)}</textarea><label for="note-content">知识正文</label><textarea id="note-content" class="note-body" name="content" maxlength="20000" required>${escape(n.content)}</textarea><label for="note-tags">标签 <small>用中文或英文逗号分隔，最多 6 个</small></label><input id="note-tags" name="tags" value="${escape(n.tags.join('，'))}" maxlength="200" required><div class="editor-actions"><button class="btn primary" type="submit">保存修改 ${icon('check')}</button>${button('导出 Markdown', 'export-note', 'secondary', `data-id="${n.id}"`, 'export')}</div><p class="field-hint">修改后请保存；导出的是已保存版本。</p></form><aside class="tip-card"><h3>知识的来处</h3><p>${escape(n.courseTitle)}</p><small>更新于 ${date(n.updated)}</small>${button('回到来源课程', 'source-lesson', 'secondary full', `data-id="${n.lessonId}"`, 'book')}<hr><h3>关联知识</h3><p>依据共同标签连接。</p>${related.length ? related.map(r => `<button class="citation" data-action="open-note" data-id="${r.id}">${icon('book')}${escape(r.title)}</button>`).join('') : '<p>继续积累，相似主题的卡片会在这里相遇。</p>'}</aside></div>`;
}
function settings() {
  if (desktop) return desktopSettingsPage();
  const configuration = `LLM_PROVIDER=${status.provider || 'ollama'}\nLLM_MODEL=${status.model || '填写模型名称'}\nLLM_API_KEY=云端密钥或留空\nLLM_BASE_URL=使用预设时可留空`;
  return `<section class="page-intro"><div><div class="eyebrow">MAKE IT YOUR OWN</div><h1>你的空间，由你掌握。</h1><p>连接国产云端或本地模型，让学习更个性化。</p></div></section>
  <div class="settings-grid"><section class="panel"><span class="float-icon lavender">${icon('spark')}</span><h2>AI 连接</h2>
  ${pill(status.mode === 'ai' ? (status.providerLabel || 'AI') + ' · ' + status.model : status.mode === 'error' ? '模型配置需检查' : status.mode === 'offline' ? '应用服务未连接' : '未配置模型 · 示例体验', 'purple')}
  ${status.configurationError ? `<div class="notice error">${escape(status.configurationError)}</div>` : ''}
  <p>支持 DeepSeek、通义千问，以及 Ollama、LM Studio、vLLM 本地服务；其他兼容接口使用 compatible。复制项目中的 .env.example 为 .env，填写配置后重启服务。</p>
  <pre class="config-example">${escape(configuration)}</pre>
  <p>云端服务填写 API Key，本地服务按需填写。密钥仅由服务端读取，不会显示在页面或保存在浏览器。接口地址与详细示例见 README。</p>
  ${button('测试模型连接', 'test-connection', 'primary full', status.mode === 'ai' ? '' : 'disabled', 'bolt')}
  <div id="connection-result" class="notice" role="status" aria-live="polite">${escape(connectionResult || '尚未测试。“已配置”不代表连接成功。')}</div>
  <p class="field-hint">测试会发送一条固定短提示，验证鉴权和 JSON 输出，不发送学习笔记。云端按服务商规则计费。生成课程、整理 Wiki 和问答时，相关内容会发送给当前配置的模型服务。</p></section>
  <section class="panel"><span class="float-icon green">${icon('brain')}</span><h2>我的学习数据</h2><p>路线、测验成绩、学习心得与知识卡片保存在当前浏览器。清除网站数据会丢失记录，建议定期导出。</p><div class="data-counts"><strong>${state.plans.length}<span>条路线</span></strong><strong>${state.notes.length}<span>张卡片</span></strong></div>${button('导出完整 JSON 备份', 'export-data', 'secondary full', '', 'export')}${button('导出 Wiki Markdown', 'export-wiki', 'secondary full', state.notes.length ? '' : 'disabled', 'export')}<p class="field-hint">JSON 备份用于存档；当前版本尚不支持导入。</p></section></div>`;
}

function desktopSettingsPage() {
  const cfg = desktopSettings || { provider: 'ollama', model: '', baseUrl: '', jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192, localOnly: true };
  const providers = [['ollama', 'Ollama · 本地'], ['lmstudio', 'LM Studio · 本地'], ['vllm', 'vLLM · 自部署'], ['deepseek', 'DeepSeek · 云端'], ['qwen', '通义千问 · 云端'], ['compatible', '自定义兼容接口']];
  return `<section class="page-intro"><div><div class="eyebrow">YOUR LOCAL LEARNING SPACE</div><h1>你的空间，保存在你的电脑。</h1><p>在这里配置模型，保存后立即生效，无需编辑文件或重启应用。</p></div>${pill('桌面版 · 本地存储', 'success')}</section>
  <div class="settings-grid"><section class="panel"><h2>模型设置</h2>${pill(status.mode === 'ai' ? (status.providerLabel || 'AI') + ' · ' + status.model : '尚未配置可用模型', 'purple')}
  ${cfg.error ? `<div class="notice error">${escape(cfg.error)}</div>` : ''}
  <form id="desktop-settings-form" class="desktop-form">
    <label for="model-provider">模型服务</label><select id="model-provider" name="provider">${providers.map(([id, label]) => `<option value="${id}" ${cfg.provider === id ? 'selected' : ''}>${label}</option>`).join('')}</select>
    <label for="model-name">模型名称</label><input id="model-name" name="model" maxlength="200" value="${escape(cfg.model)}" placeholder="本地已安装的模型名，或服务商的模型 ID">
    <label for="model-url">接口根地址 <small>留空使用服务预设</small></label><input id="model-url" name="baseUrl" maxlength="2000" value="${escape(cfg.baseUrl)}" placeholder="例如 http://127.0.0.1:11434">
    <label class="check-label"><input type="checkbox" name="localOnly" ${cfg.localOnly ? 'checked' : ''}>仅使用本机模型（禁止云端与局域网地址）</label>
    <p class="field-hint">开启时只允许本机地址。模型需先在 Ollama、LM Studio 等服务中安装并启动。关闭后，课程与笔记可能发送到配置的远端服务。</p>
    <label for="key-action">API Key</label><select id="key-action" name="keyAction"><option value="keep">${cfg.hasApiKey ? '保留已保存的密钥' : '不填写密钥（本地服务）'}</option><option value="replace">设置 / 更换密钥</option><option value="clear">清除已保存的密钥</option></select>
    <input id="model-key" name="apiKey" type="password" autocomplete="new-password" maxlength="4096" aria-label="新的 API Key" placeholder="仅在设置 / 更换密钥时填写，不回显旧密钥">
    <p class="field-hint">密钥通过系统安全存储加密保存在本机，不写入学习备份。更换服务或地址时不会自动沿用旧密钥。</p>
    <div class="form-row"><div><label for="json-mode">JSON 模式</label><select id="json-mode" name="jsonMode">${[['auto','自动'],['on','开启'],['off','仅提示词']].map(([v,l]) => `<option value="${v}" ${cfg.jsonMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div><label for="model-timeout">超时（秒）</label><input id="model-timeout" type="number" name="timeout" min="1" max="600" required value="${cfg.timeoutMs / 1000}"></div><div><label for="model-tokens">输出上限</label><input id="model-tokens" type="number" name="maxTokens" min="128" max="32768" required value="${cfg.maxTokens}"></div></div>
    <p id="settings-error" class="inline-error" role="alert"></p><div id="remote-permission" hidden class="notice"><p>此操作会关闭“仅使用本机模型”。配置仍保存在本机；使用 AI 时，相关内容将发送到你配置的远端服务。</p><button type="button" class="btn secondary full" data-action="allow-remote-save">允许远端连接并保存</button></div><button type="submit" class="btn primary full" ${cfg.error ? 'disabled' : ''}>保存模型配置 ${icon('check')}</button>
  </form>
  ${button('测试已保存的模型连接', 'test-connection', 'secondary full', status.mode === 'ai' ? '' : 'disabled', 'bolt')}
  <div id="connection-result" class="notice" role="status">${escape(connectionResult || '保存后可测试连接；“已配置”不代表模型已启动。')}</div><p class="field-hint">连接测试只发送固定短提示。使用云端服务时会按服务商规则计费。</p>
  </section><section class="panel"><span class="float-icon green">${icon('brain')}</span><h2>本地学习数据</h2><p>学习路线、课程、练习成绩与 Wiki 自动保存到本机文件。关闭应用后，下次打开会继续加载。</p>
  <label>数据目录</label><pre class="config-example">${escape(dataDirectory)}</pre>${button('打开本地数据目录', 'open-data', 'secondary full', '', 'book')}
  <div class="data-counts"><strong>${state.plans.length}<span>条路线</span></strong><strong>${state.notes.length}<span>张卡片</span></strong></div>
  ${button('导出完整 JSON 备份', 'export-data', 'secondary full', '', 'export')}
  ${button('导入学习备份', 'import-data', 'secondary full', '', 'plus')}
  ${button('导出 Wiki Markdown', 'export-wiki', 'secondary full', state.notes.length ? '' : 'disabled', 'export')}
  <p class="field-hint">可导入网页版导出的 JSON 备份。导入前会确认替换；上一个版本保留为 .bak 文件。学习数据不包含模型配置或密钥。</p></section></div>`;
}

function planner() {
  $('#planner').innerHTML = `<div class="modal-heading"><span class="float-icon lavender">${icon('spark')}</span><button class="icon-button" data-action="close-planner" aria-label="关闭">${icon('close')}</button></div><div class="eyebrow">START WITH CURIOSITY</div><h2 id="planner-title">你想学会什么？</h2><p>给自己一个目标，剩下的路，我们一起规划。</p><form id="plan-form"><label for="goal">我的学习目标</label><textarea id="goal" name="goal" maxlength="1000" required placeholder="例如：我想学 Python，在两周内做出一个自动整理文件的小工具。"></textarea><div class="form-row"><div><label for="level">目前的基础</label><select id="level" name="level"><option>零基础</option><option>有一点基础</option><option>希望进阶</option></select></div><div><label for="daily">每天投入</label><select id="daily" name="daily"><option value="15">15 分钟</option><option value="25" selected>25 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option></select></div><div><label for="days">计划周期</label><select id="days" name="days"><option value="7">1 周</option><option value="14" selected>2 周</option><option value="30">1 个月</option><option value="90">3 个月</option></select></div></div>${status.mode !== 'ai' ? '<div class="notice">当前未配置 AI。你可以先体验完整的 Python 示例课程；自定义路线需配置云端或本地模型。</div>' : '<div class="notice">AI 会根据目标与可投入时间规划课程，生成可能需要一两分钟。</div>'}<p id="plan-error" class="inline-error" role="alert"></p><button class="btn primary full" type="submit" ${status.mode !== 'ai' ? 'disabled' : ''}>生成我的学习路线 ${icon('spark')}</button>${status.mode !== 'ai' ? button('体验 Python 示例课程', 'demo', 'secondary full', '', 'arrow') : ''}</form>`;
  $('#planner').showModal();
}
async function openLesson(id, tab = 'read') {
  if (desktop) {
    await pendingSave;
    const detail = await desktop.getLesson(id);
    state.lessons = detail.lesson ? { [id]: detail.lesson } : {};
    state.blockCourses = detail.blockCourse ? { [id]: detail.blockCourse } : {};
    state.reflections = { [id]: detail.reflection };
    state.chats = { [id]: detail.chats };
  }
  activeLesson = id; lessonTab = tab; navigate('study');
}
async function createNote(id) {
  const existing = state.notes.find(n => n.lessonId === id);
  if (existing) { activeNote = existing.id; navigate('wiki'); return; }
  if (!progress(id).completed) throw new Error('请先通过本课随堂练习。');
  const meta = lessonById(id), lesson = contentFor(id), p = state.plans.find(p => p.lessons.some(l => l.id === id));
  const reflection = state.reflections[id] || '';
  let result;
  if (p.source === 'ai') result = await api('wiki', { title: meta.title, lesson, reflection });
  else result = { summary: lesson.takeaways[0], content: `核心概念\n\n${lesson.takeaways.map(t => '• ' + t).join('\n')}\n\n详细解释\n\n${lesson.sections.map(s => s.heading + '\n' + s.body).join('\n\n')}\n\n具体示例\n\n${lesson.example}\n\n实践任务\n\n${lesson.challenge}\n\n易错点与解析\n\n${lesson.questions.map(q => q.prompt + '\n' + q.explanation).join('\n\n')}\n\n我的心得（个人记录，未经核验）\n\n${reflection || '还没有记录心得，可在这里补充。'}` };
  if (state.notes.some(n => n.lessonId === id)) return;
  const n = { id: crypto.randomUUID(), lessonId: id, courseTitle: p.title, title: meta.title, tags: [...meta.tags], source: p.source, updated: Date.now(), ...result };
  state.notes.push(n); persist('saveNote', n); activeNote = n.id; navigate('wiki'); toast('已生成知识卡片，可以继续补充你的理解。');
}
async function download(name, content, type) {
  if (desktop) { await pendingSave; const saved = await desktop.exportFile(name, content); if (saved) toast('文件已导出。'); return; }
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function markdown(n) { return `# ${n.title}\n\n> ${n.summary}\n\n标签：${n.tags.join('、')}\n\n来源课程：${n.courseTitle}\n\n${n.content}\n`; }
async function action(name, element) {
  const id = element.dataset.id;
  if (name === 'allow-remote-save' && desktop) {
    const form = $('#desktop-settings-form');
    if (!form || $('#remote-permission').hidden) return;
    form.elements.localOnly.checked = false;
    $('#remote-permission').hidden = true;
    form.requestSubmit();
    return;
  }
  if (name === 'open-data' && desktop) return desktop.openDataFolder();
  if (name === 'import-data' && desktop) {
    await pendingSave;
    const imported = await desktop.importBackup();
    if (imported) { state = imported; activeNote = null; activeLesson = null; navigate('home'); toast('学习备份已导入。'); }
    return;
  }
  if (name === 'test-connection') {
    connectionResult = '正在测试模型的 JSON 输出能力…';
    if ($('#connection-result')) $('#connection-result').textContent = connectionResult;
    try {
      const result = await api('test-connection', {});
      connectionResult = `连接成功：${result.provider} / ${result.model}，耗时 ${(result.latencyMs / 1000).toFixed(1)} 秒。已验证 JSON 输出；具体课程质量仍取决于模型。`;
    } catch (e) { connectionResult = e.message; }
    if ($('#connection-result')) $('#connection-result').textContent = connectionResult;
    return;
  }
  if (name === 'planner') return planner();
  if (name === 'close-planner') return $('#planner').close();
  if (['routes', 'practice'].includes(name)) return navigate(name);
  if (name === 'start') return openLesson(nextLesson().id);
  if (name === 'demo') { $('#planner').close(); state.active = demoPlan.id; persist('setActivePlan', demoPlan.id); return navigate('routes'); }
  if (name === 'switch-plan') { state.active = id; activeLesson = null; persist('setActivePlan', id); return render(); }
  if (name === 'open-lesson') return openLesson(id);
  if (name === 'open-quiz') return openLesson(id, 'quiz');
  if (name === 'lesson-tab') { lessonTab = element.dataset.tab; return render(); }
  if (name === 'quiz' || name === 'notes-tab' || name === 'read-tab') { lessonTab = name === 'quiz' ? 'quiz' : name === 'read-tab' ? 'read' : 'notes'; render(); return; }
  if (name === 'generate-lesson') {
    const meta = lessonById(id), p = state.plans.find(p => p.lessons.some(l => l.id === id));
    const outline = await api('lesson-outline', { goal: p.goal, level: p.level, title: meta.title, objective: meta.objective });
    if (!validOutline(outline)) throw new Error('模型返回的大纲格式不正确，请重试。');
    const course = desktop ? await desktop.saveOutline(id, outline) : { intro: outline.intro, blocks: outline.blocks.map(block => ({ id: crypto.randomUUID(), ...block, content: null })) };
    state.blockCourses ||= {}; state.blockCourses[id] = course; if (!desktop) save(); render(); return;
  }
  if (name === 'generate-block') {
    const block = state.blockCourses?.[id]?.blocks.find(item => item.id === element.dataset.block);
    if (!block || block.content) throw new Error('内容块不存在或已生成。');
    const meta = lessonById(id), p = state.plans.find(plan => plan.lessons.some(item => item.id === id));
    const content = await api('lesson-block', { goal: p.goal, level: p.level, title: meta.title, objective: meta.objective, intro: state.blockCourses[id].intro, block: { type: block.type, title: block.title, objective: block.objective } });
    if (!validBlockContent(block.type, content)) throw new Error('模型返回的内容格式不正确，请重试。');
    if (desktop) await desktop.saveBlock(id, block.id, content);
    block.content = content;
    if (block.type === 'quiz' && state.progress[id]) state.progress[id] = { ...state.progress[id], completed: false, lastScore: 0, lastAnswers: [] };
    if (!desktop) save(); render(); return;
  }
  if (name === 'create-note') return createNote(id);
  if (name === 'open-note') { activeNote = id; return navigate('wiki'); }
  if (name === 'close-note') { activeNote = null; return render(); }
  if (name === 'source-lesson') { const p = state.plans.find(p => p.lessons.some(l => l.id === id)); if (p) { state.active = p.id; persist('setActivePlan', p.id); return openLesson(id); } }
  if (name === 'export-data') { if (desktop) { await pendingSave; if (await desktop.exportBackup()) toast('完整学习备份已导出。'); return; } return download('learnflow-backup.json', JSON.stringify(state, null, 2), 'application/json'); }
  if (name === 'export-wiki') return download('我的知识库.md', state.notes.map(markdown).join('\n---\n\n'), 'text/markdown;charset=utf-8');
  if (name === 'export-note') { const n = state.notes.find(n => n.id === id); return download(n.title.replace(/[<>:"/\\|?*]/g, '-') + '.md', markdown(n), 'text/markdown;charset=utf-8'); }
}
document.addEventListener('click', async event => {
  const element = event.target.closest('[data-page], [data-action]'); if (!element || element.disabled) return;
  event.preventDefault();
  if (element.dataset.page) { activeNote = null; return element.dataset.page === 'study' ? openLesson(activeLesson || nextLesson().id, lessonTab) : navigate(element.dataset.page); }
  const loading = ['generate-lesson', 'generate-block', 'create-note', 'test-connection'].includes(element.dataset.action);
  const html = element.innerHTML;
  try { if (loading) { element.disabled = true; element.innerHTML = '<span class="spinner"></span>正在整理，请稍候…'; } await action(element.dataset.action, element); }
  catch (e) { toast(e.message); }
  finally { if (loading && element.isConnected) { element.disabled = false; element.innerHTML = html; } }
});
document.addEventListener('input', event => {
  if (desktop && event.target.closest?.('#desktop-settings-form')) {
    $('#settings-error').textContent = '';
    $('#remote-permission').hidden = true;
    if (event.target.id === 'model-key' && event.target.value.trim()) $('#key-action').value = 'replace';
    connectionResult = '配置尚未保存，请保存后再测试连接。';
    if ($('#connection-result')) $('#connection-result').textContent = connectionResult;
    const test = $('[data-action="test-connection"]'); if (test) test.disabled = true;
  }
  if (event.target.dataset.reflection) { state.reflections[event.target.dataset.reflection] = event.target.value; persist('saveReflection', event.target.dataset.reflection, event.target.value); }
  if (event.target.id === 'wiki-search') { query = event.target.value; $('#note-results').innerHTML = noteList(state.notes.filter(n => `${n.title} ${n.content} ${n.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()))); }
});
document.addEventListener('change', event => {
  if (desktop && event.target.id === 'model-provider') {
    $('#model-url').value = ''; $('#model-name').value = ''; $('#model-key').value = ''; $('#key-action').value = ['deepseek', 'qwen'].includes(event.target.value) ? 'replace' : 'clear';
    $('#settings-error').textContent = '';
    $('#remote-permission').hidden = true;
    $('#connection-result').textContent = '已切换服务，请填写模型名称并保存。';
    $('[data-action="test-connection"]').disabled = true;
  }
  if (desktop && event.target.id === 'key-action' && event.target.value !== 'replace') $('#model-key').value = '';
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const values = new FormData(form); const submit = form.querySelector('button[type="submit"]');
  const label = submit.innerHTML; submit.disabled = true;
  try {
    if (form.id === 'desktop-settings-form' && desktop) {
      $('#settings-error').textContent = '';
      $('#remote-permission').hidden = true;
      const testButton = $('[data-action="test-connection"]');
      if (testButton) testButton.disabled = true;
      submit.innerHTML = '<span class="spinner"></span>正在保存到本机…';
      const result = await desktop.saveSettings({
        provider: values.get('provider'), model: values.get('model'), baseUrl: values.get('baseUrl'),
        keyAction: values.get('keyAction'), apiKey: values.get('apiKey'), localOnly: values.get('localOnly') === 'on',
        jsonMode: values.get('jsonMode'), timeoutMs: Number(values.get('timeout')) * 1000, maxTokens: Number(values.get('maxTokens'))
      });
      if (result.requiresRemotePermission) {
        $('#settings-error').textContent = result.error;
        $('#remote-permission').hidden = false;
        $('#remote-permission').scrollIntoView({ behavior: 'smooth', block: 'center' });
        connectionResult = '当前配置未保存：请允许远端连接，或改用本机模型地址。';
        $('#connection-result').textContent = connectionResult;
        return;
      }
      desktopSettings = result.settings; status = result.status; connectionResult = '配置已保存并生效，可测试模型连接。';
      render(); toast('模型配置已保存在本机。');
    } else if (form.id === 'plan-form') {
      $('#plan-error').textContent = ''; submit.innerHTML = '<span class="spinner"></span>正在规划学习路线…';
      const p = await api('plan', { goal: values.get('goal').trim(), level: values.get('level'), daily: Number(values.get('daily')), days: Number(values.get('days')) });
      state.plans.push(p); state.active = p.id; persist('savePlan', p); $('#planner').close(); navigate('routes'); toast('学习路线已生成，从第一步开始吧。');
    } else if (form.id === 'append-block-form') {
      const id = form.dataset.id, spec = { type: values.get('type'), title: values.get('title')?.trim(), objective: values.get('objective')?.trim() };
      if (!validBlockSpec(spec) || !state.blockCourses?.[id]) throw new Error('请填写有效的内容类型、标题和学习目标。');
      const block = desktop ? await desktop.appendBlock(id, spec) : { id: crypto.randomUUID(), ...spec, content: null };
      state.blockCourses[id].blocks.push(block); if (!desktop) save(); render(); toast('内容块已加入课程，可单独生成。');
    } else if (form.id === 'quiz-form') {
      const id = form.dataset.id, lesson = contentFor(id), answers = lesson.questions.map((q, i) => Number(values.get('q' + i)));
      const correct = lesson.questions.filter((q, i) => q.answer === answers[i]).length;
      const score = Math.round(correct / lesson.questions.length * 100), previous = progress(id);
      state.progress[id] = { ...previous, attempts: (previous.attempts || 0) + 1, lastScore: score, bestScore: Math.max(previous.bestScore || 0, score), lastAnswers: answers, completed: previous.completed || correct === lesson.questions.length, updated: Date.now() };
      persist('saveProgress', id, state.progress[id]); render(); $('.quiz-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (form.id === 'lesson-ask-form') {
      const id = form.dataset.id, meta = lessonById(id), lesson = contentFor(id), question = values.get('question')?.trim();
      if (status.mode !== 'ai' || !meta || !lesson || !question || question.length > 1000) throw new Error('请先连接 AI 模型，并输入本课问题。');
      submit.innerHTML = '<span class="spinner"></span>AI 正在回答…';
      const history = chatFor(id);
      const reply = await api('lesson-ask', { title: meta.title, objective: meta.objective, lesson, question, history: history.slice(-12) });
      state.chats ||= {};
      state.chats[id] = [...history, { role: 'user', content: question }, { role: 'assistant', content: reply.answer }].slice(-20);
      persist('appendChat', id, question, reply.answer);
      if (page === 'study' && activeLesson === id && lessonTab === 'chat') { render(); $('.chat-history')?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }
    } else if (form.id === 'note-form') {
      const n = state.notes.find(n => n.id === form.dataset.id), title = values.get('title').trim(), summary = values.get('summary').trim(), content = values.get('content').trim();
      const tags = [...new Set(values.get('tags').split(/[,，]/).map(t => t.trim()).filter(Boolean))].slice(0, 6);
      if (!title || !summary || !content || !tags.length) throw new Error('请填写标题、摘要、正文和至少一个标签。');
      Object.assign(n, { title, summary, content, tags, updated: Date.now() }); persist('saveNote', n); toast('知识卡片已保存。');
    } else if (form.id === 'ask-form') {
      submit.innerHTML = '<span class="spinner"></span>正在阅读你的知识…'; const question = values.get('question').trim();
      if (!question) throw new Error('请输入问题。');
      if (status.mode === 'ai') { answer = await api('ask', { question, notes: state.notes.slice(-30).map(({ id, title, content }) => ({ id, title, content })) }); if (state.notes.length > 30) answer.answer += '\n\n本次仅参考最近 30 张卡片。'; }
      else {
        const terms = question.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]{2}/g) || [question.toLowerCase()];
        const ranked = state.notes.map(n => ({ n, score: terms.filter(t => `${n.title} ${n.content} ${n.tags.join(' ')}`.toLowerCase().includes(t)).length })).filter(v => v.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
        answer = { demo: true, answer: ranked.length ? '找到以下相关笔记。点击查看原文；当前结果为关键词匹配，并非 AI 回答。' : '未找到相关笔记。试试“变量”“函数”等更具体的关键词。', citations: ranked.map(v => v.n.id) };
      }
      if ($('#wiki-answer')) $('#wiki-answer').innerHTML = answerHTML();
    }
  } catch (e) { if (form.id === 'desktop-settings-form' && $('#settings-error')) $('#settings-error').textContent = e.message; else if (form.id === 'plan-form' && $('#plan-error')) $('#plan-error').textContent = e.message; else if (form.id === 'lesson-ask-form' && $('#lesson-ask-error')) $('#lesson-ask-error').textContent = e.message; else toast(e.message); }
  finally { if (submit.isConnected) { submit.disabled = form.id === 'plan-form' && status.mode !== 'ai'; submit.innerHTML = label; } }
});
if (desktop) {
  $('#app').innerHTML = '<div class="empty-state"><h2>正在读取本地数据…</h2></div>';
  desktop.load().then(result => {
    if (result.state) state = result.state;
    desktopSettings = result.settings; dataDirectory = result.dataDirectory; status = result.status;
    if (result.startPage === 'settings') page = 'settings';
    storageWarning = result.stateError || ''; render();
  }).catch(error => {
    storageWarning = '桌面数据读取失败，当前会话不会覆盖本地记录：' + error.message;
    status = { mode: 'offline' }; render();
  });
} else {
  render();
  fetch('/api/status').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(s => { status = s; render(); }).catch(() => { status = { mode: 'offline' }; render(); });
}
