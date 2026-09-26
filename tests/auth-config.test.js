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

test('未知认证异常不会把英文原文显示给用户', () => {
  assert.equal(
    guard.friendlyAuthError?.({ code: 'auth/invalid-credential', message: 'The supplied credential is malformed.' }),
    'Google 登录凭据无效，请重新登录'
  );
  assert.equal(
    guard.friendlyAuthError?.({ message: 'Only a single offscreen document may be created.' }),
    'Google 登录暂时失败，请稍后重试'
  );
  assert.equal(
    guard.friendlyAuthError?.({ message: '请先配置 Firebase，当前仍可使用本地评论收藏' }),
    '请先配置 Firebase，当前仍可使用本地评论收藏'
  );
});

test('认证桥拒绝其他扩展来源', () => {
  const now = Date.now();
  assert.equal(guard.acceptAuthMessage?.({
    origin: 'chrome-extension://wrong',
    requestId: 'request-1',
    issuedAt: now
  }, {
    extensionId: 'right',
    requestId: 'request-1',
    now
  }), false);
});

test('认证桥拒绝过期响应', () => {
  const now = Date.now();
  assert.equal(guard.acceptAuthMessage?.({
    origin: 'chrome-extension://right',
    requestId: 'request-1',
    issuedAt: now - 120_001
  }, {
    extensionId: 'right',
    requestId: 'request-1',
    now
  }), false);
});

test('认证桥接受匹配且恰好 0 到 120 秒内的响应', () => {
  const now = Date.now();
  for (const issuedAt of [now, now - 120_000]) {
    assert.equal(guard.acceptAuthMessage?.({
      origin: 'chrome-extension://right',
      requestId: 'request-1',
      issuedAt
    }, {
      extensionId: 'right',
      requestId: 'request-1',
      now
    }), true);
  }
});

test('认证桥拒绝未来响应和不匹配的请求标识', () => {
  const now = Date.now();
  assert.equal(guard.acceptAuthMessage?.({
    origin: 'chrome-extension://right',
    requestId: 'another-request',
    issuedAt: now
  }, { extensionId: 'right', requestId: 'request-1', now }), false);
  assert.equal(guard.acceptAuthMessage?.({
    origin: 'chrome-extension://right',
    requestId: 'request-1',
    issuedAt: now + 1
  }, { extensionId: 'right', requestId: 'request-1', now }), false);
});

