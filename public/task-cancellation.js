const cancellationMessage = '任务已取消，本次生成结果已丢弃，原有内容保留。';
export function generationCancelled() {
  const error = new Error(cancellationMessage);
  error.name = 'AbortError'; error.code = 'GENERATION_CANCELLED'; error.status = 499;
  return error;
}
// Electron contextBridge retains an Error's message but strips custom fields.
// Match only our exact internal message, never a broad "abort"/"cancel" search.
export const isGenerationCancelled = error => error?.code === 'GENERATION_CANCELLED' || error?.message === cancellationMessage;
export function checkGenerationSignal(signal) { if (signal?.aborted) throw generationCancelled(); }
