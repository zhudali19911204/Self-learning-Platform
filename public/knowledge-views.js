import { knowledgeDomain, knowledgeDomains, knowledgeTheme, knowledgeTopic } from './knowledge-index.js';

const compare = (left, right) => left.localeCompare(right, 'zh-CN');
const cardNode = id => `card:${id}`;
const topicNode = path => `topic:${path}`;

export function knowledgeTree(notes) {
  const root = { path: '', name: '全部', count: 0, directCount: 0, children: [] };
  const folders = new Map([['', root]]);
  for (const note of notes) {
    let parent = root;
    root.count++;
    for (const segment of knowledgeTopic(note.topic).split('/')) {
      const path = parent.path ? `${parent.path}/${segment}` : segment;
      let folder = folders.get(path);
      if (!folder) {
        folder = { path, name: segment, count: 0, directCount: 0, children: [] };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      folder.count++;
      parent = folder;
    }
    parent.directCount++;
  }
  const sort = folder => {
    folder.children.sort((left, right) => compare(left.name, right.name));
    folder.children.forEach(sort);
  };
  sort(root);
  return root;
}

// A virtual directory: no Markdown files are moved when a card is regrouped.
export function courseKnowledgeTree(notes, plans = []) {
  const root = { kind: 'root', count: notes.length, children: [] };
  const coursesByLesson = new Map(plans.flatMap(plan => (plan.lessons || []).map(lesson => [lesson.id, plan])));
  const domains = new Map();
  const courses = new Map();
  for (const note of notes) {
    const plan = coursesByLesson.get(note.lessonId);
    const title = plan?.title || note.courseTitle || '未归属课程';
    const courseId = plan?.id || `legacy:${title}`;
    const domainName = knowledgeDomain(plan || { title });
    let domain = domains.get(domainName);
    if (!domain) {
      domain = { kind: 'domain', key: `domain:${domainName}`, name: domainName, count: 0, children: [] };
      domains.set(domainName, domain);
      root.children.push(domain);
    }
    const key = `${domainName}\u0000${courseId}`;
    let course = courses.get(key);
    if (!course) {
      course = { kind: 'course', key: `course:${courseId}`, name: title, count: 0, children: [], cards: [], noteIds: [] };
      courses.set(key, course);
      domain.children.push(course);
    }
    domain.count++;
    course.count++;
    course.cards.push(note);
    course.noteIds.push(note.id);
  }
  for (const course of courses.values()) {
    const candidates = new Map();
    for (const note of course.cards) {
      const label = knowledgeTheme(note);
      candidates.set(label, (candidates.get(label) || 0) + 1);
    }
    const grouped = new Map();
    for (const note of course.cards) {
      const candidate = knowledgeTheme(note);
      // A manually selected category stays even with one card. Automatic one-off
      // labels share a stable catch-all instead of creating a folder per card.
      const label = note.category || (candidates.get(candidate) >= 2 ? candidate : '课程要点');
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label).push(note);
    }
    const maxThemes = 6;
    const manual = new Set(course.cards.map(note => note.category).filter(Boolean));
    const ranked = [...grouped].filter(([name]) => name !== '课程要点').sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]));
    const automatic = ranked.filter(([name]) => !manual.has(name)).slice(0, Math.max(0, maxThemes - 1 - manual.size)).map(([name]) => name);
    const keep = new Set([...manual, ...automatic]);
    const other = [...(grouped.get('课程要点') || []), ...ranked.filter(([name]) => !keep.has(name)).flatMap(([, cards]) => cards)];
    course.children = [...ranked.filter(([name]) => keep.has(name)), ...(other.length ? [['课程要点', other]] : [])]
      .sort((a, b) => a[0] === '课程要点' ? 1 : b[0] === '课程要点' ? -1 : compare(a[0], b[0]))
      .map(([name, cards]) => ({ kind: 'theme', key: `${course.key}:theme:${name}`, name, count: cards.length, cards: [...cards].sort((a, b) => compare(a.title, b.title) || compare(a.id, b.id)), children: [] }));
    delete course.cards;
  }
  root.children.sort((a, b) => knowledgeDomains.indexOf(a.name) - knowledgeDomains.indexOf(b.name));
  for (const domain of root.children) domain.children.sort((a, b) => compare(a.name, b.name));
  return root;
}

