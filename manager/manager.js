/**
 * manager.js - 管理页面逻辑
 * 管理收藏评论：按分类查看、搜索、删除评论，管理分类（增删改）
 */

/* 状态 */
let comments = [];
let categories = [];
let currentCategory = '全部';  // 当前选中的分类，「全部」表示显示所有
let searchKeyword = '';        // 当前搜索关键词

/* DOM 元素引用 */
const categoryList = document.getElementById('category-list');
const commentList = document.getElementById('comment-list');
const emptyState = document.getElementById('empty-state');
const totalCount = document.getElementById('total-count');
const searchInput = document.getElementById('search-input');
const currentCategoryLabel = document.getElementById('current-category-label');
const newCatInput = document.getElementById('new-cat-input');
const inputCatName = document.getElementById('input-cat-name');
const btnAddCat = document.getElementById('btn-add-cat');
const btnConfirmCat = document.getElementById('btn-confirm-cat');
const btnCancelCat = document.getElementById('btn-cancel-cat');
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');
const importFile = document.getElementById('import-file');

/**
 * 初始化：从 storage 加载数据
 */
async function init() {
  try {
    const [catResp, commentResp] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getCategories' }),
      chrome.runtime.sendMessage({ action: 'getComments' })
    ]);

    if (catResp.success) {
      categories = catResp.data;
    }
    if (commentResp.success) {
      comments = commentResp.data;
    }
  } catch (err) {
    // 直接读取 storage（background 可能未响应）
    const result = await chrome.storage.local.get(['xhs_categories', 'xhs_comments']);
    categories = result.xhs_categories || ['干货', '好物', '攻略', '避雷', '其他'];
    comments = result.xhs_comments || [];
  }

  renderAll();
}

/**
 * 渲染整个页面
 */
function renderAll() {
  renderCategories();
  renderComments();
  updateTotalCount();
  updateEmptyState();
}

/**
 * 渲染分类列表
 */
function renderCategories() {
  categoryList.innerHTML = '';

  // 「全部」项
  const allItem = createCategoryItem('全部', comments.length, false);
  if (currentCategory === '全部') {
    allItem.classList.add('active');
  }
  allItem.addEventListener('click', () => selectCategory('全部'));
  categoryList.appendChild(allItem);

  // 各分类项
  categories.forEach(cat => {
    const count = comments.filter(c => c.category === cat).length;
    const item = createCategoryItem(cat, count, true);
    if (currentCategory === cat) {
      item.classList.add('active');
    }
    item.addEventListener('click', () => selectCategory(cat));
    categoryList.appendChild(item);
  });
}

/**
 * 创建分类项 DOM 元素
 * @param {string} name - 分类名
 * @param {number} count - 该分类的评论数
 * @param {boolean} showActions - 是否显示操作按钮（「全部」不显示）
 * @returns {HTMLElement}
 */
function createCategoryItem(name, count, showActions) {
  const li = document.createElement('li');
  li.className = 'category-item';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'category-item-name';
  nameSpan.textContent = name;

  const countSpan = document.createElement('span');
  countSpan.className = 'category-item-count';
  countSpan.textContent = count;

  li.appendChild(nameSpan);
  li.appendChild(countSpan);

  if (showActions) {
    const actions = document.createElement('span');
    actions.className = 'category-item-actions';

    // 重命名按钮
    const renameBtn = document.createElement('button');
    renameBtn.className = 'cat-action-btn';
    renameBtn.textContent = '✎';
    renameBtn.title = '重命名';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRenameCategory(name);
    });

    // 删除按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'cat-action-btn';
    deleteBtn.textContent = '✕';
    deleteBtn.title = '删除';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCategoryHandler(name);
    });

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    li.appendChild(actions);
  }

  return li;
}

/**
 * 切换选中分类
 * @param {string} name - 分类名
 */
function selectCategory(name) {
  currentCategory = name;
  currentCategoryLabel.textContent = name;
  searchInput.value = '';
  searchKeyword = '';
  renderAll();
}

/**
 * 渲染评论列表
 * 评论组（相同 groupId）会聚合显示，后面的评论作为「上下文」缩进展示
 */
