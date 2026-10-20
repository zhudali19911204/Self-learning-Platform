import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { masteredQuizQuestions, quizRecordAfterChange } from '../public/quiz-progress.js';
import { validQuizRecord } from '../public/course-revision.js';
import { createSqliteStore } from '../desktop/sqlite-store.mjs';
import { validState } from '../desktop/local-store.mjs';

const question = n => ({ prompt: `第${n}个判断题？`, options: ['正确', '误区一', '误区二', '误区三'], answer: 0, explanation: `第${n}题的判断依据。` });
const progress = answers => ({ completed: answers.every(n => n === 0), attempts: 1, lastScore: Math.round(answers.filter(n => n === 0).length / answers.length * 100), bestScore: 100, lastAnswers: answers, updated: 1 });

test('only actually correct answers are mastered; wrong, missing and edited questions need practice', () => {
  const questions = [question(1), question(2)];
  assert.deepEqual(masteredQuizQuestions(questions, progress([0, 1])), [true, false]);
  assert.deepEqual(masteredQuizQuestions(questions, { ...progress([0, 1]), completed: true, lastAnswers: [] }), [false, false]);
  const record = { currentFingerprint: 'new', progressFingerprint: 'old', history: [{ questions, progress: progress([0, 1]) }] };
  assert.deepEqual(masteredQuizQuestions([question(2), question(1), question(3)], progress([0, 0]), record), [false, true, false], 'match full content, not positions');
  for (const patch of [{ answer: 1 }, { prompt: '改过的题干？' }, { options: ['不同选项', '乙', '丙', '丁'] }, { explanation: '改过的解析。' }]) {
    assert.deepEqual(masteredQuizQuestions([{ ...question(1), ...patch }], null, record), [false]);
  }
});

test('web quiz snapshots keep desktop-compatible fingerprints and preserve passes through repeated additions', async () => {
  const before = [question(1), question(2)], after = [...before, question(3)], oldProgress = progress([0, 1]);
  const result = await quizRecordAfterChange(before, after, null, oldProgress);
  assert.ok(validQuizRecord(result.record)); assert.deepEqual(result.progress, oldProgress);
  assert.equal(result.record.currentFingerprint, createHash('sha256').update(JSON.stringify(after)).digest('hex'));
  assert.deepEqual(masteredQuizQuestions(after, oldProgress, result.record), [true, false, false]);
  const next = await quizRecordAfterChange(after, [...after, question(4)], result.record, oldProgress);
  assert.deepEqual(masteredQuizQuestions([...after, question(4)], oldProgress, next.record), [true, false, false, false]);
  const restored = await quizRecordAfterChange(after, before, result.record, oldProgress);
  assert.deepEqual(restored.progress, oldProgress); assert.equal(restored.record.currentFingerprint, restored.record.progressFingerprint);
});

test('SQLite snapshots previously untracked quiz grades before appending, including restart and full backup', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'learnflow-quiz-append-')); let store;
  t.after(async () => { store?.close(); await rm(directory, { recursive: true, force: true }); });
  store = await createSqliteStore(directory);
  const outline = store.saveOutline('p1', { intro: '导语', blocks: [{ type: 'reading', title: '讲解', objective: '理解' }, { type: 'quiz', title: '初始练习', objective: '检验' }] });
  store.saveBlock('p1', outline.blocks[1].id, { questions: [question(1), question(2)] });
  store.saveProgress('p1', progress([0, 1]));
  assert.equal(store.getLesson('p1').quizRecord, undefined, 'cover existing courses without tracked quiz versions');
  const block = store.appendBlock('p1', { type: 'quiz', title: '追加练习', objective: '继续检验' });
  const saved = store.saveFactCheckedBlock('p1', block.id, { questions: [question(3)] }, null, null);
  assert.ok(validQuizRecord(saved.quizRecord)); assert.equal(saved.quizRecord.history.length, 1);
  const questions = store.getLesson('p1').blockCourse.blocks.filter(b => b.type === 'quiz').flatMap(b => b.content.questions);
  assert.deepEqual(masteredQuizQuestions(questions, store.overview().progress.p1, saved.quizRecord), [true, false, false]);
  assert.ok(validState(store.exportState())); store.close(); store = await createSqliteStore(directory);
  assert.deepEqual(masteredQuizQuestions(questions, store.overview().progress.p1, store.getLesson('p1').quizRecord), [true, false, false]);
  const snapshot = store.exportState(); store.replaceState(snapshot);
  assert.deepEqual(masteredQuizQuestions(questions, store.overview().progress.p1, store.getLesson('p1').quizRecord), [true, false, false]);
  const fingerprint = store.getLesson('p1').quizRecord.currentFingerprint;
  store.saveProgress('p1', { ...progress([0, 0, 0]), quizFingerprint: fingerprint });
  const next = store.appendBlock('p1', { type: 'quiz', title: '再次追加', objective: '再检验' });
  store.saveBlock('p1', next.id, { questions: [question(4)] });
  assert.deepEqual(masteredQuizQuestions([...questions, question(4)], store.overview().progress.p1, store.getLesson('p1').quizRecord), [true, true, true, false]);
});
