/**
 * apiconfig.js - API 格式化配置
 * 定义各服务商的请求/响应格式（headers、buildBody、parseResponse）
 * 非敏感默认参数保存在代码中，API Key 与用户选择仅存 chrome.storage.local。
 */
const API_PROVIDER_DEFAULTS = globalThis.XHS_API_CONFIG_CORE.PROVIDER_DEFAULTS;

const API_PROVIDERS = {
  anthropic: {
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
      return data.content[0].text;
    }
  },
  openai: {
    headers(apiKey) {
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      };
    },
    buildBody(model, prompt) {
      return { model, messages: [{ role: 'user', content: prompt }] };
    },
    parseResponse(data) {
      return data.choices[0].message.content;
    }
  },
  // OpenAI 兼容格式（MiniMax、DeepSeek 等）
  minimax: {
    headers(apiKey) {
      return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
    },
    buildBody(model, prompt) {
      return { model, messages: [{ role: 'user', content: prompt }] };
    },
    parseResponse(data) {
      return data.choices[0].message.content;
    }
  },
  deepseek: {
    headers(apiKey) {
      return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
    },
    buildBody(model, prompt) {
      return { model, messages: [{ role: 'user', content: prompt }] };
    },
    parseResponse(data) {
      return data.choices[0].message.content;
    }
  }
};
