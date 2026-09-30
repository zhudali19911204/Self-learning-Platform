// Small deterministic force layout for the bounded, local Wiki graph.
export function createGraphMotion(graph, previous = new Map()) {
  const centerX = graph.width / 2, centerY = graph.height / 2;
  const groups = [...new Set(graph.nodes.map(node => node.group))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const anchors = new Map(groups.map((group, index) => {
    const angle = (index / Math.max(1, groups.length)) * Math.PI * 2 - Math.PI / 2;
    const radius = groups.length === 1 ? 0 : Math.min(graph.width, graph.height) * .18;
    return [group, { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius }];
  }));
  const nodes = graph.nodes.map(node => {
    const saved = previous.get(node.id);
    return { id: node.id, kind: node.kind, group: node.group,
      x: saved?.x ?? centerX + (node.x - centerX) * .48,
      y: saved?.y ?? centerY + (node.y - centerY) * .48,
      vx: 0, vy: 0, fixed: false };
  });
  const byId = new Map(nodes.map((node, index) => [node.id, index]));
  const edges = graph.edges.filter(edge => byId.has(edge.source) && byId.has(edge.target)).map(edge => ({ source: byId.get(edge.source), target: byId.get(edge.target), type: edge.type }));
  return { nodes, edges, byId, anchors, width: graph.width, height: graph.height, alpha: .95 };
}

export function stepGraphMotion(motion, spacing = 1) {
  const { nodes, edges, anchors, width, height } = motion;
  const forceX = new Float64Array(nodes.length), forceY = new Float64Array(nodes.length);
  const alpha = motion.alpha;
  const range = 190 * spacing;
  for (let left = 0; left < nodes.length; left++) {
    for (let right = left + 1; right < nodes.length; right++) {
      let dx = nodes[right].x - nodes[left].x, dy = nodes[right].y - nodes[left].y;
      if (!dx && !dy) { dx = (right - left) % 2 ? 1 : -1; dy = 1; }
      const distance2 = dx * dx + dy * dy;
      if (distance2 > range * range) continue;
      const distance = Math.sqrt(distance2);
      const charge = (nodes[left].kind === 'topic' || nodes[right].kind === 'topic' ? 1200 : 600) * spacing * alpha / (distance2 + 80);
      const x = dx / distance * charge, y = dy / distance * charge;
      forceX[left] -= x; forceY[left] -= y;
      forceX[right] += x; forceY[right] += y;
    }
  }
  for (const edge of edges) {
    const left = nodes[edge.source], right = nodes[edge.target];
    const dx = right.x - left.x, dy = right.y - left.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const desired = ({ membership: 52, hierarchy: 95, related: 72, prerequisites: 85, contrasts: 98, suggested: 112 }[edge.type] || 80) * spacing;
    const pull = (distance - desired) * (edge.type === 'suggested' ? .0018 : .0035) * alpha;
    const x = dx / distance * pull, y = dy / distance * pull;
    forceX[edge.source] += x; forceY[edge.source] += y;
    forceX[edge.target] -= x; forceY[edge.target] -= y;
  }
  let movement = 0;
  nodes.forEach((node, index) => {
    if (node.fixed) { node.vx = node.vy = 0; return; }
    const anchor = anchors.get(node.group);
    const ax = (anchor.x - node.x) * .0009 * alpha;
    const ay = (anchor.y - node.y) * .0009 * alpha;
    node.vx = (node.vx + forceX[index] + ax) * .86;
    node.vy = (node.vy + forceY[index] + ay) * .86;
    node.x = Math.max(22, Math.min(width - 22, node.x + node.vx));
    node.y = Math.max(22, Math.min(height - 22, node.y + node.vy));
    movement += Math.abs(node.vx) + Math.abs(node.vy);
  });
  motion.alpha *= .989;
  return movement / Math.max(1, nodes.length);
}
