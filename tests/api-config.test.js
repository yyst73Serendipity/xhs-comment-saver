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

test('只接受四个服务商各自已授权的 API 来源', async () => {
  const context = await loadApiModules();
  const { PROVIDER_DEFAULTS, validateProviderUrl } = context.XHS_API_CONFIG_CORE;
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));

  for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    assert.equal(validateProviderUrl(provider, defaults.baseUrl), defaults.baseUrl);
    const originPermission = `${new URL(defaults.baseUrl).origin}/*`;
    assert.equal(manifest.host_permissions.includes(originPermission), true);
  }
  const expectedPermissions = Object.values(PROVIDER_DEFAULTS)
    .map(defaults => `${new URL(defaults.baseUrl).origin}/*`)
    .sort();
  const actualPermissions = manifest.host_permissions
    .filter(value => value.startsWith('https://api.'))
    .sort();
  assert.deepEqual(actualPermissions, expectedPermissions);
  assert.throws(
    () => validateProviderUrl('deepseek', 'https://llm.example.com/chat/completions'),
    /只能使用 DeepSeek 官方 API 地址/
  );
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
