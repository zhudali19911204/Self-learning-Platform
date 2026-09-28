const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const short = (value, limit = 16) => Array.from(value).slice(0, limit).join('') + (Array.from(value).length > limit ? '…' : '');
const colors = ['#6755bb', '#54a5a0', '#e0a255', '#9679ca', '#618aca', '#c97783', '#7b9f66', '#b18b6e'];

function flow(source, architecture) {
  const lines = source.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 40) return null;
  const nodes = [], edges = [];
  for (const line of lines) {
    const match = /^([^<>|]{1,50}?)\s*--?>\s*(?:\|([^|\r\n]{1,50})\|\s*)?([^<>|]{1,50})$/.exec(line);
    if (!match) return null;
    const from = match[1].trim(), label = match[2]?.trim() || '', to = match[3].trim();
    if (!from || !to || from === to) return null;
    for (const label of [from, to]) if (!nodes.includes(label)) nodes.push(label);
    edges.push({ from, to, label });
  }
  if (nodes.length > 24 || new Set(edges.map(edge => [edge.from, edge.to, edge.label].join('\0'))).size !== edges.length) return null;
  // Collapse cycles before assigning rows so retries/feedback loops remain drawable.
  const outgoing = new Map(nodes.map(node => [node, edges.filter(edge => edge.from === node).map(edge => edge.to)]));
  const indices = new Map(), lows = new Map(), stack = [], active = new Set(), components = [];
  const visit = node => {
    const index = indices.size;
    indices.set(node, index); lows.set(node, index); stack.push(node); active.add(node);
    for (const next of outgoing.get(node)) {
      if (!indices.has(next)) { visit(next); lows.set(node, Math.min(lows.get(node), lows.get(next))); }
      else if (active.has(next)) lows.set(node, Math.min(lows.get(node), indices.get(next)));
    }
    if (lows.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do { member = stack.pop(); active.delete(member); component.push(member); } while (member !== node);
      components.push(component.sort((a, b) => nodes.indexOf(a) - nodes.indexOf(b)));
    }
  };
  for (const node of nodes) if (!indices.has(node)) visit(node);
  const componentFor = new Map(components.flatMap((group, index) => group.map(node => [node, index])));
  const componentRanks = components.map(() => 0);
  for (let iteration = 0; iteration < components.length; iteration++) {
    let changed = false;
    for (const { from, to } of edges) {
      const fromIndex = componentFor.get(from), toIndex = componentFor.get(to);
      if (fromIndex === toIndex) continue;
      const nextRank = componentRanks[fromIndex] + components[fromIndex].length;
      if (componentRanks[toIndex] < nextRank) { componentRanks[toIndex] = nextRank; changed = true; }
    }
    if (!changed) break;
  }
  const ranks = new Map(components.flatMap((group, index) => group.map((node, offset) => [node, componentRanks[index] + offset])));
  const levels = Math.max(...ranks.values()) + 1;
  const groups = Array.from({ length: levels }, (_, rank) => nodes.filter(node => ranks.get(node) === rank));
  const width = Math.max(700, (Math.max(...groups.map(group => group.length)) + 1) * 175), height = 90 + levels * 104;
  const points = new Map();
  groups.forEach((group, rank) => group.forEach((node, index) => points.set(node, { x: (index + 1) * width / (group.length + 1), y: 52 + rank * 104 })));
  let backwardCount = 0;
  const connections = edges.map(({ from, to, label }) => {
    const a = points.get(from), b = points.get(to);
    const startY = a.y + 25, endY = b.y - 26;
    const backward = ranks.get(to) <= ranks.get(from);
    const sideX = backward ? Math.max(10, Math.min(a.x, b.x) - 112 - (backwardCount++ % 5) * 14) : 0;
    const wire = backward
      ? `<path d="M ${a.x - 78} ${a.y} L ${sideX} ${a.y} L ${sideX} ${b.y} L ${b.x - 88} ${b.y}" class="diagram-edge"/><path d="M ${b.x - 88} ${b.y - 5} L ${b.x - 78} ${b.y} L ${b.x - 88} ${b.y + 5}" class="diagram-edge"/>`
      : `<path d="M ${a.x} ${startY} L ${b.x} ${endY - 8}" class="diagram-edge"/><path d="M ${b.x - 5} ${endY - 9} L ${b.x} ${endY} L ${b.x + 5} ${endY - 9}" class="diagram-edge"/>`;
    if (!label) return wire;
    const labelX = backward ? sideX + 18 : a.x + (b.x - a.x) * .8;
    const labelY = backward ? (a.y + b.y) / 2 : startY + (endY - startY) * .58;
    const labelWidth = Math.min(204, Math.max(54, Array.from(short(label, 18)).reduce((sum, character) => sum + (character.codePointAt(0) > 127 ? 14 : 8), 0) + 18));
    return `${wire}<rect x="${(labelX - labelWidth / 2).toFixed(2)}" y="${(labelY - 12).toFixed(2)}" width="${labelWidth}" height="24" rx="10" class="diagram-edge-label-bg"/><text x="${labelX.toFixed(2)}" y="${(labelY + 4).toFixed(2)}" text-anchor="middle" class="diagram-edge-label">${escapeHTML(short(label, 18))}</text>`;
  }).join('');
  const boxes = nodes.map(node => {
    const { x, y } = points.get(node);
    return `<rect x="${x - 78}" y="${y - 25}" width="156" height="50" rx="10" class="diagram-node${edges.filter(edge => edge.from === node).length > 1 ? ' diagram-decision' : ''}"/><text x="${x}" y="${y + 5}" text-anchor="middle" class="diagram-node-label">${escapeHTML(short(node))}</text>`;
  }).join('');
  const caption = edges.map(({ from, to, label }) => `${from} → ${label ? `〔${label}〕` : ''}${to}`).join('；');
  return `<figure class="learning-visual learning-flow"><svg viewBox="0 0 ${width} ${height}" style="min-width:${width > 700 ? width : 480}px" role="img" aria-label="${escapeHTML(caption)}">${connections}${boxes}</svg><figcaption>${architecture ? '架构图' : '流程图'} · ${nodes.length} 个节点，${edges.length} 条连线<details><summary>查看完整关系</summary><p>${escapeHTML(caption)}</p></details></figcaption></figure>`;
}

