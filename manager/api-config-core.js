/**
 * 定义 AI 配置边界，校验公网 HTTPS 端点并生成精确主机权限。
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
  const PROTOCOLS = Object.freeze({
    OPENAI: 'openai-compatible',
    ANTHROPIC: 'anthropic'
  });

  /** 把用户输入转换为安全的本机配置键。 */
  function normalizeProviderName(value) {
    const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const unsafeNames = ['__proto__', 'prototype', 'constructor'];
    if (!provider || provider.length > 64 || unsafeNames.includes(provider)) {
      throw new Error('AI 服务商名称无效');
    }
    return provider;
  }

  /** 判断显式主机名是否属于本机、私有或保留网络。 */
  function isNonPublicHostname(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === '::' || host === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/.test(host)) return true;
    if (host.startsWith('::ffff:')) return isNonPublicHostname(host.slice(7));

    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [first, second] = parts;
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && (second === 0 || second === 168))
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224;
  }

  /** 校验 API 地址为不含内嵌凭证的公网 HTTPS 地址。 */
  function validateApiUrl(value) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('API 地址格式无效');
    }
    if (parsed.protocol !== 'https:') throw new Error('API 地址必须使用 HTTPS');
    if (parsed.username || parsed.password) throw new Error('API 地址不能包含账号或密码');
    if (!parsed.hostname || isNonPublicHostname(parsed.hostname)) throw new Error('API 地址必须是公网 HTTPS 地址');
    return parsed.href;
  }

  /** 从完整 API 地址生成 Chrome 可选主机权限模式。 */
  function createHostPermissionPattern(value) {
    const parsed = new URL(validateApiUrl(value));
    return `https://${parsed.hostname}/*`;
  }

  /** 把本机存储值转换为可供请求使用的受限配置。 */
  function normalizeApiConfig(value) {
    if (!value?.activeProvider) return null;
    const provider = normalizeProviderName(value?.activeProvider);
    const defaults = PROVIDER_DEFAULTS[provider];
    if (!value?.providers || !Object.prototype.hasOwnProperty.call(value.providers, provider)) return null;
    const saved = value.providers[provider];
    if (!saved || typeof saved !== 'object') return null;
    const protocol = saved.protocol || (provider === 'anthropic' ? PROTOCOLS.ANTHROPIC : PROTOCOLS.OPENAI);
    if (!Object.values(PROTOCOLS).includes(protocol)) throw new Error('不支持该接口类型');
    const baseUrl = saved.baseUrl || defaults?.baseUrl;
    const model = typeof saved.model === 'string' && saved.model.trim() ? saved.model.trim() : defaults?.model;
    if (!model) throw new Error('模型名称不能为空');
    return {
      provider,
      protocol,
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
      baseUrl: validateApiUrl(baseUrl),
      model
    };
  }

  globalThis.XHS_API_CONFIG_CORE = Object.freeze({
    PROVIDER_DEFAULTS,
    PROTOCOLS,
    createHostPermissionPattern,
    normalizeApiConfig,
    normalizeProviderName,
    validateApiUrl
  });
})();