export function knowledgeGraph(notes, maxCards = 240) {
  const cards = [...notes].sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0) || compare(a.id, b.id)).slice(0, maxCards);
  const byId = new Map(cards.map(card => [card.id, card]));
  const topics = new Map();
  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();
  const declaredPairs = new Set();
  const addEdge = (source, target, type) => {
    if (source === target) return;
    const pair = [source, target].sort(compare).join(':');
    if (type === 'suggested' && declaredPairs.has(pair)) return;
    const key = type === 'prerequisites' ? `${type}:${source}:${target}` : `${type}:${[source, target].sort(compare).join(':')}`;
    if (edgeKeys.has(key)) return;
    if (['related', 'prerequisites', 'contrasts'].includes(type)) declaredPairs.add(pair);
    edgeKeys.add(key);
    edges.push({ source, target, type });
  };
  for (const card of cards) {
    const path = knowledgeTopic(card.topic);
    let parent = '';
    for (const segment of path.split('/')) {
      const current = parent ? `${parent}/${segment}` : segment;
      if (!topics.has(current)) {
        topics.set(current, { id: topicNode(current), kind: 'topic', label: segment, topic: current, group: path.split('/')[0], count: 0 });
        if (parent) addEdge(topicNode(parent), topicNode(current), 'hierarchy');
      }
      topics.get(current).count++;
      parent = current;
    }
    nodes.push({ id: cardNode(card.id), kind: 'card', cardId: card.id, label: card.title, topic: path, group: path.split('/')[0] });
    addEdge(topicNode(path), cardNode(card.id), 'membership');
  }
  nodes.unshift(...topics.values());
  for (const card of cards) {
    for (const [field, type] of [['related', 'related'], ['prerequisites', 'prerequisites'], ['contrasts', 'contrasts']]) {
      for (const other of card[field] || []) {
        if (byId.has(other)) addEdge(field === 'prerequisites' ? cardNode(other) : cardNode(card.id), field === 'prerequisites' ? cardNode(card.id) : cardNode(other), type);
      }
    }
  }
  const tagGroups = new Map();
  for (const card of cards) {
    for (const tag of new Set((card.tags || []).map(value => String(value).trim().toLocaleLowerCase()).filter(value => value.length > 1))) {
      if (!tagGroups.has(tag)) tagGroups.set(tag, []);
      tagGroups.get(tag).push(card.id);
    }
  }
  let suggestedCount = 0;
  for (const ids of tagGroups.values()) {
    if (ids.length < 2 || suggestedCount >= maxCards * 2) continue;
    for (let index = 1; index < ids.length && suggestedCount < maxCards * 2; index++) {
      const before = edges.length;
      addEdge(cardNode(ids[index - 1]), cardNode(ids[index]), 'suggested');
      suggestedCount += edges.length - before;
      if (index > 1 && suggestedCount < maxCards * 2) {
        const count = edges.length;
        addEdge(cardNode(ids[index - 2]), cardNode(ids[index]), 'suggested');
        suggestedCount += edges.length - count;
      }
    }
  }
  const groups = [...new Set(nodes.map(node => node.group))].sort(compare);
  const maxGroup = Math.max(1, ...groups.map(group => nodes.filter(node => node.group === group).length));
  const cell = Math.max(360, Math.ceil(2 * (34 * Math.sqrt(maxGroup) + 90)));
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.length)));
  const rows = Math.ceil(groups.length / columns);
  const width = columns * cell;
  const height = rows * cell;
  for (const [groupIndex, group] of groups.entries()) {
    const members = nodes.filter(node => node.group === group).sort((a, b) => a.kind === b.kind ? compare(a.id, b.id) : a.kind === 'topic' ? -1 : 1);
    const centerX = (groupIndex % columns + .5) * cell;
    const centerY = (Math.floor(groupIndex / columns) + .5) * cell;
    members.forEach((node, index) => {
      const radius = index === 0 ? 0 : 34 * Math.sqrt(index);
      const angle = index * 2.399963229728653;
      node.x = Math.round(centerX + Math.cos(angle) * radius);
      node.y = Math.round(centerY + Math.sin(angle) * radius);
    });
  }
  return { nodes, edges, width, height, shownCards: cards.length, totalCards: notes.length };
}

export function filterKnowledgeGraph(graph, { relation = 'all', type = 'all', orphansOnly = false, localTwoHop = false, selectedId = '' } = {}) {
  const structural = edge => edge.type === 'membership' || edge.type === 'hierarchy';
  const edges = graph.edges.filter(edge => structural(edge) || relation === 'all' || (relation === 'declared' ? edge.type !== 'suggested' : edge.type === 'suggested'));
  const cardIds = new Set(graph.nodes.filter(node => node.kind === 'card').map(node => node.id));
  const adjacent = new Map([...cardIds].map(id => [id, new Set()]));
  for (const edge of edges) {
    if (cardIds.has(edge.source) && cardIds.has(edge.target)) {
      adjacent.get(edge.source).add(edge.target);
      adjacent.get(edge.target).add(edge.source);
    }
  }
  let visibleCards = cardIds;
  if (orphansOnly) visibleCards = new Set([...cardIds].filter(id => !adjacent.get(id).size));
  else if (localTwoHop && cardIds.has(selectedId)) {
    visibleCards = new Set([selectedId]);
    let frontier = [selectedId];
    for (let hop = 0; hop < 2; hop++) {
      frontier = frontier.flatMap(id => [...adjacent.get(id)]).filter(id => !visibleCards.has(id));
      frontier.forEach(id => visibleCards.add(id));
    }
  }
  const topics = new Set();
  for (const edge of edges) {
    if (edge.type === 'membership' && visibleCards.has(edge.target)) {
      const path = edge.source.slice('topic:'.length).split('/');
      for (let index = 1; index <= path.length; index++) topics.add(`topic:${path.slice(0, index).join('/')}`);
    }
  }
  const visible = new Set([...visibleCards, ...topics]);
  const nodes = graph.nodes.filter(node => visible.has(node.id) && (type === 'all' || node.kind === type));
  const finalIds = new Set(nodes.map(node => node.id));
  return { ...graph, nodes, edges: edges.filter(edge => finalIds.has(edge.source) && finalIds.has(edge.target)), shownCards: nodes.filter(node => node.kind === 'card').length, orphanCards: [...cardIds].filter(id => !adjacent.get(id).size).length };
}
