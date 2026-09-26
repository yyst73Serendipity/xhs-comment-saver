/**
 * 管理 Google 登录桥、所有者校验和账号本地命名空间切换。
 */
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signOut
} from 'firebase/auth/web-extension';
import { activateAccount } from '../storage/account-state.js';
import { config, extensionId } from '../config/firebase-config.js';
import { acceptAuthMessage, isConfigured, isOwnerConfigured } from './auth-guard.js';
import { firebaseClient } from './firebase-client.js';

export const AUTH_ACTIONS = new Set(['cloudLogin', 'cloudLogout', 'cloudStatus']);
const AUTH_OFFSCREEN_PATH = 'offscreen/offscreen.html';

/** 检查认证隐藏文档是否存在，兼容 Chrome 116 的 runtime.getContexts。 */
export async function hasAuthOffscreenDocument(options = {}) {
  const runtime = options.runtime || globalThis.chrome?.runtime;
  const clientsApi = options.clientsApi === undefined ? globalThis.clients : options.clientsApi;
  const documentUrl = runtime?.getURL?.(AUTH_OFFSCREEN_PATH);
  if (!documentUrl) return false;
  if (typeof runtime.getContexts === 'function') {
    const contexts = await runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl]
    });
    return contexts.length > 0;
  }
  if (typeof clientsApi?.matchAll === 'function') {
    const clients = await clientsApi.matchAll();
    return clients.some(client => client.url === documentUrl);
  }
  return false;
}

/** 创建可注入浏览器边界的认证服务，保证并发请求只打开一个登录流程。 */
export function createAuthService(options = {}) {
  const clientFactory = options.clientFactory || firebaseClient;
  const configValue = options.configValue || config;
  const extensionIdValue = options.extensionIdValue || extensionId;
  const offscreen = options.offscreen || globalThis.chrome?.offscreen;
  const runtime = options.runtime || globalThis.chrome?.runtime;
  const clientsApi = options.clientsApi === undefined ? globalThis.clients : options.clientsApi;
  const sendMessage = options.sendMessage || (message => globalThis.chrome.runtime.sendMessage(message));
  const randomUUID = options.randomUUID || (() => globalThis.crypto.randomUUID());
  const makeCredential = options.makeCredential || (token => GoogleAuthProvider.credential(token));
  const signIn = options.signIn || signInWithCredential;
  const signOutUser = options.signOutUser || signOut;
  const observeAuth = options.observeAuth || onAuthStateChanged;
  let signingIn = null;

  /** 发起一次受控 Google 登录，任何结果都销毁隐藏认证文档。 */
  function login() {
    if (signingIn) return signingIn;
    signingIn = (async () => {
      const client = clientFactory();
      if (!client) throw new Error('请先配置 Firebase，当前仍可使用本地评论收藏');
      const requestId = randomUUID();
      let created = false;
      try {
        if (await hasAuthOffscreenDocument({ runtime, clientsApi })) await offscreen.closeDocument();
        await offscreen.createDocument({
          url: AUTH_OFFSCREEN_PATH,
          reasons: ['IFRAME_SCRIPTING'],
          justification: '通过受控托管页面完成用户主动请求的 Google 登录'
        });
        created = true;
        const response = await sendMessage({ target: 'auth-offscreen', requestId });
        if (!acceptAuthMessage(response, {
          extensionId: extensionIdValue,
          requestId,
          now: Date.now()
        }) || typeof response.idToken !== 'string' || !response.idToken) {
          throw new Error('Google 登录响应无效或已过期，请重新尝试');
        }
        const signed = await signIn(client.auth, makeCredential(response.idToken));
        if (configValue.ownerUid && signed.user.uid !== configValue.ownerUid) {
          await signOutUser(client.auth);
          throw new Error('此扩展仅允许配置的个人账号登录');
        }
        return { uid: signed.user.uid, email: signed.user.email || '' };
      } finally {
        if (created) await offscreen.closeDocument().catch(() => {});
      }
    })().finally(() => { signingIn = null; });
    return signingIn;
  }

  /** 退出 Firebase Auth；账号的本地工作区由调用方保留。 */
  async function logout() {
    const client = clientFactory();
    if (client) await signOutUser(client.auth);
  }

  /** 订阅 Firebase Auth 状态，并拒绝已持久化的非所有者账号。 */
  function observe(callback) {
    const client = clientFactory();
    if (!client) {
      queueMicrotask(() => {
        void Promise.resolve(callback(null)).catch(() => {});
      });
      return () => {};
    }
    return observeAuth(client.auth, async user => {
      if (user && configValue.ownerUid && user.uid !== configValue.ownerUid) {
        await signOutUser(client.auth);
        await callback(null);
        return;
      }
      await callback(user ? { uid: user.uid, email: user.email || '' } : null);
    });
  }

  return { login, logout, observe };
}

let sharedService;

/** 返回后台进程内唯一的认证服务。 */
export function authService() {
  if (!sharedService) sharedService = createAuthService();
  return sharedService;
}

/** 把 Firebase Auth 变化串行写入 LocalStore 的当前账号指针。 */
export function bindAuthState({ service, store, logger = console }) {
  let resolveReady;
  let rejectReady;
  let waitingForInitialState = true;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Service Worker 启动时即使初始化失败，也不产生未处理的 Promise 拒绝。
  void ready.catch(() => {});
  const unsubscribe = service.observe(async user => {
    try {
      await store.update(state => activateAccount(state, user));
      if (waitingForInitialState) resolveReady();
    } catch (error) {
      logger.error('[评论收藏] 更新登录状态失败:', error);
      if (waitingForInitialState) rejectReady(new Error('登录状态初始化失败，请重新加载扩展'));
    } finally {
      waitingForInitialState = false;
    }
  });
  return { ready, unsubscribe };
}

/** 在 Firebase 首次认证状态落盘后，才分发任何账号范围消息。 */
export function createAuthReadyDispatcher({ ready, dispatchLocal, dispatchAuth }) {
  return async function dispatchReady(message) {
    await ready;
    return AUTH_ACTIONS.has(message?.action) ? dispatchAuth(message) : dispatchLocal(message);
  };
}

/** 创建 cloudLogin、cloudLogout、cloudStatus 的后台分发器。 */
export function createAuthDispatcher({ service, store, configValue = config }) {
  return async function dispatchAuth(message) {
    if (!message || !AUTH_ACTIONS.has(message.action)) throw new Error('未知认证操作');
    if (message.action === 'cloudLogin') {
      const user = await service.login();
      await store.update(state => activateAccount(state, user));
      return user;
    }
    if (message.action === 'cloudLogout') {
      await service.logout();
      await store.update(state => activateAccount(state, null));
      return true;
    }
    const state = await store.read() || await store.update(value => value);
    const uid = state.activeAccountUid;
    const account = uid === null ? null : state.accounts?.[uid];
    return {
      configured: isConfigured(configValue),
      ownerConfigured: isOwnerConfigured(configValue),
      signedIn: uid !== null,
      user: account ? { uid: account.uid, email: account.email || '' } : null
    };
  };
}
