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
const newCatInput = document.getElementById('new-cat-input');
const inputCatName = document.getElementById('input-cat-name');
const btnAddCat = document.getElementById('btn-add-cat');
const btnConfirmCat = document.getElementById('btn-confirm-cat');
const btnCancelCat = document.getElementById('btn-cancel-cat');
const btnExport = document.getElementById('btn-export');
const btnImport = document.getElementById('btn-import');
const btnClear = document.getElementById('btn-clear');
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
    categories = result.xhs_categories || ['未分类', '好物', '避雷', '搞笑'];
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

  // 各分类项（「未分类」也不可操作）
  categories.forEach(cat => {
    const count = comments.filter(c => c.category === cat).length;
    const editable = cat !== '未分类';
    const item = createCategoryItem(cat, count, editable);
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
 * 高亮文本中的搜索关键词
 * @param {string} text - 原始文本
 * @param {string} keyword - 搜索关键词
 * @returns {string} HTML 字符串
 */
function highlightText(text, keyword) {
  if (!keyword) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const escapedKw = escapeHtml(keyword);
  const regex = new RegExp(escapedKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(regex, match => `<mark class="search-highlight">${match}</mark>`);
}

/**
 * HTML 转义，防止 XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

  // 评论文本（搜索高亮）
  const textEl = document.createElement('div');
  textEl.className = 'comment-card-text';
  textEl.innerHTML = highlightText(comment.text, searchKeyword);
  card.appendChild(textEl);

  // 元信息栏
  const meta = document.createElement('div');
  meta.className = 'comment-card-meta';

  const author = document.createElement('span');
  author.className = 'comment-card-author';
  author.textContent = comment.author || '';
  meta.appendChild(author);

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

  const link = document.createElement('a');
  link.className = 'comment-card-link';
  link.textContent = '查看原帖';
  link.href = comment.postUrl || '#';
  link.target = '_blank';
  meta.appendChild(link);

  const time = document.createElement('span');
  time.className = 'comment-card-time';
  time.textContent = formatTime(comment.savedAt);
  meta.appendChild(time);

  // 复制按钮（仅复制评论文本）
  const copyBtn = document.createElement('button');
  copyBtn.className = 'comment-card-action-btn';
  copyBtn.textContent = '复制';
  copyBtn.title = '复制评论原文';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(comment.text).then(() => {
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    });
  });
  meta.appendChild(copyBtn);

  // 分享按钮（生成复古卡片图片）
  const shareBtn = document.createElement('button');
  shareBtn.className = 'comment-card-action-btn';
  shareBtn.textContent = '分享';
  shareBtn.title = '生成分享卡片';
  shareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    generateShareCard(comment);
  });
  meta.appendChild(shareBtn);

  // 删除按钮
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'comment-card-delete';
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', () => deleteCommentHandler(comment.id));
  meta.appendChild(deleteBtn);

  card.appendChild(meta);

  // 笔记区域（hover 时显示，点击切换查看/编辑）
  const noteContainer = document.createElement('div');
  noteContainer.className = 'comment-card-note-container';

  // 查看态
  const noteView = document.createElement('div');
  noteView.className = 'comment-card-note-view';
  noteView.textContent = comment.note || '';
  noteView.addEventListener('click', () => {
    noteView.style.display = 'none';
    noteEdit.style.display = 'block';
    // 等浏览器完成重排后再计算高度
    requestAnimationFrame(() => {
      noteEdit.style.height = 'auto';
      noteEdit.style.height = noteEdit.scrollHeight + 'px';
    });
    noteEdit.focus();
  });

  // 编辑态
  const noteEdit = document.createElement('textarea');
  noteEdit.className = 'comment-card-note-edit';
  noteEdit.placeholder = '添加笔记...';
  noteEdit.value = comment.note || '';
  noteEdit.rows = 1;
  noteEdit.addEventListener('input', () => {
    noteEdit.style.height = 'auto';
    noteEdit.style.height = noteEdit.scrollHeight + 'px';
  });
  noteEdit.addEventListener('blur', async () => {
    noteEdit.style.height = 'auto';
    noteEdit.style.height = noteEdit.scrollHeight + 'px';
    const newNote = noteEdit.value.trim();
    if (newNote === (comment.note || '')) {
      // 切回查看态
      noteEdit.style.display = 'none';
      noteView.style.display = newNote ? 'block' : 'none';
      return;
    }
    comment.note = newNote;
    noteView.textContent = newNote;
    try {
      await chrome.runtime.sendMessage({ action: 'updateNote', id: comment.id, note: newNote });
    } catch (err) {
      const all = await chrome.storage.local.get('xhs_comments');
      const list = all.xhs_comments || [];
      const target = list.find(c => c.id === comment.id);
      if (target) target.note = newNote;
      await chrome.storage.local.set({ xhs_comments: list });
    }
    noteEdit.style.display = 'none';
    noteView.style.display = newNote ? 'block' : 'none';
  });

  // 初始状态：有笔记显示查看态，无笔记默认显示编辑态（hover 卡片可见）
  if (comment.note) {
    noteView.style.display = 'block';
    noteEdit.style.display = 'none';
  } else {
    noteView.style.display = 'none';
    noteEdit.style.display = 'block';
  }

  noteContainer.appendChild(noteView);
  noteContainer.appendChild(noteEdit);
  card.appendChild(noteContainer);

  return card;
}

/**
 * 创建评论组卡片（折叠展开模式，默认只展示第一条）
 * @param {Array} group - 同一组的评论数组（已按 groupIndex 排序）
 * @returns {HTMLElement}
 */
function createCommentGroupCard(group) {
  const wrapper = document.createElement('div');
  wrapper.className = 'comment-group-card';

  // 第一条正常展示
  wrapper.appendChild(createCommentCard(group[0]));

  const restCount = group.length - 1;
  if (restCount === 0) return wrapper;

  // 折叠/展开按钮
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'group-toggle-btn';
  toggleBtn.textContent = '+ ' + restCount + ' 条关联评论';
  toggleBtn.addEventListener('click', () => {
    const expanded = foldContainer.classList.toggle('expanded');
    toggleBtn.textContent = expanded
      ? '收起关联评论'
      : '+ ' + restCount + ' 条关联评论';
  });

  // 折叠容器：包含其余评论，默认隐藏
  const foldContainer = document.createElement('div');
  foldContainer.className = 'group-fold-container';

  group.slice(1).forEach((comment, i) => {
    const ctxCard = document.createElement('div');
    ctxCard.className = 'comment-context-card';

    const ctxBody = document.createElement('div');
    ctxBody.className = 'comment-context-body';

    const ctxText = document.createElement('div');
    ctxText.className = 'comment-context-text';
    ctxText.innerHTML = highlightText(comment.text, searchKeyword);

    const ctxAuthor = document.createElement('span');
    ctxAuthor.className = 'comment-context-author';
    ctxAuthor.textContent = comment.author ? '— ' + comment.author : '';

    ctxBody.appendChild(ctxText);
    ctxBody.appendChild(ctxAuthor);
    ctxCard.appendChild(ctxBody);

    // 操作栏
    const ctxActions = document.createElement('div');
    ctxActions.className = 'comment-context-actions';

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
    ctxActions.appendChild(ctxCatSelect);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'comment-card-delete';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => deleteCommentHandler(comment.id));
    ctxActions.appendChild(deleteBtn);

    ctxCard.appendChild(ctxActions);
    foldContainer.appendChild(ctxCard);
  });

  wrapper.appendChild(toggleBtn);
  wrapper.appendChild(foldContainer);
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
  if (name === '未分类') {
    alert('「未分类」不可删除');
    return;
  }
  // 不允许删除最后一个分类
  if (categories.length <= 1) {
    alert('至少保留一个分类');
    return;
  }

  const fallbackCat = categories.find(c => c !== name) || '好物';
  if (!confirm(`确定删除分类「${name}」吗？该分类下的评论将移至「${fallbackCat}」。`)) {
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
      }
      renderAll();
    }
  } catch (err) {
    // 直接操作 storage
    categories = categories.filter(c => c !== name);
    comments = comments.map(c => c.category === name ? { ...c, category: fallbackCat } : c);
    await chrome.storage.local.set({
      xhs_categories: categories,
      xhs_comments: comments
    });
    if (currentCategory === name) {
      currentCategory = '全部';
    }
    renderAll();
  }
}

