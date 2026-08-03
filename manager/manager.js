/**
 * manager.js - 管理页面逻辑
 * 管理收藏评论：按分类查看、搜索、删除评论，管理分类（增删改）
 */

/* 状态 */
let comments = [];
let categories = [];
let currentCategory = '全部';  // 当前选中的分类，「全部」表示显示所有
let searchKeyword = '';        // 当前搜索关键词
let editingCategory = null;   // 当前正在内联编辑的分类名
let pendingDeleteCommentId = null; // 待删除的评论 ID

/* 分享卡片模板列表：默认（纯色复古底）+ 14张纸张纹理图片 */
const SHARE_TEMPLATES = [
  { id: 'default', name: '默认', type: 'default', src: null }
];
// 动态添加图片模板
for (let i = 1; i <= 22; i++) {
  const num = String(i).padStart(2, '0');
  SHARE_TEMPLATES.push({
    id: `tpl-${num}`,
    name: `模板 ${i + 1}`,
    type: 'image',
    src: `assets/templates/template-${num}.jpg`
  });
}

// 预加载的模板图片
const preloadedTemplates = {};

/** 预加载所有模板图片 */
function preloadTemplateImages() {
  SHARE_TEMPLATES.forEach(tpl => {
    if (tpl.type === 'image') {
      const img = new Image();
      img.src = chrome.runtime.getURL(tpl.src);
      preloadedTemplates[tpl.id] = img;
    }
  });
}

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
const deleteModal = document.getElementById('delete-modal');
const deleteModalBody = document.getElementById('delete-modal-body');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalConfirm = document.getElementById('btn-modal-confirm');
const commentDeleteModal = document.getElementById('comment-delete-modal');
const btnCommentModalCancel = document.getElementById('btn-comment-modal-cancel');
const btnCommentModalConfirm = document.getElementById('btn-comment-modal-confirm');
const clearModal = document.getElementById('clear-modal');
const btnClearModalCancel = document.getElementById('btn-clear-modal-cancel');
const btnClearModalConfirm = document.getElementById('btn-clear-modal-confirm');

/**
 * 去重：按 commentId 或 key 去除重复评论，保留最早保存的那条
 * @param {Array} list - 评论列表
 * @returns {Array} 去重后的列表
 */
function dedupeComments(list) {
  const seen = new Map(); // commentId/key → 评论
  for (const c of list) {
    const id = c.commentId || c.key;
    if (!id || seen.has(id)) continue;
    seen.set(id, c);
  }
  return Array.from(seen.values());
}

/**
 * 初始化：从 storage 加载数据
 */
async function init() {
  // 预加载分享卡片的模板图片
  preloadTemplateImages();

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

  // 去重并写回 storage（清理历史重复数据）
  const deduped = dedupeComments(comments);
  if (deduped.length !== comments.length) {
    comments = deduped;
    await chrome.storage.local.set({ xhs_comments: comments });
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
    item.addEventListener('click', () => {
      if (editingCategory) return;
      selectCategory(cat);
    });
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
      startRenameCategory(name, li);
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

  // 内联编辑区域（默认隐藏）
  const editWrap = document.createElement('div');
  editWrap.className = 'category-item-edit';
  const editInput = document.createElement('input');
  editInput.type = 'text';
  editInput.maxLength = 20;
  const editActions = document.createElement('div');
  editActions.className = 'edit-actions';
  const btnConfirm = document.createElement('button');
  btnConfirm.className = 'btn-confirm';
  btnConfirm.textContent = '确定';
  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn-cancel';
  btnCancel.textContent = '取消';
  editActions.appendChild(btnConfirm);
  editActions.appendChild(btnCancel);
  editWrap.appendChild(editInput);
  editWrap.appendChild(editActions);

  btnConfirm.addEventListener('click', (e) => {
    e.stopPropagation();
    confirmEditCategory(name, editInput.value.trim(), li);
  });
  btnCancel.addEventListener('click', (e) => {
    e.stopPropagation();
    cancelEditCategory(li);
  });
  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      confirmEditCategory(name, editInput.value.trim(), li);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      cancelEditCategory(li);
    }
  });
  editInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (li.classList.contains('editing') &&
          document.activeElement !== btnConfirm &&
          document.activeElement !== btnCancel) {
        cancelEditCategory(li);
      }
    }, 150);
  });

  li.appendChild(editWrap);

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
 * @returns {string} 如 "2026/06/10 21:21"
 */
