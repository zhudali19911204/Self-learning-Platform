// Home-only visual effects. No learning data, storage, network or model calls.
export function startHomeMotion({document, window, seen = new Map(), enter = false}) {
  const root = document.querySelector('.page-home');
  if (!root?.querySelectorAll || !window.requestAnimationFrame) return () => {};
  const hero = root.querySelector('.hero'), stats = root.querySelector('.stats');
  if (!hero || !stats) return () => {};
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const frames = new Set(), counts = [...root.querySelectorAll('[data-stat-count]')];
  let disposed = false, heroVisible = true, statsVisible = !window.IntersectionObserver, pointerFrame = 0;
  const request = fn => {
    const id = window.requestAnimationFrame(time => { frames.delete(id); if (!disposed) fn(time); });
    frames.add(id); return id;
  };
  const finishCounts = () => {
    for (const node of counts) node.textContent = node.dataset.statCount;
    for (const id of frames) window.cancelAnimationFrame(id);
    frames.clear(); pointerFrame = 0;
  };
  const resetPointer = () => { hero.style.setProperty('--pointer-x', '0px'); hero.style.setProperty('--pointer-y', '0px'); };
  const startCounts = () => {
    if (!statsVisible || document.hidden || media?.matches) return;
    for (const node of counts) {
      const value = Number(node.dataset.statCount), key = node.dataset.statKey;
      if (!Number.isSafeInteger(value) || value < 0 || seen.get(key) === value) continue;
      seen.set(key, value);
      if (!value) continue;
      let started;
      const tick = time => {
        started ??= time;
        const progress = Math.min(1, (time - started) / 650);
        node.textContent = String(Math.round(value * (1 - (1 - progress) ** 3)));
        if (progress < 1) request(tick);
      };
      request(tick);
    }
  };
  const refresh = () => {
    if (disposed) return;
    const paused = document.hidden || !heroVisible || !!media?.matches;
    hero.classList.toggle('is-motion-paused', paused);
    root.classList.toggle('is-motion-reduced', !!media?.matches);
    if (document.hidden || media?.matches) { finishCounts(); resetPointer(); root.classList.remove('home-entering'); }
    else startCounts();
  };
  const pointer = event => {
    if (event.pointerType === 'touch' || media?.matches || document.hidden || !heroVisible || pointerFrame) return;
    const rect = hero.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
    pointerFrame = request(() => {
      pointerFrame = 0;
      hero.style.setProperty('--pointer-x', `${(x * 7).toFixed(2)}px`);
      hero.style.setProperty('--pointer-y', `${(y * 6).toFixed(2)}px`);
    });
  };
  const reset = () => { if (pointerFrame) { window.cancelAnimationFrame(pointerFrame); frames.delete(pointerFrame); pointerFrame = 0; } resetPointer(); };
  const description = root.querySelector('.home-course-description');
  const measure = () => {
    if (disposed) return;
    const text = description?.querySelector('p'), button = description?.querySelector('button');
    if (text && button) button.hidden = !description.classList.contains('is-expanded') && text.scrollHeight <= text.clientHeight + 1;
  };
  const observer = window.IntersectionObserver ? new window.IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.target === hero) heroVisible = entry.isIntersecting;
      if (entry.target === stats) statsVisible = entry.isIntersecting;
    }
    refresh();
  }, {threshold: 0.05}) : null;
  observer?.observe(hero); observer?.observe(stats);
  const resize = description && window.ResizeObserver ? new window.ResizeObserver(measure) : null;
  resize?.observe(description);
  window.addEventListener('resize', measure);
  document.addEventListener('visibilitychange', refresh);
  media?.addEventListener?.('change', refresh);
  hero.addEventListener('pointermove', pointer, {passive: true});
  hero.addEventListener('pointerleave', reset);
  if (enter && !media?.matches && !document.hidden) root.classList.add('home-entering');
  measure(); refresh();
  return () => {
    disposed = true; finishCounts(); observer?.disconnect(); resize?.disconnect();
    window.removeEventListener('resize', measure);
    document.removeEventListener('visibilitychange', refresh);
    media?.removeEventListener?.('change', refresh);
    hero.removeEventListener('pointermove', pointer); hero.removeEventListener('pointerleave', reset);
  };
}