/**
 * 开始重命名分类
 * @param {string} oldName - 旧分类名
 */
function startRenameCategory(oldName) {
  if (oldName === '未分类') {
    alert('「未分类」不可重命名');
    return;
  }
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
  totalCount.textContent = comments.length > 0 ? `已捕获 ${comments.length} 条宝藏` : '空空如也';
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
 * 生成复古风格分享卡片并下载
 * @param {Object} comment - 评论数据
 */
function generateShareCard(comment) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const w = 600;
  const padding = 40;

  ctx.font = '16px Georgia, "Songti SC", "Noto Serif SC", serif';
  const textLines = wrapText(ctx, comment.text, w - padding * 2);
  const noteLines = comment.note ? wrapText(ctx, '笔记：' + comment.note, w - padding * 2) : [];

  // 来源链接和标题
  ctx.font = '11px Georgia, "Songti SC", "Noto Serif SC", serif';
  const sourceText = '来自：' + (comment.postTitle || '小红书');
  const sourceLines = wrapText(ctx, sourceText, w - padding * 2);
  const urlLines = wrapText(ctx, comment.postUrl || '', w - padding * 2);

  const cardHeight = padding + 60 + textLines.length * 28
    + (noteLines.length > 0 ? 30 + noteLines.length * 28 : 0)
    + 30 + sourceLines.length * 20 + urlLines.length * 20 + 50;

  canvas.width = w;
  canvas.height = cardHeight;

  // 复古纸张底色 + 纹理
  ctx.fillStyle = '#f5f0e6';
  ctx.fillRect(0, 0, w, cardHeight);
  addNoiseTexture(ctx, w, cardHeight);

  // 外边框
  ctx.strokeStyle = '#8b7355';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, w - 20, cardHeight - 20);

  // 内边框
  ctx.strokeStyle = '#c4a97d';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(18, 18, w - 36, cardHeight - 36);
  ctx.setLineDash([]);

  // 顶部装饰
  ctx.fillStyle = '#8b7355';
  ctx.font = 'bold 18px Georgia, "Songti SC", "Noto Serif SC", serif';
  ctx.textAlign = 'center';
  ctx.fillText('—— 小红书评论收藏 ——', w / 2, padding + 30);

  // 评论正文
  ctx.fillStyle = '#3d2b1f';
  ctx.font = '16px Georgia, "Songti SC", "Noto Serif SC", serif';
  ctx.textAlign = 'left';
  let y = padding + 80;
  textLines.forEach(line => {
    ctx.fillText(line, padding, y);
    y += 28;
  });

  // 笔记
  if (noteLines.length > 0) {
    y += 20;
    ctx.fillStyle = '#2a5c8a';
    ctx.font = 'italic 14px Georgia, "Songti SC", "Noto Serif SC", serif';
    noteLines.forEach(line => {
      ctx.fillText(line, padding, y);
      y += 28;
    });
  }

  // 底部分隔
  y += 15;
  ctx.strokeStyle = '#8b7355';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(w - padding, y);
  ctx.stroke();

  // 来源标题
  y += 25;
  ctx.fillStyle = '#8b7355';
  ctx.font = '11px Georgia, "Songti SC", "Noto Serif SC", serif';
  sourceLines.forEach(line => {
    ctx.fillText(line, padding, y);
    y += 20;
  });

  // 来源链接（可多行）
  ctx.fillStyle = '#6b5b4f';
  ctx.font = '10px Georgia, serif';
  urlLines.forEach(line => {
    ctx.fillText(line, padding, y);
    y += 20;
  });

  // 预览弹窗
  showSharePreview(canvas);
}

