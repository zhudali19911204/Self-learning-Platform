import test from 'node:test';
import assert from 'node:assert/strict';
import { courseKnowledgeTree, knowledgeTree, knowledgeGraph, filterKnowledgeGraph } from '../public/knowledge-views.js';
import { createGraphMotion, stepGraphMotion } from '../public/graph-motion.js';

const card = (id, topic, other = {}) => ({ id, title: id, topic, tags: [], updated: 1, ...other });

test('tree nests arbitrary topic levels and counts direct versus descendant cards', () => {
  const tree = knowledgeTree([card('a', '编程/Python/语法'), card('b', '编程/Python'), card('c', '编程/Git'), card('d', '')]);
  assert.equal(tree.count, 4);
  const programming = tree.children.find(item => item.path === '编程');
  assert.equal(programming.count, 3);
  const python = programming.children.find(item => item.path === '编程/Python');
  assert.equal(python.count, 2);
  assert.equal(python.directCount, 1);
  assert.equal(python.children[0].path, '编程/Python/语法');
  assert.equal(tree.children.find(item => item.path === '未分类').count, 1);
});

test('course-first tree groups old cards without one folder per card or changing their topics', () => {
  const plans = [
    { id: 'git-plan', title: 'Windows Git 入门', lessons: [{ id: 'git-lesson' }] },
    { id: 'sql-plan', title: 'SQL 查询入门', lessons: [{ id: 'sql-lesson' }] }
  ];
  const notes = [
    card('install', 'Git安装', { lessonId: 'git-lesson', tags: ['Git安装'] }),
    card('verify', '未分类', { lessonId: 'git-lesson', tags: ['Git安装'] }),
    card('identity', 'Git', { lessonId: 'git-lesson', tags: ['Git'] }),
    card('manual', '未分类', { lessonId: 'git-lesson', category: '身份与基础配置', tags: ['Git'] }),
    card('select', 'SQL', { lessonId: 'sql-lesson' })
  ];
  const before = structuredClone(notes);
  const tree = courseKnowledgeTree(notes, plans);
  assert.equal(tree.count, 5);
  assert.deepEqual(tree.children.map(domain => domain.name), ['技术与开发', '数据与分析']);
  const git = tree.children[0].children[0];
  assert.equal(git.key, 'course:git-plan');
  assert.equal(git.name, 'Windows Git 入门');
  assert.deepEqual(new Set(git.children.map(theme => theme.name)), new Set(['Git安装', '身份与基础配置', '课程要点']));
  const cardsIn = name => git.children.find(theme => theme.name === name).cards.map(note => note.id);
  assert.deepEqual(cardsIn('Git安装'), ['install', 'verify']);
  assert.deepEqual(cardsIn('身份与基础配置'), ['manual']);
  assert.deepEqual(cardsIn('课程要点'), ['identity']);
  assert.deepEqual(notes, before, 'classification is virtual and does not rewrite notes');
});

test('same-titled courses keep separate stable directories and excessive singleton topics share a catch-all', () => {
  const plans = [
    { id: 'first', title: 'Python 入门', lessons: [{ id: 'l1' }] },
    { id: 'second', title: 'Python 入门', lessons: [{ id: 'l2' }] }
  ];
  const notes = Array.from({ length: 9 }, (_, index) => card(`c${index}`, `独立主题${index}`, { lessonId: 'l1' }));
  notes.push(card('other', '基础', { lessonId: 'l2' }));
  const domain = courseKnowledgeTree(notes, plans).children[0];
  assert.equal(domain.children.length, 2);
  assert.deepEqual(domain.children.map(course => course.key), ['course:first', 'course:second']);
  assert.equal(domain.children[0].children.length, 1);
  assert.equal(domain.children[0].children[0].name, '课程要点');
  assert.equal(domain.children[0].children[0].cards.length, 9);
});

test('explicit card categories are never merged away by the automatic theme limit', () => {
  const plans = [{ id: 'course', title: 'Git 基础', lessons: [{ id: 'lesson' }] }];
  const notes = Array.from({ length: 7 }, (_, index) => card(`manual-${index}`, `独立主题${index}`, { lessonId: 'lesson', category: `人工分类${index}` }));
  const course = courseKnowledgeTree(notes, plans).children[0].children[0];
  assert.equal(course.children.length, 7);
  assert.deepEqual(new Set(course.children.map(theme => theme.name)), new Set(notes.map(note => note.category)));
});

