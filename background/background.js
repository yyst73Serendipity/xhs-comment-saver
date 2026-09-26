/**
 * Service Worker：统一处理本地数据消息，并保留点击图标打开管理页的行为。
 */
import { LocalStore } from '../storage/local-store.js';
import { createLocalDispatcher, respondToLocalMessage } from './local-dispatch.js';

const store = new LocalStore();
const dispatchLocal = createLocalDispatcher(store);

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
  void respondToLocalMessage(dispatchLocal, notifyDataChanged, message, sendResponse);
  return true;
});