/**
 * 显示分享卡片预览弹窗
 */
function showSharePreview(canvas) {
  // 移除已有弹窗
  const existing = document.querySelector('.share-preview-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'share-preview-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const dialog = document.createElement('div');
  dialog.className = 'share-preview-dialog';
  dialog.appendChild(canvas);
  canvas.style.maxWidth = '100%';
  canvas.style.height = 'auto';
  canvas.style.borderRadius = '8px';
  canvas.style.boxShadow = '0 8px 32px rgba(0,0,0,0.2)';

  // 操作按钮区
  const actions = document.createElement('div');
  actions.className = 'share-preview-actions';

  const downloadBtn = document.createElement('button');
  downloadBtn.textContent = '下载图片';
  downloadBtn.addEventListener('click', () => {
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'xhs-comment-share.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', () => overlay.remove());

  actions.appendChild(downloadBtn);
  actions.appendChild(closeBtn);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

/**
 * 文本换行
 */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let current = '';
  for (const char of text) {
    const test = current + char;
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = char;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * 添加噪点纹理
 */
function addNoiseTexture(ctx, w, h) {
  const imageData = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < imageData.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * 10;
    imageData.data[i] += noise;
    imageData.data[i + 1] += noise;
    imageData.data[i + 2] += noise;
  }
  ctx.putImageData(imageData, 0, 0);
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

// 清空数据按钮
btnClear.addEventListener('click', async () => {
  if (!confirm('确定清空所有收藏数据和分类吗？此操作不可恢复。\n\n建议先导出备份。')) return;
  await chrome.storage.local.remove(['xhs_categories', 'xhs_comments']);
  // 恢复默认分类
  await chrome.storage.local.set({ xhs_categories: ['未分类', '好物', '避雷', '搞笑'] });
  location.reload();
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