test('托管登录页只构造令牌、请求标识和签发时间', () => {
  assert.deepEqual(guard.createAuthResponse?.('token', 'request-1', 123), {
    idToken: 'token',
    requestId: 'request-1',
    issuedAt: 123
  });
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

test('未配置 Firebase 时登录保持纯本地模式且不创建隐藏文档', async () => {
  const { createAuthService } = await import('../auth/auth-service.js');
  let created = 0;
  const service = createAuthService({
    clientFactory: () => null,
    configValue: {},
    offscreen: { createDocument: async () => { created += 1; } }
  });
  await assert.rejects(service.login(), /请先配置 Firebase/);
  assert.equal(created, 0);
});

test('并发登录复用同一流程且始终关闭唯一隐藏文档', async () => {
  const { createAuthService } = await import('../auth/auth-service.js');
  let created = 0;
  let closed = 0;
  let resolveBridge;
  const bridge = new Promise(resolve => { resolveBridge = resolve; });
  const service = createAuthService({
    clientFactory: () => ({ auth: {} }),
    configValue: { ownerUid: 'owner' },
    extensionIdValue: 'extension-id',
    runtime: {
      getURL: path => `chrome-extension://extension-id/${path}`,
      getContexts: async () => []
    },
    offscreen: {
      createDocument: async () => { created += 1; },
      closeDocument: async () => { closed += 1; }
    },
    sendMessage: async () => bridge,
    randomUUID: () => 'request-1',
    makeCredential: token => ({ token }),
    signIn: async () => ({ user: { uid: 'owner', email: 'owner@example.com' } }),
    signOutUser: async () => {}
  });
  const first = service.login();
  const second = service.login();
  resolveBridge({
    idToken: 'token',
    requestId: 'request-1',
    issuedAt: Date.now(),
    origin: 'chrome-extension://extension-id'
  });
  assert.deepEqual(await first, { uid: 'owner', email: 'owner@example.com' });
  assert.deepEqual(await second, { uid: 'owner', email: 'owner@example.com' });
  assert.equal(created, 1);
  assert.equal(closed, 1);
});

test('所有者 UID 不匹配时撤销登录并关闭隐藏文档', async () => {
  const { createAuthService } = await import('../auth/auth-service.js');
  let signedOut = 0;
  let closed = 0;
  const service = createAuthService({
    clientFactory: () => ({ auth: {} }),
    configValue: { ownerUid: 'owner' },
    extensionIdValue: 'extension-id',
    runtime: {
      getURL: path => `chrome-extension://extension-id/${path}`,
      getContexts: async () => []
    },
    offscreen: {
      createDocument: async () => {},
      closeDocument: async () => { closed += 1; }
    },
    sendMessage: async message => ({
      idToken: 'token', requestId: message.requestId, issuedAt: Date.now(), origin: 'chrome-extension://extension-id'
    }),
    randomUUID: () => 'request-1',
    makeCredential: token => ({ token }),
    signIn: async () => ({ user: { uid: 'other', email: 'other@example.com' } }),
    signOutUser: async () => { signedOut += 1; }
  });
  await assert.rejects(service.login(), /个人账号/);
  assert.equal(signedOut, 1);
  assert.equal(closed, 1);
});

test('Chrome 116 通过 runtime.getContexts 检查隐藏文档', async () => {
  const { hasAuthOffscreenDocument } = await import('../auth/auth-service.js');
  const calls = [];
  const found = await hasAuthOffscreenDocument?.({
    runtime: {
      getURL: path => `chrome-extension://extension-id/${path}`,
      getContexts: async query => {
        calls.push(query);
        return [{ contextType: 'OFFSCREEN_DOCUMENT' }];
      }
    },
    clientsApi: null
  });
  assert.equal(found, true);
  assert.deepEqual(calls, [{
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: ['chrome-extension://extension-id/offscreen/offscreen.html']
  }]);
});

test('认证未就绪时账号消息等待首次状态并使用恢复后的账号', async () => {
  const { bindAuthState, createAuthReadyDispatcher } = await import('../auth/auth-service.js');
  const state = {
    version: 2,
    activeAccountUid: 'old-account',
    guest: { marker: 'guest' },
    accounts: Object.assign(Object.create(null), {
      'old-account': { uid: 'old-account', email: '', workspace: { marker: 'old' } }
    })
  };
  let authCallback;
  const binding = bindAuthState({
    service: { observe: callback => { authCallback = callback; return () => {}; } },
    store: { update: async callback => callback(state) }
  });
  let dispatched = false;
  const dispatch = createAuthReadyDispatcher?.({
    ready: binding?.ready,
    dispatchLocal: async () => {
      dispatched = true;
      return state.activeAccountUid;
    },
    dispatchAuth: async () => null
  });
  const pending = dispatch?.({ action: 'getComments' });
  await Promise.resolve();
  assert.equal(dispatched, false);
  await authCallback({ uid: 'new-account', email: 'new@example.com' });
  assert.equal(await pending, 'new-account');
});

test('未配置 Firebase 时首次认证状态会清除旧账号指针', async () => {
  const { bindAuthState, createAuthService } = await import('../auth/auth-service.js');
  const state = {
    version: 2,
    activeAccountUid: 'old-account',
    guest: { marker: 'guest' },
    accounts: Object.assign(Object.create(null), {
      'old-account': { uid: 'old-account', email: '', workspace: { marker: 'old' } }
    })
  };
  const binding = bindAuthState({
    service: createAuthService({ clientFactory: () => null, configValue: {} }),
    store: { update: async callback => callback(state) }
  });
  await binding?.ready;
  assert.equal(state.activeAccountUid, null);
});

test('认证状态和登录退出动作通过 LocalStore 更新账号空间', async () => {
  const { createAuthDispatcher, bindAuthState } = await import('../auth/auth-service.js');
  const state = {
    version: 2,
    activeAccountUid: null,
    guest: { marker: 'guest' },
    accounts: Object.create(null)
  };
  const store = {
    update: async callback => callback(state),
    read: async () => state
  };
  let authCallback;
  const binding = bindAuthState({
    service: { observe: callback => { authCallback = callback; return () => 'stopped'; } },
    store
  });
  await authCallback({ uid: 'owner', email: 'owner@example.com' });
  await binding.ready;
  assert.equal(state.activeAccountUid, 'owner');
  assert.equal(binding.unsubscribe(), 'stopped');

  let loggedOut = 0;
  const dispatch = createAuthDispatcher({
    service: {
      login: async () => ({ uid: 'owner', email: 'owner@example.com' }),
      logout: async () => { loggedOut += 1; }
    },
    store,
    configValue: {
      apiKey: 'key', authDomain: 'a', projectId: 'p', appId: 'app',
      authPageUrl: 'https://p.web.app', ownerUid: 'owner'
    }
  });
  assert.deepEqual(await dispatch({ action: 'cloudStatus' }), {
    configured: true,
    ownerConfigured: true,
    signedIn: true,
    user: { uid: 'owner', email: 'owner@example.com' }
  });
  await dispatch({ action: 'cloudLogout' });
  assert.equal(loggedOut, 1);
  assert.equal(state.activeAccountUid, null);
  await dispatch({ action: 'cloudLogin' });
  assert.equal(state.activeAccountUid, 'owner');
});

test('Service Worker 接入三项云认证动作和账号状态监听', async () => {
  const source = await readFile('background/background.js', 'utf8');
  assert.match(source, /AUTH_ACTIONS/);
  assert.match(source, /createAuthDispatcher/);
  assert.match(source, /bindAuthState/);
});
