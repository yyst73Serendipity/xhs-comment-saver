/**
 * 定义 OpenAI 兼容协议与 Anthropic 原生协议的请求响应适配器。
 */
const API_PROVIDER_DEFAULTS = globalThis.XHS_API_CONFIG_CORE?.PROVIDER_DEFAULTS || {};

const API_PROTOCOL_ADAPTERS = Object.freeze({
  'openai-compatible': Object.freeze({
    headers(apiKey) {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      };
    },
    buildBody(model, prompt) {
      return { model, messages: [{ role: 'user', content: prompt }] };
    },
    parseResponse(data) {
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('AI 接口未返回可用内容');
      return content;
    }
  }),
  anthropic: Object.freeze({
    headers(apiKey) {
      return {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      };
    },
    buildBody(model, prompt) {
      return {
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      };
    },
    parseResponse(data) {
      const content = data?.content?.[0]?.text;
      if (typeof content !== 'string' || !content.trim()) throw new Error('AI 接口未返回可用内容');
      return content;
    }
  })
});

/** 根据配置协议返回对应请求适配器。 */
function getApiAdapter(protocol) {
  const adapter = API_PROTOCOL_ADAPTERS[protocol];
  if (!adapter) throw new Error('不支持该接口类型');
  return adapter;
}

globalThis.XHS_API_ADAPTERS = Object.freeze({ getAdapter: getApiAdapter });
