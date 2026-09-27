/**
 * Service Worker：统一处理本地数据消息，并保留点击图标打开管理页的行为。
 */
import { LocalStore } from '../storage/local-store.js';
import {
  LOCAL_MUTATION_ACTIONS,
  createLocalDispatcher,
  respondToLocalMessage
} from './local-dispatch.js';
import {
  AUTH_ACTIONS,
  authService,
  bindAuthState,
  createAuthDispatcher,
  createAuthReadyDispatcher
} from '../auth/auth-service.js';
import { friendlyAuthError, isOwnerConfigured } from '../auth/auth-guard.js';
import { firebaseClient } from '../auth/firebase-client.js';
import { config } from '../config/firebase-config.js';
import { CloudStore } from '../sync/cloud-store.js';
import {
  SYNC_ACTIONS,
  SYNC_ALARM,
  SyncEngine,
  createSyncDispatcher,
  currentSyncStatus
} from '../sync/sync-engine.js';

const store = new LocalStore();
const dispatchLocalBase = createLocalDispatcher(store);
const authentication = authService();
const dispatchAuthBase = createAuthDispatcher({ service: authentication, store });
const firebase = firebaseClient();
const syncEngine = firebase && isOwnerConfigured(config)
  ? new SyncEngine({
      store,
      cloud: new CloudStore(firebase.db),
      alarms: chrome.alarms,
      onDataChanged: notifyDataChanged
    })
  : null;
const dispatchSync = createSyncDispatcher({ store, engine: syncEngine });

function startSync(reason, options) {
  if (!syncEngine) return;
  void syncEngine.sync(options).catch(error => {
    console.warn(`[评论收藏] ${reason}触发的云同步未完成:`, error?.cause?.code || error?.name || 'unknown');
  });
}

async function dispatchLocal(message) {
  const result = await dispatchLocalBase(message);
  if (LOCAL_MUTATION_ACTIONS.has(message?.action)) {
    const state = await store.read();
    if (state?.activeAccountUid != null) startSync('本地修改');
  }
  return result;
}

async function dispatchAuth(message) {
  const result = await dispatchAuthBase(message);
  if (message.action === 'cloudLogin') startSync('登录');
  if (message.action === 'cloudStatus') {
    return { ...result, ...currentSyncStatus(await store.read()) };
  }
  return result;
}

// Firebase 恢复或清除会话时，只切换活动命名空间，不删除任何账号工作区。
const authBinding = bindAuthState({ service: authentication, store });
const dispatchReady = createAuthReadyDispatcher({
  ready: authBinding.ready,
  dispatchLocal,
  dispatchAuth
});

async function dispatchMessage(message) {
  await authBinding.ready;
  return SYNC_ACTIONS.has(message?.action) ? dispatchSync(message) : dispatchReady(message);
}

// Service Worker 恢复已登录会话后主动续传，无需等待页面打开。
void authBinding.ready.then(async () => {
  const state = await store.read();
  if (state?.activeAccountUid != null) startSync('会话恢复');
}).catch(() => {});

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

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === SYNC_ALARM) startSync('定时重试', { rerunIfRunning: false });
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
  void respondToLocalMessage(dispatchMessage, notifyDataChanged, message, sendResponse);
  return true;
});