test('graph distinguishes declared relations, topic membership and tentative shared tags', () => {
  const notes = [
    card('git', '开发工具/Git', { related: ['commit'], prerequisites: ['config'], tags: ['Git'] }),
    card('commit', '开发工具/Git', { contrasts: ['config'], tags: ['Git'] }),
    card('config', '开发工具/Git', { tags: ['配置'] }),
    card('branch', '开发工具/Git', { tags: ['Git'] })
  ];
  const graph = knowledgeGraph(notes);
  assert.equal(graph.shownCards, 4);
  assert.ok(graph.edges.some(edge => edge.source === 'topic:开发工具' && edge.target === 'topic:开发工具/Git' && edge.type === 'hierarchy'));
  assert.ok(graph.edges.some(edge => edge.source === 'topic:开发工具/Git' && edge.target === 'card:git' && edge.type === 'membership'));
  assert.ok(graph.edges.some(edge => edge.source === 'card:git' && edge.target === 'card:commit' && edge.type === 'related'));
  assert.ok(graph.edges.some(edge => edge.source === 'card:config' && edge.target === 'card:git' && edge.type === 'prerequisites'));
  assert.ok(graph.edges.some(edge => edge.type === 'contrasts'));
  assert.ok(graph.edges.some(edge => edge.type === 'suggested'));
  assert.ok(!graph.edges.some(edge => edge.type === 'suggested' && [edge.source, edge.target].sort().join(':') === ['card:git', 'card:commit'].sort().join(':')));
  assert.ok(graph.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.deepEqual(knowledgeGraph(notes), graph, 'same notes produce stable layout');
});

test('graph rendering limit is explicit while filtered input can reveal an older card', () => {
  const notes = Array.from({ length: 245 }, (_, index) => card(`card-${index}`, '学习', { updated: index }));
  const graph = knowledgeGraph(notes);
  assert.equal(graph.totalCards, 245);
  assert.equal(graph.shownCards, 240);
  assert.ok(!graph.nodes.some(node => node.cardId === 'card-0'));
  const filtered = knowledgeGraph(notes.filter(note => note.id === 'card-0'));
  assert.equal(filtered.shownCards, 1);
  assert.ok(filtered.nodes.some(node => node.cardId === 'card-0'));
});

test('widely shared tags create a bounded candidate network instead of an unconnected star', () => {
  const notes = Array.from({ length: 80 }, (_, index) => card(`item-${index}`, '编程/Python', { tags: ['Python'], updated: index }));
  const graph = knowledgeGraph(notes);
  const candidates = graph.edges.filter(edge => edge.type === 'suggested');
  assert.ok(candidates.length >= 79);
  assert.ok(candidates.length <= 160);
  assert.ok(graph.edges.some(edge => edge.type === 'membership'));
});

test('graph filters preserve structural links and make orphan and two-hop views explicit', () => {
  const base = knowledgeGraph([
    card('a', '技术/Git', { related: ['b'] }),
    card('b', '技术/Git', { related: ['c'] }),
    card('c', '技术/Git'),
    card('alone', '其他')
  ]);
  const local = filterKnowledgeGraph(base, { localTwoHop: true, selectedId: 'card:a' });
  assert.deepEqual(local.nodes.filter(node => node.kind === 'card').map(node => node.cardId).sort(), ['a', 'b', 'c']);
  assert.ok(local.edges.some(edge => edge.type === 'membership'));
  const orphans = filterKnowledgeGraph(base, { orphansOnly: true });
  assert.deepEqual(orphans.nodes.filter(node => node.kind === 'card').map(node => node.cardId), ['alone']);
  assert.ok(orphans.nodes.some(node => node.id === 'topic:其他'));
  const suggested = filterKnowledgeGraph(knowledgeGraph([card('a', '技术', { tags: ['Git'] }), card('b', '技术', { tags: ['Git'] })]), { relation: 'suggested' });
  assert.ok(suggested.edges.some(edge => edge.type === 'suggested'));
  assert.ok(suggested.edges.some(edge => edge.type === 'membership'));
  const cardsOnly = filterKnowledgeGraph(base, { type: 'card' });
  assert.ok(cardsOnly.nodes.every(node => node.kind === 'card'));
  assert.ok(cardsOnly.edges.every(edge => edge.source.startsWith('card:') && edge.target.startsWith('card:')));
  const topicsOnly = filterKnowledgeGraph(base, { type: 'topic' });
  assert.ok(topicsOnly.nodes.every(node => node.kind === 'topic'));
  assert.ok(topicsOnly.edges.every(edge => edge.type === 'hierarchy'));
});

test('force motion is deterministic, finite, cools down and respects a dragged node', () => {
  const graph = knowledgeGraph([card('a', '技术/Git', { related: ['b'] }), card('b', '技术/Git')]);
  const motion = createGraphMotion(graph);
  const first = motion.nodes[0];
  first.fixed = true;
  const location = { x: first.x, y: first.y };
  for (let step = 0; step < 100; step++) stepGraphMotion(motion);
  assert.deepEqual({ x: first.x, y: first.y }, location);
  assert.ok(motion.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.ok(motion.alpha < .95);
  const copy = createGraphMotion(graph);
  for (let step = 0; step < 100; step++) stepGraphMotion(copy);
  assert.notDeepEqual(copy.nodes.map(node => [node.x, node.y]), graph.nodes.map(node => [node.x, node.y]));
});
