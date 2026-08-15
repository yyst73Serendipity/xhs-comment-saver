/**
 * apiconfig.js - API 格式化配置
 * 定义各服务商的请求/响应格式（headers、buildBody、parseResponse）
 * 参数（baseUrl、model、apiKey）由 apiconfig.json + .env 提供
 */
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
