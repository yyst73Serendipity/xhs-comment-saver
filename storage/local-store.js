/**
 * 串行保存账号状态，并在同一次原子写入中广播旧界面需要的兼容投影。
 */
import { createState, currentWorkspace } from './account-state.js';
import { project } from './model.js';

export const STATE_KEY = 'xhs_comment_state_v2';
const LEGACY_KEYS = ['xhs_comments', 'xhs_categories', 'xhs_summaries'];
let sharedTail = Promise.resolve();

export class LocalStore {
  /** 串行读取最新状态、执行修改，并只调用一次 storage.set 原子提交。 */
  update(callback) {
    if (typeof callback !== 'function') return Promise.reject(new Error('本地存储更新函数无效'));
    const task = sharedTail.then(async () => {
      const saved = await chrome.storage.local.get([STATE_KEY, ...LEGACY_KEYS]);
      const source = saved[STATE_KEY] || await createState(
        saved.xhs_comments || [],
        saved.xhs_categories || ['未分类', '好物', '避雷', '搞笑'],
        saved.xhs_summaries || {}
      );
      // 回调只修改内存副本，失败时不会污染已读取的存储对象。
      const state = structuredClone(source);
      const result = await callback(state);
      const projection = project(currentWorkspace(state));
      await chrome.storage.local.set({
        [STATE_KEY]: state,
        xhs_comments: projection.comments,
        xhs_categories: projection.categories,
        xhs_summaries: projection.summaries
      });
      return result;
    });
    sharedTail = task.catch(() => {});
    return task;
  }

  /** 等待正在进行的写入后读取持久化状态。 */
  async read() {
    await sharedTail;
    const saved = await chrome.storage.local.get(STATE_KEY);
    return saved[STATE_KEY] || null;
  }
}
