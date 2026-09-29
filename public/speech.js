export const speechDefaults = Object.freeze({ enabled: false, model: 'qwen-audio-3.0-tts-plus', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1', voice: 'longanlingxin', otherVoice: 'longanlufeng', language: 'en', rate: 1, timeoutMs: 180000, localOnly: false, downloadHosts: '' });
export const speechVoices = Object.freeze([['longanlingxin', '龙安灵心 · 女声（中英）'], ['longanlufeng', '龙安鲁风 · 男声（中英）']]);
export const validSpeechVoice = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
export const validAudioId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Extract a preview only: never send course text automatically or interpret code.
export function listeningText(markdown) {
  if (typeof markdown !== 'string') return '';
  const fences = [...markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)]
    .filter(match => !/^(?:js|javascript|ts|typescript|python|py|sql|json|html|css|bash|sh|mermaid|chart)\b/i.test(match[1].trim()))
    .map(match => match[2].trim()).filter(text => /[a-z]{2,}/i.test(text) && !/[\u3400-\u9fff]/.test(text));
  if (fences.length) return fences.join('\n\n').slice(0, 8000);
  return markdown.replace(/```[\s\S]*?```/g, '').split('\n').map(line => line.trim())
    .filter(line => /[a-z]{2,}/i.test(line) && !/[\u3400-\u9fff]/.test(line) && !/^\s*[#|>]|https?:\/\//i.test(line))
    .map(line => line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '')).join('\n').slice(0, 8000);
}

export function speechTurns(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('朗读材料须为 1–8000 字，请先选择或粘贴听力原文。');
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const turns = []; let speaker = '';
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z .'-]{0,49}):\s+(.+)$/);
    if (match) { speaker = match[1].trim(); turns.push({ speaker, text: match[2].trim() }); }
    else if (turns.length && turns.at(-1).speaker === speaker) turns.at(-1).text += '\n' + line;
    else turns.push({ speaker, text: line });
  }
  const chunks = [];
  for (const turn of turns) {
    let remaining = turn.text;
    while (remaining.length > 1500) {
      let end = remaining.lastIndexOf(' ', 1500); if (end < 700) end = 1500;
      chunks.push({ speaker: turn.speaker, text: remaining.slice(0, end).trim() }); remaining = remaining.slice(end).trim();
    }
    if (remaining) chunks.push({ speaker: turn.speaker, text: remaining });
  }
  if (chunks.length > 16 || new Set(chunks.map(turn => turn.speaker)).size > 8) throw new Error('每次最多 16 段、8 个角色，请分批朗读。');
  return chunks;
}

export function speechRequest(text, settings, assignments = {}) {
  const turns = speechTurns(text), speakers = [...new Set(turns.map(turn => turn.speaker))];
  return turns.map(turn => {
    const index = speakers.indexOf(turn.speaker);
    const voice = Object.hasOwn(assignments, turn.speaker) ? assignments[turn.speaker] : index % 2 ? settings.otherVoice : settings.voice;
    if (!validSpeechVoice(voice)) throw new Error('请为每个角色填写有效音色 ID。');
    return { ...turn, voice };
  });
}