function chart(source) {
  const lines = source.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 4 || lines.length > 10) return null;
  const typeMatch = /^type:\s*(bar|line|pie)$/i.exec(lines[0]);
  const titleMatch = /^title:\s*(.{1,80})$/i.exec(lines[1]);
  if (!typeMatch || !titleMatch) return null;
  const type = typeMatch[1].toLowerCase(), title = titleMatch[1].trim();
  const rows = lines.slice(2).map(line => /^([^|\r\n]{1,40})\s*\|\s*(-?\d+(?:\.\d{1,4})?)$/.exec(line));
  if (rows.some(row => !row)) return null;
  const data = rows.map(row => ({ label: row[1].trim(), value: Number(row[2]) }));
  if (data.some(item => !item.label || !Number.isFinite(item.value) || item.value < 0 || item.value > 1e9)) return null;
  const max = Math.max(...data.map(item => item.value));
  if (max === 0) return null;
  const label = type === 'bar' ? '柱状图' : type === 'line' ? '折线图' : '饼图';
  let drawing;
  if (type === 'pie') {
    const total = data.reduce((sum, item) => sum + item.value, 0);
    let angle = -Math.PI / 2;
    drawing = data.map((item, index) => {
      if (item.value === 0) return '';
      const next = angle + 2 * Math.PI * item.value / total;
      const x1 = 350 + 105 * Math.cos(angle), y1 = 135 + 105 * Math.sin(angle);
      const x2 = 350 + 105 * Math.cos(next), y2 = 135 + 105 * Math.sin(next);
      const path = item.value === total
        ? `<circle cx="350" cy="135" r="105" fill="${colors[index]}"/>`
        : `<path d="M 350 135 L ${x1.toFixed(3)} ${y1.toFixed(3)} A 105 105 0 ${next - angle > Math.PI ? 1 : 0} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z" fill="${colors[index]}"/>`;
      angle = next;
      return path;
    }).join('');
  } else {
    const step = 600 / data.length;
    const points = data.map((item, index) => ({ x: 55 + step * (index + .5), y: 240 - item.value / max * 180 }));
    const axis = '<path d="M 45 40 L 45 240 L 660 240" class="chart-axis"/>';
    const labels = data.map((item, index) => `<text x="${points[index].x}" y="264" text-anchor="middle" class="chart-label">${escapeHTML(short(item.label, data.length > 5 ? 5 : 8))}</text>`).join('');
    const values = data.map((item, index) => `<text x="${points[index].x}" y="${Math.max(28, points[index].y - 10)}" text-anchor="middle" class="chart-value">${item.value}</text>`).join('');
    drawing = type === 'bar'
      ? data.map((item, index) => `<rect x="${points[index].x - Math.min(42, step * .35)}" y="${points[index].y}" width="${Math.min(84, step * .7)}" height="${240 - points[index].y}" rx="4" fill="${colors[index]}"/>`).join('')
      : `<polyline points="${points.map(point => `${point.x},${point.y}`).join(' ')}" class="chart-line"/>${points.map(point => `<circle cx="${point.x}" cy="${point.y}" r="5" class="chart-point"/>`).join('')}`;
    drawing = axis + drawing + values + labels;
  }
  const legend = type === 'pie' ? `<ul class="chart-legend">${data.map((item, index) => `<li><span class="legend-swatch" style="background:${colors[index]}"></span>${escapeHTML(item.label)}：${item.value}</li>`).join('')}</ul>` : '';
  return `<figure class="learning-visual learning-chart"><div class="chart-heading">${escapeHTML(title)} <small>${label}</small></div><svg viewBox="0 0 700 280" role="img" aria-label="${escapeHTML(title + '：' + data.map(item => `${item.label} ${item.value}`).join('，'))}">${drawing}</svg>${legend}<figcaption>${label} · ${escapeHTML(data.map(item => `${item.label} ${item.value}`).join('；'))}</figcaption></figure>`;
}

export function renderVisual(lang, source) {
  if (typeof source !== 'string' || source.length > 5000) return null;
  const type = String(lang || '').trim().toLowerCase();
  if (type === 'flow' || type === 'architecture') return flow(source, type === 'architecture');
  if (type === 'chart') return chart(source);
  return null;
}
