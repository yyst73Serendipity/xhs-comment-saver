/**
 * 验证通用 OpenAI 兼容协议与 Anthropic 原生协议的请求响应格式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadAdapters() {
  const context = vm.createContext({ URL });
  context.globalThis = context;
  vm.runInContext(await readFile('manager/apiconfig.js', 'utf8'), context);
  return context.XHS_API_ADAPTERS;
}

test('OpenAI 兼容适配器可用于任意服务商', async () => {
  const adapter = (await loadAdapters()).getAdapter('openai-compatible');
  assert.equal(adapter.headers('key').Authorization, 'Bearer key');
  assert.equal(adapter.headers('key')['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(JSON.stringify(adapter.buildBody('qwen-plus', '总结内容'))), {
    model: 'qwen-plus',
    messages: [{ role: 'user', content: '总结内容' }]
  });
  assert.equal(adapter.parseResponse({ choices: [{ message: { content: '结果' } }] }), '结果');
});

test('Anthropic 原生适配器继续可用', async () => {
  const adapter = (await loadAdapters()).getAdapter('anthropic');
  assert.equal(adapter.headers('key')['x-api-key'], 'key');
  assert.equal(adapter.parseResponse({ content: [{ text: '结果' }] }), '结果');
});

test('响应缺少正文时抛出中文错误', async () => {
  const adapter = (await loadAdapters()).getAdapter('openai-compatible');
  assert.throws(() => adapter.parseResponse({ choices: [] }), /未返回可用内容/);
});
