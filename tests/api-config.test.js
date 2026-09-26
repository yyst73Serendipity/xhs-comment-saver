/**
 * 验证 AI 配置迁移、本机存储读取和服务商 API 来源边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('同一固定扩展 ID 迁移后构建版直接从本机存储读取', async () => {
  const context = await loadApiModules();
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  const extensionId = createHash('sha256')
    .update(Buffer.from(manifest.key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + Number.parseInt(value, 16)));
  const storageByExtensionId = new Map([[extensionId, {}]]);
  const bucket = storageByExtensionId.get(extensionId);
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

  let distFetchCount = 0;
  const loadedInDist = await context.XHS_API_CONFIG_STORE.readApiConfig({
    storage,
    allowLegacy: false,
    fetchResource: async () => {
      distFetchCount += 1;
      throw new Error('构建版不应读取旧配置文件');
    }
  });
  assert.equal(loadedInDist.migrated, false);
  assert.equal(loadedInDist.value.providers.deepseek.apiKey, 'secret-key');
  assert.equal(distFetchCount, 0);

  delete bucket.xhs_api_config;
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
});