function formatTime(timestamp) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${day} ${h}:${min}`;
}

/**
 * 创建分类下拉组件（马卡龙色块风格）
 * @param {Object} comment - 评论数据
 * @returns {HTMLElement}
 */
function createCatDropdown(comment) {
  const wrap = document.createElement('span');
  wrap.className = 'cat-dropdown-wrap';

  const trigger = document.createElement('button');
  trigger.className = 'cat-dropdown-trigger';
  trigger.type = 'button';
  trigger.innerHTML = `${escapeHtml(comment.category)} <span class="cat-dropdown-arrow"></span>`;

  const panel = document.createElement('div');
  panel.className = 'cat-dropdown-panel';

  categories.forEach((cat, i) => {
    const opt = document.createElement('button');
    opt.className = 'cat-dropdown-option';
    opt.classList.add('cat-macaron-' + (i % 12));
    opt.type = 'button';
    if (cat === comment.category) opt.classList.add('selected');
    opt.textContent = cat;
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      changeCommentCategory(comment.id, cat);
      trigger.innerHTML = `${escapeHtml(cat)} <span class="cat-dropdown-arrow"></span>`;
      panel.querySelectorAll('.cat-dropdown-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      panel.classList.remove('open');
      trigger.classList.remove('open');
    });
    panel.appendChild(opt);
  });

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = panel.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) {
      panel.classList.add('open');
      trigger.classList.add('open');
    }
  });

  wrap.appendChild(trigger);
  wrap.appendChild(panel);
  return wrap;
}

/** 关闭所有打开的分类下拉面板 */
function closeAllDropdowns() {
  document.querySelectorAll('.cat-dropdown-panel.open').forEach(p => p.classList.remove('open'));
  document.querySelectorAll('.cat-dropdown-trigger.open').forEach(t => t.classList.remove('open'));
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

  // 评论图片缩略图
  if (comment.images && comment.images.length > 0) {
    const imagesRow = document.createElement('div');
    imagesRow.className = 'comment-card-images';
    comment.images.forEach(url => {
      const thumb = document.createElement('img');
      thumb.src = url;
      thumb.loading = 'lazy';
      thumb.addEventListener('click', () => window.open(url, '_blank'));
      imagesRow.appendChild(thumb);
    });
    card.appendChild(imagesRow);
  }

  // 元信息栏
  const meta = document.createElement('div');
  meta.className = 'comment-card-meta';

  // 左侧：作者 + 分类 + 链接
  const metaLeft = document.createElement('div');
  metaLeft.className = 'comment-card-meta-left';

  const author = document.createElement('span');
  author.className = 'comment-card-author';
  author.textContent = comment.author || '';
  metaLeft.appendChild(author);

  const catDropdown = createCatDropdown(comment);
  metaLeft.appendChild(catDropdown);

  // 只有保存了原文链接时才显示
  if (comment.postUrl) {
    const link = document.createElement('a');
    link.className = 'comment-card-link';
    link.textContent = '查看原帖';
    link.href = comment.postUrl;
    link.target = '_blank';
    metaLeft.appendChild(link);
  }

  meta.appendChild(metaLeft);

  // 右侧：时间 + 操作按钮
  const metaRight = document.createElement('div');
  metaRight.className = 'comment-card-meta-right';

  const time = document.createElement('span');
  time.className = 'comment-card-time';
  time.textContent = formatTime(comment.savedAt);
  metaRight.appendChild(time);

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
  metaRight.appendChild(copyBtn);

  // 分享按钮（生成复古卡片图片）
  const shareBtn = document.createElement('button');
  shareBtn.className = 'comment-card-action-btn';
  shareBtn.textContent = '分享';
  shareBtn.title = '生成分享卡片';
  shareBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const canvas = await generateShareCard(comment);
    showSharePreview(canvas, comment);
  });
  metaRight.appendChild(shareBtn);

  // 删除按钮
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'comment-card-delete';
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', () => deleteCommentHandler(comment.id));
  metaRight.appendChild(deleteBtn);

  meta.appendChild(metaRight);

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
      if (newNote) {
        noteView.style.display = 'block';
      }
      // 无笔记时保持编辑态可见，否则展开/收起关联评论后 textarea 消失
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
    if (newNote) {
      noteContainer.classList.add('has-note');
    } else {
      noteContainer.classList.remove('has-note');
    }
  });

  // 初始状态：有笔记显示查看态，无笔记默认显示编辑态（hover 卡片可见）
  if (comment.note) {
    noteContainer.classList.add('has-note');
    noteView.style.display = 'block';
    noteEdit.style.display = 'none';
  } else {
    noteContainer.classList.remove('has-note');
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

    const ctxCatDropdown = createCatDropdown(comment);
    ctxActions.appendChild(ctxCatDropdown);

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
 * 删除评论 —— 弹出确认弹窗
 * @param {string} id - 评论 ID
 */
function deleteCommentHandler(id) {
  pendingDeleteCommentId = id;
  commentDeleteModal.classList.remove('hidden');
  btnCommentModalConfirm.focus();
}

/**
 * 确认删除评论
 */
async function confirmDeleteComment() {
  const id = pendingDeleteCommentId;
  if (!id) return;
  closeCommentDeleteModal();

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
    comments = comments.filter(c => c.id !== id);
    await chrome.storage.local.set({ xhs_comments: comments });
    renderAll();
  }
}

/**
 * 关闭评论删除弹窗
 */
function closeCommentDeleteModal() {
  commentDeleteModal.classList.add('hidden');
  pendingDeleteCommentId = null;
}

/**
 * 删除分类 —— 弹出确认弹窗
 * @param {string} name - 分类名
 */
function deleteCategoryHandler(name) {
  if (name === '未分类') {
    alert('「未分类」不可删除');
    return;
  }
  // 不允许删除最后一个分类
  if (categories.length <= 1) {
    alert('至少保留一个分类');
    return;
  }

  showDeleteModal(name);
}

/** 待删除的分类名 */
let pendingDeleteCategory = null;

/**
 * 显示删除确认弹窗
 * @param {string} name - 分类名
 */
function showDeleteModal(name) {
  pendingDeleteCategory = name;
  const fallbackCat = categories.find(c => c !== name) || '未分类';
  deleteModalBody.querySelector('.cat-name-highlight').textContent = name;
  deleteModalBody.querySelector('.cat-fallback-highlight').textContent = fallbackCat;
  deleteModal.classList.remove('hidden');
  btnModalConfirm.focus();
}

/** 关闭删除确认弹窗 */
function closeDeleteModal() {
  deleteModal.classList.add('hidden');
  pendingDeleteCategory = null;
}

/** 确认删除分类 */
async function confirmDeleteCategory() {
  const name = pendingDeleteCategory;
  if (!name) return;
  closeDeleteModal();

  const fallbackCat = categories.find(c => c !== name) || '未分类';

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'deleteCategory',
      name
    });
    if (response.success) {
      categories = response.data;
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
 * 开始内联编辑分类名
 * @param {string} oldName - 旧分类名
 * @param {HTMLElement} li - 分类项 DOM 元素
 */
function startRenameCategory(oldName, li) {
  if (oldName === '未分类') {
    alert('「未分类」不可重命名');
    return;
  }
  // 如果已有其他分类在编辑，先取消
  if (editingCategory) {
    const prev = document.querySelector('.category-item.editing');
    if (prev) cancelEditCategory(prev);
  }
  editingCategory = oldName;
  li.classList.add('editing');
  const input = li.querySelector('.category-item-edit input');
  input.value = oldName;
  input.focus();
  input.select();
}

/**
 * 确认编辑分类名
 * @param {string} oldName - 旧分类名
 * @param {string} newName - 新分类名
 * @param {HTMLElement} li - 分类项 DOM 元素
 */
function confirmEditCategory(oldName, newName, li) {
  if (!newName || newName === oldName) {
    cancelEditCategory(li);
    return;
  }
  // 校验通过后走实际重命名逻辑
  renameCategoryHandler(oldName, newName).then(() => {
    editingCategory = null;
  }).catch(() => {
    // 重命名失败时保持编辑状态让用户修正
    const input = li.querySelector('.category-item-edit input');
    if (input) input.focus();
  });
}

/**
 * 取消内联编辑
 * @param {HTMLElement} li - 分类项 DOM 元素
 */
function cancelEditCategory(li) {
  li.classList.remove('editing');
  editingCategory = null;
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
 * 生成复古风格分享卡片
 * @param {Object} comment - 评论数据
 * @param {string} templateId - 模板 ID，默认 'default'
 * @returns {HTMLCanvasElement}
 */
async function generateShareCard(comment, templateId = 'default') {
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

  // 预加载评论图片（最多 2 张）
  const images = comment.images && comment.images.length > 0 ? comment.images.slice(0, 2) : [];
  let loadedImages = [];
  if (images.length > 0) {
    loadedImages = await Promise.all(images.map(url => {
      return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      });
    }));
    loadedImages = loadedImages.filter(img => img !== null);
  }

  // 图片区域高度（每张图最大高度 180px，宽度等比缩放至 w - padding*2）
  const imgMaxWidth = w - padding * 2;
  const imgMaxHeight = 180;
  let imgAreaHeight = 0;
  const imgDrawList = [];
  loadedImages.forEach(img => {
    let iw = img.naturalWidth;
    let ih = img.naturalHeight;
    if (iw > imgMaxWidth) {
      ih = ih * (imgMaxWidth / iw);
      iw = imgMaxWidth;
    }
    if (ih > imgMaxHeight) {
      iw = iw * (imgMaxHeight / ih);
      ih = imgMaxHeight;
    }
    imgDrawList.push({ img, iw, ih });
    imgAreaHeight += ih + 10; // 10px 间距
  });
  if (imgAreaHeight > 0) imgAreaHeight += 15; // 底部留白

  let cardHeight = padding + 60 + textLines.length * 28
    + (noteLines.length > 0 ? 30 + noteLines.length * 28 : 0)
    + (imgAreaHeight > 0 ? 10 + imgAreaHeight : 0)
    + 30 + sourceLines.length * 20 + urlLines.length * 20 + 50;

  canvas.width = w;
  canvas.height = cardHeight;

  // 背景：图片模板用纹理图 + 半透明遮罩，默认模板用纯色 + 噪点
  const template = SHARE_TEMPLATES.find(t => t.id === templateId);
  if (template && template.type === 'image') {
    const tplImg = preloadedTemplates[templateId];
    if (tplImg && tplImg.complete && tplImg.naturalWidth > 0) {
      const imgRatio = tplImg.naturalWidth / tplImg.naturalHeight;
      const canvasRatio = w / cardHeight;
      let sx, sy, sw, sh;
      if (imgRatio > canvasRatio) {
        sh = tplImg.naturalHeight;
        sw = tplImg.naturalHeight * canvasRatio;
        sx = (tplImg.naturalWidth - sw) / 2;
        sy = 0;
      } else {
        sw = tplImg.naturalWidth;
        sh = tplImg.naturalWidth / canvasRatio;
        sx = 0;
        sy = (tplImg.naturalHeight - sh) / 2;
      }
      ctx.drawImage(tplImg, sx, sy, sw, sh, 0, 0, w, cardHeight);
    }
    ctx.fillStyle = 'rgba(255, 252, 245, 0.55)';
    ctx.fillRect(0, 0, w, cardHeight);
  } else {
    ctx.fillStyle = '#f5f0e6';
    ctx.fillRect(0, 0, w, cardHeight);
    addNoiseTexture(ctx, w, cardHeight);
  }

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

  // 评论图片
  if (imgDrawList.length > 0) {
    y += 20;
    imgDrawList.forEach(({ img, iw, ih }) => {
      // 图片加细边框
      const imgX = padding + (imgMaxWidth - iw) / 2;
      ctx.fillStyle = '#e8e0d5';
      ctx.fillRect(imgX - 1, y - 1, iw + 2, ih + 2);
      ctx.drawImage(img, imgX, y, iw, ih);
      y += ih + 10;
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

  return canvas;
}

/**
 * 显示分享卡片预览弹窗
 * @param {HTMLCanvasElement} canvas - 当前卡片画布
 * @param {Object} comment - 评论数据（用于模板切换时重新生成）
 */
function showSharePreview(canvas, comment) {
  let currentTemplateId = 'default';
  let currentCanvas = canvas;

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

  // 画布容器
  const canvasWrapper = document.createElement('div');
  canvasWrapper.className = 'share-preview-canvas-wrapper';
  applyCanvasStyle(currentCanvas);
  canvasWrapper.appendChild(currentCanvas);
  dialog.appendChild(canvasWrapper);

  // 模板选择面板（画布下方，宽度与画布一致）
  const templatePanel = document.createElement('div');
  templatePanel.className = 'template-selector-panel';

  const panelLabel = document.createElement('div');
  panelLabel.className = 'template-selector-label';
  panelLabel.textContent = '模板';
  templatePanel.appendChild(panelLabel);

  const grid = document.createElement('div');
  grid.className = 'template-selector-grid';

  SHARE_TEMPLATES.forEach(tpl => {
    const item = document.createElement('div');
    item.className = 'template-thumb-item';
    if (tpl.id === currentTemplateId) item.classList.add('active');

    const thumbBox = document.createElement('div');
    thumbBox.className = 'template-thumb-img';

    if (tpl.type === 'default') {
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 40;
      thumbCanvas.height = 50;
      const tctx = thumbCanvas.getContext('2d');
      tctx.fillStyle = '#f5f0e6';
      tctx.fillRect(0, 0, 40, 50);
      const imgData = tctx.getImageData(0, 0, 40, 50);
      for (let i = 0; i < imgData.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 8;
        imgData.data[i] += n;
        imgData.data[i + 1] += n;
        imgData.data[i + 2] += n;
      }
      tctx.putImageData(imgData, 0, 0);
      tctx.strokeStyle = '#8b7355';
      tctx.lineWidth = 0.5;
      tctx.strokeRect(2, 2, 36, 46);
      thumbBox.appendChild(thumbCanvas);
    } else {
      const img = document.createElement('img');
      img.src = chrome.runtime.getURL(tpl.src);
      img.alt = tpl.name;
      thumbBox.appendChild(img);
    }
    item.appendChild(thumbBox);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'template-thumb-name';
    nameSpan.textContent = tpl.name;
    item.appendChild(nameSpan);

    item.addEventListener('click', async () => {
      if (currentTemplateId === tpl.id) return;

      grid.querySelectorAll('.template-thumb-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      currentTemplateId = tpl.id;

      const newCanvas = await generateShareCard(comment, tpl.id);
      canvasWrapper.innerHTML = '';
      applyCanvasStyle(newCanvas);
      canvasWrapper.appendChild(newCanvas);
      currentCanvas = newCanvas;
    });

    grid.appendChild(item);
  });

  templatePanel.appendChild(grid);
  dialog.appendChild(templatePanel);

  // 操作按钮区
  const actions = document.createElement('div');
  actions.className = 'share-preview-actions';

  const downloadBtn = document.createElement('button');
  downloadBtn.textContent = '下载图片';
  downloadBtn.addEventListener('click', () => {
    currentCanvas.toBlob(blob => {
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

/** 给 canvas 应用预览样式 */
function applyCanvasStyle(c) {
  c.style.maxWidth = '100%';
  c.style.height = 'auto';
  c.style.borderRadius = '8px';
  c.style.boxShadow = '0 8px 32px rgba(0,0,0,0.2)';
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

// 删除确认弹窗 — 确定
btnModalConfirm.addEventListener('click', confirmDeleteCategory);

// 删除确认弹窗 — 取消
btnModalCancel.addEventListener('click', closeDeleteModal);

// 删除确认弹窗 — 点击遮罩关闭
deleteModal.addEventListener('click', (e) => {
  if (e.target === deleteModal) closeDeleteModal();
});

// 评论删除弹窗 — 确定
btnCommentModalConfirm.addEventListener('click', confirmDeleteComment);

// 评论删除弹窗 — 取消
btnCommentModalCancel.addEventListener('click', closeCommentDeleteModal);

// 评论删除弹窗 — 点击遮罩关闭
commentDeleteModal.addEventListener('click', (e) => {
  if (e.target === commentDeleteModal) closeCommentDeleteModal();
});

// 清空数据按钮 → 弹出确认弹窗
btnClear.addEventListener('click', () => {
  clearModal.classList.remove('hidden');
  btnClearModalConfirm.focus();
});

// 确认清空数据
async function confirmClearData() {
  closeClearModal();
  await chrome.storage.local.remove(['xhs_categories', 'xhs_comments']);
  await chrome.storage.local.set({ xhs_categories: ['未分类', '好物', '避雷', '搞笑'] });
  location.reload();
}

// 关闭清空弹窗
function closeClearModal() {
  clearModal.classList.add('hidden');
}

// 清空弹窗 — 确定
btnClearModalConfirm.addEventListener('click', confirmClearData);

// 清空弹窗 — 取消
btnClearModalCancel.addEventListener('click', closeClearModal);

// 清空弹窗 — 点击遮罩关闭
clearModal.addEventListener('click', (e) => {
  if (e.target === clearModal) closeClearModal();
});

// 搜索输入

// 导出按钮
btnExport.addEventListener('click', exportData);

// 导入按钮 → 触发文件选择
btnImport.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', () => {
  if (importFile.files[0]) importData(importFile.files[0]);
  importFile.value = '';
});

// 全局点击：关闭所有分类下拉面板
document.addEventListener('click', closeAllDropdowns);

// 全局 Esc：按优先级关闭弹窗：清空 > 评论删除 > 分类删除 > 取消内联编辑
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!clearModal.classList.contains('hidden')) {
      closeClearModal();
      return;
    }
    if (!commentDeleteModal.classList.contains('hidden')) {
      closeCommentDeleteModal();
      return;
    }
    if (!deleteModal.classList.contains('hidden')) {
      closeDeleteModal();
      return;
    }
    if (editingCategory) {
      const li = document.querySelector('.category-item.editing');
      if (li) cancelEditCategory(li);
    }
  }
});

/* 页面加载 */
document.addEventListener('DOMContentLoaded', init);
