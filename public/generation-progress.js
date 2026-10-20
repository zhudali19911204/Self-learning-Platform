import { generationCancelled, isGenerationCancelled } from './task-cancellation.js';
// Request activity, not a guessed model-completion percentage.
export function createGenerationProgress({ document, cancelTask, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const tasks = new Map();
  const sessionId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const originalHost = document.querySelector('#generation-progress');
  let nextId = 0, collapsed = false, timer = null;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const elapsed = task => {
    const seconds = Math.max(0, Math.floor(((task.ended ?? now()) - task.started) / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  };
  const active = () => [...tasks.values()].filter(task => ['running', 'cancelling'].includes(task.state));
  const stateLabel = task => ({ running: '进行中', cancelling: '正在取消', cancelled: '已取消', failed: '未完成', done: '已完成' })[task.state];
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
        if (task) node.textContent = `${['running', 'cancelling'].includes(task.state) ? '已等待' : '用时'} ${elapsed(task)}`;
      }
      if ([...tasks.values()].some(task => ['running', 'cancelling', 'done'].includes(task.state))) schedule();
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
    element.innerHTML = `<header class="generation-progress-heading"><span class="generation-progress-symbol" aria-hidden="true">${running.length ? '✦' : rows.some(t => t.state === 'failed') ? '!' : rows.some(t => t.state === 'cancelled') ? '–' : '✓'}</span><strong id="generation-progress-title">${running.length ? `正在生成 · ${running.length} 项任务` : rows.some(t => t.state === 'failed') ? '生成任务有异常' : rows.some(t => t.state === 'cancelled') ? '任务已结束' : '生成完成'}</strong><button type="button" data-action="toggle-generation-progress" aria-controls="generation-progress-list" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展开' : '收起'}生成进度">${collapsed ? '展开' : '收起'}</button></header>
      <div id="generation-progress-list" ${collapsed ? 'hidden' : ''}>${rows.map(task => `<article class="generation-progress-task is-${task.state}"><div class="generation-progress-task-title"><strong>${escape(task.title)}</strong><span>${stateLabel(task)}</span></div>${task.detail ? `<p class="generation-progress-detail">${escape(task.detail)}</p>` : ''}<div class="generation-progress-track" ${task.state === 'running' ? `role="progressbar" aria-label="${escape(task.title)}，正在处理" aria-valuetext="等待模型返回，完成比例未知"` : ''}><span></span></div><div class="generation-progress-task-foot"><span data-generation-elapsed="${task.id}">${['running', 'cancelling'].includes(task.state) ? '已等待' : '用时'} ${elapsed(task)}</span>${['running', 'cancelling'].includes(task.state) ? `<button type="button" data-action="cancel-generation-task" data-id="${task.id}" ${task.state === 'cancelling' ? 'disabled' : ''} aria-label="取消${escape(task.title)}">${task.state === 'cancelling' ? '正在取消…' : '取消'}</button>` : `<button type="button" data-action="dismiss-generation-task" data-id="${task.id}" aria-label="移除${escape(task.title)}的状态">移除</button>`}</div><p class="generation-progress-message" role="status">${escape(task.message)}</p></article>`).join('')}
      ${running.length ? '<p class="generation-progress-hint">动态条表示正在处理，模型尚未提供完成百分比。取消可停止后续步骤，已发送请求仍可能计费。</p>' : ''}</div>`;
    // A manual popover stays visible above modal backdrops without taking focus.
    // When unsupported, the same markup remains a normal fixed-position panel.
    try {
      if (raise && element.matches?.(':popover-open')) element.hidePopover?.();
      if (!element.matches?.(':popover-open')) element.showPopover?.();
    } catch { /* Fixed panel fallback. */ }
  }
  function start({ title, detail = '', message = '正在等待模型返回…' }) {
    const id = `generation-${sessionId}-${++nextId}`;
    const controller = new AbortController();
    tasks.set(id, { id, title, detail: String(detail).slice(0, 160), message, state: 'running', started: now(), controller });
    // Keep all in-flight work, but bound the number of completed notifications.
    const settled = [...tasks.values()].filter(task => !['running', 'cancelling'].includes(task.state));
    for (const task of settled.slice(0, Math.max(0, settled.length - 4))) tasks.delete(task.id);
    render(true); if (host()) schedule();
    return {
      id, signal: controller.signal,
      update(message) { const task = tasks.get(id); if (task?.state === 'running') { task.message = message; render(); } },
      finish(error = '') {
        const task = tasks.get(id); if (!task || !['running', 'cancelling'].includes(task.state)) return;
        task.state = controller.signal.aborted || isGenerationCancelled(error) ? 'cancelled' : error ? 'failed' : 'done';
        task.message = task.state === 'cancelled' ? '本次生成结果已丢弃，原有内容保留。已发送请求仍可能计费。' : error?.message || error || '已收到生成结果。'; task.ended = now();
        render(); if (host()) schedule();
      }
    };
  }
  async function run(info, operation) {
    const task = start(info);
    try { const value = await operation(task); if (task.signal.aborted) throw generationCancelled(); task.finish(typeof value?.error === 'string' ? value.error : ''); return value; }
    catch (error) { task.finish(error || '生成失败，请稍后重试。'); throw error; }
  }
  return {
    start, run,
    async cancel(id) {
      const task = tasks.get(id); if (task?.state !== 'running') return false;
      task.state = 'cancelling'; task.message = '正在停止当前请求，请稍候…'; render();
      try {
        const accepted = cancelTask ? await cancelTask(id) : true;
        if (accepted && task.state === 'cancelling') task.controller.abort(generationCancelled());
        else if (task.state === 'cancelling') { task.state = 'running'; task.message = '任务已进入收尾阶段，等待保存结果。'; render(); }
        return accepted;
      } catch (error) {
        if (task.state === 'cancelling') { task.state = 'running'; task.message = '取消请求未成功，请稍后再试。'; render(); }
        throw error;
      }
    },
    update(id, message) { const task = tasks.get(id); if (task?.state === 'running') { task.message = message; render(); } },
    toggle() { collapsed = !collapsed; render(); },
    dismiss(id) { if (!['running', 'cancelling'].includes(tasks.get(id)?.state)) { tasks.delete(id); render(); } }
  };
}
