import { demoPlan, demoLessons } from './demo.js';
import { lessonFromBlocks, validOutline, validBlockContent, validBlockSpec, blockGenerationContext, revisedContent, restoredContent, assistedBlockTypes } from './blocks.js';
import { Marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
import { createMarkdownRenderer } from './markdown.js';
import { validQuestionnaire, validClarification, learningBriefFrom } from './planning.js';
import { validIllustration, validImageProposal } from './illustrations.js';
import { speechDefaults, speechVoices, listeningText, speechTurns, speechRequest, validAudioId } from './speech.js';
import { validKnowledgeSource, validKnowledgeDraft, localKnowledgeDraft, knowledgeTags, knowledgeConditions } from './knowledge-draft.js';
import { validAnnotations, personalNotesForSource, personalNotesMarkdown } from './annotations.js';
import { knowledgeCatalog, knowledgeDomain, knowledgeDomainColors, knowledgeTopic, retrieveKnowledge, validKnowledgeOrganization } from './knowledge-index.js';
import { courseKnowledgeTree, knowledgeGraph, filterKnowledgeGraph } from './knowledge-views.js';
import { createGraphMotion, stepGraphMotion } from './graph-motion.js';

const renderMarkdown = createMarkdownRenderer(Marked, DOMPurify);

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
  speaker: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12"/>',
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
const fresh = () => ({ version: 1, plans: [structuredClone(demoPlan)], active: demoPlan.id, lessons: {}, blockCourses: {}, progress: {}, notes: [], reflections: {}, annotations: {}, chats: {} });
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
state.annotations ||= {};
let page = 'home', activeLesson = null, activeNote = null, lessonTab = 'read', query = '', topicFilter = '', answer = null;
let knowledgeView = 'tree', selectedGraphId = '', hoveredGraphId = '', suppressedGraphHoverId = '', graphViewport = null;
let graphDrag = null;
const folderOverrides = new Map();
let graphMotion = null, graphFrame = 0, pendingGraph = null, graphPositions = new Map();
let graphPaused = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
let graphTagFilter = '', graphStatusFilter = '', graphTypeFilter = 'all', graphRelationFilter = 'all', graphOrphansOnly = false, graphLocalTwoHop = false, graphSpacing = 1;
let readingReturn = null;
let syllabusCollapsed = false, annotationDraft = null, pendingAnnotationAnchor = null;
const collapsedBlocks = new Set();
let status = { mode: 'loading' };
let connectionResult = '';
let revisionBusy = false;
let imageSettings = null, imageConnectionResult = '', illustrationBusy = false, illustrationDraft = null;
let webSearchSettings = null, webSearchSaveResult = '';
let speechSettings = null, speechConnectionResult = '', speechBusy = false, speechDraft = null, speechPlaylist = [];
let knowledgeDraft = null, knowledgeBusy = false;
let knowledgeOrganize = null, knowledgeOrganizeBusy = false;
const knowledgeOrganizeUndo = new Map();
// Unsaved configuration stays in memory only, including newly typed keys.
const modelFormDrafts = new Map();
const modelServiceDrafts = new Map();
const modelFormIds = ['desktop-settings-form', 'image-settings-form', 'speech-settings-form', 'web-search-settings-form'];
let modelSettingsSaving = false;
function rememberModelDrafts(changedId) {
  if (!desktop || page !== 'settings') return;
  for (const id of modelFormIds) {
    if (id !== changedId && !modelFormDrafts.has(id)) continue;
    const form = $('#' + id);
    if (!form?.elements) continue;
    const fields = Array.from(form.elements).filter(field => field.name).map(field => ({ name: field.name, value: field.value, checked: field.checked }));
    modelFormDrafts.set(id, { fields, advancedOpen: !!form.querySelector('.model-advanced')?.open });
  }
}
function restoreModelDrafts() {
  if (!desktop || page !== 'settings') return;
  for (const [id, draft] of modelFormDrafts) {
    const form = $('#' + id);
    if (!form?.elements) continue;
    const selector = id === 'desktop-settings-form' ? 'provider' : id === 'image-settings-form' ? 'protocol' : null;
    const selected = selector && draft.fields.find(field => field.name === selector)?.value;
    if (selected) { updateProfileKeyField(form, savedModelProfile(id, selected)); form.dataset.profile = selected; }
    for (const field of draft.fields) {
      const input = form.elements.namedItem(field.name);
      if (!input) continue;
      input.value = field.value;
      if (input.type === 'checkbox') input.checked = field.checked;
    }
    const advanced = form.querySelector('.model-advanced');
    if (advanced) advanced.open = draft.advancedOpen;
    syncModelKey(form);
    if (id === 'image-settings-form') updateImageProtocolHints();
    const check = form.parentElement.querySelector('[data-action$="connection"]');
    if (check) check.disabled = true;
  }
}
function savedModelProfile(formId, selected) {
  const image = formId === 'image-settings-form', settings = image ? imageSettings : desktopSettings;
  const selector = image ? 'protocol' : 'provider';
  const base = image
    ? { enabled: false, protocol: selected, model: '', baseUrl: '', size: '1024x1024', responseFormat: 'auto', timeoutMs: 180000, localOnly: true, downloadHosts: '', hasApiKey: false }
    : { provider: selected, model: '', baseUrl: '', jsonMode: 'auto', timeoutMs: 120000, maxTokens: 8192, localOnly: true, hasApiKey: false };
  const saved = settings?.profiles && Object.hasOwn(settings.profiles, selected) ? settings.profiles[selected] : settings?.[selector] === selected ? settings : null;
  return { ...base, ...saved };
}
function updateProfileKeyField(form, cfg) {
  const host = form.querySelector('.model-key-field');
  if (!host) return;
  const image = form.id === 'image-settings-form';
  host.innerHTML = modelKeyField(image ? 'image-model-key' : 'model-key', image ? 'image-key-action' : 'key-action', cfg);
}
function switchModelProfile(form) {
  if (!form?.elements) return;
  const image = form.id === 'image-settings-form', selector = image ? 'protocol' : 'provider';
  const selected = form.elements.namedItem(selector).value;
  const previous = form.dataset.profile;
  if (modelSettingsSaving) { form.elements.namedItem(selector).value = previous; toast('配置正在保存，请稍后再切换服务。'); return; }
  if (previous) {
    const fields = Array.from(form.elements).filter(field => field.name).map(field => ({ name: field.name, value: field.name === selector ? previous : field.value, checked: field.checked }));
    modelServiceDrafts.set(`${form.id}:${previous}`, { fields, advancedOpen: !!form.querySelector('.model-advanced')?.open });
  }
  const cfg = savedModelProfile(form.id, selected), draft = modelServiceDrafts.get(`${form.id}:${selected}`);
  updateProfileKeyField(form, cfg);
  const values = { ...cfg, timeout: cfg.timeoutMs / 1000, apiKey: '', keyAction: 'keep' };
  const fields = draft?.fields || Array.from(form.elements).filter(field => field.name).map(field => ({ name: field.name, value: values[field.name] ?? '', checked: values[field.name] === true }));
  for (const field of fields) {
    const input = form.elements.namedItem(field.name); if (!input) continue;
    if (input.type === 'checkbox') input.checked = field.checked;
    else input.value = field.value;
  }
  form.dataset.profile = selected;
  if (draft && form.querySelector('.model-advanced')) form.querySelector('.model-advanced').open = draft.advancedOpen;
  if (image) updateImageProtocolHints();
  dirtyModelForm(form);
  const message = draft ? '已恢复此服务的未保存参数；点击保存后生效。' : cfg.model || cfg.baseUrl || cfg.hasApiKey ? '已恢复此服务保存的参数；点击保存后生效，密钥不回显。' : '此服务尚无保存参数，请填写后保存。';
  if (image) { imageConnectionResult = message; $('#image-connection-result').textContent = message; }
  else { connectionResult = message; $('#connection-result').textContent = message; }
}
function clearSavedModelDraft(form) {
  const selector = form.id === 'image-settings-form' ? 'protocol' : 'provider';
  modelServiceDrafts.delete(`${form.id}:${form.elements?.namedItem(selector)?.value}`);
}
function modelKeyField(inputId, actionId, cfg) {
  return `<label for="${inputId}">API Key <small>可选</small></label><div class="api-key-control"><input type="hidden" id="${actionId}" name="keyAction" value="keep"><input id="${inputId}" name="apiKey" type="password" autocomplete="new-password" maxlength="4096" placeholder="${cfg.hasApiKey ? '已保存 · 留空保留，填写替换' : '有就填写，没有可留空'}">${cfg.hasApiKey ? `<button type="button" class="key-clear-button" data-action="clear-model-key" data-input="${inputId}" data-key-action="${actionId}" aria-label="清除本模型已保存的 API Key">清除</button>` : ''}</div><p class="field-hint key-hint">${cfg.hasApiKey ? '旧密钥不回显；清除需点击“清除”后保存。' : '无需选择密钥操作，填写后直接保存。'}</p>`;
}
function modelKeyValues(values) {
  const apiKey = values.get('apiKey') || '';
  return { apiKey, keyAction: apiKey.trim() ? 'replace' : values.get('keyAction') === 'clear' ? 'clear' : 'keep' };
}
function syncModelKey(form) {
  if (!form?.elements) return;
  const mode = form.elements.namedItem('keyAction'), input = form.elements.namedItem('apiKey');
  if (!mode || !input) return;
  if (input.value.trim()) mode.value = 'replace';
  else if (mode.value === 'replace') mode.value = 'keep';
  const clearing = mode.value === 'clear';
  const clear = form.querySelector('[data-action="clear-model-key"]');
  if (clear) clear.textContent = clearing ? '取消清除' : '清除';
  input.placeholder = clearing ? '保存后清除密钥；填写可替换' : clear ? '已保存 · 留空保留，填写替换' : '有就填写，没有可留空';
  const hint = form.querySelector('.key-hint');
  if (hint) hint.textContent = clearing ? '密钥待清除，保存后生效。云端服务可能需要先关闭启用开关。' : clear ? '旧密钥不回显；清除需点击“清除”后保存。' : '无需选择密钥操作，填写后直接保存。';
}
function dirtyModelForm(form) {
  if (!desktop || !modelFormIds.includes(form?.id)) return;
  if (form.id === 'web-search-settings-form') {
    $('#web-search-settings-error').textContent = '';
    webSearchSaveResult = '设置尚未保存，请点击“保存网页搜图设置”。';
    $('#web-search-settings-result').textContent = webSearchSaveResult;
    rememberModelDrafts(form.id);
    return;
  }
  const speech = form.id === 'speech-settings-form', image = form.id === 'image-settings-form';
  const prefix = speech ? 'speech-' : image ? 'image-' : '';
  $('#' + (prefix ? prefix + 'settings-error' : 'settings-error')).textContent = '';
  if (!prefix) $('#remote-permission').hidden = true;
  const message = '配置尚未保存，请保存后再检查连接。';
  if (speech) speechConnectionResult = message;
  else if (image) imageConnectionResult = message;
  else connectionResult = message;
  $('#' + prefix + 'connection-result').textContent = message;
  $('[data-action="' + (prefix ? 'check-' + prefix + 'connection' : 'test-connection') + '"]').disabled = true;
  syncModelKey(form);
  rememberModelDrafts(form.id);
}
function updateImageProtocolHints(protocol = $('#image-protocol').value) {
  const native = protocol === 'dashscope', hints = imageProtocolHints(protocol);
  $('#image-protocol-hint').textContent = hints.service;
  $('#image-size-hint').textContent = hints.size;
  $('#image-download-hint').textContent = hints.downloads;
  $('#image-model-url').placeholder = hints.url;
  $('#image-response-format').disabled = native;
  if (native) $('#image-response-format').value = 'auto';
}
let plannerDraft = { step: 'goal', goal: '', level: '零基础', daily: 25, days: 14, questionnaire: null, answers: [], notes: '' };
let plannerBusy = false, plannerError = '';
const plan = () => state.plans.find(p => p.id === state.active) || state.plans[0];
const categoryRules = [
  ['AI 与大模型', /(?:大模型|人工智能|机器学习|深度学习|智能体|提示词|\b(?:LLM|GPT|RAG|AI)\b|DeepSeek|通义|千问)/i],
  ['数据分析', /(?:数据分析|数据可视化|数据库|数据处理|\b(?:Power\s*(?:BI|Query)|DAX|Excel|SQL|Tableau|BI)\b)/i],
  ['开发工具', /(?:版本控制|代码管理|容器|运维|\b(?:Git|GitHub|Docker|Linux|Kubernetes|CI\/CD)\b)/i],
  ['编程开发', /(?:编程|程序设计|代码|软件开发|前端|后端|自动化脚本|\b(?:Python|JavaScript|TypeScript|Java|Rust|C\+\+)\b)/i],
  ['游戏与兴趣', /(?:游戏|电竞|三角洲行动|摄影|绘画|音乐|烹饪|旅行)/i]
];
function categoryFor(planValue) {
  const title = planValue.title || '';
  const details = [planValue.goal, planValue.description, ...planValue.lessons.flatMap(lesson => [lesson.title, ...lesson.tags])].join(' ');
  for (const text of [title, details]) for (const [label, pattern] of categoryRules) if (pattern.test(text)) return label;
  return '其他主题';
}
const progress = id => state.progress[id] || {};
const completed = () => plan().lessons.filter(l => progress(l.id).completed).length;
const percent = () => Math.round(completed() / plan().lessons.length * 100);
const nextLesson = () => plan().lessons.find(l => !progress(l.id).completed) || plan().lessons[0];
const contentFor = id => state.blockCourses?.[id] ? lessonFromBlocks(state.blockCourses[id]) : state.lessons[id] || demoLessons[id];
const lessonById = id => state.plans.flatMap(p => p.lessons).find(l => l.id === id);
const chatFor = id => state.chats?.[id] || [];
const deletedBackupPrefix = 'learnflow.before-delete.';
function recentDeleteBackup() {
  if (desktop) return null;
  try { return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(name => name?.startsWith(deletedBackupPrefix)).sort().at(-1) || null; }
  catch { return null; }
}
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
const moreLearningTools = actions => `<details class="more-learning-tools"><summary>更多学习工具</summary><div class="more-learning-tools-menu">${actions}</div></details>`;
const syllabusToggle = () => `<button type="button" class="text-button syllabus-toggle" data-action="toggle-syllabus" aria-controls="course-syllabus" aria-expanded="${!syllabusCollapsed}">${syllabusCollapsed ? '展开课程目录' : '收起课程目录'}</button>`;
const date = timestamp => new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
const quickAskButton = (available = true) => available ? `<div class="quick-ask-dock"><button type="button" class="quick-ask-button ${lessonTab === 'chat' ? 'active' : ''}" data-action="quick-ask" aria-label="打开当前课程的 AI 答疑" title="打开当前课程的 AI 答疑">${icon('spark')}<span>AI<br>答疑</span></button>${desktop ? `<button type="button" class="quick-ask-button quick-speech-button" data-action="open-speech" data-id="${escape(activeLesson)}" aria-label="打开当前课程的 AI 朗读" title="朗读选中的文字或当前阅读的内容块">${icon('speaker')}<span>AI<br>朗读</span></button>` : ''}</div>` : '';
function navigate(target) { page = target; answer = null; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function switchLessonTab(target, focusQuestion = false) {
  if (!['read', 'quiz', 'chat'].includes(target)) target = 'read';
  if (page === 'study' && lessonTab === 'read' && target !== 'read') {
    readingReturn = { lessonId: activeLesson, scrollTop: window.scrollY };
  }
  if (lessonTab !== target) { lessonTab = target; render(); }
  if (target === 'read' && readingReturn?.lessonId === activeLesson) {
    window.scrollTo({ top: readingReturn.scrollTop, behavior: 'auto' });
  }
  if (target === 'chat' && focusQuestion) {
    $('.study-chat')?.scrollIntoView({ behavior: 'auto', block: 'start' });
    $('#lesson-question')?.focus({ preventScroll: true });
  }
}
function render() {
  stopGraphMotion(); pendingGraph = null;
  rememberModelDrafts();
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
  if ($('#annotation-quick-add')) $('#annotation-quick-add').hidden = true;
  pendingAnnotationAnchor = null;
  restoreModelDrafts();
  decorateKnowledgeActions();
  paintAnnotations();
  decorateGraphToolbar();
  startGraphMotion(pendingGraph);
}
function annotationTextNodes(root) {
  if (!document.createTreeWalker) return [];
  const walker = document.createTreeWalker(root, 4, { acceptNode: node => node.parentElement?.closest('.annotation-marker') ? 2 : 1 });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}
function annotationPlainText(root) { return annotationTextNodes(root).map(node => node.textContent).join(''); }
function annotationOffset(root, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(root); range.setEnd(container, offset);
  const fragment = range.cloneContents();
  fragment.querySelectorAll?.('.annotation-marker').forEach(marker => marker.remove());
  return fragment.textContent.length;
}
function paintAnnotations() {
  if (page !== 'study' || lessonTab !== 'read' || !document.createTreeWalker) return;
  document.querySelectorAll('.annotation-marker').forEach(marker => marker.remove());
  const notes = state.annotations?.[activeLesson] || [];
  for (const root of document.querySelectorAll('.annotatable[data-annotation-source]')) {
    const full = annotationPlainText(root);
    const matching = notes.filter(note => note.source === root.dataset.annotationSource).sort((a, b) => b.offset - a.offset);
    for (const note of matching) {
      let at = Math.min(note.offset, full.length), stale = false;
      if (note.quote && full.slice(at, at + note.quote.length) !== note.quote) {
        const found = full.indexOf(note.quote);
        if (found >= 0) at = found;
        else stale = true;
      }
      const nodes = annotationTextNodes(root);
      let remaining = at, target = nodes.at(-1), position = target?.textContent.length || 0;
      for (const node of nodes) {
        if (remaining <= node.textContent.length) { target = node; position = remaining; break; }
        remaining -= node.textContent.length;
      }
      if (!target) continue;
      const marker = document.createElement('button');
      marker.type = 'button'; marker.className = `annotation-marker${stale ? ' annotation-stale' : ''}`;
      marker.dataset.action = 'open-annotation'; marker.dataset.id = note.id;
      marker.textContent = '✎'; marker.title = stale ? '查看笔记 · 原文已更新，标记位置可能变化' : '查看我的笔记';
      marker.setAttribute('aria-label', marker.title);
      const range = document.createRange(); range.setStart(target, position); range.collapse(true); range.insertNode(marker);
    }
  }
}
function annotationSelection() {
  if (page !== 'study' || lessonTab !== 'read' || !window.getSelection || !document.createRange) return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const root = startElement?.closest('.annotatable[data-annotation-source]');
  if (!root || !root.contains(range.endContainer)) return null;
  const start = annotationOffset(root, range.startContainer, range.startOffset);
  const end = annotationOffset(root, range.endContainer, range.endOffset);
  const quote = annotationPlainText(root).slice(start, end).slice(0, 300);
  if (!quote.trim()) return null;
  return { source: root.dataset.annotationSource, offset: start, quote, rect: range.getBoundingClientRect?.() || { left: 8, top: 48 } };
}
function showAnnotationShortcut() {
  const shortcut = $('#annotation-quick-add');
  if (!shortcut) return;
  const anchor = annotationSelection();
  pendingAnnotationAnchor = anchor ? { source: anchor.source, offset: anchor.offset, quote: anchor.quote } : null;
  shortcut.hidden = !anchor;
  if (anchor) {
    shortcut.style.left = `${Math.max(8, Math.min(window.innerWidth - 130, anchor.rect.left))}px`;
    shortcut.style.top = `${Math.max(8, anchor.rect.top - 39)}px`;
  }
}
function renderAnnotationDialog() {
  if (!annotationDraft) return;
  const { item, error } = annotationDraft;
  $('#annotation-dialog').innerHTML = `<div class="modal-heading"><h2 id="annotation-title">${item.id ? '我的随文笔记' : '添加随文笔记'}</h2><button type="button" class="icon-button" data-action="close-annotation" aria-label="关闭">${icon('close')}</button></div><p class="annotation-quote">${escape(item.quote || '当前原文位置')}</p><form id="annotation-form"><label for="annotation-text">我的理解或疑问</label><textarea id="annotation-text" name="text" maxlength="2000" required placeholder="记录你的理解、例子或尚未弄懂的问题…">${escape(item.text || '')}</textarea><p class="field-hint">笔记独立于课程原文保存；制作该段知识卡片时，会附在“我的笔记”中。</p>${error ? `<p class="inline-error" role="alert">${escape(error)}</p>` : ''}<div class="annotation-dialog-actions">${item.id ? `<button type="button" class="btn danger" data-action="delete-annotation">删除笔记</button>` : ''}<button type="submit" class="btn primary">保存笔记</button></div></form>`;
}
async function commitAnnotations(lessonId, items) {
  if (!validAnnotations(items)) throw new Error('随文笔记格式不正确，或本课笔记已达上限。');
  if (desktop) { await pendingSave; if (storageWarning) throw new Error(storageWarning); await desktop.saveAnnotations(lessonId, items); state.annotations[lessonId] = items; }
  else {
    const next = { ...state, annotations: { ...state.annotations, [lessonId]: items } };
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { throw new Error('浏览器存储失败，笔记尚未保存。'); }
    state = next;
  }
  paintAnnotations();
}
function decorateKnowledgeActions() {
  if (page !== 'study' || !activeLesson) return;
  if (typeof document.createElement !== 'function') return;
  const lesson = contentFor(activeLesson);
  if (!lesson) return;
  const host = $('.lesson-content');
  if (!host?.querySelector) return;
  if (lessonTab === 'read') {
    const toolbar = document.createElement('div');
    toolbar.className = 'knowledge-entry-toolbar';
    toolbar.innerHTML = `<span class="annotation-tip">选中原文可添加随文笔记</span>${state.blockCourses?.[activeLesson] ? '' : moreLearningTools(button('用本课内容制作知识卡片', 'create-note', 'secondary', `data-id="${escape(activeLesson)}"`, 'brain'))}`;
    host.querySelector('.tabs')?.after(toolbar);
    if (!state.blockCourses?.[activeLesson]) {
      host.querySelectorAll('.reading-section').forEach((section, index) => {
        const slot = document.createElement('div');
        slot.className = 'knowledge-section-action';
        slot.innerHTML = moreLearningTools(button('提炼这段知识', 'create-note', 'secondary', `data-id="${escape(activeLesson)}" data-section="${index}"`, 'brain'));
        section.append(slot);
      });
    }
  }
}
function home() {
  const p = plan(), next = nextLesson();
  const allCompleted = Object.values(state.progress).filter(v => v.completed).length;
  const attempts = Object.values(state.progress).reduce((n, v) => n + (v.attempts || 0), 0);
  return `<section class="page-intro"><div><div class="eyebrow">A LITTLE BETTER, EVERY DAY</div><h1>让每一次好奇，都有回响<span class="title-dot">.</span></h1><p>从一个学习目标开始，构建属于你的知识世界。</p></div>${button('开启新的学习', 'planner', 'primary', '', 'plus')}</section>
  <section class="hero"><div class="hero-copy">${pill('你的 AI 学习伙伴', 'hero-pill')}<h2>不止学会，<br>更要成为自己的知识。</h2><p>为你规划路径，陪你练习思考，<br>将每一次收获，连接成你的第二大脑。</p>${button('探索我的学习路线', 'routes', 'dark')}<div class="hero-caption"><span class="mini-dot"></span>目标驱动 <span>·</span> 学练结合 <span>·</span> 知识沉淀</div></div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orb-center">${icon('brain')}<span>我的知识宇宙</span></div><div class="float-card float-top"><span class="float-icon lavender">${icon('route')}</span><div><small>找到你的方向</small><strong>个性化学习路线</strong></div><b>↗</b></div><div class="float-card float-left"><span class="float-icon peach">${icon('bolt')}</span><div><small>在实践中理解</small><strong>让知识发生</strong></div></div><div class="float-card float-bottom"><span class="float-icon green">${icon('book')}</span><div><small>连接每一次收获</small><strong>你的第二大脑</strong></div><span class="check-bubble">✓</span></div><span class="star star-one">✦</span><span class="star star-two">✧</span><span class="orb-dot dot-one"></span><span class="orb-dot dot-two"></span></div></section>
  <section class="stats" aria-label="学习统计">${[['route', '学习路线', state.plans.length, '条探索中的路径', 'lavender'], ['check', '已完成课程', allCompleted, '次从不懂到掌握', 'green'], ['bolt', '练习提交', attempts, '次认真思考', 'peach'], ['brain', '知识卡片', state.notes.length, '份属于你的积累', 'blue']].map(([symbol, label, value, detail, color]) => `<div class="stat"><div class="stat-top"><span>${label}</span><span class="stat-icon ${color}">${icon(symbol)}</span></div><strong>${value}<small>${label === '学习路线' ? '条' : label === '知识卡片' ? '张' : '次'}</small></strong><p>${detail}</p></div>`).join('')}</section>
  <div class="dashboard-columns"><section><div class="section-heading"><h2>继续你的学习<span>KEEP GOING</span></h2><button class="text-button" data-page="routes">全部路线 ${icon('arrow')}</button></div><article class="course-card"><div class="course-top"><span class="course-icon">Py<span>✦</span></span><div>${pill(p.source === 'demo' ? '示例课程' : 'AI 定制', 'purple')} ${pill(p.level)}</div><button class="icon-button" data-page="routes" aria-label="查看课程路线">${icon('arrow')}</button></div><h3>${escape(p.title)}</h3><p>${escape(p.description)}</p><div class="progress-label"><span>学习进度</span><strong>${completed()} / ${p.lessons.length} 节</strong></div><div class="progress-bar"><span style="width:${percent()}%"></span></div><div class="next-up"><span class="next-marker">${icon('book')}</span><div><small>${completed() === p.lessons.length ? '回顾所学' : '接下来学习'}</small><strong>${escape(next.title)}</strong></div><span>${next.minutes} 分钟</span></div>${button(completed() ? '继续学习' : '开始第一课', 'open-lesson', 'primary full', `data-id="${next.id}"`)}</article></section>
  <section><div class="section-heading"><h2>知识在这里生长<span>YOUR SECOND BRAIN</span></h2></div><article class="knowledge-preview">${state.notes.length ? `<div class="knowledge-heading">${icon('brain')}最近收获</div>${state.notes.slice(-3).reverse().map(n => `<button class="note-preview" data-action="open-note" data-id="${n.id}"><span class="note-glyph">${icon('book')}</span><div><strong>${escape(n.title)}</strong><small>${escape(n.tags.slice(0, 2).join(' · '))} · ${date(n.updated)}</small></div>${icon('arrow')}</button>`).join('')}` : `<div class="seed-illustration">${icon('leaf')}<span>+ 第一颗知识种子</span></div><h3>学过的，不再只是路过。</h3><p>学习过程中随时提炼概念与心得，<br>整理成可以反复使用的知识卡片。</p><div class="sample-note"><span>未来的知识卡片</span><strong>核心概念 + 实践经验 + 我的思考</strong><div>${pill('可编辑')} ${pill('可关联')} ${pill('可检索')}</div></div>`}<button class="text-button purple-text" data-page="wiki">打开我的知识库 ${icon('arrow')}</button></article></section></div>
  <div class="bottom-note">${icon('spark')} 学习的终点，不是记住答案，而是拥有解决问题的能力。</div>`;
}
function routes() {
  const p = plan();
  const grouped = new Map();
  for (const route of state.plans) { const category = categoryFor(route); if (!grouped.has(category)) grouped.set(category, []); grouped.get(category).push(route); }
  return `<section class="page-intro"><div><div class="eyebrow">YOUR LEARNING JOURNEY</div><h1>每个目标，都有一条路。</h1><p>把远处的目标，拆解为今天可以迈出的一步。</p></div><div class="route-page-actions">${recentDeleteBackup() ? button('恢复最近删除', 'restore-deleted-plan', 'secondary', '', 'back') : ''}${button('新建学习路线', 'planner', 'primary', '', 'plus')}</div></section>
  <div class="route-library"><div class="route-library-heading"><h2>我的课程分类</h2><span>根据标题、目标和课程标签自动整理</span></div>${[...grouped].map(([category, routes]) => `<section class="route-group"><h3>${escape(category)} <span>${routes.length}</span></h3><div class="route-group-items">${routes.map(route => `<button class="route-chip ${route.id === state.active ? 'selected' : ''}" data-action="switch-plan" data-id="${route.id}" aria-pressed="${route.id === state.active}">${icon('route')}<span>${escape(route.title)}</span></button>`).join('')}</div></section>`).join('')}</div>
  <section class="route-overview"><div>${pill(p.source === 'demo' ? '精选示例 · 非 AI 生成' : 'AI 定制路线', 'purple')}<h2>${escape(p.title)}</h2><p>${escape(p.goal)}</p><div class="metadata">${icon('clock')}每天 ${p.daily} 分钟 <span>·</span>计划 ${p.days} 天 <span>·</span>${escape(p.level)}</div><div class="route-overview-actions">${pill(categoryFor(p))}${button('删除这条路线', 'delete-plan', 'danger', `data-id="${p.id}" ${state.plans.length <= 1 ? 'disabled title="至少保留一条路线"' : ''}`, 'close')}</div></div><div class="progress-ring" style="--progress:${percent()}%"><div><strong>${percent()}<small>%</small></strong><span>已完成</span></div></div></section>
  ${p.source === 'ai' ? `<section class="route-design"><h3>学习成果与规划说明</h3><p>${escape(p.description)}</p>${p.learningBrief ? `<details><summary>查看定制需求与回答</summary>${briefHTML(p.learningBrief)}${p.learningBrief.notes ? `<h4>最后补充</h4><p>${escape(p.learningBrief.notes)}</p>` : ''}</details>` : ''}</section>` : ''}
  <div class="route-layout"><section class="timeline">${p.lessons.map((l, i) => `${i === 0 || l.phase !== p.lessons[i - 1].phase ? `<h3 class="phase">${escape(l.phase)}</h3>` : ''}<article class="lesson-row ${progress(l.id).completed ? 'complete' : ''}"><div class="step-number">${progress(l.id).completed ? icon('check') : String(i + 1).padStart(2, '0')}</div><div class="lesson-row-main"><div class="lesson-title"><h3>${escape(l.title)}</h3>${progress(l.id).completed ? pill('已掌握', 'success') : l.id === nextLesson().id ? pill('推荐下一步', 'purple') : ''}</div><p>${escape(l.objective)}</p><div class="lesson-meta">${icon('clock')}${l.minutes} 分钟<span>·</span>${escape(l.tags.join(' / '))}</div></div>${button(progress(l.id).completed ? '复习' : '进入课程', 'open-lesson', 'secondary', `data-id="${l.id}"`)}</article>`).join('')}</section><aside class="tip-card"><span class="float-icon lavender">${icon('target')}</span><h3>按自己的节奏前进</h3><p>路线是一张地图。你可以先预览任意课程，再根据自己的基础选择起点。</p><hr><strong>掌握比完成更重要</strong><p>每节课通过全部测验后会记录为已掌握。答错时，读一读解析，再试一次。</p>${button('去练习与巩固', 'practice', 'secondary full', '', 'bolt')}</aside></div>`;
}
function study() {
  const p = plan(); const meta = p.lessons.find(l => l.id === activeLesson) || nextLesson(); activeLesson = meta.id;
  const lesson = contentFor(meta.id), record = progress(meta.id);
  if (state.blockCourses?.[meta.id]) return studyBlocks(meta, p, record);
  return `<div class="study-top"><button class="text-button" data-page="routes">${icon('back')}返回学习路线</button>${syllabusToggle()}${pill(p.source === 'demo' ? '示例课程' : 'AI 生成 · 请核验重要知识', 'purple')}</div>
  <div class="study-layout${syllabusCollapsed ? ' syllabus-collapsed' : ''}"><aside id="course-syllabus" class="syllabus" ${syllabusCollapsed ? 'hidden' : ''}><div class="syllabus-heading">课程目录 <span>${completed()}/${p.lessons.length}</span></div>${p.lessons.map((l, i) => `<button class="syllabus-item ${l.id === meta.id ? 'selected' : ''}" data-action="open-lesson" data-id="${l.id}"><span>${progress(l.id).completed ? icon('check') : String(i + 1).padStart(2, '0')}</span><strong>${escape(l.title)}</strong></button>`).join('')}<div class="syllabus-bottom">${icon('leaf')} 慢慢来，也是在前进。</div></aside>${quickAskButton(!!lesson)}
  <section class="lesson-content"><div class="eyebrow">LESSON ${String(p.lessons.indexOf(meta) + 1).padStart(2, '0')}</div><h1>${escape(meta.title)}</h1><p class="lesson-objective">${escape(meta.objective)}</p><div class="metadata">${icon('clock')}${meta.minutes} 分钟 <span>·</span>${escape(meta.tags.join(' / '))}</div>
  <div class="tabs" role="tablist" aria-label="课程内容">${[['read', 'book', '学习内容'], ['quiz', 'bolt', `随堂练习${record.completed ? ' ✓' : ''}`], ['chat', 'spark', 'AI 答疑']].map(([tab, symbol, label]) => `<button role="tab" aria-selected="${lessonTab === tab}" class="${lessonTab === tab ? 'active' : ''}" data-action="lesson-tab" data-tab="${tab}">${icon(symbol)}${label}</button>`).join('')}</div>
  ${!lesson ? `<div class="empty-state">${icon('spark')}<h3>为你展开这一课</h3><p>根据你的目标与基础，生成讲解、示例和随堂练习。</p>${button('生成课程内容', 'generate-lesson', 'primary', `data-id="${meta.id}"`, 'spark')}</div>` : lessonTab === 'read' ? `<div class="lesson-intro annotatable" data-annotation-source="intro">${escape(lesson.intro)}</div>${lesson.sections.map((s, index) => `<section class="reading-section"><h2>${escape(s.heading)}</h2><p class="annotatable" data-annotation-source="section:${index}">${escape(s.body)}</p></section>`).join('')}<div class="code-block"><div>具体示例 <span>阅读与推演</span></div><pre><code class="annotatable" data-annotation-source="example">${escape(lesson.example)}</code></pre></div><div class="challenge"><h3>${icon('bolt')}动手试一试</h3><p class="annotatable" data-annotation-source="challenge">${escape(lesson.challenge)}</p><small>请在你自己的工具或编程环境中完成。这里不执行代码。</small></div><div class="lesson-actions"><span>理解之后，用练习检验一下。</span>${button('开始随堂练习', 'quiz', 'primary')}</div>` : lessonTab === 'quiz' ? quiz(meta, lesson) : studyChat(meta)}</section></div>`;
}
function blockPart(block, index, lessonId, teaching = false) {
  const labels = { reading: '知识讲解', example: '配套案例', practice: '动手实践', quiz: '随堂练习', summary: '知识总结' };
  const attrs = `data-id="${escape(lessonId)}" data-block="${escape(block.id)}"`;
  const editable = assistedBlockTypes.includes(block.type) && block.content;
  const imageAction = editable && desktop ? button(block.content.illustration ? '调整配图' : block.content.imageProposal ? '查看建议配图' : 'AI 配图建议', 'request-illustration', 'secondary', attrs, 'spark') : '';
  const otherRevision = editable && block.type === 'practice' ? button('换个任务', 'request-revision', 'secondary', attrs, '') : '';
  const primaryRevision = editable && ['reading', 'example'].includes(block.type) ? button(block.type === 'reading' ? '换个讲法' : '换个例子', 'request-revision', 'secondary', attrs, '') : '';
  const tools = button('生成知识卡片', 'create-note', 'secondary', attrs, 'brain') + imageAction + otherRevision + (editable && block.content.revisions?.length ? button('恢复上一版', 'restore-block', 'secondary', attrs, 'back') : '');
  const actions = block.content && block.type !== 'quiz' ? `<div class="revision-actions">${primaryRevision}${moreLearningTools(tools)}</div>` : '';
  const figure = desktop && validIllustration(block.content?.illustration) ? `<figure class="course-illustration"><img src="/course-images/${block.content.illustration.id}" alt="${escape(block.content.illustration.caption)}" loading="lazy"><figcaption>${escape(block.content.illustration.caption)}<small>${['commons', 'web'].includes(block.content.illustration.source) ? `网络资料 · ${block.content.illustration.source === 'commons' ? 'Wikimedia Commons' : '百炼网页搜图'} · ${escape(block.content.illustration.author)} · ${escape(block.content.illustration.license)} <button type="button" class="text-button" data-action="${block.content.illustration.source === 'commons' ? 'open-commons-source' : 'open-image-source'}" data-url="${escape(block.content.illustration.sourceUrl)}">查看来源与许可</button>` : 'AI 生成教学示意 · 请结合正文核验，勿用于精确测量或数据判断'}</small></figcaption></figure>` : '';
  const canCollapse = Boolean(block.content) && ['reading', 'example'].includes(block.type);
  const collapseKey = `${lessonId}:${block.id}`;
  const collapsed = canCollapse && collapsedBlocks.has(collapseKey);
  const bodyId = `block-body-${lessonId}-${block.id}`;
  const toggle = canCollapse ? `<button type="button" class="block-collapse-toggle" data-action="toggle-block-collapse" ${attrs} aria-controls="${escape(bodyId)}" aria-expanded="${!collapsed}">${collapsed ? '展开' : '收起'}</button>` : '';
  const body = block.content && block.type !== 'quiz' ? `<div class="block-text markdown-content annotatable" data-annotation-source="block:${escape(block.id)}">${renderMarkdown(block.content.text)}</div>${figure}` : '';
  const bodyMarkup = canCollapse ? `<div id="${escape(bodyId)}" class="block-collapsible-body" ${collapsed ? 'hidden' : ''}>${body}</div>` : body;
  return `<section class="${teaching ? `teaching-part teaching-${block.type}` : 'reading-section content-block'}" data-block-id="${escape(block.id)}"><div class="teaching-part-heading"><span class="pill purple">${String(index + 1).padStart(2, '0')} · ${labels[block.type]}</span>${actions}</div><div class="block-title-row"><h2 class="block-title">${escape(block.title)}</h2>${toggle}</div><p class="block-objective">${escape(block.objective)}</p>${block.content ? block.type === 'quiz' ? `<p>已生成 ${block.content.questions.length} 道练习题。${button('去练习', 'quiz', 'secondary')}</p>` : bodyMarkup : `<div class="block-pending"><span>此模块尚未生成，可以按需展开。</span>${button('生成这一块', 'generate-block', 'secondary', attrs, 'spark')}</div>`}</section>`;
}
function teachingSequence(course, lessonId) {
  const units = [];
  for (let index = 0; index < course.blocks.length; index++) {
    const block = course.blocks[index];
    if (block.type !== 'reading') { units.push(blockPart(block, index, lessonId, block.type === 'example')); continue; }
    const parts = [blockPart(block, index, lessonId, true)];
    while (course.blocks[index + 1]?.type === 'example') {
      index++;
      parts.push(blockPart(course.blocks[index], index, lessonId, true));
    }
    units.push(`<article class="teaching-unit" aria-label="讲解与配套案例">${parts.join('')}</article>`);
  }
  return units.join('');
}
function updateNotePreview(draft) {
  const value = draft || { title: $('#note-title').value, content: $('#note-content').value };
  $('#note-preview-title').textContent = value.title;
  $('#note-preview-content').innerHTML = value.content?.trim() ? renderMarkdown(value.content) : '<p class="markdown-empty">还没有正文，请切换到编辑模式补充。</p>';
}
function studyBlocks(meta, p, record) {
  const course = state.blockCourses[meta.id], lesson = lessonFromBlocks(course);
  const labels = { reading: '讲解', example: '示例', practice: '实践', quiz: '练习', summary: '总结' };
  const read = `<div class="lesson-intro annotatable" data-annotation-source="intro">${escape(course.intro)}</div><div class="block-sequence">${teachingSequence(course, meta.id)}</div><form id="append-block-form" data-id="${meta.id}" class="append-block-form"><h3>继续扩展本课</h3><div class="form-row"><div><label for="block-type">内容类型</label><select id="block-type" name="type">${Object.entries(labels).map(([type, label]) => `<option value="${type}">${label}</option>`).join('')}</select></div><div><label for="block-title">模块标题</label><input id="block-title" name="title" required maxlength="160" placeholder="例如：更多实际案例"></div></div><label for="block-objective">本块的学习目标</label><input id="block-objective" name="objective" required maxlength="1000" placeholder="你想在这里学会什么？"><button class="btn secondary" type="submit">添加内容块 ${icon('plus')}</button></form>`;
  const quizBody = lesson.questions.length ? quiz(meta, lesson) : `<div class="empty-state"><h3>练习尚未生成</h3><p>请先在“学习内容”里生成练习模块。</p>${button('查看内容块', 'read-tab', 'secondary')}</div>`;
  return `<div class="study-top"><button class="text-button" data-page="routes">${icon('back')}返回学习路线</button>${syllabusToggle()}${pill('分步课程 · 可扩展', 'purple')}</div><div class="study-layout${syllabusCollapsed ? ' syllabus-collapsed' : ''}"><aside id="course-syllabus" class="syllabus" ${syllabusCollapsed ? 'hidden' : ''}><div class="syllabus-heading">课程目录 <span>${completed()}/${p.lessons.length}</span></div>${p.lessons.map((l, i) => `<button class="syllabus-item ${l.id === meta.id ? 'selected' : ''}" data-action="open-lesson" data-id="${l.id}"><span>${progress(l.id).completed ? icon('check') : String(i + 1).padStart(2, '0')}</span><strong>${escape(l.title)}</strong></button>`).join('')}</aside>${quickAskButton()}<section class="lesson-content"><div class="eyebrow">LESSON ${String(p.lessons.indexOf(meta) + 1).padStart(2, '0')}</div><h1>${escape(meta.title)}</h1><p class="lesson-objective">${escape(meta.objective)}</p><div class="tabs" role="tablist" aria-label="课程内容">${[['read', 'book', '学习内容'], ['quiz', 'bolt', `随堂练习${record.completed ? ' ✓' : ''}`], ['chat', 'spark', 'AI 答疑']].map(([tab, symbol, label]) => `<button role="tab" aria-selected="${lessonTab === tab}" class="${lessonTab === tab ? 'active' : ''}" data-action="lesson-tab" data-tab="${tab}">${icon(symbol)}${label}</button>`).join('')}</div>${lessonTab === 'read' ? read : lessonTab === 'quiz' ? quizBody : studyChat(meta)}</section></div>`;
}
function studyChat(meta) {
  const messages = chatFor(meta.id);
  return `<section class="study-chat"><div class="study-chat-heading"><span class="float-icon lavender">${icon('spark')}</span><div><h2>学习中遇到疑问？</h2><p>AI 会参考《${escape(meta.title)}》的讲解与最近对话，帮你理解概念和练习思路。</p></div><button type="button" class="btn secondary qa-back-to-reading" data-action="back-to-reading">${icon('back')}返回学习内容</button></div>
    <div class="chat-history" aria-label="本课答疑记录">${messages.length ? messages.map(message => `<div class="chat-message ${message.role === 'user' ? 'from-user' : 'from-ai'}"><strong>${message.role === 'user' ? '你' : 'AI 学习助手'}</strong><div class="chat-body markdown-content">${renderMarkdown(message.content)}</div></div>`).join('') : '<p class="chat-empty">例如：“这一步为什么这样做？”或“能再举一个例子吗？”</p>'}</div>
    ${status.mode === 'ai' ? `<form id="lesson-ask-form" data-id="${meta.id}"><label class="sr-only" for="lesson-question">向 AI 提问</label><textarea id="lesson-question" name="question" required maxlength="1000" placeholder="输入你对本课的疑问…"></textarea><div class="chat-compose"><small>对话保存在${desktop ? '本机' : '当前浏览器'}，回答可能有误，请结合课程核对。</small><button class="btn primary" type="submit">发送问题 ${icon('arrow')}</button></div></form>` : `<div class="notice">先在设置中连接 AI 模型，即可就本课内容提问。</div>`}
    <p id="lesson-ask-error" class="inline-error" role="alert"></p></section>`;
}
function quiz(meta, lesson) {
  const record = progress(meta.id);
  return `<div class="quiz-intro"><h2>让理解，在练习中发生。</h2><p>共 ${lesson.questions.length} 道单选题，全部答对即可掌握本课。可以反复练习。</p></div><form id="quiz-form" data-id="${meta.id}">${lesson.questions.map((q, i) => `<fieldset class="question"><legend><span>${String(i + 1).padStart(2, '0')}</span>${escape(q.prompt)}</legend>${q.options.map((o, j) => `<label class="quiz-option"><input type="radio" name="q${i}" value="${j}" required><span class="option-letter">${String.fromCharCode(65 + j)}</span><span>${escape(o)}</span></label>`).join('')}</fieldset>`).join('')}<button class="btn primary" type="submit">提交并查看解析 ${icon('check')}</button></form>${record.lastAnswers?.length === lesson.questions.length ? `<section class="quiz-result ${record.lastScore === 100 ? 'passed' : ''}" aria-live="polite"><h3>${record.lastScore === 100 ? '做得好，本课已掌握！' : '发现盲点，就是进步的开始。'}<span>${record.lastScore} 分</span></h3><p>上次提交 · 已练习 ${record.attempts} 次 · 最高 ${record.bestScore} 分</p>${lesson.questions.map((q, i) => `<div class="answer-review"><strong>${record.lastAnswers[i] === q.answer ? '✓ 回答正确' : '↻ 再想一想'} · 第 ${i + 1} 题</strong><p>你的答案：${escape(q.options[record.lastAnswers[i]])}<br>正确答案：${escape(q.options[q.answer])}</p><p>${escape(q.explanation)}</p></div>`).join('')}${record.completed ? button('制作本课知识卡片', 'create-note', 'primary', `data-id="${meta.id}"`, 'brain') : `<p>结合解析回到上方重新作答，或切换到学习内容复习。</p>`}</section>` : ''}`;
}
function practice() {
  const p = plan(), reviewed = p.lessons.filter(l => progress(l.id).attempts), weak = reviewed.filter(l => progress(l.id).lastScore < 100);
  return `<section class="page-intro"><div><div class="eyebrow">LEARN BY DOING</div><h1>练过，才真正属于你。</h1><p>从错题中发现盲点，在回顾中巩固理解。</p></div>${pill('当前路线 · ' + p.lessons.length + ' 节', 'purple')}</section><div class="practice-banner"><div class="float-icon peach">${icon('bolt')}</div><div><h2>${weak.length ? `${weak.length} 节课程值得再练一次` : reviewed.length ? '保持手感，继续巩固' : '从你的第一次练习开始'}</h2><p>${weak.length ? '根据最近一次测验，优先回顾这些课程。' : '先学习一小段，再用问题检验理解。每次提交都会保留进度。'}</p></div></div><div class="practice-grid">${[...weak, ...p.lessons.filter(l => !weak.includes(l))].map(l => { const r = progress(l.id); return `<article class="practice-card"><div class="practice-card-top"><span class="float-icon ${r.completed ? 'green' : 'lavender'}">${icon(r.completed ? 'check' : 'bolt')}</span>${pill(r.attempts ? `最近 ${r.lastScore} 分` : '尚未练习', r.completed ? 'success' : '')}</div><h3>${escape(l.title)}</h3><p>${escape(l.objective)}</p><div class="practice-card-bottom"><small>${r.attempts || 0} 次练习${r.attempts ? ` · 最高 ${r.bestScore} 分` : ''}</small>${button(r.attempts ? '再次练习' : '去练习', 'open-quiz', 'secondary', `data-id="${l.id}"`, 'arrow')}</div></article>`; }).join('')}</div>`;
}
function wiki() {
  if (activeNote) {
    const n = state.notes.find(n => n.id === activeNote); if (n) return noteEditor(n); activeNote = null;
  }
  return `<section class="page-intro"><div><div class="eyebrow">YOUR PERSONAL KNOWLEDGE GARDEN</div><h1>把所学，连成自己的世界。</h1><p>积累不只是收藏。让每个概念，都能被再次找到和使用。</p></div>${button('导出知识库', 'export-wiki', 'secondary', state.notes.length ? '' : 'disabled', 'export')}</section><div class="wiki-layout"><section class="wiki-explorer"><div class="wiki-view-switch" role="tablist" aria-label="知识库展示方式"><button type="button" role="tab" data-action="switch-wiki-view" data-view="chat" aria-selected="${knowledgeView === 'chat'}">知识问答</button><button type="button" role="tab" data-action="switch-wiki-view" data-view="tree" aria-selected="${knowledgeView === 'tree'}">树状目录</button><button type="button" role="tab" data-action="switch-wiki-view" data-view="graph" aria-selected="${knowledgeView === 'graph'}">关联图谱</button></div><div class="wiki-toolbar"><label class="search-field">${icon('search')}<input id="wiki-search" type="search" placeholder="搜索标题、正文或标签…" value="${escape(query)}" aria-label="搜索知识库"></label><span class="wiki-match-count">共 ${state.notes.length} 张卡片</span></div><section id="note-results" role="tabpanel" aria-label="${knowledgeViewLabel()}">${knowledgeResults()}</section></section></div>`;
}
function knowledgeViewLabel() {
  return { tree: '树状目录', chat: '知识问答', graph: '关联图谱' }[knowledgeView];
}
function knowledgeConversation() {
  return `<section class="ask-panel knowledge-conversation"><div class="ask-heading">${icon('spark')}知识问答</div><p>${status.mode === 'ai' ? '先按知识目录筛选相关卡片，再由 AI 根据卡片原文回答并列出引用。' : '示例模式按目录与关键词检索；接入模型后可基于相关卡片问答。'}</p><form id="ask-form"><label class="sr-only" for="wiki-question">向知识库提问</label><textarea id="wiki-question" name="question" required maxlength="1000" placeholder="例如：变量和字符串有什么区别？" ${state.notes.length ? '' : 'disabled'}></textarea><button type="submit" class="btn primary full" ${state.notes.length ? '' : 'disabled'}>${status.mode === 'ai' ? '向知识库提问' : '检索相关笔记'} ${icon('arrow')}</button></form><div id="wiki-answer" aria-live="polite">${answerHTML()}</div><div class="ask-footnote">${icon('book')}${state.notes.length ? '仅引用本次检索到的相关卡片；没找到时会明确说明。' : '生成一张卡片后，即可开始检索。'}</div></section>`;
}
function filteredKnowledgeNotes(includeTopic = knowledgeView === 'graph') {
  const term = query.toLocaleLowerCase();
  const courses = new Map(state.plans.flatMap(course => course.lessons.map(lesson => [lesson.id, course])));
  return state.notes.filter(note => {
    const course = courses.get(note.lessonId);
    return (!includeTopic || !topicFilter || knowledgeTopic(note.topic) === topicFilter || knowledgeTopic(note.topic).startsWith(topicFilter + '/')) && `${note.title} ${note.summary} ${note.content} ${note.tags.join(' ')} ${note.topic || ''} ${note.category || ''} ${course?.title || note.courseTitle || ''} ${knowledgeDomain(course || { title: note.courseTitle })} ${(note.aliases || []).join(' ')}`.toLocaleLowerCase().includes(term);
  });
}
function knowledgeDirectory(notes) {
  const tree = courseKnowledgeTree(notes, state.plans);
  if (!tree.count) return noteList([]);
  const folder = (item, depth) => {
    const expanded = query ? true : folderOverrides.get(item.key) ?? depth < 2;
    const cards = (item.cards || []).map(note => `<button type="button" class="wiki-tree-card" data-action="open-note" data-id="${escape(note.id)}">${icon('book')}<span><strong>${escape(note.title)}</strong><span class="wiki-tree-card-summary markdown-content">${renderMarkdown(note.summary || '')}</span></span>${icon('arrow')}</button>`).join('');
    return `<div class="wiki-tree-folder wiki-tree-${item.kind}"><div class="wiki-tree-folder-heading"><button type="button" class="wiki-tree-row wiki-tree-folder-toggle" data-action="toggle-folder" data-folder="${escape(item.key)}" data-name="${escape(item.name)}" aria-expanded="${expanded}" aria-label="${expanded ? '折叠' : '展开'} ${escape(item.name)}"><span class="wiki-tree-expander" aria-hidden="true">${expanded ? '▾' : '▸'}</span><span class="wiki-tree-topic">${escape(item.name)}</span><span class="wiki-tree-count">${item.count}</span></button>${item.kind === 'course' ? `<button type="button" class="wiki-organize-trigger" data-action="open-organize" data-course="${escape(item.key)}">管理主题</button>` : ''}</div><div class="wiki-tree-children" ${expanded ? '' : 'hidden'}>${item.children.map(child => folder(child, depth + 1)).join('')}${cards}</div></div>`;
  };
  return `<nav class="wiki-directory" aria-label="知识目录"><div class="wiki-directory-heading"><strong>知识目录 · ${tree.count} 张卡片</strong><small>领域 → 课程 → 主题 → 卡片；打开卡片并切换到编辑，可调整“知识库归类”</small></div><div class="wiki-tree">${tree.children.map(child => folder(child, 0)).join('')}</div></nav>`;
}
function knowledgeResults() {
  if (knowledgeView === 'chat') return knowledgeConversation();
  const filtered = filteredKnowledgeNotes();
  if (knowledgeView === 'tree') return knowledgeDirectory(filtered);
  const filter = topicFilter ? `<div class="wiki-active-filter">当前主题：${escape(topicFilter)} <button type="button" data-action="filter-topic" data-topic="">清除主题筛选</button></div>` : '';
  return filter + knowledgeGraphView(filtered.filter(note => (!graphTagFilter || (note.tags || []).includes(graphTagFilter)) && (!graphStatusFilter || (note.status || 'draft') === graphStatusFilter)));
}
function refreshKnowledgeResults() {
  stopGraphMotion(); pendingGraph = null; hoveredGraphId = '';
  const results = $('#note-results');
  if (results) { results.innerHTML = knowledgeResults(); results.setAttribute('aria-label', knowledgeViewLabel()); }
  const count = $('.wiki-match-count');
  if (count) count.textContent = query || topicFilter ? `显示 ${filteredKnowledgeNotes().length} / ${state.notes.length} 张卡片` : `共 ${state.notes.length} 张卡片`;
  decorateGraphToolbar(); startGraphMotion(pendingGraph); applyGraphFocus();
}
function applyGraphFocus() {
  const svg = $('#knowledge-graph-svg');
  if (!svg?.querySelectorAll) return;
  const nodes = [...svg.querySelectorAll('.graph-node')];
  const focusedId = hoveredGraphId || selectedGraphId;
  const activeId = nodes.some(node => node.dataset.id === focusedId) ? focusedId : '';
  svg.classList.toggle('has-focus', Boolean(activeId));
  const neighbors = new Set(activeId ? [activeId] : []);
  const edges = [...svg.querySelectorAll('.graph-edge')];
  for (const edge of edges) {
    if (activeId && (edge.dataset.source === activeId || edge.dataset.target === activeId)) {
      neighbors.add(edge.dataset.source); neighbors.add(edge.dataset.target);
    }
  }
  for (const edge of edges) edge.classList.toggle('dimmed', Boolean(activeId) && edge.dataset.source !== activeId && edge.dataset.target !== activeId);
  for (const node of nodes) {
    node.classList.toggle('dimmed', Boolean(activeId) && !neighbors.has(node.dataset.id));
    node.classList.toggle('focused', node.dataset.id === activeId);
  }
}
function knowledgeGraphView(notes) {
  const graph = filterKnowledgeGraph(knowledgeGraph(notes, 240, state.plans), { relation: graphRelationFilter, type: graphTypeFilter, orphansOnly: graphOrphansOnly, localTwoHop: graphLocalTwoHop, selectedId: selectedGraphId });
  pendingGraph = graph;
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const selected = byId.get(selectedGraphId);
  const box = graphViewport && graphViewport.totalWidth === graph.width && graphViewport.totalHeight === graph.height ? graphViewport : { x: 0, y: 0, width: graph.width, height: graph.height, totalWidth: graph.width, totalHeight: graph.height };
  const lines = graph.edges.map(edge => { const from = byId.get(edge.source), to = byId.get(edge.target); return `<line class="graph-edge graph-edge-${edge.type}" data-source="${escape(edge.source)}" data-target="${escape(edge.target)}" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"><title>${escape({ membership: '属于主题', hierarchy: '主题层级', related: '明确相关', prerequisites: '前置知识', contrasts: '对比知识', suggested: '共同标签·候选关联' }[edge.type])}</title></line>`; }).join('');
  const points = graph.nodes.map(node => `<a href="#" class="graph-node graph-node-${node.kind}${node.id === selectedGraphId ? ' selected' : ''}" style="--node-color:${knowledgeDomainColors[node.domain] || knowledgeDomainColors['待归类']}" data-action="select-graph-node" data-id="${escape(node.id)}" aria-label="${escape(node.kind === 'topic' ? `主题：${node.topic}` : `卡片：${node.label}`)}"><title>${escape(node.kind === 'topic' ? `主题：${node.topic}，${node.count} 张卡片` : `${node.label} · ${node.topic}`)}</title><circle cx="${node.x}" cy="${node.y}" r="${node.kind === 'topic' ? 10 : 6}"></circle><text x="${node.x + 11}" y="${node.y + 4}">${escape(node.label.length > 12 ? node.label.slice(0, 11) + '…' : node.label)}</text></a>`).join('');
  const selectedCard = selected?.kind === 'card' ? state.notes.find(note => note.id === selected.cardId) : null;
  const related = selected ? graph.edges.filter(edge => edge.source === selected.id || edge.target === selected.id).filter(edge => !['membership', 'hierarchy'].includes(edge.type)).slice(0, 8) : [];
  return `<div class="knowledge-graph${graph.shownCards > 30 ? ' graph-dense' : ''}"><div class="knowledge-graph-header"><div><strong>知识关联图谱</strong><small>${graph.shownCards} 张卡片 · ${graph.edges.length} 条连线${graph.totalCards > graph.shownCards ? ` · 仅显示最近 ${graph.shownCards} 张；可搜索或按主题缩小范围` : ''}</small></div><div class="graph-controls"><button type="button" data-action="graph-zoom-in" aria-label="放大图谱">＋</button><button type="button" data-action="graph-zoom-out" aria-label="缩小图谱">－</button><button type="button" data-action="graph-reset">重置</button></div></div><div class="knowledge-graph-canvas"><svg id="knowledge-graph-svg" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" data-graph-width="${graph.width}" data-graph-height="${graph.height}" role="group" aria-label="可缩放和拖动的知识关联图谱">${lines}${points}</svg></div><div class="graph-legend"><span class="graph-legend-topic">主题与归属</span><span class="graph-legend-related">明确关联</span><span class="graph-legend-prerequisites">前置知识</span><span class="graph-legend-contrasts">对比知识</span><span class="graph-legend-suggested">共同标签（候选）</span></div><div class="graph-selection">${selected ? `<strong>${escape(selected.kind === 'topic' ? selected.topic : selectedCard?.title || selected.label)}</strong><p>${selected.kind === 'topic' ? `${selected.count} 张卡片归入这一主题。` : escape(selectedCard?.summary || '暂无摘要。')}</p>${selected.kind === 'topic' ? `<button type="button" class="btn secondary" data-action="filter-topic" data-topic="${escape(selected.topic)}">查看这个主题</button>` : `<button type="button" class="btn primary" data-action="open-note" data-id="${escape(selected.cardId)}">打开知识卡片</button>`}${related.length ? `<div class="graph-related">${related.map(edge => { const other = byId.get(edge.source === selected.id ? edge.target : edge.source); return other?.kind === 'card' ? `<button type="button" data-action="select-graph-node" data-id="${escape(other.id)}">${escape(other.label)} <small>${edge.type === 'suggested' ? '共同标签·候选' : edge.type === 'prerequisites' ? '前置知识' : edge.type === 'contrasts' ? '对比知识' : '明确相关'}</small></button>` : ''; }).join('')}</div>` : ''}` : '<p>点击节点查看卡片和关联；拖动画布、滚轮或右上角按钮可缩放。</p>'}</div></div>`;
}
function setGraphViewport(svg, x, y, width, height) {
  graphViewport = { x, y, width, height, totalWidth: Number(svg.dataset.graphWidth), totalHeight: Number(svg.dataset.graphHeight) };
  svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
}
function zoomKnowledgeGraph(factor) {
  const svg = $('#knowledge-graph-svg');
  if (!svg) return;
  const [x, y, width, height] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
  const nextWidth = Math.max(Number(svg.dataset.graphWidth) * .22, Math.min(Number(svg.dataset.graphWidth) * 3, width * factor));
  const nextHeight = height * nextWidth / width;
  setGraphViewport(svg, x + (width - nextWidth) / 2, y + (height - nextHeight) / 2, nextWidth, nextHeight);
}
function decorateGraphToolbar() {
  const host = $('.knowledge-graph');
  if (!host || typeof host.querySelector !== 'function' || typeof host.insertAdjacentHTML !== 'function' || host.querySelector('.graph-toolbar')) return;
  const topics = knowledgeCatalog(state.notes).topics;
  const tags = [...new Set(state.notes.flatMap(note => note.tags || []))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const option = (value, label, selected) => `<option value="${escape(value)}" ${selected ? 'selected' : ''}>${escape(label)}</option>`;
  host.insertAdjacentHTML('afterbegin', `<div class="graph-toolbar">
    <label class="graph-search"><span class="sr-only">搜索图谱卡片</span><input id="graph-search" type="search" value="${escape(query)}" placeholder="搜索标题或内容…"></label>
    <label><span class="sr-only">图谱主题</span><select id="graph-topic">${option('', '全部目录', !topicFilter)}${topics.map(topic => option(topic.path, `${'　'.repeat(Math.min(3, topic.path.split('/').length - 1))}${topic.path.split('/').at(-1)} (${topic.count})`, topicFilter === topic.path)).join('')}</select></label>
    <label><span class="sr-only">图谱类型</span><select id="graph-type">${option('all', '全部类型', graphTypeFilter === 'all')}${option('card', '知识卡片', graphTypeFilter === 'card')}${option('topic', '主题目录', graphTypeFilter === 'topic')}</select></label>
    <label><span class="sr-only">卡片状态</span><select id="graph-status">${option('', '全部状态', !graphStatusFilter)}${option('draft', '草稿', graphStatusFilter === 'draft')}${option('reviewed', '已核验', graphStatusFilter === 'reviewed')}</select></label>
    <label><span class="sr-only">知识标签</span><select id="graph-tag">${option('', '全部标签', !graphTagFilter)}${tags.map(tag => option(tag, tag, graphTagFilter === tag)).join('')}</select></label>
    <label><span class="sr-only">关系类型</span><select id="graph-relation">${option('all', '全部关系', graphRelationFilter === 'all')}${option('declared', '明确关系', graphRelationFilter === 'declared')}${option('suggested', '标签候选', graphRelationFilter === 'suggested')}</select></label>
    <button type="button" data-action="graph-orphans" aria-pressed="${graphOrphansOnly}">孤立节点</button>
    <button type="button" data-action="graph-local" aria-pressed="${graphLocalTwoHop}" ${selectedGraphId.startsWith('card:') ? '' : 'disabled'}>局部 2 跳</button>
    <button type="button" data-action="graph-fit">适应画布</button><button type="button" data-action="graph-refresh">刷新布局</button>
    <button type="button" data-action="graph-pause" aria-pressed="${graphPaused}">${graphPaused ? '继续运动' : '暂停运动'}</button>
    <details class="graph-settings"><summary>图谱设置</summary><label>节点间距 <input id="graph-spacing" type="range" min="0.6" max="1.8" step="0.1" value="${graphSpacing}"></label><small>密集图默认隐藏卡片名称，悬停或选中时显示。</small></details>
  </div>`);
}
function paintGraphMotion() {
  if (!graphMotion?.svg?.isConnected) return;
  for (const node of graphMotion.nodes) {
    const element = graphMotion.nodeElements.get(node.id);
    if (!element) continue;
    element.querySelector('circle')?.setAttribute('cx', node.x.toFixed(1));
    element.querySelector('circle')?.setAttribute('cy', node.y.toFixed(1));
    element.querySelector('text')?.setAttribute('x', (node.x + 11).toFixed(1));
    element.querySelector('text')?.setAttribute('y', (node.y + 4).toFixed(1));
  }
  graphMotion.edges.forEach((edge, index) => {
    const element = graphMotion.lineElements[index];
    if (!element) return;
    const source = graphMotion.nodes[edge.source], target = graphMotion.nodes[edge.target];
    element.setAttribute('x1', source.x.toFixed(1)); element.setAttribute('y1', source.y.toFixed(1));
    element.setAttribute('x2', target.x.toFixed(1)); element.setAttribute('y2', target.y.toFixed(1));
  });
}
function animateGraphMotion() {
  graphFrame = 0;
  if (!graphMotion || graphPaused || document.hidden || !graphMotion.svg.isConnected) return;
  const movement = stepGraphMotion(graphMotion, graphSpacing);
  paintGraphMotion();
  if (graphMotion.alpha > .025 || movement > .08) graphFrame = window.requestAnimationFrame?.(animateGraphMotion) || 0;
}
function stopGraphMotion() {
  if (graphFrame) window.cancelAnimationFrame?.(graphFrame);
  graphFrame = 0;
  if (graphMotion) graphPositions = new Map(graphMotion.nodes.map(node => [node.id, { x: node.x, y: node.y }]));
  graphMotion = null;
}
function startGraphMotion(graph) {
  const svg = $('#knowledge-graph-svg');
  if (!graph || !svg || typeof svg.querySelectorAll !== 'function') return;
  if (!graph.nodes.length) {
    svg.insertAdjacentHTML?.('afterend', '<p class="graph-empty">当前筛选没有可显示的节点。请修改上方搜索或筛选条件。</p>');
    return;
  }
  const hadPositions = graphPositions.size > 0;
  graphMotion = createGraphMotion(graph, graphPositions);
  graphMotion.alpha = hadPositions ? .25 : .95;
  graphMotion.svg = svg;
  graphMotion.nodeElements = new Map([...svg.querySelectorAll('.graph-node')].map(element => [element.dataset.id, element]));
  graphMotion.lineElements = [...svg.querySelectorAll('.graph-edge')];
  paintGraphMotion();
  if (!graphPaused && !document.hidden) graphFrame = window.requestAnimationFrame?.(animateGraphMotion) || 0;
}
function noteList(notes) {
  return notes.length ? `<div class="note-grid">${notes.map(n => `<button class="wiki-card" data-action="open-note" data-id="${n.id}"><div class="wiki-card-top"><span class="note-glyph">${icon('book')}</span><small>${date(n.updated)}</small></div><h3>${escape(n.title)}</h3><div class="note-card-summary markdown-content">${renderMarkdown(n.summary)}</div><div class="tags">${n.tags.map(t => pill(t)).join('')}</div><div class="wiki-card-bottom">来自课程学习 ${icon('arrow')}</div></button>`).join('')}</div>` : `<div class="empty-state"><div class="empty-icon">${icon(query ? 'search' : 'leaf')}</div><h3>${query ? '还没有找到匹配的知识' : '给未来的自己，留下一份收获。'}</h3><p>${query ? '试试更短的关键词，或搜索一个知识标签。' : '阅读课程时即可提炼知识卡片，不用先完成练习。'}</p>${query ? '' : button('开始学习', 'start', 'primary')}</div>`;
}
function answerHTML() {
  if (!answer) return '';
  return `<div class="grounded-answer"><strong>${answer.demo ? '关键词检索结果' : '基于你的知识库'}</strong><div class="answer-body markdown-content">${renderMarkdown(answer.answer)}</div>${answer.citations.map(id => { const n = state.notes.find(n => n.id === id); return n ? `<button class="citation" data-action="open-note" data-id="${id}">${icon('book')}${escape(n.title)}</button>` : ''; }).join('')}</div>`;
}
function noteEditor(n) {
  const related = state.notes.filter(o => o.id !== n.id && o.tags.some(t => n.tags.includes(t))).slice(0, 5);
  return `<div class="study-top"><button class="text-button" data-action="close-note">${icon('back')}全部知识卡片</button>${pill(n.source === 'ai' ? 'AI 整理 · 可编辑' : '课程要点整理', 'purple')}</div><div class="note-editor-layout"><form id="note-form" data-id="${n.id}" class="note-editor"><div class="note-view-toolbar"><div class="eyebrow">A NOTE TO YOUR FUTURE SELF</div><div class="note-view-switch" role="group" aria-label="知识卡片显示模式"><button type="button" id="note-read-switch" data-action="note-view" data-mode="read" aria-pressed="true">阅读</button><button type="button" id="note-edit-switch" data-action="note-view" data-mode="edit" aria-pressed="false">编辑 Markdown</button></div></div>
    <section id="note-preview-view"><h1 id="note-preview-title">${escape(n.title)}</h1><div id="note-preview-content" class="note-reading-content markdown-content">${renderMarkdown(n.content)}</div></section>
    <div id="note-source-view" hidden><label for="note-title">标题</label><input id="note-title" name="title" value="${escape(n.title)}" maxlength="160" required><label for="note-summary">一句话摘要</label><textarea id="note-summary" name="summary" maxlength="500" required>${escape(n.summary)}</textarea><label for="note-topic">原始知识主题 <small>保留已有 Markdown 归档位置</small></label><input id="note-topic" name="topic" value="${escape(n.topic || '未分类')}" maxlength="160" required><label for="note-category">知识库归类 <small>可选；留空自动归类，填写后归入本课程的指定主题，不移动原始文件目录</small></label><input id="note-category" name="category" value="${escape(n.category || '')}" maxlength="80" placeholder="例如：安装与环境验证"><label for="note-content">知识正文 <small>使用 Markdown 编写，切换阅读可预览未保存修改</small></label><textarea id="note-content" class="note-body" name="content" maxlength="20000" required>${escape(n.content)}</textarea><label for="note-tags">标签 <small>用中文或英文逗号分隔，最多 6 个</small></label><input id="note-tags" name="tags" value="${escape(n.tags.join('，'))}" maxlength="200" required><label for="note-use">什么时候使用 <small>每行一项，资料不足可留空</small></label><textarea id="note-use" name="useWhen">${escape((n.useWhen || []).join('\n'))}</textarea><label for="note-avoid">什么时候不能用 <small>每行一项，资料不足可留空</small></label><textarea id="note-avoid" name="avoidWhen">${escape((n.avoidWhen || []).join('\n'))}</textarea></div>
    <div class="editor-actions"><button id="note-save" class="btn primary" type="submit" hidden>保存修改 ${icon('check')}</button>${button('导出 Markdown', 'export-note', 'secondary', `data-id="${n.id}"`, 'export')}<button type="button" class="btn danger" data-action="delete-note" data-id="${escape(n.id)}">删除这张卡片 ${icon('close')}</button></div><p class="field-hint">阅读视图可预览未保存的编辑；修改后请切回编辑并保存。导出的是已保存的 Markdown 源文。</p></form><aside class="tip-card"><h3>知识的来处</h3><p>${escape(n.courseTitle)}</p><small>更新于 ${date(n.updated)}</small>${button('回到来源课程', 'source-lesson', 'secondary full', `data-id="${n.lessonId}"`, 'book')}<hr><h3>关联知识</h3><p>依据共同标签连接。</p>${related.length ? related.map(r => `<button class="citation" data-action="open-note" data-id="${r.id}">${icon('book')}${escape(r.title)}</button>`).join('') : '<p>继续积累，相似主题的卡片会在这里相遇。</p>'}</aside></div>`;
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
  return `<section class="page-intro"><div><div class="eyebrow">YOUR LOCAL LEARNING SPACE</div><h1>模型与数据设置</h1><p>文字、图片、语音在同一页配置，各自保存后立即生效，无需重启。</p></div>${pill('桌面版 · 本地存储', 'success')}</section>
  <p class="settings-key-note">文字模型按服务、图片模型按接口协议分别记住参数，切回时自动恢复，点击保存后才生效。API Key 有就填写，没有可留空；已保存的密钥不回显，留空保留，不跨服务沿用。三种模型独立保存密钥，加密保存在本机，不写入学习备份。</p>
  <div class="model-settings-grid"><section class="panel model-settings-card"><div class="model-card-heading">${icon('brain')}<h2>LLM 文字模型</h2></div><p class="model-card-description">规划课程、讲解知识和 AI 答疑。</p>${pill(status.mode === 'ai' ? (status.providerLabel || 'AI') + ' · ' + status.model : '尚未配置可用模型', 'purple')}
  ${cfg.error ? `<div class="notice error">${escape(cfg.error)}</div>` : ''}
  <form id="desktop-settings-form" class="desktop-form" data-profile="${escape(cfg.provider)}">
    <label for="model-provider">模型服务</label><select id="model-provider" name="provider">${providers.map(([id, label]) => `<option value="${id}" ${cfg.provider === id ? 'selected' : ''}>${label}</option>`).join('')}</select>
    <label for="model-name">模型名称</label><input id="model-name" name="model" maxlength="200" value="${escape(cfg.model)}" placeholder="本地已安装的模型名，或服务商的模型 ID">
    <label for="model-url">接口根地址 <small>留空使用服务预设</small></label><input id="model-url" name="baseUrl" maxlength="2000" value="${escape(cfg.baseUrl)}" placeholder="例如 http://127.0.0.1:11434">
    <label class="check-label"><input type="checkbox" name="localOnly" ${cfg.localOnly ? 'checked' : ''}>仅使用本机模型</label>
    <p class="field-hint">云端或局域网模型请关闭此项。</p>
    <div class="model-key-field">${modelKeyField('model-key', 'key-action', cfg)}</div>
    <details class="model-advanced"><summary>高级设置</summary><div class="model-advanced-content">
    <div class="form-row"><div><label for="json-mode">JSON 模式</label><select id="json-mode" name="jsonMode">${[['auto','自动'],['on','开启'],['off','仅提示词']].map(([v,l]) => `<option value="${v}" ${cfg.jsonMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div><label for="model-timeout">超时（秒）</label><input id="model-timeout" type="number" name="timeout" min="1" max="600" required value="${cfg.timeoutMs / 1000}"></div><div><label for="model-tokens">输出上限</label><input id="model-tokens" type="number" name="maxTokens" min="128" max="32768" required value="${cfg.maxTokens}"></div></div>
    <p class="field-hint">仅本机模式只允许 localhost、127.0.0.1 或 ::1；模型需先在本机安装并启动。关闭后，相关课程与笔记可能发送到远端服务。不跨服务或新地址沿用密钥；切回已有存档且地址未变时，可留空保留该服务的密钥。</p></div></details>
    <p id="settings-error" class="inline-error" role="alert"></p><div id="remote-permission" hidden class="notice"><p>此操作会关闭“仅使用本机模型”。配置仍保存在本机；使用 AI 时，相关内容将发送到你配置的远端服务。</p><button type="button" class="btn secondary full" data-action="allow-remote-save">允许远端连接并保存</button></div><button type="submit" class="btn primary full" ${cfg.error ? 'disabled' : ''}>保存模型配置 ${icon('check')}</button>
  </form>
  ${button('测试已保存的模型连接', 'test-connection', 'secondary full', status.mode === 'ai' ? '' : 'disabled', 'bolt')}
  <div id="connection-result" class="notice" role="status">${escape(connectionResult || '保存后可测试连接；“已配置”不代表模型已启动。')}</div><p class="field-hint">连接测试只发送固定短提示。使用云端服务时会按服务商规则计费。</p>
  </section>${imageSettingsPanel()}${speechSettingsPanel()}</div>${webSearchSettingsPanel()}<section class="panel settings-data-panel"><h2>本地学习数据</h2><p>学习路线、课程、练习成绩与 Wiki 自动保存到本机。关闭应用后，下次打开会继续加载。</p>
  <label>数据目录</label><pre class="config-example">${escape(dataDirectory)}</pre>
  <div class="data-counts"><strong>${state.plans.length}<span>条路线</span></strong><strong>${state.notes.length}<span>张卡片</span></strong></div>
  <div class="settings-data-actions">${button('打开数据目录', 'open-data', 'secondary', '', 'book')}${button('导出完整 JSON 备份', 'export-data', 'secondary', '', 'export')}${button('导入学习备份', 'import-data', 'secondary', '', 'plus')}${button('导出 Wiki Markdown', 'export-wiki', 'secondary', state.notes.length ? '' : 'disabled', 'export')}</div>
  <p class="field-hint">完整备份包含课程配图和历史版本。导入前会确认替换并创建 SQLite 快照。学习备份不包含模型配置或密钥。朗读音频为独立本地缓存；如需保留，请在应用关闭后备份整个数据目录。</p></section>`;
}

function webSearchSettingsPanel() {
  const cfg = webSearchSettings || { enabled: false };
  return `<section class="panel web-search-settings-panel"><h2>网页图片搜索 · 百炼文搜图</h2><p>使用当前文字模型的地址、模型和密钥，通过 Responses 的 web_search_image 工具查找互联网图片，不需要另一套搜索 Key。</p><form id="web-search-settings-form" class="desktop-form">
  <label class="check-label"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}>启用百炼网页搜图（允许联网并使用当前文字模型账号）</label>
  <p class="field-hint">需使用支持文搜图的百炼模型，如 qwen3.8-max；不会自动更换模型、地址或计费账号。搜索可能消耗模型与工具额度。只有点击搜索才发送关键词或模块摘要；预览会访问图片来源网站，不附带密钥和 Cookie。返回结果不代表使用授权。</p>
  <p class="field-hint">Token Plan 个人版官方限制其用于编程／智能体工具的交互式使用，不允许自定义应用后端；请确认你的账号与接入方式适用，或使用允许应用后端调用的百炼服务。</p>
  <p id="web-search-settings-error" class="inline-error" role="alert">${escape(cfg.error || '')}</p><button type="submit" class="btn primary" ${cfg.error ? 'disabled' : ''}>保存网页搜图设置</button>
  <p id="web-search-settings-result" class="field-hint" role="status">${escape(webSearchSaveResult || (cfg.enabled ? '已保存：网页搜图已启用；只有点击搜索才联网。' : '网页搜图未启用；勾选后请点击保存。'))}</p></form></section>`;
}
function imageProtocolHints(protocol) {
  return protocol === 'dashscope' ? {
    url: '例如 https://dashscope.aliyuncs.com/api/v1',
    service: '百炼原生同步接口：支持 wan2.7-image / wan2.7-image-pro、qwen-image-3.0 / qwen-image-3.0-pro。根地址以 /api/v1 结尾；填写百炼官方 /compatible-mode/v1 地址时，保存会转换为同域名的 /api/v1，不切换服务商。使用该服务对应的密钥。旧版异步模型暂不支持。Token Plan 使用范围有限，请确认服务商是否允许当前使用方式；此提醒不阻止保存，也不代表生成权限已验证。',
    size: '1024x1024（自动转换为 1024*1024）；万相支持 1K / 2K，pro 还支持 4K。千问 3.0 仅填宽x高。',
    downloads: '原生接口返回 URL。仅对百炼官方接口内置允许已核实的地域结果域名和加速存储域名（含 dashscope-7c2c.oss-accelerate.aliyuncs.com，清单见 README）；官方存储会动态变化，其他域名仍须核对后填写精确域名，不放开全部 OSS 或通配域名。下载失败可修改下载域名并保存，再回到原内容块仅重试下载；不要重启，以免丢失待下载链接。仅本机模式不允许远端下载；下载不携带 API Key 或 Cookie，不跟随重定向。'
  } : {
    url: '例如 http://127.0.0.1:8001/v1（不含 /images/generations）',
    service: '通用兼容接口：自动追加 /images/generations，要求服务返回 data[0].b64_json 或 data[0].url；不要填完整生成地址。',
    size: '尺寸为宽x高，如 1024x1024；须符合服务商实际支持范围。',
    downloads: 'URL 结果默认只能从接口同源地址下载。CDN 须填写服务商可信的精确域名；不支持通配符。下载不会携带 API Key。若支持，优先选择 Base64。'
  };
}
function imageSettingsPanel() {
  const cfg = imageSettings || { enabled: false, protocol: 'compatible', model: '', baseUrl: '', size: '1024x1024', responseFormat: 'auto', timeoutMs: 180000, localOnly: true, downloadHosts: '' };
  const native = cfg.protocol === 'dashscope', hints = imageProtocolHints(cfg.protocol);
  return `<section class="panel image-settings-panel model-settings-card"><div class="model-card-heading">${icon('spark')}<h2>图片生成模型</h2></div><p class="model-card-description">生成教学配图，确认后才生成。</p>${cfg.error ? `<div class="notice error">${escape(cfg.error)}</div>` : ''}<form id="image-settings-form" class="desktop-form" data-profile="${escape(cfg.protocol)}">
  <label class="check-label"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}>启用课程配图</label>
  <label for="image-protocol">图片接口协议</label><select id="image-protocol" name="protocol"><option value="compatible" ${!native ? 'selected' : ''}>通用兼容接口</option><option value="dashscope" ${native ? 'selected' : ''}>阿里百炼原生接口</option></select>
  <label for="image-model-name">图片模型名称</label><input id="image-model-name" name="model" maxlength="200" value="${escape(cfg.model)}" placeholder="服务实际提供的文生图模型 ID，不能填聊天模型">
  <label for="image-model-url">接口根地址</label><input id="image-model-url" name="baseUrl" maxlength="2000" value="${escape(cfg.baseUrl)}" placeholder="${escape(hints.url)}">
  <label class="check-label"><input type="checkbox" name="localOnly" ${cfg.localOnly ? 'checked' : ''}>仅本机图片服务</label><p class="field-hint">云端请关闭此项，使用 HTTPS 地址。</p>
  <div class="model-key-field">${modelKeyField('image-model-key', 'image-key-action', cfg)}</div>
  <details class="model-advanced"><summary>高级设置 · 尺寸与下载</summary><div class="model-advanced-content"><p id="image-protocol-hint" class="field-hint">${escape(hints.service)}</p>
  <div class="form-row"><div><label for="image-size">尺寸（宽x高）</label><input id="image-size" name="size" value="${escape(cfg.size)}" maxlength="20" required></div><div><label for="image-response-format">返回格式</label><select id="image-response-format" name="responseFormat" ${native ? 'disabled' : ''}>${[['auto','自动（不传参数）'],['b64_json','Base64'],['url','图片 URL']].map(([v,l]) => `<option value="${v}" ${(native ? v === 'auto' : cfg.responseFormat === v) ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div><label for="image-timeout">超时（秒）</label><input id="image-timeout" name="timeout" type="number" min="1" max="600" value="${cfg.timeoutMs / 1000}" required></div></div><p id="image-size-hint" class="field-hint">${escape(hints.size)}</p>
  <label for="image-download-hosts">额外允许的图片下载域名（可选）</label><input id="image-download-hosts" name="downloadHosts" maxlength="2000" value="${escape(cfg.downloadHosts)}" placeholder="可信精确域名，用英文逗号分隔"><p id="image-download-hint" class="field-hint">${escape(hints.downloads)}</p><p class="field-hint">图片提示词会发送到图片服务；配图分析会将当前模块正文发送到文字模型。不会自动生成或自动重试；云端生成可能计费。图片保存在本机，随完整学习备份导出。</p></div></details>
  <p id="image-settings-error" class="inline-error" role="alert"></p><button type="submit" class="btn primary full" ${cfg.error ? 'disabled' : ''}>保存图片模型配置 ${icon('check')}</button></form>
  ${button('检查连接（不生成图片）', 'check-image-connection', 'secondary full', cfg.enabled && !cfg.error ? '' : 'disabled', 'bolt')}<div id="image-connection-result" class="notice" role="status">${escape(imageConnectionResult || '仅检查 /models，不请求付费生成。')}</div></section>`;
}
function speechSettingsPanel() {
  if (!desktop) return '';
  const cfg = { ...speechDefaults, ...speechSettings };
  return `<section class="panel speech-settings-panel model-settings-card"><div class="model-card-heading">${icon('bolt')}<h2>语音生成模型</h2></div><p class="model-card-description">合成听力材料，本地缓存反复播放。</p><form id="speech-settings-form" class="desktop-form">
  <label class="check-label"><input type="checkbox" name="enabled" ${cfg.enabled ? 'checked' : ''}>启用 AI 朗读</label>
  <label for="speech-model">语音模型</label><input id="speech-model" name="model" required value="${escape(cfg.model)}" maxlength="200">
  <label for="speech-url">接口根地址</label><input id="speech-url" name="baseUrl" required value="${escape(cfg.baseUrl)}" maxlength="2000">
  <label class="check-label"><input type="checkbox" name="localOnly" ${cfg.localOnly ? 'checked' : ''}>仅本机语音服务</label><p class="field-hint">云端请关闭此项，使用 HTTPS 地址。</p>
  ${modelKeyField('speech-key', 'speech-key-action', cfg)}
  <details class="model-advanced"><summary>高级设置 · 音色与语速</summary><div class="model-advanced-content"><p class="field-hint">独立使用 qwen-audio-3.0-tts-plus。可填 Token Plan /compatible-mode/v1，保存会调整为同域名 /api/v1；调用 /services/audio/tts/SpeechSynthesizer，不切换服务或密钥。套餐使用范围须向服务商确认。</p>
  <div class="form-row"><div><label for="speech-voice">默认音色 ID</label><input id="speech-voice" name="voice" required value="${escape(cfg.voice)}" list="speech-voices" maxlength="200"></div><div><label for="speech-other-voice">第二角色音色 ID</label><input id="speech-other-voice" name="otherVoice" required value="${escape(cfg.otherVoice)}" list="speech-voices" maxlength="200"></div></div><datalist id="speech-voices">${speechVoices.map(([id, label]) => `<option value="${id}">${escape(label)}</option>`).join('')}</datalist><p class="field-hint">使用该模型支持的系统、基础或自建音色 ID。默认两种中英音色不保证特定口音；英式 / 美式效果须试听确认。Jennifer、Aiden 属于其他模型，不可混用。三个以上角色可在生成预览中分别填音色 ID。</p>
  <div class="form-row three"><div><label for="speech-language">材料语言</label><select id="speech-language" name="language"><option value="en" ${cfg.language === 'en' ? 'selected' : ''}>英语</option><option value="zh" ${cfg.language === 'zh' ? 'selected' : ''}>中文</option></select></div><div><label for="speech-rate">合成语速</label><input id="speech-rate" type="number" min="0.5" max="2" step="0.1" name="rate" value="${cfg.rate}" required></div><div><label for="speech-timeout">每阶段超时（秒）</label><input id="speech-timeout" type="number" min="1" max="600" name="timeout" value="${cfg.timeoutMs / 1000}" required></div></div>
  <label for="speech-download-hosts">额外允许的音频下载域名</label><input id="speech-download-hosts" name="downloadHosts" value="${escape(cfg.downloadHosts)}" maxlength="2000" placeholder="可信的精确域名，用英文逗号分隔"><p class="field-hint">百炼官方来源内置已核实的地域 / 加速结果域名；未知域名不会访问。可信域名的 HTTP 签名链接只升级为 HTTPS，不回退 HTTP，不携带密钥或 Cookie，不跟随重定向。</p>
  <p class="field-hint">仅在确认后合成，可能按服务商规则计费。发送所选材料，不发送整门课程、笔记或聊天记录。重复播放本地缓存不调用模型。</p></div></details><p id="speech-settings-error" class="inline-error" role="alert">${escape(cfg.error || '')}</p><button type="submit" class="btn primary full" ${cfg.error ? 'disabled' : ''}>保存语音配置 ${icon('check')}</button></form>${button('检查连接（不合成语音）', 'check-speech-connection', 'secondary full', cfg.enabled && !cfg.error ? '' : 'disabled', 'bolt')}<p id="speech-connection-result" class="notice" role="status">${escape(speechConnectionResult || '保存后可检查服务，不生成试听音频。')}</p></section>`;
}
function stopSpeechPlayback() {
  const player = $('#speech-player'); player?.pause?.(); if (player) { player.onended = null; player.currentTime = 0; }
  speechPlaylist = [];
}
function renderSpeechDialog() {
  stopSpeechPlayback();
  const draft = speechDraft, cfg = { ...speechDefaults, ...speechSettings };
  let speakers = []; try { speakers = [...new Set(speechTurns(draft.text).map(turn => turn.speaker))]; } catch {}
  const preview = draft.plan;
  $('#speech-dialog').innerHTML = `<div class="modal-heading"><h2 id="speech-title">AI 听力朗读</h2><button class="icon-button" data-action="close-speech" aria-label="关闭" ${speechBusy ? 'disabled' : ''}>${icon('close')}</button></div><p>选择课程原文或在下方粘贴听力材料。自动提取仅供预览，请核对原文；姓名用于分配音色，不会被朗读。不改写课程。</p>${!cfg.enabled ? '<p class="notice">尚未启用语音模型，请到“设置与数据 → AI 朗读模型”填写独立密钥并保存。</p>' : ''}
  <form id="speech-preview-form"><fieldset id="speech-preview-fields" ${speechBusy ? 'disabled' : ''}><label for="speech-material">待朗读材料（可修改，最多 8000 字）</label><textarea id="speech-material" name="text" rows="8" required maxlength="8000" placeholder="Sarah: Alright, let's get started.&#10;Mark: I've finished the login page.">${escape(draft.text)}</textarea><div class="speech-roles">${speakers.map((speaker, index) => `<div><label for="speech-role-${index}">${escape(speaker || '旁白')} · 音色 ID</label><input id="speech-role-${index}" name="voice-${index}" value="${escape(Object.hasOwn(draft.assignments, speaker) ? draft.assignments[speaker] : index % 2 ? cfg.otherVoice : cfg.voice)}" maxlength="200"></div>`).join('')}</div><button type="submit" class="btn secondary full">预览角色与缓存（不生成、不计费）</button></fieldset></form><p id="speech-error" class="inline-error" role="alert">${escape(draft.error || '')}</p>
  <div id="speech-preview-body">${preview ? `<p class="notice">共 ${preview.turns.length} 段，已缓存 ${preview.cachedCount} 段，待下载 ${preview.pendingCount} 段；新合成 ${preview.newCount} 段 / ${preview.characters} 字符。只发送确认的片段；按服务商规则计费，不自动重试。</p><ol class="speech-turns">${preview.turns.map((turn, index) => `<li id="speech-turn-${index}"><div><strong>${escape(turn.speaker || '旁白')}</strong><small>${escape(turn.voice)} · ${turn.id ? '本地音频' : turn.pending ? '已生成，待下载' : '尚未生成'}</small></div><p>${escape(turn.text)}</p>${turn.id && validAudioId(turn.id) ? button('重听此段', 'play-speech-turn', 'secondary', `data-index="${index}"`, '') : ''}${turn.pending ? `<small>下载域名：${escape(turn.host)}</small>` : ''}</li>`).join('')}</ol><form id="speech-generate-form"><button type="submit" class="btn primary full" ${speechBusy || !cfg.enabled || (!preview.newCount && !preview.pendingCount) ? 'disabled' : ''}>${speechBusy ? '正在合成 / 下载，请勿重复提交…' : preview.pendingCount ? '仅重试下载（不合成新片段）' : preview.newCount ? `确认生成 ${preview.newCount} 段 AI 朗读（可能计费）` : '全部已缓存，不需要重新生成'}</button></form>${preview.cachedCount ? `<div class="speech-player-tools">${button('播放已缓存片段', 'play-speech-all', 'secondary', '', '')}${button('停止', 'stop-speech', 'secondary', '', '')}<label>播放速度<select id="speech-play-rate"><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option></select></label></div><audio id="speech-player" controls preload="none"></audio><p id="speech-playing" role="status">AI 合成示意语音 · 点击播放；不是原始录音。</p>` : ''}` : ''}</div><p class="field-hint">下载失败的链接仅在本次运行中保留 30 分钟，关闭应用后失效。已保存的音频可离线播放，修改文本、音色或合成参数会使用新缓存，不覆盖课程和旧音频。</p>`;
}
async function openSpeech(lessonId, blockId) {
  if (!desktop || speechBusy) return;
  const selected = window.getSelection?.()?.toString() || '';
  const block = state.blockCourses?.[lessonId]?.blocks.find(item => item.id === blockId);
  const lesson = contentFor(lessonId);
  const firstReadyBlock = state.blockCourses?.[lessonId]?.blocks.find(item => ['reading', 'example', 'practice'].includes(item.type) && item.content);
  const raw = block?.content?.text || firstReadyBlock?.content?.text || lesson?.example || '';
  speechDraft = { lessonId, text: selected.trim().slice(0, 8000) || listeningText(raw), assignments: {}, plan: null, error: '' };
  speechBusy = !!speechDraft.text;
  renderSpeechDialog(); $('#speech-dialog').showModal();
  // Local cache lookup is non-generating, even when the text was auto-extracted.
  if (speechDraft.text) {
    try { speechDraft.plan = await desktop.prepareSpeech({ lessonId, text: speechDraft.text, assignments: {} }); }
    catch (error) { speechDraft.error = error.message; }
    finally { speechBusy = false; }
    renderSpeechDialog();
  }
}
function visibleSpeechBlock() {
  const blocks = [...(document.querySelectorAll?.('.teaching-part[data-block-id], .content-block[data-block-id]') || [])].filter(node => node.querySelector('.block-text') && !node.querySelector('.block-collapsible-body[hidden]'));
  const visible = blocks.map(node => ({ node, rect: node.getBoundingClientRect() })).filter(item => item.rect.height && item.rect.top < window.innerHeight && item.rect.bottom > 0);
  visible.sort((a, b) => Math.abs((a.rect.top + a.rect.bottom) / 2 - window.innerHeight / 2) - Math.abs((b.rect.top + b.rect.bottom) / 2 - window.innerHeight / 2));
  return visible[0]?.node.dataset.blockId || '';
}
async function playSpeech(indices) {
  stopSpeechPlayback(); speechPlaylist = indices.filter(index => validAudioId(speechDraft?.plan?.turns[index]?.id));
  if (!speechPlaylist.length) return;
  const playNext = async () => {
    if (!speechPlaylist.length) return;
    const index = speechPlaylist.shift(), turn = speechDraft.plan.turns[index], player = $('#speech-player');
    player.src = `/course-audio/${turn.id}`; player.playbackRate = Number($('#speech-play-rate')?.value || 1); player.preservesPitch = true;
    player.onended = () => { playNext().catch(error => { $('#speech-error').textContent = error.message; }); };
    player.onerror = () => { speechPlaylist = []; $('#speech-error').textContent = '本地音频无法播放，请检查缓存文件；不会重新生成或计费。'; };
    $('#speech-playing').textContent = `第 ${index + 1} 段 · ${turn.speaker || '旁白'} · AI 合成语音`;
    await player.play();
  };
  await playNext();
}
function renderIllustrationDialog() {
  const draft = illustrationDraft;
  const pending = draft.pendingDownload;
  const warning = draft.mode === 'search' && draft.warning ? `<p class="notice">${escape(draft.warning)}</p>` : '';
  const tabs = `<div class="illustration-tabs" role="tablist" aria-label="配图来源"><button type="button" role="tab" aria-selected="${draft.mode === 'generate'}" class="${draft.mode === 'generate' ? 'active' : ''}" data-action="illustration-mode" data-mode="generate" ${illustrationBusy ? 'disabled' : ''}>AI 提示词生成</button><button type="button" role="tab" aria-selected="${draft.mode === 'search'}" class="${draft.mode === 'search' ? 'active' : ''}" data-action="illustration-mode" data-mode="search" ${illustrationBusy ? 'disabled' : ''}>在线找图</button></div>`;
  const generate = `<form id="illustration-form"><fieldset class="planner-fields" ${illustrationBusy || !imageSettings?.enabled ? 'disabled' : ''}><label for="illustration-prompt">图片生成提示词${pending ? '（已生成结果，不再修改）' : '（可以修改）'}</label><textarea id="illustration-prompt" name="prompt" maxlength="4000" rows="6" required ${pending ? 'readonly' : ''}>${escape(draft.prompt)}</textarea><label for="illustration-caption">图注：帮助读者理解什么</label><textarea id="illustration-caption" name="caption" maxlength="500" rows="3" required ${pending ? 'readonly' : ''}>${escape(draft.caption)}</textarea><p class="field-hint">只生成一张；云端按服务商规则计费。图片可能包含错误，应以正文为准。</p>${pending ? `<p id="illustration-download-notice" class="notice">服务已返回图片地址，可能已计费。下载域名：${escape(pending.host)}。仅重试下载不会重新生成；链接只在本次运行中保留最多 30 分钟。</p>` : ''}<p id="illustration-error" class="inline-error" role="alert">${escape(draft.error || '')}</p><button type="submit" class="btn primary full">${illustrationBusy ? '<span class="spinner"></span>正在处理…' : pending ? '仅重试下载（不重新生成）' : '确认生成图片（可能计费）'}</button>${pending ? '<button type="button" class="btn secondary full" data-action="illustration-download-settings">打开图片设置</button><button type="button" class="btn secondary full" data-action="discard-illustration-download">放弃此结果，重新生成（可能计费）</button>' : ''}</fieldset></form>${!imageSettings?.enabled ? '<p class="notice">图片模型未启用。可以切换到“在线找图”，或先在设置中启用图片模型。</p>' : ''}`;
  const web = draft.searchProvider !== 'commons';
  const provider = `<div class="commons-search-actions"><button type="button" class="btn ${web ? 'primary' : 'secondary'}" data-action="image-search-provider" data-provider="web" ${illustrationBusy ? 'disabled' : ''}>全网图片 · 百炼</button><button type="button" class="btn ${!web ? 'primary' : 'secondary'}" data-action="image-search-provider" data-provider="commons" ${illustrationBusy ? 'disabled' : ''}>Commons 图库</button></div>`;
  const results = draft.results?.length ? `<form id="commons-select-form"><fieldset class="planner-fields" ${illustrationBusy ? 'disabled' : ''}><div class="commons-results">${draft.results.map(item => `<label class="commons-result"><input type="radio" name="pageId" value="${escape(item.candidateId || item.pageId)}" required ${String(draft.selectedPageId) === String(item.candidateId || item.pageId) ? 'checked' : ''}>${item.preview ? `<img src="${escape(item.preview)}" alt="${escape(item.title)}">` : `<div class="commons-no-preview">${escape(item.previewError || '无法预览')}</div>`}<strong>${escape(item.title)}</strong><small>${escape(item.author || item.provider)} · ${escape(item.license)}</small><button type="button" class="text-button" data-action="${web ? 'open-image-source' : 'open-commons-source'}" data-url="${escape(item.sourceUrl || item.pageUrl || item.imageUrl)}">${web && !item.sourceUrl ? '查看原图（来源页面未提供）' : '查看原始来源与许可'}</button></label>`).join('')}</div><label for="commons-caption">课程图注</label><textarea id="commons-caption" name="caption" maxlength="500" rows="2" required>${escape(draft.webCaption || draft.caption)}</textarea><label class="commons-confirm"><input type="checkbox" name="rightsConfirmed" required> 我已核对图片来源并确认具有当前用途所需的使用权限</label><button type="submit" class="btn primary full">确认下载选中图片并保存到本机</button></fieldset></form>` : draft.searched ? '<p class="notice">没有找到可用候选图，请修改搜索需求。模型未调用文搜图时不会使用其自行写出的图片链接。</p>' : '';
  const search = `${provider}<p class="field-hint">${web ? '全网图片使用百炼 Responses 文搜图。手动搜索发送下方需求；AI 自动找图发送当前模块摘要。可能消耗套餐 Credits 或模型与工具费用；只有点击才联网，不自动重试。图片预览会访问来源网站，不携带模型密钥或 Cookie。搜索结果不等于使用授权。' : 'Commons 搜索只发送关键词；AI 自动找图先将模块摘要交给文字模型提取关键词。图库许可仍需核对。'}</p>${web && !webSearchSettings?.enabled ? '<div class="notice">请先在设置中启用“百炼网页搜图”，沿用当前文字模型账号。<button type="button" class="text-button" data-action="web-search-settings">打开搜图设置</button></div>' : ''}<form id="commons-search-form"><fieldset class="planner-fields" ${illustrationBusy || (web && !webSearchSettings?.enabled) ? 'disabled' : ''}><label for="commons-query">图片搜索需求</label><input id="commons-query" name="query" minlength="2" maxlength="${web ? '200' : '100'}" required value="${escape(draft.query)}" placeholder="例如：适合初学者理解心房和心室的结构示意图"><div class="commons-search-actions"><button type="submit" class="btn secondary">${illustrationBusy ? '<span class="spinner"></span>正在搜索…' : web ? '搜索互联网图片（可能计费）' : '按关键词搜索'}</button>${status.mode === 'ai' ? '<button type="button" class="btn secondary" data-action="auto-search-commons">AI 自动找图</button>' : ''}</div></fieldset></form><p id="commons-error" class="inline-error" role="alert">${escape(draft.error || '')}</p>${draft.recommendation ? `<section class="planner-summary"><h3>AI 配图推荐说明</h3><div class="markdown-content">${renderMarkdown(draft.recommendation)}</div></section>` : ''}${results}`;
  $('#illustration-dialog').innerHTML = `<div class="modal-heading"><h2 id="illustration-title">教学配图</h2><button class="icon-button" data-action="close-illustration" aria-label="关闭" ${illustrationBusy ? 'disabled' : ''}>${icon('close')}</button></div>${tabs}<p>${escape(draft.reason)}</p>${warning}${draft.mode === 'search' ? search : generate}`;
}

function planner() { renderPlanner(); if (!$('#planner').open) $('#planner').showModal(); }
function briefHTML(brief) {
  return `<div class="planner-summary"><h3>AI 的初步理解</h3><p>${escape(brief.summary)}</p></div><dl class="planner-answers">${brief.answers.map(answer => `<div><dt>${escape(answer.question)}</dt><dd>${escape(answer.selected.join('、'))}${answer.detail ? `<p>${escape(answer.detail)}</p>` : ''}</dd></div>`).join('')}</dl>`;
}
function renderPlanner() {
  const draft = plannerDraft, step = ['goal', 'questions', 'review'].indexOf(draft.step);
  let body;
  if (draft.step === 'goal') {
    body = `<h2 id="planner-title">先说说，你想学什么？</h2><p>还没有明确方向也没关系。描述你的兴趣、遇到的难题，或想完成的事情，AI 会先帮你澄清需求。</p><form id="plan-form"><fieldset class="planner-fields" ${plannerBusy ? 'disabled' : ''}><label for="goal">我的学习需求</label><textarea id="goal" name="goal" maxlength="1000" required placeholder="例如：我想学 AI，但不知道从哪里开始；或我想让日常报表更省时间。">${escape(draft.goal)}</textarea><div class="form-row"><div><label for="level">目前的基础</label><select id="level" name="level">${['零基础', '有一点基础', '希望进阶'].map(level => `<option ${draft.level === level ? 'selected' : ''}>${level}</option>`).join('')}</select></div><div><label for="daily">每天投入</label><select id="daily" name="daily">${[15,25,45,60].map(minutes => `<option value="${minutes}" ${draft.daily === minutes ? 'selected' : ''}>${minutes} 分钟</option>`).join('')}</select></div><div><label for="days">计划周期</label><select id="days" name="days">${[[7,'1 周'],[14,'2 周'],[30,'1 个月'],[90,'3 个月']].map(([days,label]) => `<option value="${days}" ${draft.days === days ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div><button class="btn primary full" type="submit" ${status.mode !== 'ai' ? 'disabled' : ''}>${plannerBusy ? '<span class="spinner"></span>AI 正在分析需求…' : `让 AI 帮我澄清需求 ${icon('spark')}`}</button></fieldset></form>`;
  } else if (draft.step === 'questions') {
    body = `<h2 id="planner-title">一起确定适合你的方向</h2><p>AI 根据尚未明确、又会影响路线的 ${draft.questionnaire.questions.length} 个问题来澄清需求。每题可以选择方向、自由补充，或让 AI 推荐。</p><div class="planner-summary"><h3>AI 的初步理解</h3><p>${escape(draft.questionnaire.summary)}</p></div><form id="clarification-form"><fieldset class="planner-fields" ${plannerBusy ? 'disabled' : ''}>${draft.questionnaire.questions.map((question, index) => {
      const answer = draft.answers.find(item => item.questionId === question.id) || { optionIds: [], detail: '' };
      return `<fieldset class="clarification-question"><legend>${index + 1}. ${escape(question.question)} <small>${question.type === 'multiple' ? '可多选' : '单选'}</small></legend><p class="question-why">${escape(question.why)}</p><div class="clarification-options">${[...question.options, {id:'unsure',label:'还不确定，请 AI 推荐',description:'规划时会说明建议与假设。'}].map(option => `<label class="clarification-option"><input type="${question.type === 'multiple' ? 'checkbox' : 'radio'}" name="${question.id}" value="${option.id}" ${answer.optionIds.includes(option.id) ? 'checked' : ''}><span><strong>${escape(option.label)}</strong>${option.description ? `<small>${escape(option.description)}</small>` : ''}</span></label>`).join('')}</div><label class="question-detail-label" for="detail-${question.id}">自己的想法或补充（可代替选项）</label><textarea id="detail-${question.id}" name="detail-${question.id}" maxlength="500" rows="2" placeholder="没有合适的选项？可以直接告诉 AI。">${escape(answer.detail)}</textarea></fieldset>`;
    }).join('')}<div class="planner-actions"><button type="button" class="btn secondary" data-action="planner-back">${icon('back')}修改需求</button><button type="button" class="btn secondary" data-action="planner-regenerate">重新梳理问题</button>${draft.questionnaire.questions.length < 4 ? '<button type="button" class="btn secondary" data-action="planner-deepen">深入澄清（4–6 题）</button>' : ''}<button type="submit" class="btn primary">确认我的选择 ${icon('arrow')}</button></div><p class="field-hint">重新梳理或深入澄清会再次调用模型；云端可能计费。成功后替换当前问卷和回答，失败则保留。</p></fieldset></form>`;
  } else {
    const brief = learningBriefFrom({ questionnaire: draft.questionnaire, answers: draft.answers, notes: '' });
    body = `<h2 id="planner-title">确认需求，再规划课程</h2><p>AI 将按这些回答倒推学习成果、必要知识和实践任务。若理解有偏差，请返回修改，或在下方补充。</p><div class="planner-original"><strong>原始需求</strong><p>${escape(draft.goal)}</p><small>${escape(draft.level)} · 每天 ${draft.daily} 分钟 · ${draft.days} 天</small></div>${briefHTML(brief)}<form id="plan-confirm-form"><fieldset class="planner-fields" ${plannerBusy ? 'disabled' : ''}><label for="planner-notes">最后补充：想达成的成果、不想学的内容、工具限制等（可选）</label><textarea id="planner-notes" name="notes" maxlength="1000" rows="3" placeholder="例如：只学能用于工作的内容，不学习编程；最终希望独立完成一份分析报告。">${escape(draft.notes)}</textarea><div class="planner-actions"><button type="button" class="btn secondary" data-action="planner-back">${icon('back')}修改回答</button><button type="submit" class="btn primary">${plannerBusy ? '<span class="spinner"></span>正在定制学习路线…' : `确认并生成学习路线 ${icon('spark')}`}</button></div></fieldset></form>`;
  }
  $('#planner').innerHTML = `<div class="modal-heading"><span class="float-icon lavender">${icon('spark')}</span><button class="icon-button" data-action="close-planner" aria-label="关闭" ${plannerBusy ? 'disabled' : ''}>${icon('close')}</button></div><ol class="planner-steps" aria-label="学习规划进度">${['描述需求','澄清方向','确认并规划'].map((label,index) => `<li ${index === step ? 'aria-current="step"' : ''}>${index + 1} · ${label}</li>`).join('')}</ol><p id="plan-error" class="inline-error" role="alert">${escape(plannerError)}</p>${body}${status.mode !== 'ai' ? `<div class="notice">当前未配置 AI。自定义问卷与路线需要连接模型。</div>${button('体验 Python 示例课程','demo','secondary full','','arrow')}` : '<p class="field-hint">需求和回答将发送到已配置的模型服务；路线生成后，确认后的需求随学习数据保存在本地。生成可能需要一两分钟。</p>'}`;
}
function collectPlannerAnswers(values) {
  return plannerDraft.questionnaire.questions.map(question => ({ questionId: question.id, optionIds: values.getAll(question.id), detail: (values.get(`detail-${question.id}`) || '').trim() }));
}
async function submitPlanner(formId, values) {
  if (plannerBusy) return;
  plannerError = '';
  try {
    if (formId === 'clarification-form') {
      plannerDraft.answers = collectPlannerAnswers(values);
      if (!validClarification({ questionnaire: plannerDraft.questionnaire, answers: plannerDraft.answers, notes: plannerDraft.notes })) throw new Error('请回答每个问题：选择方向、补充自己的想法，或选择“还不确定”。');
      plannerDraft.step = 'review'; return;
    }
    if (status.mode !== 'ai') throw new Error('请先连接 AI 模型，再生成澄清问卷或学习路线。');
    plannerBusy = true;
    if (formId === 'plan-form') {
      const next = { goal: (values.get('goal') || '').trim(), level: values.get('level'), daily: Number(values.get('daily')), days: Number(values.get('days')), depth: values.get('depth') === 'deep' ? 'deep' : 'adaptive' };
      if (!next.goal) throw new Error('请先描述你想学习的内容。');
      const unchanged = plannerDraft.questionnaireFor === JSON.stringify(next);
      Object.assign(plannerDraft, next);
      if (unchanged && plannerDraft.questionnaire) { plannerDraft.step = 'questions'; return; }
      renderPlanner();
      const questionnaire = await api('plan-clarify', next);
      if (!validQuestionnaire(questionnaire)) throw new Error('模型返回的问卷格式不正确，请重新生成。');
      plannerDraft.questionnaire = questionnaire; plannerDraft.questionnaireFor = JSON.stringify(next); plannerDraft.answers = []; plannerDraft.notes = ''; plannerDraft.step = 'questions';
    } else if (formId === 'plan-confirm-form') {
      plannerDraft.notes = (values.get('notes') || '').trim();
      const clarification = { questionnaire: plannerDraft.questionnaire, answers: plannerDraft.answers, notes: plannerDraft.notes };
      if (!validClarification(clarification)) throw new Error('需求回答不完整，请返回修改。');
      renderPlanner();
      const { goal, level, daily, days } = plannerDraft;
      const p = await api('plan', { goal, level, daily, days, clarification });
      await pendingSave;
      if (storageWarning) throw new Error('本地存储有错误，路线尚未保存：' + storageWarning);
      const nextState = { ...state, plans: [...state.plans, p], active: p.id };
      if (desktop) await desktop.savePlan(p);
      else { try { localStorage.setItem(key, JSON.stringify(nextState)); } catch { throw new Error('浏览器本地存储不可用或已满，路线未保存。请释放空间后重试。'); } }
      state = nextState;
      $('#planner').close(); navigate('routes'); toast('定制学习路线已生成，从第一步开始吧。');
      plannerDraft = { step: 'goal', goal: '', level: '零基础', daily: 25, days: 14, questionnaire: null, answers: [], notes: '' };
    }
  } catch (error) { plannerError = error.message; }
  finally { plannerBusy = false; if ($('#planner').open) { renderPlanner(); $('#planner').scrollTop = 0; } }
}
async function openLesson(id, tab = 'read') {
  if (desktop) {
    await pendingSave;
    const detail = await desktop.getLesson(id);
    state.lessons = detail.lesson ? { [id]: detail.lesson } : {};
    state.blockCourses = detail.blockCourse ? { [id]: detail.blockCourse } : {};
    state.reflections = { [id]: detail.reflection };
    state.annotations = { [id]: detail.annotations || [] };
    state.chats = { [id]: detail.chats };
  }
  readingReturn = null; activeLesson = id; lessonTab = ['read', 'quiz', 'chat'].includes(tab) ? tab : 'read'; navigate('study');
}
function knowledgeSource(id, blockId = '', sectionIndex = '') {
  const meta = lessonById(id), course = state.blockCourses?.[id], lesson = contentFor(id);
  const route = state.plans.find(item => item.lessons.some(entry => entry.id === id));
  if (!meta || !route || !lesson) throw new Error('请先生成课程内容。');
  let sourceTitle = meta.title, sourceText = '';
  if (blockId) {
    const block = course?.blocks.find(item => item.id === blockId);
    if (!block?.content?.text || block.type === 'quiz') throw new Error('这一块尚未生成可提炼的正文。');
    sourceTitle = block.title; sourceText = block.content.text;
  } else if (sectionIndex !== '') {
    const section = lesson.sections[Number(sectionIndex)];
    if (!section) throw new Error('这段课程内容不存在。');
    sourceTitle = section.heading; sourceText = section.body;
  } else if (course) {
    sourceText = course.blocks.filter(block => block.type !== 'quiz' && block.content?.text).map(block => `## ${block.title}\n\n${block.content.text}`).join('\n\n');
  } else {
    sourceText = [lesson.intro, ...lesson.sections.map(section => `## ${section.heading}\n\n${section.body}`), `## 具体示例\n\n${lesson.example}`, `## 实践任务\n\n${lesson.challenge}`].join('\n\n');
  }
  const annotationSource = blockId ? `block:${blockId}` : sectionIndex !== '' ? `section:${sectionIndex}` : '';
  const source = { courseTitle: route.title, lessonTitle: meta.title, objective: meta.objective, sourceTitle, sourceText: sourceText.slice(0, 12000), tags: meta.tags.slice(0, 6), personalNotes: personalNotesForSource(state.annotations?.[id], annotationSource) };
  if (!validKnowledgeSource(source)) throw new Error('当前课程内容不足，无法制作知识卡片。');
  return source;
}
function renderKnowledgeDraft() {
  if (!knowledgeDraft) return;
  const { source, result, error } = knowledgeDraft;
  const matches = state.notes.filter(note => note.lessonId === knowledgeDraft.lessonId && (note.title === result?.title || note.tags.some(tag => result?.tags.includes(tag)))).slice(0, 5);
  $('#knowledge-draft-dialog').innerHTML = `<div class="modal-heading"><h2 id="knowledge-draft-title">制作知识卡片</h2><button type="button" class="icon-button" data-action="close-knowledge-draft" aria-label="关闭">${icon('close')}</button></div>
    <p class="field-hint">来源：${escape(source.lessonTitle)} · ${escape(source.sourceTitle)}。${knowledgeDraft.origin === 'ai' ? 'AI 草稿需核验，生成可能消耗模型额度。' : '当前使用课程摘录草稿，请自行核对和提炼。'}</p>
    ${knowledgeBusy && !result ? '<div class="notice">正在提炼草稿，请稍候…</div>' : ''}${error ? `<p class="inline-error" role="alert">${escape(error)}</p>` : ''}
    ${result ? `<form id="knowledge-draft-form">
      <label for="draft-title">知识点标题</label><input id="draft-title" name="title" maxlength="160" required value="${escape(result.title)}">
      <label for="draft-summary">知识描述</label><textarea id="draft-summary" name="summary" maxlength="500" required>${escape(result.summary)}</textarea>
      <label for="draft-topic">主题目录 <small>例如：编程/Python</small></label><input id="draft-topic" name="topic" maxlength="160" required value="${escape(result.topic || result.tags[0] || '未分类')}">
      <label for="draft-content">正文 · Markdown</label><textarea id="draft-content" name="content" maxlength="20000" required>${escape(result.content)}</textarea>
      <div class="knowledge-draft-columns"><div><label for="draft-use">什么时候使用 · 每行一项</label><textarea id="draft-use" name="useWhen" maxlength="6011" placeholder="资料不足可留空">${escape(result.useWhen.join('\n'))}</textarea></div><div><label for="draft-avoid">什么时候不能用 · 每行一项</label><textarea id="draft-avoid" name="avoidWhen" maxlength="6011" placeholder="资料不足可留空">${escape(result.avoidWhen.join('\n'))}</textarea></div></div>
      <label for="draft-tags">标签 · 逗号分隔</label><input id="draft-tags" name="tags" maxlength="245" required value="${escape(result.tags.join('，'))}">
      ${matches.length ? `<div class="notice">本课已有相近卡片：${matches.map(note => escape(note.title)).join('、')}。请确认没有重复后再保存。</div>` : ''}
      <div class="revision-dialog-actions"><button type="button" class="btn secondary" data-action="close-knowledge-draft">取消</button><button type="submit" class="btn primary">确认保存卡片 ${icon('check')}</button></div>
    </form>` : ''}`;
}
async function createNote(id, blockId = '', sectionIndex = '') {
  if (knowledgeBusy) return;
  const source = knowledgeSource(id, blockId, sectionIndex);
  const route = state.plans.find(item => item.lessons.some(entry => entry.id === id));
  knowledgeDraft = { lessonId: id, source, origin: route?.source === 'ai' && status.mode === 'ai' ? 'ai' : 'demo', result: null, error: '' };
  const dialog = $('#knowledge-draft-dialog');
  knowledgeBusy = true; renderKnowledgeDraft(); dialog.showModal();
  try {
    const result = knowledgeDraft.origin === 'ai' ? await api('wiki-draft', source) : localKnowledgeDraft(source);
    const personal = personalNotesMarkdown(source.personalNotes);
    if (personal) result.content = `${result.content.slice(0, Math.max(0, 20000 - personal.length - 2))}\n\n${personal}`;
    if (!validKnowledgeDraft(result)) throw new Error('模型返回的卡片草稿不完整，请重新尝试。');
    if (!knowledgeDraft || knowledgeDraft.lessonId !== id) return;
    knowledgeDraft.result = result;
  } catch (error) { if (knowledgeDraft) knowledgeDraft.error = error.message; }
  finally { knowledgeBusy = false; if (knowledgeDraft) renderKnowledgeDraft(); }
}
function renderKnowledgeOrganize() {
  if (!knowledgeOrganize) return;
  const draft = knowledgeOrganize;
  const proposed = new Map((draft.result?.groups || []).flatMap(group => group.ids.map(id => [id, group.name])));
  const unclassified = draft.cards.filter(card => !card.category).length;
  const eligible = draft.aiScope === 'unclassified' ? draft.cards.filter(card => !card.category) : draft.cards.filter(card => draft.included.has(card.id));
  const available = eligible.length >= 2 && eligible.length <= 80;
  const undo = knowledgeOrganizeUndo.get(draft.courseKey);
  const heading = `<div class="modal-heading"><h2 id="knowledge-organize-title">管理课程主题</h2><button type="button" class="icon-button" data-action="close-organize" aria-label="关闭" ${knowledgeOrganizeBusy ? 'disabled' : ''}>${icon('close')}</button></div><p class="field-hint">${escape(draft.courseTitle)} · ${draft.cards.length} 张卡片。调整只修改知识库归类，不移动 Markdown 文件。</p><div class="knowledge-organize-tabs" role="tablist" aria-label="主题管理方式"><button type="button" role="tab" data-action="organize-tab" data-mode="current" aria-selected="${draft.mode === 'current'}">当前归类</button><button type="button" role="tab" data-action="organize-tab" data-mode="ai" aria-selected="${draft.mode === 'ai'}">AI 建议</button></div>${draft.error ? `<p class="inline-error" role="alert">${escape(draft.error)}</p>` : ''}`;
  const current = `<form id="knowledge-organize-manual-form"><div class="knowledge-organize-list">${draft.cards.map(card => `<label class="knowledge-organize-item"><span><strong>${escape(card.title)}</strong><small>${escape(card.category ? '已固定' : '自动归类')} · 当前：${escape(card.theme)}</small></span><input name="manual:${escape(card.id)}" maxlength="80" required value="${escape(draft.manual.get(card.id) ?? card.theme)}" aria-label="${escape(card.title)}的知识主题"></label>`).join('')}</div><p class="field-hint">直接改成相同的主题名称即可合并；未修改的卡片不会重新保存。</p><div class="revision-dialog-actions">${undo ? '<button type="button" class="btn secondary" data-action="undo-organize">撤销上次整理</button>' : ''}<button type="submit" class="btn primary">保存手动调整 ${icon('check')}</button></div></form>`;
  const scope = `<label for="knowledge-organize-scope">整理范围</label><select id="knowledge-organize-scope"><option value="unclassified" ${draft.aiScope === 'unclassified' ? 'selected' : ''}>只整理未手动归类的卡片（${unclassified} 张）</option><option value="all" ${draft.aiScope === 'all' ? 'selected' : ''}>重新整理本课程（手动分类默认锁定）</option></select><p class="field-hint">打开此页不调用模型；只有点击生成或重新生成才可能消耗额度。</p>`;
  const include = draft.aiScope === 'all' ? `<div class="knowledge-organize-list">${draft.cards.map(card => `<label class="knowledge-organize-choice"><input type="checkbox" name="include:${escape(card.id)}" ${draft.included.has(card.id) ? 'checked' : ''}><span><strong>${escape(card.title)}</strong><small>${card.category ? '已有手动分类，默认锁定' : '自动归类'} · ${escape(card.theme)}</small></span></label>`).join('')}</div>` : '';
  const explanation = !available ? `<p class="notice">${eligible.length < 2 ? '当前可交给 AI 的卡片不足 2 张。可以切换到“重新整理本课程”并主动解锁已有分类，或直接在“当前归类”手动调整。' : '一次最多整理 80 张卡片，请缩小范围。'}</p>` : '';
  const preview = draft.result ? `<form id="knowledge-organize-form"><div class="knowledge-organize-list">${draft.cards.filter(card => proposed.has(card.id)).map(card => { const suggestion = draft.aiDraft.get(card.id) ?? proposed.get(card.id); return `<div class="knowledge-organize-preview"><label class="knowledge-organize-choice"><input type="checkbox" name="apply:${escape(card.id)}" ${draft.aiSelected.has(card.id) ? 'checked' : ''}><span><strong>${escape(card.title)}</strong><small>当前：${escape(card.theme)}</small></span></label><span aria-hidden="true">→</span><input name="suggestion:${escape(card.id)}" maxlength="80" required value="${escape(suggestion)}" aria-label="${escape(card.title)}的建议主题"></div>`; }).join('')}</div><p class="field-hint">只保存勾选且发生变化的卡片；可先编辑建议。未勾选及锁定的卡片保持原样。</p><div class="revision-dialog-actions"><button type="submit" class="btn primary">应用选中的修改 ${icon('check')}</button></div></form>` : '';
  const ai = `${scope}${include}${explanation}<button type="button" class="btn secondary knowledge-organize-generate" data-action="generate-organize" ${knowledgeOrganizeBusy || !available || status.mode !== 'ai' ? 'disabled' : ''}>${knowledgeOrganizeBusy ? '正在生成建议…' : draft.result ? '重新生成建议（可能计费）' : '生成 AI 建议（可能计费）'}</button>${status.mode !== 'ai' ? '<p class="field-hint">配置并启用文字模型后才能生成 AI 建议；手动整理仍可使用。</p>' : ''}${preview}`;
  $('#knowledge-organize-dialog').innerHTML = heading + (draft.mode === 'current' ? current : ai);
}

async function persistKnowledgeCategories(changes) {
  if (!changes.length) return null;
  if (desktop) { await pendingSave; if (storageWarning) throw new Error(storageWarning); }
  const prepared = changes.map(({ id, category, expectedUpdated }, index) => {
    const note = state.notes.find(item => item.id === id);
    if (!note || note.updated !== expectedUpdated) throw new Error('有卡片已在别处修改，请重新打开主题管理。');
    if (category !== undefined && (typeof category !== 'string' || !category.trim() || category.length > 80)) throw new Error('主题名称应为 1–80 字。');
    const before = { ...note };
    const next = { ...note, updated: Math.max(Date.now(), note.updated + 1) + index };
    if (category === undefined) delete next.category; else next.category = category.trim();
    return { note, before, next };
  });
  const saved = [];
  try {
    for (const item of prepared) { if (desktop) await desktop.saveNote(item.next); saved.push(item); }
  } catch (error) {
    const failed = [];
    for (const item of saved.reverse()) {
      try { await desktop.saveNote({ ...item.before, updated: Math.max(Date.now(), item.next.updated + 1) }); }
      catch { failed.push(item); }
    }
    if (failed.length) { storageWarning = '知识主题部分保存且自动恢复失败，请重启应用核对卡片。'; throw new Error(storageWarning); }
    throw new Error(`保存失败，已恢复之前的归类：${error.message}`);
  }
  for (const item of prepared) { Object.assign(item.note, item.next); if (item.next.category === undefined) delete item.note.category; }
  if (!desktop) save();
  return prepared.map(item => ({ id: item.note.id, category: item.before.category, expectedUpdated: item.next.updated }));
}
async function download(name, content, type) {
  if (desktop) { await pendingSave; const saved = await desktop.exportFile(name, content); if (saved) toast('文件已导出。'); return; }
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function markdown(n) { return `# ${n.title}\n\n${n.summary.split('\n').map(line => '> ' + line).join('\n')}\n\n标签：${n.tags.join('、')}\n\n来源课程：${n.courseTitle}\n\n${n.content}\n`; }
async function action(name, element) {
  if (name === 'toggle-syllabus') {
    syllabusCollapsed = !syllabusCollapsed;
    const syllabus = $('#course-syllabus'), layout = $('.study-layout');
    if (syllabus) syllabus.hidden = syllabusCollapsed;
    layout?.classList.toggle('syllabus-collapsed', syllabusCollapsed);
    element.setAttribute('aria-expanded', String(!syllabusCollapsed));
    element.textContent = syllabusCollapsed ? '展开课程目录' : '收起课程目录';
    return;
  }
  if (name === 'toggle-block-collapse') {
    const body = document.getElementById(element.getAttribute('aria-controls'));
    if (!body) return;
    body.hidden = !body.hidden;
    const key = `${element.dataset.id}:${element.dataset.block}`;
    if (body.hidden) collapsedBlocks.add(key); else collapsedBlocks.delete(key);
    element.setAttribute('aria-expanded', String(!body.hidden));
    element.textContent = body.hidden ? '展开' : '收起';
    return;
  }
  if (name === 'add-annotation') {
    if (!pendingAnnotationAnchor || !activeLesson) return;
    annotationDraft = { lessonId: activeLesson, item: { ...pendingAnnotationAnchor, text: '' }, error: '' };
    $('#annotation-quick-add').hidden = true; pendingAnnotationAnchor = null;
    renderAnnotationDialog(); $('#annotation-dialog').showModal(); $('#annotation-text')?.focus(); return;
  }
  if (name === 'open-annotation') {
    const note = (state.annotations?.[activeLesson] || []).find(item => item.id === element.dataset.id);
    if (!note) return;
    annotationDraft = { lessonId: activeLesson, item: { ...note }, error: '' };
    renderAnnotationDialog(); $('#annotation-dialog').showModal(); return;
  }
  if (name === 'close-annotation') { $('#annotation-dialog').close(); annotationDraft = null; return; }
  if (name === 'delete-annotation') {
    if (!annotationDraft?.item.id || !window.confirm('删除这条随文笔记？课程原文不会改变。')) return;
    const lessonId = annotationDraft.lessonId;
    await commitAnnotations(lessonId, (state.annotations?.[lessonId] || []).filter(item => item.id !== annotationDraft.item.id));
    $('#annotation-dialog').close(); annotationDraft = null; toast('随文笔记已删除。'); return;
  }
  if (name === 'clear-model-key' && desktop) {
    const input = $('#' + element.dataset.input), mode = $('#' + element.dataset.keyAction);
    mode.value = mode.value === 'clear' ? 'keep' : 'clear';
    input.value = '';
    dirtyModelForm(input.closest('form'));
    return;
  }
  const id = element.dataset.id;
  if (name === 'open-speech') return openSpeech(id, element.dataset.block || visibleSpeechBlock());
  if (name === 'close-speech') { if (!speechBusy) { stopSpeechPlayback(); $('#speech-dialog').close(); } return; }
  if (name === 'stop-speech') return stopSpeechPlayback();
  if (name === 'play-speech-turn') return playSpeech([Number(element.dataset.index)]);
  if (name === 'play-speech-all') return playSpeech(speechDraft.plan.turns.map((_turn, index) => index));
  if (name === 'check-speech-connection' && desktop) {
    element.disabled = true;
    try { speechConnectionResult = (await desktop.checkSpeechConnection()).message; }
    catch (error) { speechConnectionResult = error.message; }
    finally { element.disabled = false; $('#speech-connection-result').textContent = speechConnectionResult; }
    return;
  }
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
  if (name === 'close-planner') { if (!plannerBusy) $('#planner').close(); return; }
  if (['planner-regenerate', 'planner-deepen'].includes(name)) {
    if (plannerBusy || plannerDraft.step !== 'questions') return;
    plannerDraft.answers = collectPlannerAnswers(new FormData($('#clarification-form')));
    if (!window.confirm(`${name === 'planner-deepen' ? '深入澄清并生成 4–6 题' : '重新分析需求并生成一份新问卷'}？成功后会替换当前问卷和回答；云端模型可能计费。`)) return;
    plannerDraft.questionnaireFor = null;
    return submitPlanner('plan-form', new Map([['goal', plannerDraft.goal], ['level', plannerDraft.level], ['daily', plannerDraft.daily], ['days', plannerDraft.days], ['depth', name === 'planner-deepen' ? 'deep' : plannerDraft.depth || 'adaptive']]));
  }
  if (name === 'planner-back') {
    if (plannerBusy) return;
    if (plannerDraft.step === 'questions') { plannerDraft.answers = collectPlannerAnswers(new FormData($('#clarification-form'))); plannerDraft.step = 'goal'; }
    else if (plannerDraft.step === 'review') { plannerDraft.notes = $('#planner-notes').value; plannerDraft.step = 'questions'; }
    plannerError = ''; renderPlanner(); $('#planner').scrollTop = 0; return;
  }
  if (['routes', 'practice'].includes(name)) return navigate(name);
  if (name === 'start') return openLesson(nextLesson().id);
  if (name === 'demo') { $('#planner').close(); state.active = demoPlan.id; persist('setActivePlan', demoPlan.id); return navigate('routes'); }
  if (name === 'switch-plan') { state.active = id; activeLesson = null; persist('setActivePlan', id); return render(); }
  if (name === 'delete-plan') {
    const target = state.plans.find(route => route.id === id);
    if (!target || state.plans.length <= 1) throw new Error('至少保留一条学习路线。');
    if (storageWarning) throw new Error('当前本地存储有错误，请先处理后再删除。');
    if (desktop) {
      await pendingSave;
      const result = await desktop.deletePlan(id);
      if (!result) return;
      state = result.state; activeLesson = null; activeNote = null; answer = null;
      navigate('routes'); toast(result.warnings?.length ? `路线已删除，但有 ${result.warnings.length} 项文件未清理：${result.warnings.join('；')}` : '路线及关联的图片、语音和历史备份已清理。');
      return;
    }
    const lessonIds = new Set(target.lessons.map(lesson => lesson.id));
    const notesCount = state.notes.filter(note => lessonIds.has(note.lessonId)).length;
    if (!window.confirm(`删除「${target.title}」及其 ${lessonIds.size} 节课程、练习记录和 ${notesCount} 张 Wiki 卡片？删除前会在浏览器保存可恢复备份。`)) return;
    const backupKey = `${deletedBackupPrefix}${Date.now()}-${crypto.randomUUID()}`;
    const next = structuredClone(state);
    next.plans = next.plans.filter(route => route.id !== id);
    if (next.active === id) next.active = next.plans[0].id;
    for (const lessonId of lessonIds) for (const collection of ['lessons', 'blockCourses', 'progress', 'reflections', 'chats']) if (next[collection]) delete next[collection][lessonId];
    next.notes = next.notes.filter(note => !lessonIds.has(note.lessonId));
    try { localStorage.setItem(backupKey, JSON.stringify(state)); localStorage.setItem(key, JSON.stringify(next)); }
    catch { throw new Error('浏览器空间不足，无法先保存删除前备份；路线未删除。'); }
    state = next; activeLesson = null; activeNote = null; answer = null; navigate('routes'); toast('路线已删除，可用“恢复最近删除”撤销。'); return;
  }
  if (name === 'restore-deleted-plan' && !desktop) {
    const backupKey = recentDeleteBackup();
    if (!backupKey || !window.confirm('恢复最近一次删除前的完整学习记录？这会覆盖删除之后的新修改。')) return;
    const raw = localStorage.getItem(backupKey), restored = JSON.parse(raw);
    if (restored?.version !== 1 || !Array.isArray(restored.plans) || !restored.plans.length || !restored.plans.some(route => route.id === restored.active)) throw new Error('删除前备份格式不正确，未覆盖现有记录。');
    localStorage.setItem(key, raw); localStorage.removeItem(backupKey);
    state = restored; activeLesson = null; activeNote = null; answer = null; navigate('routes'); toast('已恢复删除前的学习记录。'); return;
  }
  if (name === 'open-lesson') return openLesson(id);
  if (name === 'open-quiz') return openLesson(id, 'quiz');
  if (name === 'quick-ask') return switchLessonTab('chat', true);
  if (name === 'back-to-reading') return switchLessonTab('read');
  if (name === 'lesson-tab') return switchLessonTab(element.dataset.tab);
  if (name === 'quiz' || name === 'read-tab') return switchLessonTab(name === 'quiz' ? 'quiz' : 'read');
  if (name === 'generate-lesson') {
    const meta = lessonById(id), p = state.plans.find(p => p.lessons.some(l => l.id === id));
    const outline = await api('lesson-outline', { goal: p.goal, level: p.level, ...(p.learningBrief ? { learningBrief: p.learningBrief } : {}), title: meta.title, objective: meta.objective, route: p.lessons.map(({ title, objective }) => ({ title, objective })), lessonPosition: p.lessons.findIndex(lesson => lesson.id === id) + 1 });
    if (!validOutline(outline)) throw new Error('模型返回的大纲格式不正确，请重试。');
    const course = desktop ? await desktop.saveOutline(id, outline) : { intro: outline.intro, blocks: outline.blocks.map(block => ({ id: crypto.randomUUID(), ...block, content: null })) };
    state.blockCourses ||= {}; state.blockCourses[id] = course; if (!desktop) save(); render(); return;
  }
  if (name === 'generate-block') {
    const block = state.blockCourses?.[id]?.blocks.find(item => item.id === element.dataset.block);
    if (!block || block.content) throw new Error('内容块不存在或已生成。');
    const meta = lessonById(id), p = state.plans.find(plan => plan.lessons.some(item => item.id === id));
    const context = blockGenerationContext(state.blockCourses[id], block.id);
    const content = await api('lesson-block', { goal: p.goal, level: p.level, ...(p.learningBrief ? { learningBrief: p.learningBrief } : {}), title: meta.title, objective: meta.objective, minutes: meta.minutes, ...context, block: { type: block.type, title: block.title, objective: block.objective } });
    if (!validBlockContent(block.type, content)) throw new Error('模型返回的内容格式不正确，请重试。');
    if (desktop) await desktop.saveBlock(id, block.id, content);
    block.content = content;
    if (block.type === 'quiz' && state.progress[id]) state.progress[id] = { ...state.progress[id], completed: false, lastScore: 0, lastAnswers: [] };
    if (!desktop) save(); render(); return;
  }
  if (name === 'check-image-connection') {
    try { const result = await desktop.checkImageConnection(); imageConnectionResult = result.message; }
    catch (error) { imageConnectionResult = '服务检查失败：' + error.message; }
    if ($('#image-connection-result')) $('#image-connection-result').textContent = imageConnectionResult;
    return;
  }
  if (name === 'close-illustration') { if (!illustrationBusy) $('#illustration-dialog').close(); return; }
  if (name === 'open-commons-source') { if (!desktop) return; await desktop.openCommonsSource(element.dataset.url); return; }
  if (name === 'open-image-source') { if (!desktop) return; await desktop.openImageSource(element.dataset.url); return; }
  if (name === 'web-search-settings') {
    if (illustrationBusy) return;
    $('#illustration-dialog').close(); page = 'settings'; render(); $('.web-search-settings-panel').scrollIntoView({ block: 'start' }); return;
  }
  if (name === 'image-search-provider') {
    if (illustrationBusy || !illustrationDraft || !['commons', 'web'].includes(element.dataset.provider)) return;
    illustrationDraft.searchProvider = element.dataset.provider; illustrationDraft.results = []; illustrationDraft.recommendation = ''; illustrationDraft.warning = ''; illustrationDraft.searched = false; illustrationDraft.error = ''; renderIllustrationDialog(); return;
  }
  if (name === 'illustration-mode') {
    if (illustrationBusy || !illustrationDraft || !['generate', 'search'].includes(element.dataset.mode)) return;
    if ($('#illustration-prompt')) illustrationDraft.prompt = $('#illustration-prompt').value;
    if ($('#illustration-caption')) illustrationDraft.caption = $('#illustration-caption').value;
    if ($('#commons-query')) illustrationDraft.query = $('#commons-query').value;
    if ($('#commons-caption')) illustrationDraft.webCaption = $('#commons-caption').value;
    illustrationDraft.mode = element.dataset.mode; illustrationDraft.error = ''; renderIllustrationDialog(); return;
  }
  if (name === 'auto-search-commons') {
    if (!desktop || !illustrationDraft || illustrationBusy) return;
    illustrationBusy = true; illustrationDraft.error = ''; illustrationDraft.warning = ''; renderIllustrationDialog();
    try {
      const result = illustrationDraft.searchProvider === 'commons' ? await desktop.autoSearchCommonsImages(illustrationDraft.lessonId, illustrationDraft.blockId) : await desktop.autoSearchWebImages(illustrationDraft.lessonId, illustrationDraft.blockId);
      illustrationDraft.query = result.query; illustrationDraft.results = result.results; illustrationDraft.searched = true; illustrationDraft.selectedPageId = null;
      illustrationDraft.recommendation = result.recommendation || '';
      illustrationDraft.warning = result.warning || '';
    } catch (error) { illustrationDraft.error = 'AI 找图失败：' + error.message; }
    finally { illustrationBusy = false; renderIllustrationDialog(); }
    return;
  }
  if (name === 'illustration-download-settings') {
    if (illustrationBusy) return;
    $('#illustration-dialog').close(); page = 'settings'; render(); $('.image-settings-panel').scrollIntoView({ block: 'start' }); return;
  }
  if (name === 'discard-illustration-download') {
    if (illustrationBusy || !illustrationDraft?.pendingDownload) return;
    if (!window.confirm('放弃待下载结果后，再次生成可能重复计费。确定放弃这次结果吗？')) return;
    const draft = illustrationDraft;
    await desktop.discardIllustrationDownload(draft.lessonId, draft.blockId, draft.pendingDownload.id);
    delete draft.pendingDownload; delete draft.error; renderIllustrationDialog(); return;
  }
  if (name === 'request-illustration') {
    if (!desktop) throw new Error('配图功能仅在桌面版提供。');
    if (illustrationBusy) throw new Error('正在处理配图，请稍候。');
    const id = element.dataset.id, block = state.blockCourses?.[id]?.blocks.find(item => item.id === element.dataset.block);
    if (!block?.content || !assistedBlockTypes.includes(block.type)) throw new Error('请先生成讲解、案例或实践任务。');
    const proposal = (['commons', 'web'].includes(block.content.illustration?.source) ? null : block.content.illustration) || block.content.imageProposal;
    let pending;
    illustrationBusy = true;
    try { pending = await desktop.getPendingIllustration?.(id, block.id); }
    catch (error) { illustrationBusy = false; throw error; }
    illustrationDraft = { lessonId: id, blockId: block.id, expectedText: block.content.text, expectedImageId: block.content.illustration?.id || '', prompt: proposal?.prompt || '', caption: proposal?.caption || block.title, webCaption: block.content.illustration?.caption || block.title, query: block.title.slice(0, 100), mode: imageSettings?.enabled ? 'generate' : 'search', searchProvider: 'web', results: [], searched: false, reason: proposal ? '可修改生成提示词，或切换到在线找图。' : '可以让 AI 生成示意图，或使用百炼文搜图获取互联网图片候选。' };
    if (pending?.pendingDownload) Object.assign(illustrationDraft, { prompt: pending.prompt, caption: pending.caption, pendingDownload: pending.pendingDownload, error: pending.error, reason: '上次图片下载或保存未完成，可以重用已有结果，不需要再次生成。' });
    illustrationBusy = illustrationDraft.mode === 'generate' && !pending?.pendingDownload && !proposal && status.mode === 'ai';
    renderIllustrationDialog(); $('#illustration-dialog').showModal();
    if (!illustrationBusy) {
      if (illustrationDraft.mode === 'generate' && !pending?.pendingDownload && !proposal) { illustrationDraft.reason = '文字模型尚未连接，无法自动分析；你也可以自己填写图片提示词。'; renderIllustrationDialog(); }
      return;
    }
    try {
      const suggestion = await desktop.suggestIllustration(id, block.id);
      illustrationDraft.reason = suggestion.reason + (suggestion.needed ? '' : ' 如仍想配图，可以填写自己的提示词。');
      if (suggestion.needed && validImageProposal(suggestion)) { illustrationDraft.prompt = suggestion.prompt; illustrationDraft.caption = suggestion.caption; }
    } catch (error) { illustrationDraft.reason = 'AI 配图分析失败：' + error.message + ' 你仍可自己填写提示词。'; }
    finally { illustrationBusy = false; renderIllustrationDialog(); }
    return;
  }
  if (name === 'request-revision') {
    const block = state.blockCourses?.[id]?.blocks.find(item => item.id === element.dataset.block);
    if (!block?.content || !assistedBlockTypes.includes(block.type)) throw new Error('请先生成讲解、案例或实践任务。');
    if (status.mode !== 'ai') throw new Error('请先在设置中连接 AI 模型。');
    const title = block.type === 'reading' ? '按你的需求重新讲解' : block.type === 'practice' ? '按你的需求调整实践任务' : '按你的需求更换案例';
    const description = block.type === 'practice' ? '告诉 AI 希望调整的场景、材料、步骤或难度，保持本模块的学习目标。' : '告诉 AI 哪里没讲清楚，以及你希望怎样解释。';
    const placeholder = block.type === 'practice' ? '例如：改成日常会议听力，提供可朗读的英文原文；降低难度，列出操作步骤和完成标准，不直接给出完整答案。' : '例如：术语太多，请从基础概念开始，用编号步骤和一个具体案例解释；数据比较请用普通表格。';
    $('#revise-block-dialog').innerHTML = `<div class="modal-heading"><h2 id="revise-block-title">${title}</h2><button class="icon-button" data-action="close-revision" aria-label="关闭">${icon('close')}</button></div><p>当前模块：${escape(block.title)}。${description}</p><form id="revision-form" data-id="${escape(id)}" data-block="${escape(block.id)}"><div class="revision-request-heading"><label for="revision-request">你的具体要求</label><button type="button" class="text-button" data-action="markdown-revision-preset">仅优化排版</button></div><textarea id="revision-request" name="request" required maxlength="1000" placeholder="${placeholder}"></textarea><p class="field-hint">新内容支持 Markdown 标题、重点、列表、普通表格和程序代码。只替换当前模块，其他内容和学习进度不变。保留最近 10 个旧版本；已保存的 Wiki 不会自动改写。</p><p id="revision-error" class="inline-error" role="alert"></p><div class="revision-dialog-actions"><button type="button" class="btn secondary" data-action="close-revision">取消</button><button type="submit" class="btn primary">按要求重新生成 ${icon('spark')}</button></div></form>`;
    $('#revise-block-dialog').showModal(); return;
  }
  if (name === 'markdown-revision-preset') {
    if (revisionBusy) return;
    $('#revision-request').value = '请仅优化当前内容的阅读排版，保留原有概念、事实、数值、案例、代码和关键说明，不额外扩充主题。按 Markdown 文档组织：用 ## 划分主题，用 ### 划分子主题；关键定义和结论使用少量 **加粗**；并列要点用列表，操作步骤用编号列表，提示和易错点用 > 引用块；代码使用标明语言的代码围栏。不要重复模块大标题，不要把整篇正文放进一个代码围栏。';
    $('#revision-request').focus(); return;
  }
  if (name === 'close-revision') { if (!revisionBusy) $('#revise-block-dialog').close(); return; }
  if (name === 'restore-block') {
    const block = state.blockCourses?.[id]?.blocks.find(item => item.id === element.dataset.block);
    if (!block?.content) throw new Error('内容块不存在。');
    if (!window.confirm('恢复这一模块的上一版内容？其他模块、练习成绩和 Wiki 不会改变。')) return;
    block.content = desktop ? await desktop.restoreBlock(id, block.id, block.content.text) : restoredContent(block.type, block.content);
    if (!desktop) save(); render(); toast('已恢复上一版内容。'); return;
  }
  if (name === 'create-note') return createNote(id, element.dataset.block || '', element.dataset.section ?? '');
  if (name === 'close-knowledge-draft') { if (!knowledgeBusy) { $('#knowledge-draft-dialog').close(); knowledgeDraft = null; } return; }
  if (name === 'open-note') { activeNote = id; return navigate('wiki'); }
  if (name === 'open-organize') {
    if (knowledgeOrganizeBusy) return;
    const course = courseKnowledgeTree(state.notes, state.plans).children.flatMap(domain => domain.children).find(item => item.key === element.dataset.course);
    if (!course) throw new Error('课程目录已变化，请刷新后重试。');
    const themes = new Map(course.children.flatMap(theme => theme.cards.map(card => [card.id, theme.name])));
    const cards = course.noteIds.map(noteId => state.notes.find(note => note.id === noteId)).filter(Boolean).map(({ id, title, summary, tags, updated, category }) => ({ id, title, summary, tags, updated, category, theme: themes.get(id) || '课程要点' }));
    knowledgeOrganize = { courseKey: course.key, courseTitle: course.name, cards, existingThemes: course.children.map(theme => theme.name).filter(name => name !== '课程要点').slice(0, 12), mode: 'current', manual: new Map(cards.map(card => [card.id, card.theme])), aiScope: 'unclassified', included: new Set(cards.filter(card => !card.category).map(card => card.id)), aiDraft: new Map(), aiSelected: new Set(), result: null, error: '' };
    renderKnowledgeOrganize(); $('#knowledge-organize-dialog').showModal(); return;
  }
  if (name === 'close-organize') { if (!knowledgeOrganizeBusy) { $('#knowledge-organize-dialog').close(); knowledgeOrganize = null; } return; }
  if (name === 'organize-tab') { if (!knowledgeOrganize || knowledgeOrganizeBusy) return; knowledgeOrganize.mode = element.dataset.mode === 'ai' ? 'ai' : 'current'; knowledgeOrganize.error = ''; renderKnowledgeOrganize(); return; }
  if (name === 'undo-organize') {
    if (!knowledgeOrganize || knowledgeOrganizeBusy) return;
    const undo = knowledgeOrganizeUndo.get(knowledgeOrganize.courseKey);
    if (!undo) return;
    knowledgeOrganizeBusy = true;
    try {
      await persistKnowledgeCategories(undo);
      knowledgeOrganizeUndo.delete(knowledgeOrganize.courseKey);
      $('#knowledge-organize-dialog').close(); knowledgeOrganize = null;
      refreshKnowledgeResults(); toast('已撤销上次课程主题整理。');
    } catch (error) { knowledgeOrganize.error = error.message; }
    finally { knowledgeOrganizeBusy = false; if (knowledgeOrganize) renderKnowledgeOrganize(); }
    return;
  }
  if (name === 'generate-organize') {
    if (!knowledgeOrganize || knowledgeOrganizeBusy || status.mode !== 'ai') return;
    const cards = knowledgeOrganize.cards.filter(card => knowledgeOrganize.aiScope === 'unclassified' ? !card.category : knowledgeOrganize.included.has(card.id));
    if (cards.length < 2 || cards.length > 80) { knowledgeOrganize.error = '请选中 2–80 张卡片后再生成建议。'; renderKnowledgeOrganize(); return; }
    knowledgeOrganizeBusy = true; knowledgeOrganize.error = ''; renderKnowledgeOrganize();
    try {
      const result = await api('knowledge-organize', { courseTitle: knowledgeOrganize.courseTitle, existingThemes: knowledgeOrganize.existingThemes, cards: cards.map(({ id, title, summary, tags }) => ({ id, title, summary, tags })) });
      if (!validKnowledgeOrganization(result, cards.map(card => card.id))) throw new Error('模型返回的归类不完整，请重试。');
      knowledgeOrganize.result = result;
      const proposed = new Map(result.groups.flatMap(group => group.ids.map(cardId => [cardId, group.name])));
      knowledgeOrganize.aiDraft = proposed;
      knowledgeOrganize.aiSelected = new Set(cards.filter(card => proposed.get(card.id) !== card.theme).map(card => card.id));
    } catch (error) { knowledgeOrganize.error = error.message; }
    finally { knowledgeOrganizeBusy = false; if (knowledgeOrganize) renderKnowledgeOrganize(); }
    return;
  }
  if (name === 'switch-wiki-view') {
    knowledgeView = ['tree', 'chat', 'graph'].includes(element.dataset.view) ? element.dataset.view : 'tree';
    graphViewport = null; suppressedGraphHoverId = '';
    document.querySelectorAll('.wiki-view-switch [role="tab"]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.view === knowledgeView)));
    refreshKnowledgeResults(); return;
  }
  if (name === 'toggle-folder') {
    const expanded = element.getAttribute('aria-expanded') !== 'true';
    folderOverrides.set(element.dataset.folder, expanded);
    element.setAttribute('aria-expanded', String(expanded));
    element.setAttribute('aria-label', `${expanded ? '折叠' : '展开'} ${element.dataset.name}`);
    element.querySelector('.wiki-tree-expander').textContent = expanded ? '▾' : '▸';
    element.closest('.wiki-tree-folder').querySelector('.wiki-tree-children').hidden = !expanded; return;
  }
  if (name === 'filter-topic') { topicFilter = element.dataset.topic || ''; selectedGraphId = ''; graphLocalTwoHop = false; graphViewport = null; refreshKnowledgeResults(); return; }
  if (name === 'select-graph-node') {
    const deselect = selectedGraphId === id;
    selectedGraphId = deselect ? '' : id;
    if (deselect) graphLocalTwoHop = false;
    suppressedGraphHoverId = deselect ? id : '';
    refreshKnowledgeResults(); return;
  }
  if (name === 'graph-orphans') { graphOrphansOnly = !graphOrphansOnly; graphLocalTwoHop = false; selectedGraphId = ''; graphViewport = null; refreshKnowledgeResults(); return; }
  if (name === 'graph-local') { if (!selectedGraphId.startsWith('card:')) return; graphLocalTwoHop = !graphLocalTwoHop; graphOrphansOnly = false; graphViewport = null; refreshKnowledgeResults(); return; }
  if (name === 'graph-pause') {
    graphPaused = !graphPaused;
    element.setAttribute('aria-pressed', String(graphPaused)); element.textContent = graphPaused ? '继续运动' : '暂停运动';
    if (graphPaused && graphFrame) { window.cancelAnimationFrame?.(graphFrame); graphFrame = 0; }
    if (!graphPaused && graphMotion && !graphFrame) { graphMotion.alpha = Math.max(graphMotion.alpha, .25); graphFrame = window.requestAnimationFrame?.(animateGraphMotion) || 0; }
    return;
  }
  if (name === 'graph-fit') { graphViewport = null; const svg = $('#knowledge-graph-svg'); if (svg) svg.setAttribute('viewBox', `0 0 ${svg.dataset.graphWidth} ${svg.dataset.graphHeight}`); return; }
  if (name === 'graph-refresh') { stopGraphMotion(); graphPositions.clear(); graphViewport = null; refreshKnowledgeResults(); return; }
  if (name === 'graph-zoom-in') { zoomKnowledgeGraph(.78); return; }
  if (name === 'graph-zoom-out') { zoomKnowledgeGraph(1.28); return; }
  if (name === 'graph-reset') { graphViewport = null; refreshKnowledgeResults(); return; }
  if (name === 'close-note') { activeNote = null; return render(); }
  if (name === 'note-view') {
    const mode = element.dataset.mode;
    if (!['read', 'edit'].includes(mode) || !$('#note-form')) return;
    if (mode === 'read') updateNotePreview();
    $('#note-source-view').hidden = mode !== 'edit';
    $('#note-preview-view').hidden = mode !== 'read';
    $('#note-save').hidden = mode !== 'edit';
    $('#note-read-switch').setAttribute('aria-pressed', String(mode === 'read'));
    $('#note-edit-switch').setAttribute('aria-pressed', String(mode === 'edit')); return;
  }
  if (name === 'source-lesson') { const p = state.plans.find(p => p.lessons.some(l => l.id === id)); if (p) { state.active = p.id; persist('setActivePlan', p.id); return openLesson(id); } }
  if (name === 'export-data') { if (desktop) { await pendingSave; if (await desktop.exportBackup()) toast('完整学习备份已导出。'); return; } return download('learnflow-backup.json', JSON.stringify(state, null, 2), 'application/json'); }
  if (name === 'export-wiki') return download('我的知识库.md', state.notes.map(markdown).join('\n---\n\n'), 'text/markdown;charset=utf-8');
  if (name === 'export-note') { const n = state.notes.find(n => n.id === id); if (desktop) await pendingSave; return download(n.title.replace(/[<>:"/\\|?*]/g, '-') + '.md', desktop ? await desktop.cardMarkdown(id) : markdown(n), 'text/markdown;charset=utf-8'); }
  if (name === 'delete-note') {
    const note = state.notes.find(item => item.id === id);
    if (!note) throw new Error('知识卡片不存在，请刷新后重试。');
    if (storageWarning) throw new Error('当前本地存储有错误，请先处理后再删除。');
    if (desktop) {
      await pendingSave;
      if (storageWarning) throw new Error(storageWarning);
      const result = await desktop.deleteNote(id);
      if (!result) return;
      state.notes = state.notes.filter(item => item.id !== id);
    } else {
      if (!window.confirm(`删除知识卡片「${note.title}」？未保存的修改会丢失。卡片将从当前知识库移除；已有导出或历史备份可能仍保留副本。`)) return;
      const next = { ...state, notes: state.notes.filter(item => item.id !== id) };
      try { localStorage.setItem(key, JSON.stringify(next)); }
      catch { throw new Error('浏览器存储写入失败，卡片未删除。'); }
      state = next;
    }
    knowledgeOrganizeUndo.clear();
    activeNote = null; answer = null;
    render(); toast('知识卡片已删除；来源课程和其他卡片保持不变。');
    return;
  }
}
document.addEventListener('click', event => {
  const owner = event.target.closest?.('.more-learning-tools');
  const chosenAction = event.target.closest?.('.more-learning-tools-menu [data-action]');
  document.querySelectorAll?.('.more-learning-tools[open]').forEach(menu => {
    if (menu !== owner || chosenAction) menu.open = false;
  });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') document.querySelectorAll?.('.more-learning-tools[open]').forEach(menu => { menu.open = false; });
});
document.addEventListener('click', async event => {
  const element = event.target.closest('[data-page], [data-action]'); if (!element || element.disabled) return;
  event.preventDefault();
  if (element.dataset.page) { activeNote = null; return element.dataset.page === 'study' ? openLesson(activeLesson || nextLesson().id, lessonTab) : navigate(element.dataset.page); }
  const loading = ['generate-lesson', 'generate-block', 'restore-block', 'create-note', 'test-connection', 'check-image-connection', 'delete-note'].includes(element.dataset.action);
  const html = element.innerHTML;
  try { if (loading) { element.disabled = true; element.innerHTML = '<span class="spinner"></span>正在整理，请稍候…'; } await action(element.dataset.action, element); }
  catch (e) { toast(e.message); }
  finally { if (loading && element.isConnected) { element.disabled = false; element.innerHTML = html; } }
});
document.addEventListener('pointerup', event => {
  if (event.target.closest?.('#annotation-quick-add, #annotation-dialog')) return;
  if (page === 'study' && lessonTab === 'read') setTimeout(showAnnotationShortcut, 0);
});
document.addEventListener('keyup', event => {
  if (page === 'study' && lessonTab === 'read' && event.target.closest?.('.annotatable')) showAnnotationShortcut();
});
document.addEventListener('cancel', event => {
  if (event.target.id === 'revise-block-dialog' && revisionBusy) event.preventDefault();
  if (event.target.id === 'planner' && plannerBusy) event.preventDefault();
  if (event.target.id === 'illustration-dialog' && illustrationBusy) event.preventDefault();
  if (event.target.id === 'knowledge-draft-dialog' && knowledgeBusy) event.preventDefault();
}, true);
document.addEventListener('input', event => {
  if (!['model-provider', 'image-protocol'].includes(event.target.id)) dirtyModelForm(event.target.closest?.('form'));
  if (!plannerBusy && event.target.closest?.('#planner')) {
    if (event.target.id === 'goal') plannerDraft.goal = event.target.value;
    if (event.target.id === 'planner-notes') plannerDraft.notes = event.target.value;
    if (event.target.id.startsWith('detail-')) plannerDraft.answers = collectPlannerAnswers(new FormData($('#clarification-form')));
  }
  if (event.target.id === 'wiki-search') { query = event.target.value; graphViewport = null; selectedGraphId = ''; graphLocalTwoHop = false; refreshKnowledgeResults(); }
  if (event.target.id === 'graph-search') {
    query = event.target.value; const caret = event.target.selectionStart;
    const search = $('#wiki-search'); if (search) search.value = query;
    graphViewport = null; selectedGraphId = ''; graphLocalTwoHop = false; refreshKnowledgeResults();
    const next = $('#graph-search'); next?.focus(); if (Number.isInteger(caret)) next?.setSelectionRange(caret, caret);
  }
  if (event.target.id === 'graph-spacing') {
    graphSpacing = Math.max(.6, Math.min(1.8, Number(event.target.value) || 1));
    if (graphMotion) { graphMotion.alpha = Math.max(graphMotion.alpha, .55); if (!graphPaused && !graphFrame) graphFrame = window.requestAnimationFrame?.(animateGraphMotion) || 0; }
  }
});
document.addEventListener('wheel', event => {
  if (!event.target.closest?.('.knowledge-graph-canvas')) return;
  event.preventDefault();
  zoomKnowledgeGraph(event.deltaY < 0 ? .9 : 1.1);
}, { passive: false });
document.addEventListener('pointerover', event => {
  const node = event.target.closest?.('#knowledge-graph-svg .graph-node');
  if (!node || graphDrag) return;
  if (suppressedGraphHoverId && node.dataset.id !== suppressedGraphHoverId) suppressedGraphHoverId = '';
  if (node.dataset.id === suppressedGraphHoverId || hoveredGraphId === node.dataset.id) return;
  hoveredGraphId = node.dataset.id; applyGraphFocus();
});
document.addEventListener('pointerout', event => {
  const node = event.target.closest?.('#knowledge-graph-svg .graph-node');
  if (!node || !node.isConnected || event.relatedTarget?.closest?.('.graph-node') === node) return;
  if (suppressedGraphHoverId === node.dataset.id) suppressedGraphHoverId = '';
  if (hoveredGraphId === node.dataset.id) { hoveredGraphId = ''; applyGraphFocus(); }
});
document.addEventListener('pointerdown', event => {
  const svg = event.target.closest?.('#knowledge-graph-svg');
  if (!svg) return;
  const target = event.target.closest?.('.graph-node');
  if (target && graphMotion) {
    const node = graphMotion.nodes[graphMotion.byId.get(target.dataset.id)];
    if (!node) return;
    node.fixed = true;
    graphDrag = { kind: 'node', svg, node, x: event.clientX, y: event.clientY };
    return;
  }
  graphDrag = { kind: 'canvas', svg, x: event.clientX, y: event.clientY };
  svg.classList.add('dragging');
});
document.addEventListener('pointermove', event => {
  if (!graphDrag || !graphDrag.svg.isConnected) return;
  const { svg } = graphDrag;
  if (graphDrag.kind === 'node') {
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const position = point.matrixTransform(svg.getScreenCTM().inverse());
    graphDrag.node.x = position.x; graphDrag.node.y = position.y;
    graphDrag.node.vx = graphDrag.node.vy = 0;
    paintGraphMotion(); return;
  }
  const [x, y, width, height] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  setGraphViewport(svg, x - (event.clientX - graphDrag.x) * width / rect.width, y - (event.clientY - graphDrag.y) * height / rect.height, width, height);
  graphDrag.x = event.clientX; graphDrag.y = event.clientY;
});
document.addEventListener('pointerup', () => {
  if (graphDrag?.kind === 'node') {
    graphDrag.node.fixed = false;
    if (graphMotion) { graphMotion.alpha = Math.max(graphMotion.alpha, .5); if (!graphPaused && !graphFrame) graphFrame = window.requestAnimationFrame?.(animateGraphMotion) || 0; }
  }
  graphDrag?.svg.classList.remove('dragging'); graphDrag = null;
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && graphMotion && !graphPaused && !graphFrame) graphFrame = window.requestAnimationFrame?.(animateGraphMotion) || 0;
});
document.addEventListener('change', event => {
  if (event.target.id === 'graph-topic') { topicFilter = event.target.value; selectedGraphId = ''; graphLocalTwoHop = false; graphViewport = null; refreshKnowledgeResults(); return; }
  if (event.target.id === 'graph-tag') { graphTagFilter = event.target.value; selectedGraphId = ''; graphLocalTwoHop = false; graphViewport = null; refreshKnowledgeResults(); return; }
  if (event.target.id === 'graph-type') { graphTypeFilter = event.target.value; selectedGraphId = ''; graphLocalTwoHop = false; graphViewport = null; refreshKnowledgeResults(); return; }
  if (event.target.id === 'graph-status') { graphStatusFilter = event.target.value; selectedGraphId = ''; graphLocalTwoHop = false; graphViewport = null; refreshKnowledgeResults(); return; }
  if (event.target.id === 'graph-relation') { graphRelationFilter = event.target.value; selectedGraphId = ''; graphLocalTwoHop = false; graphViewport = null; refreshKnowledgeResults(); return; }
  if (!plannerBusy && event.target.closest?.('#planner')) {
    if (event.target.id === 'level') plannerDraft.level = event.target.value;
    if (['daily','days'].includes(event.target.id)) plannerDraft[event.target.id] = Number(event.target.value);
    if (event.target.closest('.clarification-question')) {
      if (event.target.type === 'checkbox' && event.target.checked) {
        for (const input of event.target.closest('.clarification-question').querySelectorAll('input[type=checkbox]')) {
          if (input !== event.target && (event.target.value === 'unsure' || input.value === 'unsure')) input.checked = false;
        }
      }
      plannerDraft.answers = collectPlannerAnswers(new FormData($('#clarification-form')));
    }
  }
  if (desktop && event.target.id === 'model-provider') {
    switchModelProfile($('#desktop-settings-form')); return;
  }
  if (desktop && event.target.id === 'image-protocol') {
    switchModelProfile($('#image-settings-form')); return;
  }
  dirtyModelForm(event.target.closest?.('form'));
});
document.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const values = new FormData(form);
  if (form.id === 'annotation-form') {
    if (!annotationDraft) return;
    const text = String(values.get('text') || '').trim();
    const existing = state.annotations?.[annotationDraft.lessonId] || [];
    const item = { ...annotationDraft.item, id: annotationDraft.item.id || crypto.randomUUID(), text, created: annotationDraft.item.created || Date.now() };
    const next = annotationDraft.item.id ? existing.map(note => note.id === item.id ? item : note) : [...existing, item];
    try {
      await commitAnnotations(annotationDraft.lessonId, next);
      $('#annotation-dialog').close(); annotationDraft = null; window.getSelection?.()?.removeAllRanges(); toast('随文笔记已保存，原文未修改。');
    } catch (error) { annotationDraft.error = error.message; annotationDraft.item.text = text; renderAnnotationDialog(); }
    return;
  }
  if (['illustration-form', 'commons-search-form', 'commons-select-form'].includes(form.id) && illustrationBusy) return;
  if (['speech-preview-form', 'speech-generate-form'].includes(form.id) && speechBusy) return;
  if (form.id === 'knowledge-draft-form' && knowledgeBusy) return;
  if (['knowledge-organize-form', 'knowledge-organize-manual-form'].includes(form.id) && knowledgeOrganizeBusy) return;
  if (['plan-form', 'clarification-form', 'plan-confirm-form'].includes(form.id)) return submitPlanner(form.id, values);
  if (modelFormIds.includes(form.id)) {
    if (modelSettingsSaving) return;
    // Capture all pending drafts before any save re-renders the shared page.
    dirtyModelForm(form);
    modelSettingsSaving = true;
  }
  const submit = form.querySelector('button[type="submit"]');
  const label = submit.innerHTML; submit.disabled = true;
  try {
    if (form.id === 'web-search-settings-form' && desktop) {
      webSearchSettings = await desktop.saveWebSearchSettings({ enabled: values.get('enabled') === 'on' });
      webSearchSaveResult = `网页搜图已${webSearchSettings.enabled ? '启用' : '关闭'}并保存；没有发起搜索。`;
      modelFormDrafts.delete(form.id); render(); toast('百炼网页搜图设置已保存；没有发起搜索。');
    } else if (form.id === 'commons-search-form' && desktop) {
      if (illustrationBusy || !illustrationDraft) throw new Error('正在处理配图，请稍候。');
      illustrationDraft.query = String(values.get('query') || '').trim(); illustrationDraft.error = ''; illustrationDraft.warning = '';
      illustrationBusy = true; renderIllustrationDialog();
      if (illustrationDraft.searchProvider === 'commons') illustrationDraft.results = await desktop.searchCommonsImages(illustrationDraft.query);
      else { const result = await desktop.searchWebImages(illustrationDraft.query); illustrationDraft.results = result.results; illustrationDraft.recommendation = result.recommendation || ''; illustrationDraft.warning = result.warning || ''; }
      illustrationDraft.searched = true; illustrationDraft.selectedPageId = null;
      illustrationBusy = false; renderIllustrationDialog();
    } else if (form.id === 'commons-select-form' && desktop) {
      if (illustrationBusy || !illustrationDraft) throw new Error('正在处理配图，请稍候。');
      const selected = illustrationDraft.results.find(item => String(item.candidateId || item.pageId) === String(values.get('pageId')));
      if (!selected || values.get('rightsConfirmed') !== 'on') throw new Error('请先选择图片并查看其来源与许可。');
      const caption = String(values.get('caption') || '').trim();
      if (!caption || caption.length > 500) throw new Error('请填写不超过 500 字的图注。');
      illustrationDraft.selectedPageId = selected.candidateId || selected.pageId; illustrationDraft.webCaption = caption; illustrationDraft.error = '';
      illustrationBusy = true; renderIllustrationDialog();
      const draft = illustrationDraft, scrollTop = window.scrollY;
      const request = { lessonId: draft.lessonId, blockId: draft.blockId, expectedText: draft.expectedText, expectedImageId: draft.expectedImageId, pageId: selected.pageId, expectedLicense: selected.license, candidateId: selected.candidateId, rightsConfirmed: true, caption };
      const content = draft.searchProvider === 'commons' ? await desktop.useCommonsImage(request) : await desktop.useWebImage(request);
      const block = state.blockCourses?.[draft.lessonId]?.blocks.find(item => item.id === draft.blockId);
      if (block) block.content = content;
      illustrationBusy = false; $('#illustration-dialog').close(); render(); window.scrollTo({ top: scrollTop, behavior: 'instant' }); toast('网络资料图片已下载并保存到本机。');
    } else if (form.id === 'speech-settings-form' && desktop) {
      $('#speech-settings-error').textContent = '';
      speechSettings = await desktop.saveSpeechSettings({ enabled: values.get('enabled') === 'on', model: values.get('model'), baseUrl: values.get('baseUrl'), voice: values.get('voice'), otherVoice: values.get('otherVoice'), language: values.get('language'), rate: Number(values.get('rate')), timeoutMs: Number(values.get('timeout')) * 1000, localOnly: values.get('localOnly') === 'on', downloadHosts: values.get('downloadHosts'), ...modelKeyValues(values) });
      modelFormDrafts.delete(form.id);
      speechConnectionResult = '语音配置已保存。根地址为同域名 /api/v1；未更换服务商或密钥。保存不会合成音频。'; render(); toast('语音配置已保存在本机，密钥已加密。');
    } else if (form.id === 'speech-preview-form' && desktop) {
      const assignments = { ...speechDraft.assignments };
      let previousSpeakers = []; try { previousSpeakers = [...new Set(speechTurns(speechDraft.text).map(turn => turn.speaker))]; } catch {}
      previousSpeakers.forEach((speaker, index) => { const voice = values.get(`voice-${index}`); if (voice !== null) Object.defineProperty(assignments, speaker, { value: voice.trim(), enumerable: true, configurable: true, writable: true }); });
      speechDraft.text = values.get('text')?.trim() || ''; speechDraft.assignments = assignments; speechDraft.error = ''; speechDraft.plan = null;
      speechBusy = true; $('#speech-preview-fields').disabled = true;
      speechDraft.plan = await desktop.prepareSpeech({ lessonId: speechDraft.lessonId, text: speechDraft.text, assignments });
      speechBusy = false; renderSpeechDialog();
    } else if (form.id === 'speech-generate-form' && desktop) {
      if (!speechDraft?.plan || ($('#speech-material').value ?? speechDraft.text) !== speechDraft.text) throw new Error('材料已修改，请重新预览后再确认生成。');
      speechBusy = true; $('#speech-preview-fields').disabled = true; $('#speech-error').textContent = ''; submit.innerHTML = '正在合成 / 下载，请勿重复提交…';
      const result = await desktop.generateSpeech({ lessonId: speechDraft.lessonId, text: speechDraft.text, assignments: speechDraft.assignments, confirmed: true, mode: speechDraft.plan.pendingCount ? 'download-only' : 'generate' });
      speechDraft.plan = result; speechDraft.error = result.error || ''; speechBusy = false; renderSpeechDialog();
    } else if (form.id === 'image-settings-form' && desktop) {
      $('#image-settings-error').textContent = '';
      submit.innerHTML = '<span class="spinner"></span>正在保存到本机…';
      imageSettings = await desktop.saveImageSettings({ enabled: values.get('enabled') === 'on', protocol: values.get('protocol') || 'compatible', model: values.get('model'), baseUrl: values.get('baseUrl'), localOnly: values.get('localOnly') === 'on', ...modelKeyValues(values), size: values.get('size'), responseFormat: values.get('protocol') === 'dashscope' ? 'auto' : values.get('responseFormat'), timeoutMs: Number(values.get('timeout')) * 1000, downloadHosts: values.get('downloadHosts') });
      clearSavedModelDraft(form);
      modelFormDrafts.delete(form.id);
      const rootAdjusted = values.get('baseUrl')?.trim().replace(/\/+$/, '') !== imageSettings.baseUrl;
      imageConnectionResult = rootAdjusted && imageSettings.protocol === 'dashscope' ? '图片配置已保存。已将根地址调整为同域名的 /api/v1，未更换服务商或密钥。保存不调用模型；可检查服务，实际生成仍需手动确认。' : '图片配置已保存。可检查服务，或在讲解、案例与动手实践右上角查看配图建议。'; render(); toast('图片模型配置已保存在本机。');
    } else if (form.id === 'illustration-form' && desktop) {
      if (illustrationBusy) throw new Error('正在生成配图，请勿重复提交。');
      $('#illustration-error').textContent = '';
      const prompt = values.get('prompt')?.trim(), caption = values.get('caption')?.trim();
      if (!validImageProposal({ prompt, caption }) || !illustrationDraft) throw new Error('请填写图片提示词和图注。');
      illustrationDraft.prompt = prompt; illustrationDraft.caption = caption;
      illustrationBusy = true; submit.innerHTML = illustrationDraft.pendingDownload ? '<span class="spinner"></span>仅下载已有图片…' : '<span class="spinner"></span>正在生成并保存图片…';
      const fields = form.querySelector('fieldset'); if (fields) fields.disabled = true;
      const draft = { ...illustrationDraft }, scrollTop = window.scrollY;
      const content = draft.pendingDownload ? await desktop.retryIllustrationDownload({ lessonId: draft.lessonId, blockId: draft.blockId, pendingId: draft.pendingDownload.id }) : await desktop.generateIllustration(draft);
      if (content?.pendingDownload) {
        Object.assign(illustrationDraft, { pendingDownload: content.pendingDownload, prompt: content.prompt, caption: content.caption, error: content.error });
        illustrationBusy = false; renderIllustrationDialog(); return;
      }
      const block = state.blockCourses?.[draft.lessonId]?.blocks.find(item => item.id === draft.blockId);
      if (block) block.content = content;
      $('#illustration-dialog').close(); render(); window.scrollTo({ top: scrollTop, behavior: 'instant' }); toast('教学配图已保存到本机。');
    } else if (form.id === 'desktop-settings-form' && desktop) {
      $('#settings-error').textContent = '';
      $('#remote-permission').hidden = true;
      const testButton = $('[data-action="test-connection"]');
      if (testButton) testButton.disabled = true;
      submit.innerHTML = '<span class="spinner"></span>正在保存到本机…';
      const result = await desktop.saveSettings({
        provider: values.get('provider'), model: values.get('model'), baseUrl: values.get('baseUrl'),
        ...modelKeyValues(values), localOnly: values.get('localOnly') === 'on',
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
      clearSavedModelDraft(form);
      modelFormDrafts.delete(form.id);
      render(); toast('模型配置已保存在本机。');
    } else if (form.id === 'revision-form') {
      $('#revision-error').textContent = '';
      const id = form.dataset.id, block = state.blockCourses?.[id]?.blocks.find(item => item.id === form.dataset.block);
      const request = values.get('request')?.trim();
      if (status.mode !== 'ai' || !block?.content || !assistedBlockTypes.includes(block.type) || !request || request.length > 1000) throw new Error('请连接 AI 模型，并填写具体的调整要求。');
      if (revisionBusy) throw new Error('正在重新生成，请稍候。');
      revisionBusy = true;
      submit.innerHTML = '<span class="spinner"></span>正在按你的要求重新生成…';
      const meta = lessonById(id), p = state.plans.find(route => route.lessons.some(item => item.id === id));
      const previous = block.content, context = blockGenerationContext(state.blockCourses[id], block.id);
      const content = await api('lesson-block', { goal: p.goal, level: p.level, ...(p.learningBrief ? { learningBrief: p.learningBrief } : {}), title: meta.title, objective: meta.objective, minutes: meta.minutes, ...context, block: { type: block.type, title: block.title, objective: block.objective }, revisionRequest: request, currentExcerpt: previous.text.slice(0, 12000) });
      if (!validBlockContent(block.type, content)) throw new Error('模型返回的内容格式不正确，原内容已保留，请重试。');
      if (block.content !== previous) throw new Error('内容已更新，原请求未覆盖当前内容，请重新提交。');
      block.content = desktop ? await desktop.reviseBlock(id, block.id, content, previous.text) : revisedContent(block.type, previous, content);
      if (!desktop) save();
      $('#revise-block-dialog').close(); render(); toast('已按你的要求更新；可在模块右上角恢复上一版。');
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
    } else if (form.id === 'knowledge-draft-form') {
      if (!knowledgeDraft?.result) throw new Error('请先生成卡片草稿。');
      knowledgeBusy = true;
      const tags = knowledgeTags(values.get('tags'));
      const result = { title: String(values.get('title') || '').trim(), summary: String(values.get('summary') || '').trim(), content: String(values.get('content') || '').trim(), tags, topic: String(values.get('topic') || knowledgeDraft.result.topic || tags[0] || '未分类').trim(), useWhen: knowledgeConditions(values.get('useWhen')), avoidWhen: knowledgeConditions(values.get('avoidWhen')) };
      knowledgeDraft.result = result;
      if (!validKnowledgeDraft(result)) throw new Error('请填写标题、描述、正文和 1–6 个标签，并检查字段长度。');
      const created = Date.now();
      if (!result.topic || result.topic.length > 160) throw new Error('主题目录名称不正确。');
      const n = { id: crypto.randomUUID(), lessonId: knowledgeDraft.lessonId, courseTitle: knowledgeDraft.source.courseTitle, ...result, source: knowledgeDraft.origin, created, updated: created, sourceLessons: [knowledgeDraft.lessonId], status: 'draft' };
      if (desktop) { await pendingSave; if (storageWarning) throw new Error(storageWarning); await desktop.saveNote(n); }
      state.notes.push(n);
      if (!desktop) save();
      knowledgeBusy = false; knowledgeDraft = null; $('#knowledge-draft-dialog').close();
      activeNote = n.id; navigate('wiki'); toast('知识卡片已保存，可继续编辑。');
    } else if (form.id === 'knowledge-organize-manual-form' || form.id === 'knowledge-organize-form') {
      if (!knowledgeOrganize) throw new Error('请重新打开主题管理。');
      const draft = knowledgeOrganize;
      let changes;
      if (form.id === 'knowledge-organize-manual-form') {
        draft.manual = new Map(draft.cards.map(card => [card.id, String(values.get(`manual:${card.id}`) || '').trim()]));
        changes = draft.cards.filter(card => draft.manual.get(card.id) !== card.theme).map(card => ({ id: card.id, category: draft.manual.get(card.id), expectedUpdated: card.updated }));
      } else {
        if (!draft.result) throw new Error('请先生成整理建议。');
        const proposed = new Map(draft.result.groups.flatMap(group => group.ids.map(cardId => [cardId, group.name])));
        draft.aiDraft = new Map([...proposed.keys()].map(cardId => [cardId, String(values.get(`suggestion:${cardId}`) || '').trim()]));
        draft.aiSelected = new Set([...proposed.keys()].filter(cardId => values.get(`apply:${cardId}`) !== null));
        changes = draft.cards.filter(card => draft.aiSelected.has(card.id) && draft.aiDraft.get(card.id) !== card.theme).map(card => ({ id: card.id, category: draft.aiDraft.get(card.id), expectedUpdated: card.updated }));
      }
      if (!changes.length) throw new Error('没有需要保存的主题修改。');
      knowledgeOrganizeBusy = true;
      try {
        const undo = await persistKnowledgeCategories(changes);
        knowledgeOrganizeUndo.set(draft.courseKey, undo);
        $('#knowledge-organize-dialog').close(); knowledgeOrganize = null;
        refreshKnowledgeResults(); toast(`已整理 ${changes.length} 张卡片，可在“管理主题”中撤销。`);
      } finally { knowledgeOrganizeBusy = false; }
    } else if (form.id === 'note-form') {
      const n = state.notes.find(n => n.id === form.dataset.id), title = values.get('title').trim(), summary = values.get('summary').trim(), content = values.get('content').trim();
      const tags = [...new Set(values.get('tags').split(/[,，]/).map(t => t.trim()).filter(Boolean))].slice(0, 6);
      if (!title || !summary || !content || !tags.length) throw new Error('请填写标题、摘要、正文和至少一个标签。');
      const useWhen = knowledgeConditions(values.get('useWhen')), avoidWhen = knowledgeConditions(values.get('avoidWhen'));
      if (!validKnowledgeDraft({ title, summary, content, tags, useWhen, avoidWhen })) throw new Error('请检查知识卡片字段长度和适用场景条数。');
      const topic = String(values.get('topic') || n.topic || '未分类').trim();
      if (!topic || topic.length > 160) throw new Error('主题目录名称不正确。');
      const category = String(values.get('category') || '').trim();
      if (category.length > 80) throw new Error('知识库归类名称不能超过 80 字。');
      const next = { ...n, title, summary, content, tags, useWhen, avoidWhen, topic, updated: Date.now() };
      if (category) next.category = category; else delete next.category;
      if (desktop) { await pendingSave; if (storageWarning) throw new Error(storageWarning); await desktop.saveNote(next); }
      Object.assign(n, next);
      if (!category) delete n.category;
      if (!desktop) save();
      updateNotePreview(n); toast('知识卡片已保存。');
    } else if (form.id === 'ask-form') {
      submit.innerHTML = '<span class="spinner"></span>正在阅读你的知识…'; const question = values.get('question').trim();
      if (!question) throw new Error('请输入问题。');
      const selected = retrieveKnowledge(question, state.notes, 12, state.plans);
      if (status.mode === 'ai') {
        if (!selected.length) answer = { demo: true, answer: '知识目录中没有找到与问题直接相关的卡片。请换一个更具体的知识点，或先补充卡片。', citations: [] };
        else answer = await api('ask', { question, notes: selected.map(({ id, title, content, topic, category, summary, tags, useWhen, avoidWhen }) => ({ id, title, content: content.slice(0, 12000), topic: category || topic || '未分类', summary, tags, useWhen: useWhen || [], avoidWhen: avoidWhen || [] })) });
      }
      else {
        answer = { demo: true, answer: selected.length ? '按知识目录、标题、标签和正文找到以下卡片；结果是本地关键词匹配，并非 AI 回答。' : '知识目录中没有找到相关卡片。请使用更具体的知识点，或先补充卡片。', citations: selected.slice(0, 5).map(note => note.id) };
      }
      if ($('#wiki-answer')) $('#wiki-answer').innerHTML = answerHTML();
    }
  } catch (e) { if (['commons-search-form', 'commons-select-form'].includes(form.id) && illustrationDraft) { illustrationDraft.error = e.message; illustrationBusy = false; renderIllustrationDialog(); }
    else if (form.id === 'web-search-settings-form') $('#web-search-settings-error').textContent = e.message;
    else if (['speech-preview-form', 'speech-generate-form'].includes(form.id)) { speechDraft.error = e.message; speechBusy = false; renderSpeechDialog(); }
    else if (form.id === 'speech-settings-form') { $('#speech-settings-error').textContent = e.message; speechConnectionResult = `语音配置保存失败：${e.message}`; $('#speech-connection-result').textContent = speechConnectionResult; }
    else if (form.id === 'illustration-form' && $('#illustration-error')) $('#illustration-error').textContent = e.message;
    else if (form.id === 'image-settings-form' && $('#image-settings-error')) {
      $('#image-settings-error').textContent = e.message;
      imageConnectionResult = `图片配置保存失败：${e.message}`;
      $('#image-connection-result').textContent = imageConnectionResult;
      $('[data-action="check-image-connection"]').disabled = true;
    } else if (form.id === 'revision-form' && $('#revision-error')) $('#revision-error').textContent = e.message; else if (form.id === 'knowledge-draft-form' && knowledgeDraft) { knowledgeDraft.error = e.message; renderKnowledgeDraft(); } else if (['knowledge-organize-form', 'knowledge-organize-manual-form'].includes(form.id) && knowledgeOrganize) { knowledgeOrganize.error = e.message; renderKnowledgeOrganize(); } else if (form.id === 'desktop-settings-form' && $('#settings-error')) $('#settings-error').textContent = e.message; else if (form.id === 'plan-form' && $('#plan-error')) $('#plan-error').textContent = e.message; else if (form.id === 'lesson-ask-form' && $('#lesson-ask-error')) $('#lesson-ask-error').textContent = e.message; else toast(e.message); }
  finally { if (modelFormIds.includes(form.id)) modelSettingsSaving = false; if (form.id === 'knowledge-draft-form') knowledgeBusy = false; if (form.id === 'illustration-form') { illustrationBusy = false; const fields = form.querySelector('fieldset'); if (fields) fields.disabled = false; } if (form.id === 'revision-form') revisionBusy = false; if (submit.isConnected) { submit.disabled = form.id === 'plan-form' && status.mode !== 'ai'; submit.innerHTML = label; } }
});
document.addEventListener('input', event => {
  if (knowledgeOrganize && !knowledgeOrganizeBusy && event.target.name?.startsWith('manual:')) knowledgeOrganize.manual.set(event.target.name.slice(7), event.target.value);
  if (knowledgeOrganize && !knowledgeOrganizeBusy && event.target.name?.startsWith('suggestion:')) knowledgeOrganize.aiDraft.set(event.target.name.slice(11), event.target.value);
  if ((event.target.id === 'speech-material' || event.target.id?.startsWith('speech-role-')) && speechDraft && !speechBusy) {
    speechDraft.plan = null; stopSpeechPlayback();
    $('#speech-preview-body').innerHTML = ''; $('#speech-error').textContent = '材料或音色已修改，请先重新预览；尚未生成音频。';
  }
});
document.addEventListener('change', event => {
  if (knowledgeOrganize && !knowledgeOrganizeBusy && event.target.id === 'knowledge-organize-scope') {
    knowledgeOrganize.aiScope = event.target.value === 'all' ? 'all' : 'unclassified';
    knowledgeOrganize.result = null; knowledgeOrganize.aiDraft.clear(); knowledgeOrganize.aiSelected.clear(); knowledgeOrganize.error = '';
    renderKnowledgeOrganize(); return;
  }
  if (knowledgeOrganize && !knowledgeOrganizeBusy && event.target.name?.startsWith('include:')) {
    const id = event.target.name.slice(8);
    if (event.target.checked) knowledgeOrganize.included.add(id); else knowledgeOrganize.included.delete(id);
    knowledgeOrganize.result = null; knowledgeOrganize.aiDraft.clear(); knowledgeOrganize.aiSelected.clear();
    renderKnowledgeOrganize(); return;
  }
  if (knowledgeOrganize && !knowledgeOrganizeBusy && event.target.name?.startsWith('apply:')) {
    const id = event.target.name.slice(6);
    if (event.target.checked) knowledgeOrganize.aiSelected.add(id); else knowledgeOrganize.aiSelected.delete(id);
    return;
  }
  if (event.target.id === 'speech-play-rate' && $('#speech-player')) $('#speech-player').playbackRate = Number(event.target.value);
});
$('#speech-dialog')?.addEventListener?.('cancel', event => { if (speechBusy) event.preventDefault(); else stopSpeechPlayback(); });
$('#annotation-dialog')?.addEventListener?.('close', () => { annotationDraft = null; });
$('#knowledge-draft-dialog')?.addEventListener?.('close', () => { if (!knowledgeBusy) knowledgeDraft = null; });
$('#knowledge-organize-dialog')?.addEventListener?.('cancel', event => { if (knowledgeOrganizeBusy) event.preventDefault(); });
$('#knowledge-organize-dialog')?.addEventListener?.('close', () => { if (!knowledgeOrganizeBusy) knowledgeOrganize = null; });
if (desktop) {
  $('#app').innerHTML = '<div class="empty-state"><h2>正在读取本地数据…</h2></div>';
  desktop.load().then(result => {
    if (result.state) state = result.state;
    desktopSettings = result.settings; imageSettings = result.imageSettings || null; speechSettings = result.speechSettings || null; webSearchSettings = result.webSearchSettings || null; dataDirectory = result.dataDirectory; status = result.status;
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
