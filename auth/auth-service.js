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

/** 创建可注入浏览器边界的认证服务，保证并发请求只打开一个登录流程。 */
export function createAuthService(options = {}) {
  const clientFactory = options.clientFactory || firebaseClient;
  const configValue = options.configValue || config;
  const extensionIdValue = options.extensionIdValue || extensionId;
  const offscreen = options.offscreen || globalThis.chrome?.offscreen;
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
        if (await offscreen.hasDocument()) await offscreen.closeDocument();
        await offscreen.createDocument({
          url: 'offscreen/offscreen.html',
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
    if (!client) return () => {};
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
  return service.observe(user => store.update(state => activateAccount(state, user)).catch(error => {
    logger.error('[评论收藏] 更新登录状态失败:', error);
  }));
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
