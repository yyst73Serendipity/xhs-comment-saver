/**
 * 把扩展消息映射到统一账号存储，并维持旧版界面依赖的返回结构。
 */
import { currentWorkspace, mutate } from '../storage/account-state.js';
import { project } from '../storage/model.js';

const READ_ACTIONS = new Set(['getComments', 'getCategories', 'getSummaries']);

export const LOCAL_MUTATION_ACTIONS = new Set([
  'saveComment', 'saveCommentGroup', 'deleteComment', 'updateNote', 'updateCategory',
  'addCategory', 'renameCategory', 'deleteCategory', 'reorderCategories',
  'saveSummary', 'deleteSummary', 'importData', 'clearAll', 'resolveConflict'
]);

function readResult(action, projection) {
  if (action === 'getComments') return projection.comments;
  if (action === 'getCategories') return projection.categories;
  return projection.summaries;
}

/** 根据修改后的投影生成旧内容脚本和管理页仍可直接使用的响应。 */
function mutationResult(message, result, projection) {
  switch (message.action) {
    case 'saveComment':
      return projection.comments.find(comment => comment.id === result);
    case 'saveCommentGroup': {
      const byId = new Map(projection.comments.map(comment => [comment.id, comment]));
      return result.map(id => byId.get(id)).filter(Boolean);
    }
    case 'deleteComment':
      return projection.comments;
    case 'updateNote':
      return projection.comments.find(comment => comment.id === message.id);
    case 'updateCategory': {
      const selected = projection.comments.find(comment => comment.id === message.id);
      if (!selected) return [];
      return selected.groupId
        ? projection.comments.filter(comment => comment.groupId === selected.groupId)
        : [selected];
    }
    case 'addCategory':
    case 'renameCategory':
    case 'deleteCategory':
    case 'reorderCategories':
      return projection.categories;
    case 'saveSummary':
      return projection.summaries[message.category];
    case 'deleteSummary':
      return projection.summaries;
    case 'importData':
    case 'clearAll':
    case 'resolveConflict':
      return projection;
    default:
      return result;
  }
}

/** 创建可注入存储实现的本地业务分发器。 */
export function createLocalDispatcher(store) {
  return async function dispatch(message) {
    if (!message || typeof message !== 'object') throw new Error('消息格式无效');
    if (READ_ACTIONS.has(message.action)) {
      const state = await store.read();
      if (state) return readResult(message.action, project(currentWorkspace(state)));
      return store.update(initialState => readResult(message.action, project(currentWorkspace(initialState))));
    }
    if (!LOCAL_MUTATION_ACTIONS.has(message.action)) throw new Error('未知操作');
    return store.update(async state => {
      const result = await mutate(state, message);
      return mutationResult(message, result, project(currentWorkspace(state)));
    });
  };
}

/**
 * 发送本地动作响应；页面刷新通知在成功响应之后异步执行，不能阻塞已落盘的修改。
 */
export async function respondToLocalMessage(dispatch, notify, message, sendResponse, logger = console) {
  try {
    const data = await dispatch(message);
    sendResponse({ success: true, data });
    if (LOCAL_MUTATION_ACTIONS.has(message.action)) {
      void Promise.resolve()
        .then(() => notify())
        .catch(error => logger.warn('[评论收藏] 通知页面刷新失败:', error));
    }
  } catch (error) {
    logger.error(`[评论收藏] ${message?.action || '未知'} 操作失败:`, error);
    sendResponse({ success: false, error: error?.message || '操作失败' });
  }
}
