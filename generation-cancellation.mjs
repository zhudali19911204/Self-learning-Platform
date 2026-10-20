import { AsyncLocalStorage } from 'node:async_hooks';
import { generationCancelled, checkGenerationSignal } from './public/task-cancellation.js';
export { generationCancelled, isGenerationCancelled } from './public/task-cancellation.js';
const operations = new AsyncLocalStorage();
export const currentGenerationSignal = () => operations.getStore();
export const withGenerationSignal = (signal, operation) => operations.run(signal, operation);
export function checkGenerationCancellation() { checkGenerationSignal(currentGenerationSignal()); }
export function generationSignal(timeoutMs, extra) {
  const signals = [currentGenerationSignal(), extra, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}
// Race only a read/network boundary, never an entire mutating workflow. The
// caller still unwinds its finally blocks before its task/lesson lock is freed.
export async function generationAwait(operation, signal = currentGenerationSignal()) {
  if (signal?.aborted) Promise.resolve(operation).catch(() => {});
  checkGenerationSignal(signal);
  if (!signal) return operation;
  let abort;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      abort = () => reject(generationCancelled());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
export function createGenerationTasks() {
  const pending = new Map();
  return {
    async run(id, operation) {
      if (typeof id !== 'string' || !/^generation-[a-z0-9-]{1,80}$/.test(id)) return operation();
      if (pending.has(id)) throw new Error('任务标识重复，请等待当前请求完成。');
      const controller = new AbortController(); pending.set(id, controller);
      try { return await withGenerationSignal(controller.signal, operation); }
      finally { pending.delete(id); }
    },
    cancel(id) {
      const controller = pending.get(id);
      if (!controller || controller.signal.aborted) return false;
      controller.abort(generationCancelled()); return true;
    },
    signal: id => pending.get(id)?.signal,
    cancelAll() { for (const controller of pending.values()) controller.abort(generationCancelled()); }
  };
}