function renderComments() {
  commentList.innerHTML = '';

  // 先按分类过滤
  let filtered = comments;
  if (currentCategory !== '全部') {
    filtered = filtered.filter(c => c.category === currentCategory);
  }

  // 再按搜索关键词过滤
  if (searchKeyword) {
    const kw = searchKeyword.toLowerCase();
    filtered = filtered.filter(c =>
      c.text.toLowerCase().includes(kw) ||
      c.author.toLowerCase().includes(kw)
    );
  }

  // 按时间倒序排列（已按插入顺序，但分组时需要保持组在一起）
  // 为保持组内顺序，先按 groupId 分组
  const groupMap = new Map();   // groupId → 评论数组
  const ungrouped = [];         // 没有 groupId 的单条评论
  const groupOrder = [];        // 组的显示顺序（按组内最新时间倒序）

  filtered.forEach(c => {
    if (c.groupId) {
      if (!groupMap.has(c.groupId)) {
        groupMap.set(c.groupId, []);
        groupOrder.push(c.groupId);
      }
      groupMap.get(c.groupId).push(c);
    } else {
      ungrouped.push(c);
    }
  });

  // 渲染：按时间倒序交替显示组和单条评论
  // 简化处理：先渲染所有组，再渲染单条评论（都按各自的时间倒序）
  const rendered = [];

  // 收集所有待渲染项
  groupOrder.forEach(gid => {
    const group = groupMap.get(gid);
    group.sort((a, b) => a.groupIndex - b.groupIndex); // 组内按顺序
    rendered.push({ type: 'group', data: group, time: group[0].savedAt });
  });

  ungrouped.forEach(c => {
    rendered.push({ type: 'single', data: c, time: c.savedAt });
  });

  // 按时间倒序排列
  rendered.sort((a, b) => b.time - a.time);

  // 渲染
  rendered.forEach(item => {
    if (item.type === 'group') {
      commentList.appendChild(createCommentGroupCard(item.data));
    } else {
      commentList.appendChild(createCommentCard(item.data));
    }
  });
}

/**
 * 格式化时间
 * @param {number} timestamp - 时间戳
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  // 1分钟内
  if (diff < 60000) return '刚刚';
  // 1小时内
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  // 今天
  if (date.toDateString() === now.toDateString()) {
    return '今天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  // 昨天
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return '昨天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  // 更早
  return date.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * 创建评论卡片 DOM 元素
 * @param {Object} comment - 评论数据
 * @returns {HTMLElement}
 */
function createCommentCard(comment) {
  const card = document.createElement('div');
  card.className = 'comment-card';

  // 评论文本
  const textEl = document.createElement('div');
  textEl.className = 'comment-card-text';
  textEl.textContent = comment.text;
  card.appendChild(textEl);

  // 元信息栏
  const meta = document.createElement('div');
  meta.className = 'comment-card-meta';

  // 作者
  const author = document.createElement('span');
  author.className = 'comment-card-author';
  author.textContent = comment.author || '未知用户';
  meta.appendChild(author);

  // 分类切换下拉框
  const catSelect = document.createElement('select');
  catSelect.className = 'comment-card-cat-select';
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (cat === comment.category) opt.selected = true;
    catSelect.appendChild(opt);
  });
  catSelect.addEventListener('change', () => {
    changeCommentCategory(comment.id, catSelect.value);
  });
  meta.appendChild(catSelect);

  // 来源链接
  const link = document.createElement('a');
  link.className = 'comment-card-link';
  link.textContent = '查看原帖';
  link.href = comment.postUrl || '#';
  link.target = '_blank';
  meta.appendChild(link);

  // 收藏时间
  const time = document.createElement('span');
  time.className = 'comment-card-time';
  time.textContent = formatTime(comment.savedAt);
  meta.appendChild(time);

  // 删除按钮
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'comment-card-delete';
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', () => deleteCommentHandler(comment.id));
  meta.appendChild(deleteBtn);

  card.appendChild(meta);
  return card;
}

/**
 * 创建评论组卡片（多条评论一起展示，后面的作为上下文）
 * @param {Array} group - 同一组的评论数组（已按 groupIndex 排序）
 * @returns {HTMLElement}
 */
