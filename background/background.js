/**
 * Service Worker：统一处理本地数据消息，并保留点击图标打开管理页的行为。
 */
import { LocalStore } from '../storage/local-store.js';
import { createLocalDispatcher, respondToLocalMessage } from './local-dispatch.js';
import {
  AUTH_ACTIONS,
  authService,
  bindAuthState,
  createAuthDispatcher,
  createAuthReadyDispatcher
} from '../auth/auth-service.js';
import { friendlyAuthError } from '../auth/auth-guard.js';

const store = new LocalStore();
const dispatchLocal = createLocalDispatcher(store);
const authentication = authService();
const dispatchAuth = createAuthDispatcher({ service: authentication, store });

// Firebase 恢复或清除会话时，只切换活动命名空间，不删除任何账号工作区。
const authBinding = bindAuthState({ service: authentication, store });
const dispatchReady = createAuthReadyDispatcher({
  ready: authBinding.ready,
  dispatchLocal,
  dispatchAuth
});

/** 首次安装或旧版升级时创建 v2 工作区和兼容投影。 */
chrome.runtime.onInstalled.addListener(() => {
  store.update(() => {}).catch(error => {
    console.error('[评论收藏] 初始化本地数据失败:', error);
  });
});

/** 点击扩展图标时打开管理页面。 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
});

/** 通知已打开的小红书页面刷新收藏标记。 */
async function notifyDataChanged() {
  const tabs = await chrome.tabs.query({ url: '*://*.xiaohongshu.com/*' });
  await Promise.allSettled(tabs.map(tab => (
    tab.id == null ? Promise.resolve() : chrome.tabs.sendMessage(tab.id, { action: 'dataChanged' })
  )));
}

/** 统一包装异步消息响应，失败日志只记录动作名和错误。 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'auth-offscreen') return false;
  if (AUTH_ACTIONS.has(message?.action)) {
    void dispatchReady(message).then(data => {
      sendResponse({ success: true, data });
    }).catch(error => {
      console.error(`[评论收藏] ${message.action} 操作失败:`, error?.code || error?.name || 'unknown');
      sendResponse({ success: false, error: friendlyAuthError(error) });
    });
    return true;
  }
  void respondToLocalMessage(dispatchReady, notifyDataChanged, message, sendResponse);
  return true;
});
