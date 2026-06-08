/**
 * background.js - Service Worker
 * 处理扩展的后台逻辑：初始化存储、管理评论和分类的增删查改、处理消息通信
 */

/* 默认分类列表 */
const DEFAULT_CATEGORIES = ['未分类', '好物', '避雷', '搞笑'];

/* 存储键名 */
const STORAGE_KEY_COMMENTS = 'xhs_comments';
const STORAGE_KEY_CATEGORIES = 'xhs_categories';

/**
 * 扩展安装或更新时，初始化默认分类
 */
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(STORAGE_KEY_CATEGORIES);
  if (!result[STORAGE_KEY_CATEGORIES]) {
    await chrome.storage.local.set({ [STORAGE_KEY_CATEGORIES]: DEFAULT_CATEGORIES });
  }
  // 初始化评论列表为空数组（如果不存在）
  const comments = await chrome.storage.local.get(STORAGE_KEY_COMMENTS);
  if (!comments[STORAGE_KEY_COMMENTS]) {
    await chrome.storage.local.set({ [STORAGE_KEY_COMMENTS]: [] });
  }
});

/**
 * 点击扩展图标时打开管理页面
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
});

/**
 * 生成唯一 ID
 * @returns {string} 时间戳+随机数的字符串
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/**
 * 获取所有评论
 * @returns {Promise<Array>} 评论列表
 */
async function getComments() {
  const result = await chrome.storage.local.get(STORAGE_KEY_COMMENTS);
  return result[STORAGE_KEY_COMMENTS] || [];
}

/**
 * 保存单条评论
 * @param {Object} comment - 评论数据（不含 id 和 savedAt）
 * @returns {Promise<Object>} 保存后的完整评论
 */
async function saveComment(comment) {
  const newComment = {
    ...comment,
    id: generateId(),
    savedAt: Date.now()
  };
  const comments = await getComments();
  comments.unshift(newComment);
  await chrome.storage.local.set({ [STORAGE_KEY_COMMENTS]: comments });
  return newComment;
}

/**
 * 批量保存评论组（多条评论一起收藏，共享同一 groupId）
 * @param {Array} commentsData - 评论数据数组
 * @returns {Promise<Array>} 保存后的评论列表
 */
async function saveCommentGroup(commentsData) {
  const groupId = generateId();
  const now = Date.now();
  const comments = await getComments();

  const newComments = commentsData.map((c, i) => ({
    ...c,
    id: generateId(),
    groupId: groupId,
    groupIndex: i,
    savedAt: now
  }));

  comments.unshift(...newComments);
  await chrome.storage.local.set({ [STORAGE_KEY_COMMENTS]: comments });
  return newComments;
}

/**
 * 删除评论
 * @param {string} id - 评论 ID
 * @returns {Promise<Array>} 删除后的评论列表
 */
async function deleteComment(id) {
  const comments = await getComments();
  const filtered = comments.filter(c => c.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEY_COMMENTS]: filtered });
  return filtered;
}

/**
 * 获取所有分类
 * @returns {Promise<Array>} 分类列表
 */
async function getCategories() {
  const result = await chrome.storage.local.get(STORAGE_KEY_CATEGORIES);
  return result[STORAGE_KEY_CATEGORIES] || DEFAULT_CATEGORIES;
}

/**
 * 添加分类
 * @param {string} name - 分类名
 * @returns {Promise<Array>} 更新后的分类列表
 */
async function addCategory(name) {
  const categories = await getCategories();
  if (categories.includes(name)) {
    throw new Error('分类已存在');
  }
  categories.push(name);
  await chrome.storage.local.set({ [STORAGE_KEY_CATEGORIES]: categories });
  return categories;
}

/**
 * 删除分类
 * @param {string} name - 分类名
 * @returns {Promise<Array>} 更新后的分类列表
 */
async function deleteCategory(name) {
  if (name === '未分类') throw new Error('「未分类」不可删除');
  const categories = await getCategories();
  const filtered = categories.filter(c => c !== name);
  await chrome.storage.local.set({ [STORAGE_KEY_CATEGORIES]: filtered });
  // 将该分类下的评论移到第一个剩余分类
  const comments = await getComments();
  const fallback = filtered[0] || '好物';
  const updated = comments.map(c => c.category === name ? { ...c, category: fallback } : c);
  await chrome.storage.local.set({ [STORAGE_KEY_COMMENTS]: updated });
  return filtered;
}

/**
 * 重命名分类
 * @param {string} oldName - 旧分类名
 * @param {string} newName - 新分类名
 * @returns {Promise<Array>} 更新后的分类列表
 */
async function renameCategory(oldName, newName) {
  if (oldName === '未分类') throw new Error('「未分类」不可重命名');
  const categories = await getCategories();
  if (categories.includes(newName)) {
    throw new Error('目标分类名已存在');
  }
  const idx = categories.indexOf(oldName);
  if (idx === -1) {
    throw new Error('分类不存在');
  }
  categories[idx] = newName;
  await chrome.storage.local.set({ [STORAGE_KEY_CATEGORIES]: categories });
  // 更新该分类下所有评论的分类名
  const comments = await getComments();
  const updated = comments.map(c => c.category === oldName ? { ...c, category: newName } : c);
  await chrome.storage.local.set({ [STORAGE_KEY_COMMENTS]: updated });
  return categories;
}

/**
 * 更新评论的分类
 * @param {string} id - 评论 ID
 * @param {string} category - 新分类名
 * @returns {Promise<Object>} 更新后的评论
 */
async function updateCommentCategory(id, category) {
  const comments = await getComments();
  const comment = comments.find(c => c.id === id);
  if (!comment) {
    throw new Error('评论不存在');
  }
  comment.category = category;
  await chrome.storage.local.set({ [STORAGE_KEY_COMMENTS]: comments });
  return comment;
}

/* 消息处理：根据 action 类型分发到对应的处理函数 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    saveComment:       () => saveComment(message.data),
    saveCommentGroup:  () => saveCommentGroup(message.data.comments),
    deleteComment:     () => deleteComment(message.id),
    getComments:       () => getComments(),
    getCategories:     () => getCategories(),
    addCategory:       () => addCategory(message.name),
    deleteCategory:    () => deleteCategory(message.name),
    renameCategory:    () => renameCategory(message.oldName, message.newName),
    updateCategory:    () => updateCommentCategory(message.id, message.category)
  };

  const handler = handlers[message.action];
  if (!handler) {
    sendResponse({ success: false, error: '未知操作' });
    return false;
  }

  handler()
    .then(data => sendResponse({ success: true, data }))
    .catch(err => sendResponse({ success: false, error: err.message }));

  // 返回 true 表示异步 sendResponse
  return true;
});
