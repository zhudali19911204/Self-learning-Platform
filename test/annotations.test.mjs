import test from 'node:test';
import assert from 'node:assert/strict';
import { validAnnotations, personalNotesForSource, personalNotesMarkdown } from '../public/annotations.js';

const note = (id, source, text, created) => ({ id, source, text, quote: '被选中的原文', offset: 4, created });

test('inline annotations validate anchors and keep personal notes distinct from course facts', () => {
  const items = [note('one', 'block:reading-1', '我的理解', 1), note('two', 'section:0', '还有疑问', 2)];
  assert.equal(validAnnotations(items), true);
  assert.equal(validAnnotations([...items, items[0]]), false);
  assert.equal(validAnnotations([note('bad', '../outside', '内容', 3)]), false);
  assert.deepEqual(personalNotesForSource(items, 'block:reading-1'), [{ quote: '被选中的原文', text: '我的理解' }]);
  assert.match(personalNotesMarkdown(personalNotesForSource(items, 'block:reading-1')), /## 我的笔记[\s\S]*我的理解/);
});
