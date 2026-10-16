// Request activity, not a guessed model-completion percentage.
export function createGenerationProgress({ document, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const tasks = new Map();
  const sessionId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const originalHost = document.querySelector('#generation-progress');
  let nextId = 0, collapsed = false, timer = null;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const elapsed = task => {
    const seconds = Math.max(0, Math.floor(((task.ended ?? now()) - task.started) / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  };
  const active = () => [...tasks.values()].filter(task => task.state === 'running');
  function host() { return document.querySelector('#generation-progress') || originalHost; }
  function placeHost() {
    const element = host();
    if (!element || !document.body || !tasks.size) return false;
    const dialogs = [...(document.querySelectorAll?.('dialog[open]') || [])];
    const parent = dialogs.at(-1) || document.body;
    if (element.parentNode === parent) return false;
    try { element.hidePopover?.(); } catch {}
    parent.appendChild(element); return true;
  }
  function schedule() {
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      const time = now();
      let removed = false;
      for (const task of tasks.values()) if (task.state === 'done' && time - task.ended >= 8000) { tasks.delete(task.id); removed = true; }
      if (removed || placeHost()) render();
      else for (const node of host()?.querySelectorAll?.('[data-generation-elapsed]') || []) {
        const task = tasks.get(node.dataset.generationElapsed);
        if (task) node.textContent = `${task.state === 'running' ? '已等待' : '用时'} ${elapsed(task)}`;
      }
      if ([...tasks.values()].some(task => task.state !== 'failed')) schedule();
    }, 1000);
  }
  function render(raise = false) {
    const element = host();
    if (!element) return;
    placeHost();
    element.hidden = tasks.size === 0;
    if (!tasks.size) {
      if (timer !== null) clearTimer(timer); timer = null;
      try { element.hidePopover?.(); } catch { /* Older browsers use the fixed panel. */ }
      element.innerHTML = ''; return;
    }
    const running = active();
    // Prioritize current work so completed steps do not grow the corner panel.
    const rows = running.length ? running : [...tasks.values()].reverse().slice(0, 2);
    element.innerHTML = `<header class="generation-progress-heading"><span class="generation-progress-symbol" aria-hidden="true">${running.length ? '✦' : rows.some(t => t.state === 'failed') ? '!' : '✓'}</span><strong id="generation-progress-title">${running.length ? `正在生成 · ${running.length} 项任务` : rows.some(t => t.state === 'failed') ? '生成任务有异常' : '生成完成'}</strong><button type="button" data-action="toggle-generation-progress" aria-controls="generation-progress-list" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展开' : '收起'}生成进度">${collapsed ? '展开' : '收起'}</button></header>
      <div id="generation-progress-list" ${collapsed ? 'hidden' : ''}>${rows.map(task => `<article class="generation-progress-task is-${task.state}"><div class="generation-progress-task-title"><strong>${escape(task.title)}</strong><span>${task.state === 'running' ? '进行中' : task.state === 'failed' ? '未完成' : '已完成'}</span></div>${task.detail ? `<p class="generation-progress-detail">${escape(task.detail)}</p>` : ''}<div class="generation-progress-track" ${task.state === 'running' ? `role="progressbar" aria-label="${escape(task.title)}，正在处理" aria-valuetext="等待模型返回，完成比例未知"` : ''}><span></span></div><div class="generation-progress-task-foot"><span data-generation-elapsed="${task.id}">${task.state === 'running' ? '已等待' : '用时'} ${elapsed(task)}</span>${task.state !== 'running' ? `<button type="button" data-action="dismiss-generation-task" data-id="${task.id}" aria-label="移除${escape(task.title)}的状态">移除</button>` : ''}</div><p class="generation-progress-message" role="status">${escape(task.message)}</p></article>`).join('')}
      ${running.length ? '<p class="generation-progress-hint">动态条表示正在处理，模型尚未提供完成百分比。可切换页面继续浏览。</p>' : ''}</div>`;
    // A manual popover stays visible above modal backdrops without taking focus.
    // When unsupported, the same markup remains a normal fixed-position panel.
    try {
      if (raise && element.matches?.(':popover-open')) element.hidePopover?.();
      if (!element.matches?.(':popover-open')) element.showPopover?.();
    } catch { /* Fixed panel fallback. */ }
  }
  function start({ title, detail = '', message = '正在等待模型返回…' }) {
    const id = `generation-${sessionId}-${++nextId}`;
    tasks.set(id, { id, title, detail: String(detail).slice(0, 160), message, state: 'running', started: now() });
    // Keep all in-flight work, but bound the number of completed notifications.
    const settled = [...tasks.values()].filter(task => task.state !== 'running');
    for (const task of settled.slice(0, Math.max(0, settled.length - 4))) tasks.delete(task.id);
    render(true); if (host()) schedule();
    return {
      id,
      update(message) { const task = tasks.get(id); if (task?.state === 'running') { task.message = message; render(); } },
      finish(error = '') {
        const task = tasks.get(id); if (!task || task.state !== 'running') return;
        task.state = error ? 'failed' : 'done'; task.message = error || '已收到生成结果。'; task.ended = now();
        render(); if (host()) schedule();
      }
    };
  }
  async function run(info, operation) {
    const task = start(info);
    try { const value = await operation(task); task.finish(typeof value?.error === 'string' ? value.error : ''); return value; }
    catch (error) { task.finish(error?.message || '生成失败，请稍后重试。'); throw error; }
  }
  return {
    start, run,
    update(id, message) { const task = tasks.get(id); if (task?.state === 'running') { task.message = message; render(); } },
    toggle() { collapsed = !collapsed; render(); },
    dismiss(id) { if (tasks.get(id)?.state !== 'running') { tasks.delete(id); render(); } }
  };
}