function createCommentGroupCard(group) {
  const wrapper = document.createElement('div');
  wrapper.className = 'comment-group-card';

  group.forEach((comment, index) => {
    if (index === 0) {
      // 第一条正常展示
      wrapper.appendChild(createCommentCard(comment));
    } else {
      // 后续评论作为「上下文」缩进展示
      const ctxCard = document.createElement('div');
      ctxCard.className = 'comment-context-card';

      const ctxLabel = document.createElement('div');
      ctxLabel.className = 'comment-context-label';
      ctxLabel.textContent = '↳ 上下文 ' + index;

      const ctxText = document.createElement('div');
      ctxText.className = 'comment-context-text';
      ctxText.textContent = comment.text;

      const ctxAuthor = document.createElement('span');
      ctxAuthor.className = 'comment-context-author';
      ctxAuthor.textContent = '— ' + (comment.author || '未知用户');

      ctxCard.appendChild(ctxLabel);
      ctxCard.appendChild(ctxText);
      ctxCard.appendChild(ctxAuthor);

      // 上下文评论的分类切换
      const ctxCatSelect = document.createElement('select');
      ctxCatSelect.className = 'comment-card-cat-select';
      categories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        if (cat === comment.category) opt.selected = true;
        ctxCatSelect.appendChild(opt);
      });
      ctxCatSelect.addEventListener('change', () => {
        changeCommentCategory(comment.id, ctxCatSelect.value);
      });
      ctxCard.appendChild(ctxCatSelect);

      // 也支持单独删除这条上下文评论
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'comment-card-delete';
      deleteBtn.textContent = '删除';
      deleteBtn.addEventListener('click', () => deleteCommentHandler(comment.id));
      ctxCard.appendChild(deleteBtn);

      wrapper.appendChild(ctxCard);
    }
  });

  return wrapper;
}

/**
 * 修改评论分类
 * @param {string} id - 评论 ID
 * @param {string} newCategory - 新分类名
 */
async function changeCommentCategory(id, newCategory) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'updateCategory',
      id,
      category: newCategory
    });
    if (response.success) {
      // 更新本地状态
      const comment = comments.find(c => c.id === id);
      if (comment) comment.category = newCategory;
      renderCategories();
    }
  } catch (err) {
    // 直接操作 storage
    const comment = comments.find(c => c.id === id);
    if (comment) {
      comment.category = newCategory;
      await chrome.storage.local.set({ xhs_comments: comments });
      renderCategories();
    }
  }
}

/**
 * 删除评论
 * @param {string} id - 评论 ID
 */
async function deleteCommentHandler(id) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'deleteComment',
      id
    });
    if (response.success) {
      comments = response.data;
      renderAll();
    }
  } catch (err) {
    // 直接操作 storage
    comments = comments.filter(c => c.id !== id);
    await chrome.storage.local.set({ xhs_comments: comments });
    renderAll();
  }
}

/**
 * 删除分类
 * @param {string} name - 分类名
 */
async function deleteCategoryHandler(name) {
  // 不允许删除最后一个分类
  if (categories.length <= 1) {
    alert('至少保留一个分类');
    return;
  }

  if (!confirm(`确定删除分类「${name}」吗？该分类下的评论将移至「其他」。`)) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'deleteCategory',
      name
    });
    if (response.success) {
      categories = response.data;
      // 重新加载评论
      const commentResp = await chrome.runtime.sendMessage({ action: 'getComments' });
      if (commentResp.success) {
        comments = commentResp.data;
      }
      if (currentCategory === name) {
        currentCategory = '全部';
        currentCategoryLabel.textContent = '全部';
      }
      renderAll();
    }
  } catch (err) {
    // 直接操作 storage
    categories = categories.filter(c => c !== name);
    comments = comments.map(c => c.category === name ? { ...c, category: '其他' } : c);
    await chrome.storage.local.set({
      xhs_categories: categories,
      xhs_comments: comments
    });
    if (currentCategory === name) {
      currentCategory = '全部';
      currentCategoryLabel.textContent = '全部';
    }
    renderAll();
  }
}

/**
 * 开始重命名分类
 * @param {string} oldName - 旧分类名
 */
function startRenameCategory(oldName) {
  const newName = prompt('请输入新分类名：', oldName);
  if (!newName || newName.trim() === '' || newName.trim() === oldName) return;

  renameCategoryHandler(oldName, newName.trim());
}

/**
 * 重命名分类
 * @param {string} oldName - 旧分类名
 * @param {string} newName - 新分类名
 */
async function renameCategoryHandler(oldName, newName) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'renameCategory',
      oldName,
      newName
    });
    if (response.success) {
      categories = response.data;
      // 重新加载评论
      const commentResp = await chrome.runtime.sendMessage({ action: 'getComments' });
      if (commentResp.success) {
        comments = commentResp.data;
      }
      if (currentCategory === oldName) {
        currentCategory = newName;
        currentCategoryLabel.textContent = newName;
      }
      renderAll();
    } else {
      alert(response.error);
    }
  } catch (err) {
    // 直接操作 storage
    if (categories.includes(newName)) {
      alert('目标分类名已存在');
      return;
    }
    const idx = categories.indexOf(oldName);
    if (idx !== -1) {
      categories[idx] = newName;
      comments = comments.map(c => c.category === oldName ? { ...c, category: newName } : c);
      await chrome.storage.local.set({
        xhs_categories: categories,
        xhs_comments: comments
      });
      if (currentCategory === oldName) {
        currentCategory = newName;
        currentCategoryLabel.textContent = newName;
      }
      renderAll();
    }
  }
}

