// Main-process-only profile collection. Renderer receives public parameters and
// hasApiKey booleans, never plaintext keys or encrypted key blobs.
export function createModelProfiles({ defaults, selector, allowed, normalize, secrets }) {
  let profiles = new Map(), records = new Map();
  const fields = value => Object.fromEntries(Object.keys(defaults).map(key => [key, value[key]]));
  const safe = value => ({ ...fields(value), hasApiKey: !!value.apiKey });
  const decode = async record => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.hasOwn(record, 'apiKey') || (record.encryptedApiKey !== undefined && (typeof record.encryptedApiKey !== 'string' || record.encryptedApiKey.length > 32768))) throw new Error('模型服务参数存档无效。');
    const apiKey = record.encryptedApiKey ? await secrets.decrypt(record.encryptedApiKey) : '';
    return normalize({ ...record, apiKey, keyAction: apiKey ? 'replace' : 'clear' });
  };
  return {
    async load(stored) {
      const active = stored ? await decode(stored) : { ...defaults, apiKey: '' };
      const nextProfiles = new Map(), nextRecords = new Map();
      if (stored?.profiles !== undefined) {
        const saved = stored.profiles;
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).length > allowed.length) throw new Error('模型服务参数存档无效。');
        for (const [name, record] of Object.entries(saved)) {
          if (!allowed.includes(name)) throw new Error('模型服务参数存档无效。');
          const config = await decode(record);
          if (config[selector] !== name) throw new Error('模型服务与参数存档不匹配。');
          nextProfiles.set(name, config);
          nextRecords.set(name, { ...fields(config), encryptedApiKey: record.encryptedApiKey || '' });
        }
      }
      // Legacy single-service settings become the first profile in memory;
      // original files remain untouched until the next explicit successful save.
      nextProfiles.set(active[selector], active);
      nextRecords.set(active[selector], { ...fields(active), encryptedApiKey: stored?.encryptedApiKey || '' });
      profiles = nextProfiles; records = nextRecords;
      return active;
    },
    safe: () => Object.fromEntries([...profiles].map(([name, config]) => [name, safe(config)])),
    async prepare(input, active) {
      const previous = profiles.get(input?.[selector]) || active;
      const next = normalize(input, previous);
      const encryptedApiKey = next.apiKey ? await secrets.encrypt(next.apiKey) : '';
      const record = { ...fields(next), encryptedApiKey };
      const nextRecords = new Map(records); nextRecords.set(next[selector], record);
      return {
        next, value: { ...record, profiles: Object.fromEntries(nextRecords) },
        commit() { profiles.set(next[selector], next); records = nextRecords; }
      };
    }
  };
}
