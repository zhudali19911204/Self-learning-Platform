export const quizInitialCount = 4;
export const quizBatchLimit = 5;
export const quizQuestionLimit = 100;
// Full content identity prevents an edited answer or explanation inheriting a
// pass from a different question. No fuzzy matching or positional carry-over.
export const quizQuestionKey = q => JSON.stringify([q.prompt, q.options, q.answer, q.explanation]);
export const quizPromptKey = prompt => prompt.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
export function masteredQuizQuestions(questions, progress, record) {
  const passed = new Set();
  const collect = (items, result) => {
    if (!Array.isArray(items) || !Array.isArray(result?.lastAnswers) || result.lastAnswers.length !== items.length) return;
    items.forEach((q, i) => { if (result.lastAnswers[i] === q.answer) passed.add(quizQuestionKey(q)); });
  };
  for (const item of record?.history || []) collect(item.questions, item.progress);
  if (!record || record.currentFingerprint === record.progressFingerprint) collect(questions, progress);
  return questions.map(q => passed.has(quizQuestionKey(q)));
}
const fingerprint = async questions => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(questions))))].map(b => b.toString(16).padStart(2, '0')).join('');
// Browser counterpart of the desktop's versioned quiz snapshots. Backups use
// the same SHA-256 contract and remain compatible with desktop imports.
export async function quizRecordAfterChange(before, after, previous, progress) {
  const oldHash = await fingerprint(before), newHash = await fingerprint(after);
  if (oldHash === newHash || (!before.length && !previous)) return { record: previous || null, progress };
  const record = previous ? structuredClone(previous) : { version: 1, currentFingerprint: oldHash, progressFingerprint: progress ? oldHash : null, history: [] };
  if (progress && record.progressFingerprint === oldHash) record.history = [...record.history.filter(h => h.fingerprint !== oldHash), { fingerprint: oldHash, questions: structuredClone(before), progress: structuredClone(progress), updated: Date.now() }].slice(-50);
  record.currentFingerprint = newHash;
  const historical = record.history.find(h => h.fingerprint === newHash);
  if (historical) record.progressFingerprint = newHash;
  return { record, progress: historical?.progress || progress };
}