/**
 * 新建分类
 */
async function addNewCategory() {
  const name = inputCatName.value.trim();
  if (!name) return;

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'addCategory',
      name
    });
    if (response.success) {
      categories = response.data;
      newCatInput.classList.add('hidden');
      btnAddCat.classList.remove('hidden');
      inputCatName.value = '';
      renderAll();
    } else {
      alert(response.error);
    }
  } catch (err) {
    // 直接操作 storage
    if (categories.includes(name)) {
      alert('分类已存在');
      return;
    }
    categories.push(name);
    await chrome.storage.local.set({ xhs_categories: categories });
    newCatInput.classList.add('hidden');
    btnAddCat.classList.remove('hidden');
    inputCatName.value = '';
    renderAll();
  }
}

/**
 * 更新评论总数
 */
function updateTotalCount() {
  totalCount.textContent = `共 ${comments.length} 条`;
}

/**
 * 更新空状态显示
 */
function updateEmptyState() {
  const filteredCount = getFilteredCount();
  emptyState.classList.toggle('hidden', filteredCount > 0);
  commentList.classList.toggle('hidden', filteredCount === 0);
}

/**
 * 获取当前筛选条件下的评论数量
 * @returns {number}
 */
function getFilteredCount() {
  let filtered = comments;
  if (currentCategory !== '全部') {
    filtered = filtered.filter(c => c.category === currentCategory);
  }
  if (searchKeyword) {
    const kw = searchKeyword.toLowerCase();
    filtered = filtered.filter(c =>
      c.text.toLowerCase().includes(kw) ||
      c.author.toLowerCase().includes(kw)
    );
  }
  return filtered.length;
}

/**
 * 导出数据为 JSON 文件并触发下载
 */
async function exportData() {
  const result = await chrome.storage.local.get(['xhs_categories', 'xhs_comments']);
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    categories: result.xhs_categories || [],
    comments: result.xhs_comments || []
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `xhs-comments-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 导入 JSON 文件，合并到当前存储中
 */
async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);

    // 校验数据结构
    if (!data.comments || !Array.isArray(data.comments)) {
      alert('文件格式无效：缺少评论数据');
      return;
    }
    if (!data.categories || !Array.isArray(data.categories)) {
      alert('文件格式无效：缺少分类数据');
      return;
    }

    // 读取当前数据
    const current = await chrome.storage.local.get(['xhs_categories', 'xhs_comments']);
    const currentCategories = current.xhs_categories || [];
    const currentComments = current.xhs_comments || [];

    // 合并分类（去重）
    const mergedCategories = [...currentCategories];
    data.categories.forEach(cat => {
      if (!mergedCategories.includes(cat)) mergedCategories.push(cat);
    });

    // 合并评论（按 id 去重）
    const existingIds = new Set(currentComments.map(c => c.id));
    const newComments = data.comments.filter(c => !existingIds.has(c.id));
    const mergedComments = [...newComments, ...currentComments];

    await chrome.storage.local.set({
      xhs_categories: mergedCategories,
      xhs_comments: mergedComments
    });

    alert(`导入完成！新增 ${data.categories.length - currentCategories.filter(c => data.categories.includes(c)).length} 个分类、${newComments.length} 条评论`);
    location.reload();
  } catch (err) {
    alert('导入失败：' + err.message);
  }
}

/* 事件绑定 */

// 新建分类按钮
btnAddCat.addEventListener('click', () => {
  btnAddCat.classList.add('hidden');
  newCatInput.classList.remove('hidden');
  inputCatName.focus();
});

// 确认新建分类
btnConfirmCat.addEventListener('click', addNewCategory);
inputCatName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addNewCategory();
});

// 取消新建分类
btnCancelCat.addEventListener('click', () => {
  newCatInput.classList.add('hidden');
  btnAddCat.classList.remove('hidden');
  inputCatName.value = '';
});

// 搜索输入
searchInput.addEventListener('input', () => {
  searchKeyword = searchInput.value.trim();
  renderComments();
  updateEmptyState();
});

// 导出按钮
btnExport.addEventListener('click', exportData);

// 导入按钮 → 触发文件选择
btnImport.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => {
  if (importFile.files[0]) importData(importFile.files[0]);
  importFile.value = '';
});

/* 页面加载 */
document.addEventListener('DOMContentLoaded', init);
