import { createHash } from 'node:crypto';
import { speechRequest } from '../public/speech.js';
import { createSpeechModel } from '../speech-model.mjs';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const speechCacheKey = (config, turn) => digest([config.baseUrl, config.model, turn.voice, turn.text, config.language, config.rate, 'wav', 24000]);

export function createSpeechService(store, fetchImpl = fetch) {
  const pending = new Map(); let busy = false;
  function prune() { for (const [key, item] of pending) if (item.expires <= Date.now()) pending.delete(key); }
  function turns(value, config) {
    if (!value || typeof value !== 'object' || !value.assignments || typeof value.assignments !== 'object' || Array.isArray(value.assignments)) throw new Error('朗读请求格式无效。');
    return speechRequest(value.text, config, value.assignments);
  }
  async function prepare(value) {
    prune(); const config = store.getConfig(), result = [];
    for (const turn of turns(value, config)) {
      const key = speechCacheKey(config, turn), cached = await store.lookup(key), wait = pending.get(key);
      let host = '';
      if (wait) { host = new URL(wait.url).hostname; if (config.apiKey && host.includes(config.apiKey.toLowerCase())) host = '（已隐藏）'; }
      result.push({ ...turn, key, id: cached?.id || null, pending: !!wait, host });
    }
    return { turns: result, cachedCount: result.filter(turn => turn.id).length, pendingCount: result.filter(turn => !turn.id && turn.pending).length, newCount: result.filter(turn => !turn.id && !turn.pending).length, characters: result.filter(turn => !turn.id && !turn.pending).reduce((n, turn) => n + turn.text.length, 0) };
  }
  return {
    prepare,
    async generate(value) {
      if (busy) throw new Error('正在合成或下载语音，请勿重复提交。');
      if (value?.confirmed !== true || !['generate', 'download-only'].includes(value.mode)) throw new Error('请先预览并明确确认语音生成。');
      busy = true;
      try {
        const config = store.getConfig(), plan = await prepare(value), model = createSpeechModel(config, fetchImpl);
        if (value.mode === 'generate' && plan.pendingCount) throw new Error('已有生成结果待下载，请先仅重试下载；不会重新计费合成。');
        for (const turn of plan.turns) {
          if (turn.id || (value.mode === 'download-only' && !turn.pending)) continue;
          if (digest(store.getConfig()) !== digest(config)) throw new Error('语音配置已更改，已停止后续请求，请重新预览。');
          const wait = pending.get(turn.key);
          try {
            const bytes = wait ? await model.download(wait.url) : await model.synthesize(turn.text, turn.voice, url => {
              prune(); while (pending.size >= 32) pending.delete(pending.keys().next().value);
              pending.set(turn.key, { url, expires: Date.now() + 30 * 60 * 1000 });
            });
            await store.put(turn.key, bytes); pending.delete(turn.key);
          } catch (error) {
            return { ...await prepare(value), error: error.code ? '本地音频保存失败，请检查磁盘空间与目录权限。已保存片段保留，不自动重新生成。' : error.message };
          }
        }
        return prepare(value);
      } finally { busy = false; }
    }
  };
}
