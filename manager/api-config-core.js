/**
 * 定义 AI 服务商默认值，并限制请求只能发送到 Manifest 已授权的官方来源。
 */
(() => {
  const PROVIDER_DEFAULTS = Object.freeze({
    anthropic: Object.freeze({
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-5'
    }),
    openai: Object.freeze({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4.1-mini'
    }),
    minimax: Object.freeze({
      name: 'MiniMax',
      baseUrl: 'https://api.minimax.chat/v1/chat/completions',
      model: 'MiniMax-M3'
    }),
    deepseek: Object.freeze({
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat'
    })
  });

  /** 校验 API 地址属于所选服务商的官方来源。 */
  function validateProviderUrl(provider, value) {
    const defaults = PROVIDER_DEFAULTS[provider];
    if (!defaults) throw new Error('不支持该 AI 服务商');
    let parsed;
    try {
      parsed = new URL(value || defaults.baseUrl);
    } catch {
      throw new Error('API 地址格式无效');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== new URL(defaults.baseUrl).origin) {
      throw new Error(`只能使用 ${defaults.name} 官方 API 地址`);
    }
    return parsed.href;
  }

  /** 把存储值转换为可供请求使用的受限配置。 */
  function normalizeApiConfig(value) {
    const provider = value?.activeProvider;
    const defaults = PROVIDER_DEFAULTS[provider];
    const saved = value?.providers?.[provider];
    if (!defaults || !saved) return null;
    return {
      provider,
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
      baseUrl: validateProviderUrl(provider, saved.baseUrl || defaults.baseUrl),
      model: typeof saved.model === 'string' && saved.model.trim() ? saved.model.trim() : defaults.model
    };
  }

  globalThis.XHS_API_CONFIG_CORE = Object.freeze({
    PROVIDER_DEFAULTS,
    normalizeApiConfig,
    validateProviderUrl
  });
})();
