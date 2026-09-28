/**
 * 验证 AI 接口按主机检查和申请 Chrome 可选权限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function createController(permissions) {
  const context = vm.createContext({ URL });
  context.globalThis = context;
  vm.runInContext(await readFile('manager/api-config-core.js', 'utf8'), context);
  vm.runInContext(await readFile('manager/api-permission.js', 'utf8'), context);
  return context.XHS_API_PERMISSION.createPermissionController({
    permissions,
    core: context.XHS_API_CONFIG_CORE
  });
}

test('已有主机权限时不会重复申请', async () => {
  let requestCount = 0;
  const controller = await createController({
    contains: async () => true,
    request: async () => { requestCount += 1; return true; }
  });
  assert.equal(await controller.request('https://api.example.com/v1/chat/completions'), true);
  assert.equal(requestCount, 0);
});

test('用户拒绝主机权限时返回 false', async () => {
  const controller = await createController({
    contains: async () => false,
    request: async request => {
      assert.equal(request.origins[0], 'https://api.example.com/*');
      return false;
    }
  });
  assert.equal(await controller.request('https://api.example.com/v1/chat/completions'), false);
});

test('调用前可复核当前主机权限', async () => {
  let checkedOrigin = '';
  const controller = await createController({
    contains: async request => {
      checkedOrigin = request.origins[0];
      return true;
    },
    request: async () => false
  });
  assert.equal(await controller.has('https://api.example.com/v1/chat/completions'), true);
  assert.equal(checkedOrigin, 'https://api.example.com/*');
});
