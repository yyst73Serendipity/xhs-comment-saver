/**
 * 托管登录页面：验证父窗口的固定扩展来源并仅回传短期 ID token。
 */
import {
  GoogleAuthProvider,
  browserPopupRedirectResolver,
  inMemoryPersistence,
  initializeAuth,
  signInWithPopup,
  signOut
} from 'firebase/auth';
import { initializeApp } from 'firebase/app';
import { config, extensionId } from '../config/firebase-config.js';
import { createAuthResponse } from '../auth/auth-guard.js';

const allowedOrigin = `chrome-extension://${extensionId}`;
let auth;
let busy = false;

/** 仅在收到合法扩展请求后创建不持久化的 Hosting Auth 实例。 */
function hostedAuth() {
  if (!auth) {
    auth = initializeAuth(initializeApp(config), {
      persistence: inMemoryPersistence,
      popupRedirectResolver: browserPopupRedirectResolver
    });
  }
  return auth;
}

window.addEventListener('message', async event => {
  const requestId = event.data?.requestId;
  if (
    event.source !== window.parent
    || event.origin !== allowedOrigin
    || event.data?.type !== 'xhs-comment-auth-start'
    || typeof requestId !== 'string'
    || !requestId
    || busy
  ) return;

  busy = true;
  const currentAuth = hostedAuth();
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const result = await signInWithPopup(currentAuth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    window.parent.postMessage(createAuthResponse(
      credential?.idToken || '', requestId, Date.now()
    ), allowedOrigin);
  } catch (error) {
    console.error('[评论收藏] Google 登录失败:', error?.code || error?.name || 'unknown');
    window.parent.postMessage(createAuthResponse('', requestId, Date.now()), allowedOrigin);
  } finally {
    await signOut(currentAuth).catch(() => {});
    busy = false;
  }
});
