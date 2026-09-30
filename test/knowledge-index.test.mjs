import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeCatalog, knowledgeDomain, knowledgeDomainColors, knowledgeDomains, retrieveKnowledge, validKnowledgeOrganization } from '../public/knowledge-index.js';

const card = (id, overrides = {}) => ({ id, title: `通用卡片 ${id}`, summary: '普通学习内容', content: '普通正文', tags: ['通用'], topic: '未分类', courseTitle: '课程', lessonId: 'lesson', updated: Number(id.replace(/\D/g, '')) || 1, ...overrides });

test('every predefined top-level directory has its own fixed graph color', () => {
  assert.deepEqual(Object.keys(knowledgeDomainColors), knowledgeDomains);
  const colors = Object.values(knowledgeDomainColors);
  assert.equal(new Set(colors).size, knowledgeDomains.length);
  assert.ok(colors.every(color => /^#[0-9a-f]{6}$/i.test(color)));
  assert.equal(knowledgeDomainColors['技术与开发'], '#60a5fa');
  assert.equal(knowledgeDomainColors['人工智能'], '#a78bfa');
  assert.equal(knowledgeDomainColors['语言与沟通'], '#78bd63');
});

test('AI organization must cover every card once and cannot create single-card themes', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(validKnowledgeOrganization({ groups: [{ name: '基础', ids: ['a', 'b'] }, { name: '课程要点', ids: ['c'] }] }, ids), true);
  assert.equal(validKnowledgeOrganization({ groups: [{ name: '基础', ids: ['a'] }, { name: '其他', ids: ['b', 'c'] }] }, ids), false);
  assert.equal(validKnowledgeOrganization({ groups: [{ name: '基础', ids: ['a', 'b'] }, { name: '课程要点', ids: ['b', 'c'] }] }, ids), false);
});

test('catalog groups cards into parent and child topics without copying full bodies', () => {
  const catalog = knowledgeCatalog([card('1', { topic: '编程/Python', content: 'private full text' }), card('2', { topic: '编程/Git' })]);
  assert.equal(catalog.count, 2);
  assert.deepEqual(catalog.topics.find(item => item.path === '编程'), { path: '编程', parent: null, count: 2, directCount: 0 });
  assert.equal(catalog.topics.find(item => item.path === '编程/Python').count, 1);
  assert.equal(JSON.stringify(catalog).includes('private full text'), false);
});

test('retrieval reaches old cards beyond the former newest-30 cutoff and expands explicit links', () => {
  const notes = Array.from({ length: 42 }, (_, index) => card(String(index + 1)));
  notes[0] = card('1', { title: 'Git 全局身份配置', summary: '设置 user.name 和 user.email', topic: '开发工具/Git', tags: ['Git'], related: ['2'] });
  const ranked = retrieveKnowledge('Git user.email 怎么配置？', notes);
  assert.equal(ranked[0].id, '1');
  assert.ok(ranked.some(item => item.id === '2'), 'explicitly related cards are included when there is room');
  assert.deepEqual(retrieveKnowledge('completely-unmatched-topic', notes), []);
});

test('common courses map to broad shelves and manual categories help retrieval', () => {
  assert.equal(knowledgeDomain({ title: 'SQL 查询入门' }), '数据与分析');
  assert.equal(knowledgeDomain({ title: 'Git 个人项目与远程协作' }), '技术与开发');
  assert.equal(knowledgeDomain({ title: '英语会议听力' }), '语言与沟通');
  assert.equal(knowledgeDomain({ title: '未知主题' }), '待归类');
  const notes = [card('1', { title: '安装', topic: '未分类', category: '环境准备' })];
  assert.equal(retrieveKnowledge('环境准备', notes)[0].id, '1');
  assert.equal(knowledgeCatalog(notes).cards[0].category, '环境准备');
});
