/**
 * 在本机扩展存储中读写 AI 配置，并提供旧版文件的一次性迁移。
 */
(() => {
  const STORAGE_KEY = 'xhs_api_config';
  const LEGACY_KEY_REFS = Object.freeze({
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY'
  });

  function parseEnv(text) {
    const values = {};
    text.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const separator = trimmed.indexOf('=');
      if (separator === -1) return;
      values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    });
    return values;
  }

  /** 从旧版源码文件迁移配置；构建版缺少这些文件时安全返回空。 */
  async function migrateLegacyApiConfig({ storage, fetchResource }) {
    try {
      const envResponse = await fetchResource('../.env');
      if (!envResponse.ok) return null;
      const envValues = parseEnv(await envResponse.text());

      let legacy = null;
      let jsonResponse = await fetchResource('apiconfig.local.json');
      if (!jsonResponse.ok) jsonResponse = await fetchResource('apiconfig.json');
      if (jsonResponse.ok) legacy = await jsonResponse.json();

      const provider = legacy?.activeProvider
        || Object.keys(LEGACY_KEY_REFS).find(name => envValues[LEGACY_KEY_REFS[name]]);
      const defaults = globalThis.XHS_API_CONFIG_CORE.PROVIDER_DEFAULTS[provider];
      const providerConfig = legacy?.providers?.[provider] || defaults;
      const keyReference = legacy?.providers?.[provider]?.apiKeyRef || LEGACY_KEY_REFS[provider];
      const apiKey = envValues[keyReference] || '';
      if (!defaults || !providerConfig || !apiKey) return null;

      const baseUrl = globalThis.XHS_API_CONFIG_CORE.validateApiUrl(providerConfig.baseUrl || defaults.baseUrl);
      const migrated = {
        activeProvider: provider,
        providers: {
          [provider]: {
            protocol: provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
            apiKey,
            baseUrl,
            model: providerConfig.model || defaults.model
          }
        }
      };
      await storage.set({ [STORAGE_KEY]: migrated });
      return migrated;
    } catch {
      return null;
    }
  }

  /** 优先读取本机存储；只有首次升级且为空时才尝试旧版文件迁移。 */
  async function readApiConfig({ storage, fetchResource = path => fetch(path), allowLegacy = true }) {
    const stored = await storage.get(STORAGE_KEY);
    if (stored[STORAGE_KEY]) return { value: stored[STORAGE_KEY], migrated: false };
    if (!allowLegacy) return { value: null, migrated: false };
    const migrated = await migrateLegacyApiConfig({ storage, fetchResource });
    return { value: migrated, migrated: !!migrated };
  }

  globalThis.XHS_API_CONFIG_STORE = Object.freeze({
    STORAGE_KEY,
    migrateLegacyApiConfig,
    readApiConfig
  });
})();
