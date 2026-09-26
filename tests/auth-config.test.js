/**
 * 验证 Firebase 配置边界和 Manifest V3 云同步权限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const guard = await import('../auth/auth-guard.js').catch(() => ({}));

test('完整 Firebase 配置可启用登录准备', () => {
  assert.equal(typeof guard.isConfigured, 'function');
  assert.equal(guard.isConfigured({
    apiKey: 'key',
    authDomain: 'project.firebaseapp.com',
    projectId: 'project',
    appId: 'app',
    authPageUrl: 'https://project.web.app',
    ownerUid: 'uid'
  }), true);
});

test('缺少所有者 UID 时允许配置登录但禁止数据访问', () => {
  const value = {
    apiKey: 'key',
    authDomain: 'project.firebaseapp.com',
    projectId: 'project',
    appId: 'app',
    authPageUrl: 'https://project.web.app'
  };
  assert.equal(guard.isConfigured(value), true);
  assert.equal(guard.isOwnerConfigured(value), false);
});

test('无效所有者 UID 不得启用数据访问', () => {
  const value = {
    apiKey: 'key',
    authDomain: 'project.firebaseapp.com',
    projectId: 'project',
    appId: 'app',
    authPageUrl: 'https://project.web.app',
    ownerUid: 'uid with spaces'
  };
  assert.equal(guard.isOwnerConfigured(value), false);
});

test('外部错误转换为明确的中文提示', () => {
  assert.equal(
    guard.friendlyError({ code: 'auth/network-request-failed' }),
    '网络连接失败，本地修改会保留并稍后重试'
  );
  assert.equal(
    guard.friendlyError({ code: 'permission-denied' }),
    '云端权限被拒绝，请检查登录账号和数据库规则'
  );
});

test('Manifest 提供云同步所需的扩展能力', async () => {
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  for (const permission of ['storage', 'unlimitedStorage', 'alarms', 'offscreen']) {
    assert.equal(manifest.permissions.includes(permission), true);
  }
  assert.equal(manifest.background.type, 'module');
  assert.equal(typeof manifest.key, 'string');
  assert.equal(manifest.host_permissions.includes('https://*.googleapis.com/*'), true);
  assert.equal(manifest.host_permissions.includes('https://*.firebaseapp.com/*'), false);
  assert.equal(manifest.host_permissions.includes('https://*.web.app/*'), false);
  assert.equal(manifest.content_security_policy.extension_pages.includes("script-src 'self'"), true);
  assert.equal(manifest.content_security_policy.extension_pages.includes("object-src 'none'"), true);
});
