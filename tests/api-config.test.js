/**
 * 验证 AI 配置迁移、本机存储读取和服务商 API 来源边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadApiModules() {
  const context = vm.createContext({ URL });
  context.globalThis = context;
  vm.runInContext(await readFile('manager/api-config-core.js', 'utf8'), context);
  vm.runInContext(await readFile('manager/api-config-store.js', 'utf8'), context);
  return context;
}

test('任意公网 HTTPS OpenAI 兼容端点可生成精确主机权限', async () => {
  const context = await loadApiModules();
  const { validateApiUrl, createHostPermissionPattern } = context.XHS_API_CONFIG_CORE;
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));

  const examples = [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'https://dashscope.aliyuncs.com/*'],
    ['https://api.moonshot.cn/v1/chat/completions', 'https://api.moonshot.cn/*'],
    ['https://open.bigmodel.cn/api/paas/v4/chat/completions', 'https://open.bigmodel.cn/*']
  ];
  for (const [url, permission] of examples) {
    assert.equal(validateApiUrl(url), url);
    assert.equal(createHostPermissionPattern(url), permission);
  }

  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.equal(manifest.host_permissions.includes('https://*/*'), false);
  assert.equal(manifest.host_permissions.some(value => /api\.(openai|deepseek|minimax|anthropic)/.test(value)), false);
});

test('非公网 HTTPS API 地址被拒绝', async () => {
  const { validateApiUrl } = (await loadApiModules()).XHS_API_CONFIG_CORE;
  for (const value of [
    'http://api.example.com/v1/chat/completions',
    'https://localhost/v1/chat/completions',
    'https://model.local/v1/chat/completions',
    'https://127.0.0.1/v1/chat/completions',
    'https://192.168.1.2/v1/chat/completions',
    'https://user:secret@api.example.com/v1/chat/completions'
  ]) assert.throws(() => validateApiUrl(value));
});

test('任意服务商名称按 OpenAI 兼容协议标准化', async () => {
  const { normalizeApiConfig } = (await loadApiModules()).XHS_API_CONFIG_CORE;
  const result = normalizeApiConfig({
    activeProvider: ' Qwen ',
    providers: {
      qwen: {
        protocol: 'openai-compatible',
        apiKey: 'secret',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        model: 'qwen-plus'
      }
    }
  });
  assert.equal(result.provider, 'qwen');
  assert.equal(result.protocol, 'openai-compatible');
  assert.equal(result.model, 'qwen-plus');
});

test('同一源码加载路径可把旧配置迁移到当前安装实例', async () => {
  const context = await loadApiModules();
  const bucket = {};
  const storage = {
    async get(key) { return { [key]: bucket[key] }; },
    async set(value) { Object.assign(bucket, value); }
  };
  const sourceFetch = async path => {
    if (path === '../.env') return { ok: true, text: async () => 'DEEPSEEK_API_KEY=secret-key' };
    if (path === 'apiconfig.local.json') return { ok: false };
    if (path === 'apiconfig.json') {
      return {
        ok: true,
        json: async () => ({
          activeProvider: 'deepseek',
          providers: {
            deepseek: {
              apiKeyRef: 'DEEPSEEK_API_KEY',
              baseUrl: 'https://api.deepseek.com/chat/completions',
              model: 'deepseek-chat'
            }
          }
        })
      };
    }
    throw new Error(`未知路径：${path}`);
  };

  const migrated = await context.XHS_API_CONFIG_STORE.readApiConfig({ storage, fetchResource: sourceFetch });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.value.providers.deepseek.apiKey, 'secret-key');
  assert.equal(bucket.xhs_api_config.providers.deepseek.apiKey, 'secret-key');
});

test('构建版首次安装不读取旧文件并可保存本机配置', async () => {
  const context = await loadApiModules();
  const bucket = {};
  const storage = {
    async get(key) { return { [key]: bucket[key] }; },
    async set(value) { Object.assign(bucket, value); }
  };

  let distFetchCount = 0;
  const emptyDist = await context.XHS_API_CONFIG_STORE.readApiConfig({
    storage,
    allowLegacy: false,
    fetchResource: async () => {
      distFetchCount += 1;
      throw new Error('构建版不应读取旧配置文件');
    }
  });
  assert.equal(emptyDist.value, null);
  assert.equal(distFetchCount, 0);

  const enteredInDist = {
    activeProvider: 'deepseek',
    providers: {
      deepseek: {
        apiKey: 'new-install-key',
        baseUrl: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-chat'
      }
    }
  };
  await storage.set({ [context.XHS_API_CONFIG_STORE.STORAGE_KEY]: enteredInDist });
  const loadedInDist = await context.XHS_API_CONFIG_STORE.readApiConfig({
    storage,
    allowLegacy: false,
    fetchResource: async () => {
      distFetchCount += 1;
      throw new Error('构建版不应读取旧配置文件');
    }
  });
  assert.equal(loadedInDist.value.providers.deepseek.apiKey, 'new-install-key');
  assert.equal(context.XHS_API_CONFIG_CORE.normalizeApiConfig(loadedInDist.value).provider, 'deepseek');
  assert.equal(distFetchCount, 0);
});
