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

/* ========== AI 总结相关状态 ========== */
let summaries = {};              // { [category]: { content, updatedAt, generatedBy } }
let summaryEditMode = false;     // 是否编辑态
let summaryGenerating = false;   // 是否正在 AI 生成

/* ========== 拓扑图相关状态 ========== */
let currentGraphView = 'graph';   // 'river' | 'grid' | 'dashboard' | 'graph'
let graphNodes = [];             // 当前图谱节点
let graphEdges = [];             // 当前图谱边
let graphScale = 1;
let graphOffsetX = 0, graphOffsetY = 0;
let graphSelectedNode = null;
let graphDraggingNode = null;
let graphHoveredNode = null;
let graphPanning = false;
let graphLastX = 0, graphLastY = 0;
let graphDirty = true;

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
const resultModal = document.getElementById('result-modal');
const resultModalTitle = document.getElementById('result-modal-title');
const resultModalBody = document.getElementById('result-modal-body');
const btnResultModalOk = document.getElementById('btn-result-modal-ok');

/* ========== 右侧面板 DOM 引用 ========== */
const rightPanel = document.getElementById('right-panel');
const summaryEmpty = document.getElementById('summary-empty');
const summaryPreview = document.getElementById('summary-preview');
const summaryEditor = document.getElementById('summary-editor');
const summaryLoading = document.getElementById('summary-loading');
const summaryPlaceholder = document.getElementById('summary-placeholder');
const summaryMeta = document.getElementById('summary-meta');
const summaryAutosave = document.getElementById('summary-autosave');
const btnSummaryEdit = document.getElementById('btn-summary-edit');
const btnSummaryAi = document.getElementById('btn-summary-ai');
const btnSummaryExport = document.getElementById('btn-summary-export');
const graphCanvas = document.getElementById('graph-canvas');
const graphBody = document.getElementById('graph-body');
const graphEmpty = document.getElementById('graph-empty');
const graphPlaceholder = document.getElementById('graph-placeholder');
const graphLegend = document.getElementById('graph-legend');
const graphTooltip = document.getElementById('graph-tooltip');
const graphDetailPopup = document.getElementById('graph-detail-popup');
const graphDetailClose = document.getElementById('graph-detail-close');
const graphDetailAuthor = document.getElementById('graph-detail-author');
const graphDetailText = document.getElementById('graph-detail-text');
const graphDetailPost = document.getElementById('graph-detail-post');

/* ========== 多视图 DOM 引用 ========== */
const graphViewTitle = document.getElementById('graph-view-title');
const riverCanvas = document.getElementById('river-canvas');
const riverLegend = document.getElementById('river-legend');
const gridCanvas = document.getElementById('grid-canvas');
const gridTooltip = document.getElementById('grid-tooltip');
const dashboardContainer = document.getElementById('dashboard-container');

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

  // 加载 AI 总结和 API 配置
  try {
    const configResult = await chrome.storage.local.get('xhs_summaries');
    summaries = configResult.xhs_summaries || {};
  } catch (e) { /* 忽略 */ }

  await loadApiConfig();

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
  updateRightPanel();
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

  // 语音播放器
  if (comment.audio && comment.audio.url) {
    const audioWrapper = document.createElement('div');
    audioWrapper.className = 'comment-card-audio';
    const audioEl = document.createElement('audio');
    audioEl.controls = true;
    audioEl.src = comment.audio.url;
    audioEl.preload = 'metadata';
    audioWrapper.appendChild(audioEl);
    if (comment.postUrl) {
      const fallback = document.createElement('a');
      fallback.className = 'comment-card-link';
      fallback.textContent = '去原帖收听';
      fallback.href = comment.postUrl;
      fallback.target = '_blank';
      audioWrapper.appendChild(fallback);
    }
    card.appendChild(audioWrapper);
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

  // 复制按钮（暂时隐藏）
  const copyBtn = document.createElement('button');
  copyBtn.className = 'comment-card-action-btn';
  copyBtn.textContent = '复制';
  copyBtn.title = '复制评论原文';
  copyBtn.style.display = 'none';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(comment.text).then(() => {
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
    });
  });
  metaRight.appendChild(copyBtn);

  // 分享按钮（暂时隐藏）
  const shareBtn = document.createElement('button');
  shareBtn.className = 'comment-card-action-btn';
  shareBtn.textContent = '分享';
  shareBtn.title = '生成分享卡片';
  shareBtn.style.display = 'none';
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
    ctxBody.appendChild(ctxText);

    // 关联评论图片缩略图
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
      ctxBody.appendChild(imagesRow);
    }

    // 关联评论语音
    if (comment.audio && comment.audio.url) {
      const audioWrapper = document.createElement('div');
      audioWrapper.className = 'comment-card-audio';
      const audioEl = document.createElement('audio');
      audioEl.controls = true;
      audioEl.src = comment.audio.url;
      audioEl.preload = 'metadata';
      audioWrapper.appendChild(audioEl);
      ctxBody.appendChild(audioWrapper);
    }

    const ctxAuthor = document.createElement('span');
    ctxAuthor.className = 'comment-context-author';
    ctxAuthor.textContent = comment.author ? '— ' + comment.author : '';

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
      // 更新本地状态：同组评论一起改分类
      const comment = comments.find(c => c.id === id);
      if (comment) {
        if (comment.groupId) {
          comments.forEach(c => { if (c.groupId === comment.groupId) c.category = newCategory; });
        } else {
          comment.category = newCategory;
        }
      }
      renderCategories();
    }
  } catch (err) {
    // 直接操作 storage
    const comment = comments.find(c => c.id === id);
    if (comment) {
      if (comment.groupId) {
        comments.forEach(c => { if (c.groupId === comment.groupId) c.category = newCategory; });
      } else {
        comment.category = newCategory;
      }
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
      // 清理已删除分类的 AI 总结
      delete summaries[name];
      await saveSummariesToStorage();
      if (currentCategory === name) {
        currentCategory = '全部';
      }
      renderAll();
    }
  } catch (err) {
    // 直接操作 storage
    categories = categories.filter(c => c !== name);
    comments = comments.map(c => c.category === name ? { ...c, category: fallbackCat } : c);
    delete summaries[name];
    await chrome.storage.local.set({
      xhs_categories: categories,
      xhs_comments: comments,
      xhs_summaries: summaries
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
      // 迁移 AI 总结
      if (summaries[oldName]) {
        summaries[newName] = summaries[oldName];
        delete summaries[oldName];
        await saveSummariesToStorage();
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
      // 迁移 AI 总结
      if (summaries[oldName]) {
        summaries[newName] = summaries[oldName];
        delete summaries[oldName];
      }
      await chrome.storage.local.set({
        xhs_categories: categories,
        xhs_comments: comments,
        xhs_summaries: summaries
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
 * 当评论属于一个组时，展示该组所有评论（作者+正文+图片+语音），最后附笔记
 * @param {Object} comment - 评论数据
 * @param {string} templateId - 模板 ID，默认 'default'
 * @returns {HTMLCanvasElement}
 */
async function generateShareCard(comment, templateId = 'default') {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const w = 600;
  const padding = 40;
  const lineH = 28;
  const imgMaxWidth = w - padding * 2;
  const imgMaxHeight = 180;

  // 收集同组所有评论
  let shareComments = [comment];
  if (comment.groupId) {
    const group = comments.filter(c => c.groupId === comment.groupId);
    if (group.length > 0) shareComments = group.sort((a, b) => a.groupIndex - b.groupIndex);
  }

  ctx.font = '16px Georgia, "Songti SC", "Noto Serif SC", serif';

  // 预加载所有评论的图片（每条最多 2 张）
  const allImageData = await Promise.all(shareComments.map(c => {
    const imgs = c.images && c.images.length > 0 ? c.images.slice(0, 2) : [];
    if (imgs.length === 0) return [];
    return Promise.all(imgs.map(url => {
      return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
      });
    })).then(results => results.filter(r => r !== null));
  }));

  // 为每条评论预计算布局数据（文本行、图片参数、语音）
  const blockLayouts = shareComments.map((c, i) => {
    const prefix = (c.author || '匿名') + '：';
    const textLayout = wrapTextWithPrefix(ctx, c.text, prefix, w - padding * 2);

    const imgDrawList = [];
    let imgH = 0;
    (allImageData[i] || []).forEach(img => {
      let iw = img.naturalWidth;
      let ih = img.naturalHeight;
      if (iw > imgMaxWidth) { ih = ih * (imgMaxWidth / iw); iw = imgMaxWidth; }
      if (ih > imgMaxHeight) { iw = iw * (imgMaxHeight / ih); ih = imgMaxHeight; }
      imgDrawList.push({ img, iw, ih });
      imgH += ih + 10;
    });

    const hasAudio = !!(c.audio && c.audio.url);
    return { prefix, textLayout, imgDrawList, imgH, hasAudio };
  });

  // 笔记（取自第一条评论）
  const note = shareComments[0].note;
  const noteLines = note ? wrapText(ctx, '笔记：' + note, w - padding * 2) : [];

  // 计算卡片总高度
  let blocksH = 0;
  blockLayouts.forEach((bl, i) => {
    blocksH += Math.max(bl.textLayout.lines.length, 1) * lineH;
    if (bl.imgDrawList.length > 0) blocksH += 20 + bl.imgH;
    if (bl.hasAudio) blocksH += 40;
    if (i < blockLayouts.length - 1) blocksH += lineH; // 评论间空行
  });
  const noteH = noteLines.length > 0 ? 30 + noteLines.length * lineH : 0;
  const cardHeight = padding + 60 + blocksH + noteH + 50;

  canvas.width = w;
  canvas.height = cardHeight;

  // 背景
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

  // 外边框 + 内边框
  ctx.strokeStyle = '#8b7355';
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, w - 20, cardHeight - 20);
  ctx.strokeStyle = '#c4a97d';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(18, 18, w - 36, cardHeight - 36);
  ctx.setLineDash([]);

  // 顶部标题
  ctx.fillStyle = '#8b7355';
  ctx.font = 'bold 18px Georgia, "Songti SC", "Noto Serif SC", serif';
  ctx.textAlign = 'center';
  ctx.fillText('—— 小红书评论收藏 ——', w / 2, padding + 30);

  // 逐条渲染评论
  ctx.textAlign = 'left';
  ctx.font = '16px Georgia, "Songti SC", "Noto Serif SC", serif';
  let y = padding + 80;

  blockLayouts.forEach((bl, i) => {
    const { lines, prefixWidth } = bl.textLayout;

    // 第一行：作者前缀 + 正文首段
    ctx.fillStyle = '#8b7355';
    ctx.fillText(bl.prefix, padding, y);
    ctx.fillStyle = '#3d2b1f';
    if (lines.length > 0) {
      ctx.fillText(lines[0], padding + prefixWidth, y);
    }
    // 续行：仅正文
    for (let j = 1; j < lines.length; j++) {
      y += lineH;
      ctx.fillText(lines[j], padding, y);
    }
    y += lineH;

    // 图片（紧跟本评论正文）
    if (bl.imgDrawList.length > 0) {
      y += 20;
      bl.imgDrawList.forEach(({ img, iw, ih }) => {
        const imgX = padding + (imgMaxWidth - iw) / 2;
        ctx.fillStyle = '#e8e0d5';
        ctx.fillRect(imgX - 1, y - 1, iw + 2, ih + 2);
        ctx.drawImage(img, imgX, y, iw, ih);
        y += ih + 10;
      });
    }

    // 语音（紧跟本评论正文）
    if (bl.hasAudio) {
      y += 15;
      ctx.fillStyle = '#8b7355';
      ctx.font = 'italic 14px Georgia, "Songti SC", "Noto Serif SC", serif';
      ctx.fillText('🎤 语音评论', padding, y);
      y += 25;
      ctx.font = '16px Georgia, "Songti SC", "Noto Serif SC", serif';
    }

    // 评论间空行
    if (i < blockLayouts.length - 1) {
      y += lineH;
    }
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
 * 带前缀的文本换行：第一行宽度减去前缀占宽
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text - 正文
 * @param {string} prefix - 前缀（如 "作者名："）
 * @param {number} maxWidth
 * @returns {{ lines: string[], prefixWidth: number }}
 */
function wrapTextWithPrefix(ctx, text, prefix, maxWidth) {
  const lines = [];
  const prefixW = ctx.measureText(prefix).width;
  const firstMax = maxWidth - prefixW;
  let current = '';
  let isFirst = true;
  for (const char of text) {
    const test = current + char;
    const limit = isFirst ? firstMax : maxWidth;
    if (ctx.measureText(test).width > limit && current.length > 0) {
      lines.push(current);
      current = char;
      isFirst = false;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return { lines, prefixWidth: prefixW };
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
  const result = await chrome.storage.local.get(['xhs_categories', 'xhs_comments', 'xhs_summaries']);
  const exportComments = result.xhs_comments || [];
  if (exportComments.length === 0) {
    showResultModal('导出为文件', '暂无评论数据可导出');
    return;
  }
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    categories: result.xhs_categories || [],
    comments: exportComments,
    summaries: result.xhs_summaries || {}
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `xhs-comments-${new Date().toISOString().slice(0, 16).replace(':', '-')}.json`;
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
      showResultModal('文件导入', '导入失败：文件格式不正确，缺少评论数据');
      return;
    }
    if (!data.categories || !Array.isArray(data.categories)) {
      showResultModal('文件导入', '导入失败：文件格式不正确，缺少分类数据');
      return;
    }

    // 读取当前数据
    const current = await chrome.storage.local.get(['xhs_categories', 'xhs_comments', 'xhs_summaries']);
    const currentCategories = current.xhs_categories || [];
    const currentComments = current.xhs_comments || [];
    const currentSummaries = current.xhs_summaries || {};

    // 合并分类（去重）
    const mergedCategories = [...currentCategories];
    let newCatCount = 0;
    data.categories.forEach(cat => {
      if (!mergedCategories.includes(cat)) {
        mergedCategories.push(cat);
        newCatCount++;
      }
    });

    // 合并评论（按 id 去重）
    const existingIds = new Set(currentComments.map(c => c.id));
    const newComments = data.comments.filter(c => !existingIds.has(c.id));
    const mergedComments = [...newComments, ...currentComments];

    // 合并 AI 总结（导入的总结不覆盖已有）
    const mergedSummaries = { ...(data.summaries || {}), ...currentSummaries };

    await chrome.storage.local.set({
      xhs_categories: mergedCategories,
      xhs_comments: mergedComments,
      xhs_summaries: mergedSummaries
    });

    showResultModal('文件导入', `导入成功！新增 ${newCatCount} 个分类、${newComments.length} 条评论！`, () => location.reload());
  } catch (err) {
    showResultModal('文件导入', `导入失败：文件内容无法解析（${err.message}）`);
  }
}

/* ========== 右侧面板：AI 总结 + 拓扑图 ========== */

/**
 * 更新右侧面板（分类切换时调用）
 */
function updateRightPanel() {
  if (currentCategory === '全部') {
    showSummaryPlaceholderState();
  } else {
    loadSummaryForCategory(currentCategory);
  }
  // 视图仅关系图谱受分类影响；河流图/网格图/仪表盘使用全量数据
  if (currentGraphView === 'graph') {
    buildAndRenderGraph();
  }
}

/* ===== AI 总结 ===== */

/** 显示「全部分类」占位 */
function showSummaryPlaceholderState() {
  summaryEmpty.classList.add('hidden');
  summaryPreview.classList.add('hidden');
  summaryEditor.classList.add('hidden');
  summaryLoading.classList.add('hidden');
  summaryPlaceholder.classList.remove('hidden');
  summaryMeta.classList.add('hidden');
  summaryAutosave.classList.add('hidden');
  summaryEditMode = false;
  btnSummaryEdit.classList.remove('active');
}

/** 显示空状态 */
function showSummaryEmptyState() {
  summaryEmpty.classList.remove('hidden');
  summaryPreview.classList.add('hidden');
  summaryEditor.classList.add('hidden');
  summaryLoading.classList.add('hidden');
  summaryPlaceholder.classList.add('hidden');
  summaryMeta.classList.add('hidden');
  summaryAutosave.classList.add('hidden');
  summaryEditMode = false;
  btnSummaryEdit.classList.remove('active');
}

/** 显示预览态 */
function showSummaryPreviewState(summary) {
  summaryEmpty.classList.add('hidden');
  summaryPreview.classList.remove('hidden');
  summaryEditor.classList.add('hidden');
  summaryLoading.classList.add('hidden');
  summaryPlaceholder.classList.add('hidden');
  summaryMeta.classList.remove('hidden');
  summaryAutosave.classList.add('hidden');
  summaryEditMode = false;
  btnSummaryEdit.classList.remove('active');

  summaryPreview.innerHTML = renderMarkdown(summary.content);
  summaryMeta.textContent = '最后更新: ' + formatTime(summary.updatedAt);
}

/** 加载某分类的总结 */
function loadSummaryForCategory(category) {
  const summary = summaries[category];
  if (!summary || !summary.content) {
    showSummaryEmptyState();
  } else {
    showSummaryPreviewState(summary);
  }
}

/** 进入编辑态 */
function enterSummaryEdit() {
  summaryEditMode = true;
  summaryEmpty.classList.add('hidden');
  summaryPreview.classList.add('hidden');
  summaryPlaceholder.classList.add('hidden');
  summaryLoading.classList.add('hidden');
  summaryMeta.classList.add('hidden');
  summaryAutosave.classList.add('hidden');
  summaryEditor.classList.remove('hidden');
  const summary = summaries[currentCategory];
  summaryEditor.value = summary ? summary.content : '';
  btnSummaryEdit.classList.add('active');
  btnSummaryEdit.title = '退出编辑';
  summaryEditor.focus();
}

/** 退出编辑态 */
function exitSummaryEdit() {
  summaryEditMode = false;
  summaryEditor.classList.add('hidden');
  btnSummaryEdit.classList.remove('active');
  btnSummaryEdit.title = '编辑';
  summaryAutosave.classList.add('hidden');
  const summary = summaries[currentCategory];
  if (summary && summary.content) {
    summaryPreview.classList.remove('hidden');
    summaryPreview.innerHTML = renderMarkdown(summary.content);
    summaryMeta.classList.remove('hidden');
    summaryMeta.textContent = '最后更新: ' + formatTime(summary.updatedAt);
    summaryEmpty.classList.add('hidden');
    summaryPlaceholder.classList.add('hidden');
  } else {
    showSummaryEmptyState();
  }
}

/** 防抖工具 */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/** 自动保存总结（防抖 1 秒） */
const autoSaveSummary = debounce(async function () {
  const content = summaryEditor.value.trim();
  if (!content) {
    delete summaries[currentCategory];
  } else {
    summaries[currentCategory] = {
      content,
      updatedAt: Date.now(),
      generatedBy: summaries[currentCategory]?.generatedBy === 'ai' ? 'ai' : 'manual'
    };
  }
  await saveSummariesToStorage();
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ':' +
               String(now.getMinutes()).padStart(2, '0') + ':' +
               String(now.getSeconds()).padStart(2, '0');
  summaryAutosave.textContent = '已自动保存 ' + time;
  summaryAutosave.classList.remove('hidden');
}, 1000);

/** 即时保存（退出编辑时用） */
function flushAutoSave() {
  const content = summaryEditor.value.trim();
  if (!content) {
    delete summaries[currentCategory];
  } else {
    summaries[currentCategory] = {
      content,
      updatedAt: Date.now(),
      generatedBy: summaries[currentCategory]?.generatedBy === 'ai' ? 'ai' : 'manual'
    };
  }
  saveSummariesToStorage();
}

/** AI 生成总结 */
async function aiGenerateSummary() {
  if (!window.__apiConfig || !window.__apiConfig.apiKey) {
    alert('请先在 .env 文件中配置 API Key，在 apiconfig.json 中配置 activeProvider');
    return;
  }

  const categoryComments = comments.filter(c => c.category === currentCategory);
  if (categoryComments.length === 0) return;

  summaryGenerating = true;
  summaryPreview.classList.add('hidden');
  summaryEditor.classList.add('hidden');
  summaryEmpty.classList.add('hidden');
  summaryPlaceholder.classList.add('hidden');
  summaryLoading.classList.remove('hidden');
  summaryMeta.classList.add('hidden');
  summaryAutosave.classList.add('hidden');
  summaryEditMode = false;
  btnSummaryEdit.classList.remove('active');

  const commentsText = categoryComments.map(c =>
    (c.author || '匿名') + '：' + c.text
  ).join('\n');

  const prompt = `你是一位内容分析助手。请对以下小红书评论进行总结分析：

1. 归纳核心观点（提炼出 2-5 个关键主题）
2. 对每个主题，列出代表性的评论原文（标注作者）
3. 如果发现互相矛盾的观点，请特别指出
4. 最后给出一个简要的总体结论

格式要求：使用 Markdown，结构清晰

以下是评论列表（格式：作者 | 评论内容）：
---
${commentsText}
---`;

  try {
    const result = await callLLMApi(prompt);
    summaries[currentCategory] = {
      content: result,
      updatedAt: Date.now(),
      generatedBy: 'ai'
    };
    await saveSummariesToStorage();
    summaryGenerating = false;
    loadSummaryForCategory(currentCategory);
  } catch (err) {
    summaryGenerating = false;
    summaryLoading.classList.add('hidden');
    showApiErrorModal(err.code || 'Error', err.message || '未知错误');
    loadSummaryForCategory(currentCategory);
  }
}

/** 调用大模型 API */
async function callLLMApi(prompt) {
  const cfg = window.__apiConfig;
  if (!cfg) throw new Error('API 配置未加载，请检查 apiconfig.json 和 .env');

  const provider = API_PROVIDERS[cfg.provider];
  if (!provider) throw new Error('未知的 provider: ' + cfg.provider);

  const baseUrl = cfg.baseUrl;
  const model = cfg.model;

  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: provider.headers(cfg.apiKey),
    body: JSON.stringify(provider.buildBody(model, prompt))
  });
  if (!resp.ok) {
    let errBody;
    try {
      errBody = await resp.json();
    } catch {
      errBody = await resp.text().catch(() => '');
    }

    let errCode = '';
    let errMsg = '';

    // MiniMax 格式: { base_resp: { status_code, status_msg } }
    if (errBody?.base_resp) {
      errCode = 'HTTP ' + resp.status + ' / code ' + (errBody.base_resp.status_code || '?');
      errMsg = errBody.base_resp.status_msg || JSON.stringify(errBody.base_resp);
    }
    // Anthropic 格式: { error: { type, message } }
    // OpenAI 格式: { error: { code, message } }
    else if (errBody?.error && typeof errBody.error === 'object') {
      errCode = 'HTTP ' + resp.status + ' / ' + (errBody.error.type || errBody.error.code || 'error');
      errMsg = errBody.error.message || JSON.stringify(errBody.error);
    }
    // 兜底
    else {
      errCode = 'HTTP ' + resp.status;
      errMsg = typeof errBody === 'string' ? errBody : JSON.stringify(errBody);
    }

    throw { code: errCode, message: errMsg, status: resp.status };
  }
  const data = await resp.json();
  return provider.parseResponse(data);
}

/** 简易 Markdown 渲染 → HTML */
function renderMarkdown(md) {
  const div = document.createElement('div');
  let html = md;
  // 转义 HTML（先解码防止二次转义）
  div.textContent = '';
  html = escapeHtml(html);
  // 标题
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 粗体 / 斜体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 分隔线
  html = html.replace(/^---$/gm, '<hr>');
  // 无序列表
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  // 有序列表
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // 连续 <li> 包裹 <ul>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  // 普通换行
  html = html.replace(/\n\n/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

/** 导出 Markdown 文件 */
function exportSummaryMd() {
  const summary = summaries[currentCategory];
  const content = summary ? summary.content : '';
  if (!content) {
    alert('暂无总结内容可导出');
    return;
  }
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  const ts = now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0') + '-' +
    String(now.getHours()).padStart(2, '0') + '-' +
    String(now.getMinutes()).padStart(2, '0') + '-' +
    String(now.getSeconds()).padStart(2, '0');
  a.download = `${currentCategory}-${ts}.md`;
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
}

/** 保存总结到 storage */
async function saveSummariesToStorage() {
  try {
    await chrome.storage.local.set({ xhs_summaries: summaries });
  } catch (e) { /* 忽略 */ }
}

/**
 * 显示 API 错误弹窗（复用 result-modal）
 * @param {string} errCode - 错误代码
 * @param {string} errMsg - 错误信息
 */
function showApiErrorModal(errCode, errMsg) {
  resultModalTitle.textContent = 'AI 生成失败';
  resultModalBody.innerHTML =
    '<div style="margin-bottom:8px;font-size:12px;font-weight:600;color:var(--text-secondary)">错误代码</div>' +
    '<div style="background:#fef2f2;color:#dc2626;padding:8px 12px;border-radius:6px;font-family:monospace;font-size:13px;margin-bottom:16px;word-break:break-all">' +
    escapeHtml(errCode) +
    '</div>' +
    '<div style="margin-bottom:4px;font-size:12px;font-weight:600;color:var(--text-secondary)">错误信息</div>' +
    '<div style="color:var(--text-secondary);line-height:1.7;word-break:break-word">' +
    escapeHtml(errMsg) +
    '</div>';

  const actions = resultModal.querySelector('.modal-actions');
  actions.innerHTML = '';

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:12px;color:#b8a99a;margin-bottom:14px;text-align:center';
  hint.textContent = '请检查 .env 和 apiconfig.json 配置后重试';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-modal-confirm';
  closeBtn.textContent = '确定';
  closeBtn.addEventListener('click', () => {
    resultModal.classList.add('hidden');
    restoreResultModalButtons();
  });

  actions.appendChild(closeBtn);
  resultModalBody.appendChild(hint);
  resultModal.classList.remove('hidden');
  closeBtn.focus();
}

/** 恢复 result-modal 的默认确定按钮 */
function restoreResultModalButtons() {
  const actions = resultModal.querySelector('.modal-actions');
  actions.innerHTML = '<button class="btn-modal-confirm" id="btn-result-modal-ok">确定</button>';
  btnResultModalOk._onOk = null;
  document.getElementById('btn-result-modal-ok').addEventListener('click', closeResultModal);
}

/* ===== 拓扑思维导图 ===== */

/** 作者色板 */
const authorColorPalette = ['#f4a8b4', '#f7c59f', '#a8d8b9', '#a0c4e8', '#d4b8e0',
  '#f9d89c', '#b8d4e3', '#e8c4a0', '#c4d4b0', '#e0b8c8'];

function getGraphAuthorColor(author, colorMap) {
  if (!colorMap[author]) {
    colorMap[author] = authorColorPalette[Object.keys(colorMap).length % authorColorPalette.length];
  }
  return colorMap[author];
}

/** 构建图谱数据 */
function buildGraphData() {
  const categoryComments = comments.filter(c => c.category === currentCategory);
  const authorColorMap = {};

  graphNodes = categoryComments.map(c => ({
    id: c.id,
    label: c.author || '匿名',
    radius: Math.min(6 + c.text.length / 20, 18),
    color: getGraphAuthorColor(c.author, authorColorMap),
    data: c,
    x: 0, y: 0, vx: 0, vy: 0
  }));

  graphEdges = [];
  const nodeMap = new Map(graphNodes.map(n => [n.id, n]));

  // 同帖子连线（链式）
  const postGroups = new Map();
  categoryComments.forEach(c => {
    if (!c.postUrl) return;
    const key = c.postUrl;
    if (!postGroups.has(key)) postGroups.set(key, []);
    postGroups.get(key).push(c);
  });
  postGroups.forEach(group => {
    for (let i = 1; i < group.length; i++) {
      graphEdges.push({ source: group[i - 1].id, target: group[i].id, type: 'post' });
    }
  });

  // 同作者连线（链式）
  const authorGroups = new Map();
  categoryComments.forEach(c => {
    const a = c.author || '匿名';
    if (!authorGroups.has(a)) authorGroups.set(a, []);
    authorGroups.get(a).push(c);
  });
  authorGroups.forEach(group => {
    for (let i = 1; i < group.length; i++) {
      graphEdges.push({ source: group[i - 1].id, target: group[i].id, type: 'author' });
    }
  });

  // 同 groupId 连线（全连接）
  const gidGroups = new Map();
  categoryComments.forEach(c => {
    if (!c.groupId) return;
    if (!gidGroups.has(c.groupId)) gidGroups.set(c.groupId, []);
    gidGroups.get(c.groupId).push(c);
  });
  gidGroups.forEach(group => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        graphEdges.push({ source: group[i].id, target: group[j].id, type: 'group' });
      }
    }
  });

  graphDirty = true;
}

/** 调整 Canvas 尺寸 */
function resizeGraphCanvas() {
  const rect = graphBody.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (rect.width === 0 || rect.height === 0) return;
  graphCanvas.width = rect.width * dpr;
  graphCanvas.height = rect.height * dpr;
  graphCanvas.style.width = rect.width + 'px';
  graphCanvas.style.height = rect.height + 'px';
  const ctx = graphCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** 力导向布局 */
function runForceLayout(iterations) {
  const dpr = window.devicePixelRatio || 1;
  const w = graphCanvas.width / dpr;
  const h = graphCanvas.height / dpr;
  const cx = w / 2, cy = h / 2;
  if (w === 0 || h === 0 || graphNodes.length === 0) return;

  graphNodes.forEach(n => {
    n.x = 40 + Math.random() * (w - 80);
    n.y = 40 + Math.random() * (h - 80);
    n.vx = 0; n.vy = 0;
  });

  const k = Math.sqrt(w * h / graphNodes.length) * 0.3;

  for (let iter = 0; iter < iterations; iter++) {
    const temp = Math.max(0.1, 1 - iter / iterations);

    // 斥力
    for (let i = 0; i < graphNodes.length; i++) {
      for (let j = i + 1; j < graphNodes.length; j++) {
        const a = graphNodes[i], b = graphNodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = k * k / dist * temp;
        a.vx -= dx / dist * force; a.vy -= dy / dist * force;
        b.vx += dx / dist * force; b.vy += dy / dist * force;
      }
    }

    // 引力
    graphEdges.forEach(edge => {
      const a = graphNodes.find(n => n.id === edge.source);
      const b = graphNodes.find(n => n.id === edge.target);
      if (!a || !b) return;
      let dx = b.x - a.x, dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const str = edge.type === 'group' ? 0.9 : edge.type === 'post' ? 0.5 : 0.2;
      const force = dist * dist / k * str * temp;
      a.vx += dx / dist * force; a.vy += dy / dist * force;
      b.vx -= dx / dist * force; b.vy -= dy / dist * force;
    });

    // 中心引力 + 阻尼
    graphNodes.forEach(n => {
      n.vx += (cx - n.x) * 0.001 * temp;
      n.vy += (cy - n.y) * 0.001 * temp;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += Math.min(Math.abs(n.vx), 50) * Math.sign(n.vx);
      n.y += Math.min(Math.abs(n.vy), 50) * Math.sign(n.vy);
      n.x = Math.max(25, Math.min(w - 25, n.x));
      n.y = Math.max(25, Math.min(h - 25, n.y));
    });
  }

  graphDirty = false;
}

/** 渲染图谱 */
function renderGraph() {
  const ctx = graphCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = graphCanvas.width / dpr;
  const h = graphCanvas.height / dpr;

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(graphOffsetX, graphOffsetY);
  ctx.scale(graphScale, graphScale);

  // 边
  graphEdges.forEach(edge => {
    const a = graphNodes.find(n => n.id === edge.source);
    const b = graphNodes.find(n => n.id === edge.target);
    if (!a || !b) return;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    if (edge.type === 'group') {
      ctx.strokeStyle = 'rgba(232, 56, 79, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
    } else if (edge.type === 'post') {
      ctx.strokeStyle = 'rgba(180, 160, 140, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
    } else {
      ctx.strokeStyle = 'rgba(180, 160, 140, 0.2)';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([2, 6]);
    }
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // 节点
  graphNodes.forEach(node => {
    const isHovered = graphHoveredNode === node;
    const isSelected = graphSelectedNode === node;
    const r = isHovered ? node.radius * 1.3 : node.radius;

    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = node.color;
    ctx.fill();

    if (isSelected) {
      ctx.strokeStyle = '#e8384f';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else if (isHovered) {
      ctx.strokeStyle = 'rgba(232,56,79,0.4)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = '#4a4036';
    ctx.font = Math.max(9, node.radius * 0.7) + 'px sans-serif';
    ctx.textAlign = 'center';
    const label = node.label.length > 5 ? node.label.slice(0, 4) + '…' : node.label;
    ctx.fillText(label, node.x, node.y + r + 12);
  });

  ctx.restore();
}

/** 屏幕坐标 → 图谱坐标 */
function screenToGraph(e) {
  const rect = graphCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - graphOffsetX) / graphScale,
    y: (e.clientY - rect.top - graphOffsetY) / graphScale
  };
}

/** 命中检测 */
function hitTestNode(gx, gy) {
  for (const node of graphNodes) {
    const dx = gx - node.x, dy = gy - node.y;
    if (dx * dx + dy * dy < (node.radius + 5) ** 2) return node;
  }
  return null;
}

/** 显示节点详情浮层 */
function showGraphDetailPopup(node) {
  graphDetailAuthor.textContent = node.label;
  graphDetailText.textContent = node.data.text;
  graphDetailPost.innerHTML = node.data.postUrl
    ? '<a class="comment-card-link" href="' + escapeHtml(node.data.postUrl) + '" target="_blank">查看原帖</a>'
    : '';
  graphDetailPopup.classList.remove('hidden');
}

/** 构建并渲染图谱 */
function buildAndRenderGraph() {
  if (currentCategory === '全部') {
    showGraphPlaceholderState();
    return;
  }
  buildGraphData();
  if (graphNodes.length < 3) {
    graphEmpty.classList.remove('hidden');
    graphPlaceholder.classList.add('hidden');
    graphCanvas.classList.add('hidden');
    graphLegend.classList.add('hidden');
    return;
  }
  graphEmpty.classList.add('hidden');
  graphPlaceholder.classList.add('hidden');
  graphCanvas.classList.remove('hidden');
  graphLegend.classList.remove('hidden');
  resizeGraphCanvas();
  runForceLayout(100);
  renderGraph();
}

/** 显示图谱占位状态 */
function showGraphPlaceholderState() {
  graphEmpty.classList.add('hidden');
  graphPlaceholder.classList.remove('hidden');
  graphCanvas.classList.add('hidden');
  graphLegend.classList.add('hidden');
  graphTooltip.classList.add('hidden');
  graphDetailPopup.classList.add('hidden');
}

/* ===== 多视图管理 ===== */

/** 切换视图 */
function switchGraphView(viewName) {
  currentGraphView = viewName;
  // 更新按钮 active 态
  document.querySelectorAll('.view-switch-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  // 更新标题
  const titles = { river: '🌊 河流图', grid: '📊 网格图', dashboard: '📈 成长仪表盘', graph: '🔗 关系图谱' };
  graphViewTitle.textContent = titles[viewName] || '关系图谱';

  // 隐藏所有视图
  riverCanvas.classList.add('hidden');
  riverLegend.classList.add('hidden');
  gridCanvas.classList.add('hidden');
  gridTooltip.classList.add('hidden');
  dashboardContainer.classList.add('hidden');
  graphCanvas.classList.add('hidden');
  graphTooltip.classList.add('hidden');
  graphDetailPopup.classList.add('hidden');
  graphEmpty.classList.add('hidden');
  graphPlaceholder.classList.add('hidden');
  graphLegend.classList.add('hidden');

  // 显示当前视图
  switch (viewName) {
    case 'river':
      riverCanvas.classList.remove('hidden');
      riverLegend.classList.remove('hidden');
      break;
    case 'grid':
      gridCanvas.classList.remove('hidden');
      break;
    case 'dashboard':
      dashboardContainer.classList.remove('hidden');
      break;
    case 'graph':
      graphLegend.classList.remove('hidden');
      break;
  }

  renderCurrentView();
}

/** 渲染当前视图 */
function renderCurrentView() {
  switch (currentGraphView) {
    case 'river': renderRiverView(); break;
    case 'grid': renderGridView(); break;
    case 'dashboard': renderDashboardView(); break;
    case 'graph': buildAndRenderGraph(); break;
  }
}

/* ===== 河流图 ===== */

/** 分类马卡龙色板（与 CSS 的 cat-macaron-* 对应） */
const CAT_COLORS = [
  '#f4a8b4', '#f7c59f', '#a8d8b9', '#a0c4e8', '#d4b8e0',
  '#f9d89c', '#b8d4e3', '#e8c4a0', '#c4d4b0', '#e0b8c8',
  '#f0c8a0', '#c8d0e8'
];

/** 为分类分配颜色 */
function getCatColor(catIndex) {
  return CAT_COLORS[catIndex % CAT_COLORS.length];
}

/** 河流图状态 */
let riverHiddenCats = new Set();      // 隐藏的分类
let riverHoveredCat = null;          // hover 的分类名

/** 构建河流图数据 */
function buildRiverData() {
  if (comments.length === 0) return null;

  const timestamps = comments.map(c => c.savedAt).filter(t => t);
  if (timestamps.length === 0) return null;

  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);

  // 生成月份序列
  const months = [];
  const start = new Date(new Date(minTs).getFullYear(), new Date(minTs).getMonth(), 1);
  const end = new Date(new Date(maxTs).getFullYear(), new Date(maxTs).getMonth(), 1);
  let cur = new Date(start);
  while (cur <= end) {
    months.push({ year: cur.getFullYear(), month: cur.getMonth(), ts: cur.getTime() });
    cur.setMonth(cur.getMonth() + 1);
  }

  // 统计每月每分类数量
  const activeCats = [];
  const catSet = new Set();
  comments.forEach(c => { if (!catSet.has(c.category)) { catSet.add(c.category); activeCats.push(c.category); } });

  // monthCounts[catIndex][monthIndex] = count
  const monthCounts = activeCats.map(() => new Array(months.length).fill(0));
  comments.forEach(c => {
    const ci = activeCats.indexOf(c.category);
    const d = new Date(c.savedAt);
    const mi = months.findIndex(m => m.year === d.getFullYear() && m.month === d.getMonth());
    if (ci >= 0 && mi >= 0) monthCounts[ci][mi]++;
  });

  return { months, activeCats, monthCounts };
}

/** 调整河流图 Canvas 尺寸（根据数据计算最小尺寸，支持滚动） */
function resizeRiverCanvas(data) {
  const rect = graphBody.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (rect.width === 0 || rect.height === 0) return;

  // 根据数据计算最小尺寸
  const minW = data ? Math.max(rect.width, data.months.length * 50 + 24) : rect.width;
  const minH = data ? Math.max(rect.height - 30, data.activeCats.length * 30 + 80) : rect.height - 30;

  riverCanvas.width = minW * dpr;
  riverCanvas.height = minH * dpr;
  riverCanvas.style.width = minW + 'px';
  riverCanvas.style.height = minH + 'px';
  const ctx = riverCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** 绘制河流图（堆叠面积图） */
function drawRiver(data) {
  const ctx = riverCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = riverCanvas.width / dpr;
  const h = riverCanvas.height / dpr;
  ctx.clearRect(0, 0, w, h);

  const { months, activeCats, monthCounts } = data;
  if (months.length < 1 || activeCats.length === 0) return;

  const padLeft = 12;
  const padRight = 12;
  const padTop = 8;
  const padBottom = 28;
  const chartW = w - padLeft - padRight;
  const chartH = h - padTop - padBottom;

  // 计算总堆叠值用于比例缩放
  const totals = months.map((_, mi) => {
    let sum = 0;
    activeCats.forEach((_, ci) => {
      if (!riverHiddenCats.has(activeCats[ci])) sum += monthCounts[ci][mi];
    });
    return sum;
  });
  const maxTotal = Math.max(...totals, 1);

  // 按类别顺序计算堆叠 Y
  const calcStack = (mi) => {
    const stack = [];
    let yAcc = 0;
    activeCats.forEach((cat, ci) => {
      if (riverHiddenCats.has(cat)) { stack.push(null); return; }
      const count = monthCounts[ci][mi];
      const height = count / maxTotal * chartH;
      stack.push({ y0: yAcc, y1: yAcc + height, count });
      yAcc += height;
    });
    return stack;
  };

  // 绘制各分类河流（从下往上）
  const monthXs = months.map((_, mi) => padLeft + chartW * mi / Math.max(months.length - 1, 1));

  activeCats.forEach((cat, ci) => {
    if (riverHiddenCats.has(cat)) return;

    const catIdx = categories.indexOf(cat);
    const color = catIdx >= 0 ? getCatColor(catIdx) : '#c4d4b0';
    const isHovered = riverHoveredCat === cat;
    const alpha = riverHoveredCat && !isHovered ? 0.25 : 0.7;

    // 构建上边界点
    const topPoints = [];
    const bottomPoints = [];
    for (let mi = 0; mi < months.length; mi++) {
      const stack = calcStack(mi);
      const layer = stack[ci];
      if (layer) {
        topPoints.push({ x: monthXs[mi], y: padTop + chartH - layer.y0 });
        bottomPoints.push({ x: monthXs[mi], y: padTop + chartH - layer.y1 });
      }
    }

    if (topPoints.length < 2) return;

    // 绘制填充区域
    ctx.beginPath();
    ctx.moveTo(topPoints[0].x, topPoints[0].y);
    for (let i = 0; i < topPoints.length - 1; i++) {
      const cx1 = topPoints[i].x + (topPoints[i + 1].x - topPoints[i].x) / 3;
      const cx2 = topPoints[i].x + (topPoints[i + 1].x - topPoints[i].x) * 2 / 3;
      ctx.bezierCurveTo(cx1, topPoints[i].y, cx2, topPoints[i + 1].y, topPoints[i + 1].x, topPoints[i + 1].y);
    }
    // 底边界从右往左
    for (let i = bottomPoints.length - 1; i >= 1; i--) {
      const cx1 = bottomPoints[i].x - (bottomPoints[i].x - bottomPoints[i - 1].x) / 3;
      const cx2 = bottomPoints[i].x - (bottomPoints[i].x - bottomPoints[i - 1].x) * 2 / 3;
      ctx.bezierCurveTo(cx1, bottomPoints[i].y, cx2, bottomPoints[i - 1].y, bottomPoints[i - 1].x, bottomPoints[i - 1].y);
    }
    ctx.closePath();

    ctx.fillStyle = color.replace(')', ', ' + alpha + ')').replace('rgb', 'rgba');
    if (color.startsWith('#')) {
      const rgb = hexToRgb(color);
      ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
    }
    ctx.fill();

    // 上边界线
    ctx.strokeStyle = color;
    ctx.lineWidth = isHovered ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(topPoints[0].x, topPoints[0].y);
    for (let i = 0; i < topPoints.length - 1; i++) {
      const cx1 = topPoints[i].x + (topPoints[i + 1].x - topPoints[i].x) / 3;
      const cx2 = topPoints[i].x + (topPoints[i + 1].x - topPoints[i].x) * 2 / 3;
      ctx.bezierCurveTo(cx1, topPoints[i].y, cx2, topPoints[i + 1].y, topPoints[i + 1].x, topPoints[i + 1].y);
    }
    ctx.stroke();
  });

  // X 轴标签
  ctx.fillStyle = '#8c7d6c';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  const labelStep = Math.max(1, Math.floor(months.length / 8));
  months.forEach((m, i) => {
    if (i % labelStep === 0 || i === months.length - 1) {
      const label = (m.month + 1) + '月';
      ctx.fillText(label, monthXs[i], h - 6);
    }
  });

  // Y 轴参考线
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 0.5;
  for (let i = 1; i <= 3; i++) {
    const y = padTop + chartH * i / 4;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(w - padRight, y);
    ctx.stroke();
  }

  // 存储数据用于 hover 检测
  riverCanvas._riverData = { data, monthXs, padTop, padLeft, chartW, chartH, w, h, calcStack };
}

/** 渲染河流图图例 */
function renderRiverLegend(data) {
  riverLegend.innerHTML = '';
  data.activeCats.forEach((cat, ci) => {
    const catIdx = categories.indexOf(cat);
    const color = catIdx >= 0 ? getCatColor(catIdx) : '#c4d4b0';

    const item = document.createElement('span');
    item.className = 'river-legend-item';
    if (riverHiddenCats.has(cat)) item.classList.add('hidden-cat');

    const swatch = document.createElement('span');
    swatch.className = 'river-legend-swatch';
    swatch.style.background = color;

    item.appendChild(swatch);
    item.appendChild(document.createTextNode(cat));

    item.addEventListener('click', () => {
      if (riverHiddenCats.has(cat)) {
        riverHiddenCats.delete(cat);
      } else {
        riverHiddenCats.add(cat);
      }
      renderRiverLegend(data);
      drawRiver(data);
    });

    item.addEventListener('mouseenter', () => {
      riverHoveredCat = cat;
      drawRiver(data);
    });
    item.addEventListener('mouseleave', () => {
      riverHoveredCat = null;
      drawRiver(data);
    });

    riverLegend.appendChild(item);
  });
}

/** 渲染河流图 */
function renderRiverView() {
  const data = buildRiverData();
  resizeRiverCanvas(data);
  if (!data || data.months.length < 1) {
    const ctx = riverCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = riverCanvas.width / dpr;
    const h = riverCanvas.height / dpr;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#8c7d6c';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无足够数据', w / 2, h / 2);
    riverLegend.innerHTML = '';
    return;
  }
  if (data.months.length === 1) {
    const ctx = riverCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = riverCanvas.width / dpr;
    const h = riverCanvas.height / dpr;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#8c7d6c';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('数据仅在一个月内，趋势待积累', w / 2, h / 2);
    renderRiverLegend(data);
    return;
  }
  renderRiverLegend(data);
  drawRiver(data);
}

/* ===== 网格图 ===== */

/** 获取某天的 ISO 周起始日期（周一）的 timestamp */
function getWeekStart(ts) {
  const d = new Date(ts);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // 周一
  const monday = new Date(d.getFullYear(), d.getMonth(), diff);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

/** 构建网格图数据 */
function buildGridData() {
  if (comments.length === 0) return null;

  // 确定时间范围
  const timestamps = comments.map(c => c.savedAt).filter(t => t);
  if (timestamps.length === 0) return null;
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);

  // 按周分桶
  const weekStarts = [];
  let ws = getWeekStart(minTs);
  const lastWs = getWeekStart(maxTs);
  while (ws <= lastWs) {
    weekStarts.push(ws);
    ws += 7 * 24 * 60 * 60 * 1000;
  }

  // 获取活跃分类（按总收藏量降序）
  const catTotals = {};
  comments.forEach(c => { catTotals[c.category] = (catTotals[c.category] || 0) + 1; });
  const activeCats = Object.entries(catTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat);

  if (activeCats.length === 0 || weekStarts.length === 0) return null;

  // 构建矩阵：[catIndex][weekIndex] = count
  const matrix = activeCats.map(() => new Array(weekStarts.length).fill(0));
  let maxCount = 0;
  comments.forEach(c => {
    const catIdx = activeCats.indexOf(c.category);
    const weekIdx = weekStarts.findIndex(ws => c.savedAt >= ws && c.savedAt < ws + 7 * 24 * 60 * 60 * 1000);
    if (catIdx >= 0 && weekIdx >= 0) {
      matrix[catIdx][weekIdx]++;
      if (matrix[catIdx][weekIdx] > maxCount) maxCount = matrix[catIdx][weekIdx];
    }
  });

  return { weekStarts, activeCats, matrix, maxCount: Math.max(maxCount, 1) };
}

/** 调整网格图 Canvas 尺寸（根据数据计算最小尺寸，支持滚动） */
function resizeGridCanvas(data) {
  const rect = graphBody.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (rect.width === 0 || rect.height === 0) return;

  const cellW = 24, cellH = 24, cellGap = 2;
  const minW = data ? Math.max(rect.width, 8 + 8 + data.weekStarts.length * (cellW + cellGap) - cellGap) : rect.width;
  const minH = data ? Math.max(rect.height, 10 + 18 + data.activeCats.length * (cellH + cellGap) - cellGap) : rect.height;

  gridCanvas.width = minW * dpr;
  gridCanvas.height = minH * dpr;
  gridCanvas.style.width = minW + 'px';
  gridCanvas.style.height = minH + 'px';
  const ctx = gridCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** 绘制网格图 */
function drawGrid(data) {
  const ctx = gridCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = gridCanvas.width / dpr;
  const h = gridCanvas.height / dpr;
  ctx.clearRect(0, 0, w, h);

  const { activeCats, weekStarts, matrix, maxCount } = data;

  const leftPad = 8;   // 左侧留白
  const topPad = 10;
  const bottomPad = 18;  // 留空间给日期标签
  const rightPad = 8;
  const cellW = 24;  // 固定格子宽度（保证横排 8/3 能看清）
  const cellH = 24;  // 固定格子高度
  const cellGap = 2;

  // 如果数据少、Canvas 刚好填满容器，则放大格子填满
  const availW = w - leftPad - rightPad;
  const availH = h - topPad - bottomPad;
  const fitW = availW / weekStarts.length;
  const fitH = availH / activeCats.length;
  const actualCellW = fitW > cellW + cellGap ? fitW - cellGap : cellW;
  const actualCellH = fitH > cellH + cellGap ? fitH - cellGap : cellH;

  // 绘制列标签（横排 月/日）
  ctx.fillStyle = '#8c7d6c';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  weekStarts.forEach((ws, i) => {
    const d = new Date(ws);
    const label = (d.getMonth() + 1) + '/' + d.getDate();
    const x = leftPad + i * (actualCellW + cellGap) + actualCellW / 2;
    if (x + actualCellW / 2 > w - rightPad) return;
    ctx.fillText(label, x, h - bottomPad + 4);
  });

  // 绘制格子
  activeCats.forEach((cat, ci) => {
    const catIdx = categories.indexOf(cat);
    const baseColor = catIdx >= 0 ? getCatColor(catIdx) : '#c4d4b0';

    weekStarts.forEach((ws, wi) => {
      const count = matrix[ci][wi];
      const x = leftPad + wi * (actualCellW + cellGap);
      const y = topPad + ci * (actualCellH + cellGap);
      if (x + actualCellW > w - rightPad) return;

      let fillColor;
      if (count === 0) {
        fillColor = '#f5f0e6';
      } else {
        const intensity = 0.15 + (count / maxCount) * 0.85;
        fillColor = interpolateColor('#f5f0e6', baseColor, intensity);
      }

      ctx.fillStyle = fillColor;
      ctx.beginPath();
      roundRect(ctx, x, y, actualCellW, actualCellH, 3);
      ctx.fill();
    });
  });

  // 存储格子的布局数据用于 hit test
  gridCanvas._gridLayout = { activeCats, weekStarts, matrix, leftPad, topPad, actualCellW, actualCellH, cellGap, rightPad };
}

/** 简单颜色插值 */
function interpolateColor(fromHex, toHex, t) {
  const from = hexToRgb(fromHex);
  const to = hexToRgb(toHex);
  const r = Math.round(from.r + (to.r - from.r) * t);
  const g = Math.round(from.g + (to.g - from.g) * t);
  const b = Math.round(from.b + (to.b - from.b) * t);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 };
}

/** Canvas 圆角矩形 */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 渲染网格图 */
function renderGridView() {
  const data = buildGridData();
  resizeGridCanvas(data);
  if (!data || data.weekStarts.length === 0) {
    const ctx = gridCanvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = gridCanvas.width / dpr;
    const h = gridCanvas.height / dpr;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#8c7d6c';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无足够数据', w / 2, h / 2);
    return;
  }
  drawGrid(data);
}

/* ===== 仪表盘 ===== */

/** 渲染仪表盘 */
function renderDashboardView() {
  dashboardContainer.innerHTML = '';
  if (comments.length === 0) {
    dashboardContainer.innerHTML = '<div style="padding:40px;text-align:center;color:#8c7d6c;font-size:13px;">还没有收藏评论</div>';
    return;
  }
  renderDashboardTopCats();
  renderDashboardEmerging();
  renderDashboardDormant();
  renderDashboardTrend();
}

/** 本月活跃领域 Top 3 */
function renderDashboardTopCats() {
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const thisMonth = comments.filter(c => c.savedAt >= monthStart && c.savedAt <= now && c.category !== '未分类');

  const catCounts = {};
  thisMonth.forEach(c => {
    catCounts[c.category] = (catCounts[c.category] || 0) + 1;
  });

  const sorted = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const maxCount = sorted.length > 0 ? sorted[0][1] : 1;

  const card = document.createElement('div');
  card.className = 'dashboard-card';

  const title = document.createElement('div');
  title.className = 'dashboard-card-title';
  title.textContent = '本月活跃领域';
  card.appendChild(title);

  if (sorted.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:#8c7d6c;';
    empty.textContent = '本月暂无新收藏';
    card.appendChild(empty);
    dashboardContainer.appendChild(card);
    return;
  }

  const catsRow = document.createElement('div');
  catsRow.className = 'dashboard-top-cats';

  sorted.forEach(([cat, count]) => {
    const item = document.createElement('div');
    item.className = 'dashboard-top-cat-item';

    const catIdx = categories.indexOf(cat);
    const color = getCatColor(catIdx >= 0 ? catIdx : 0);

    const nameEl = document.createElement('div');
    nameEl.className = 'dashboard-top-cat-name';
    nameEl.textContent = cat;

    const countEl = document.createElement('div');
    countEl.className = 'dashboard-top-cat-count';
    countEl.textContent = count + '条';

    const bar = document.createElement('div');
    bar.className = 'dashboard-top-cat-bar';
    const fill = document.createElement('div');
    fill.className = 'dashboard-top-cat-bar-fill';
    fill.style.width = Math.round(count / maxCount * 100) + '%';
    fill.style.background = color;
    bar.appendChild(fill);

    item.appendChild(nameEl);
    item.appendChild(countEl);
    item.appendChild(bar);
    catsRow.appendChild(item);
  });

  card.appendChild(catsRow);
  dashboardContainer.appendChild(card);
}

/** 新兴关注（14 天窗口，增长率最高） */
function renderDashboardEmerging() {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const recent14 = comments.filter(c => c.savedAt >= now - 14 * DAY && c.category !== '未分类');
  const prev14 = comments.filter(c => c.savedAt >= now - 28 * DAY && c.savedAt < now - 14 * DAY && c.category !== '未分类');

  const recentCounts = {};
  recent14.forEach(c => { recentCounts[c.category] = (recentCounts[c.category] || 0) + 1; });

  const prevCounts = {};
  prev14.forEach(c => { prevCounts[c.category] = (prevCounts[c.category] || 0) + 1; });

  // 找出增长率最高的分类（近期 ≥ 2 条，前期有基础但低于近期）
  const emerging = [];
  Object.keys(recentCounts).forEach(cat => {
    if (cat === '未分类') return;
    const recent = recentCounts[cat];
    const prev = prevCounts[cat] || 0;
    if (recent >= 2 && recent > prev) {
      const growth = prev > 0 ? Math.round((recent - prev) / prev * 100) : 100;
      emerging.push({ cat, recent, prev, growth });
    }
  });
  emerging.sort((a, b) => b.growth - a.growth);

  const card = document.createElement('div');
  card.className = 'dashboard-card';

  const title = document.createElement('div');
  title.className = 'dashboard-card-title';
  title.textContent = '新兴关注（14 天）';
  card.appendChild(title);

  if (emerging.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:#8c7d6c;';
    empty.textContent = '暂无显著增长的新兴领域';
    card.appendChild(empty);
    dashboardContainer.appendChild(card);
    return;
  }

  const top = emerging[0];
  const body = document.createElement('div');
  body.className = 'dashboard-emerging';
  body.innerHTML = '<span class="dashboard-emerging-cat">' + escapeHtml(top.cat) + '</span>'
    + ' 增长 <span class="dashboard-emerging-growth">+' + top.growth + '%</span>'
    + '（近 14 天 ' + top.recent + ' 条 vs 前 14 天 ' + top.prev + ' 条）';

  // 附该分类最近评论摘要
  const catComments = comments.filter(c => c.category === top.cat).slice(-2);
  if (catComments.length > 0) {
    const quotes = document.createElement('div');
    quotes.className = 'dashboard-emerging-quotes';
    quotes.textContent = catComments.map(c =>
      (c.author || '匿名') + '：' + c.text.slice(0, 50) + (c.text.length > 50 ? '...' : '')
    ).join('\n');
    body.appendChild(quotes);
  }

  card.appendChild(body);
  dashboardContainer.appendChild(card);
}

/** 沉寂领域（30 天+ 无新收藏） */
function renderDashboardDormant() {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const recent30 = new Set(comments.filter(c => c.savedAt >= now - 30 * DAY).map(c => c.category));

  const dormant = categories.filter(cat => cat !== '未分类' && !recent30.has(cat));

  const card = document.createElement('div');
  card.className = 'dashboard-card';

  const title = document.createElement('div');
  title.className = 'dashboard-card-title';
  title.textContent = '沉寂领域（30 天+）';
  card.appendChild(title);

  if (dormant.length === 0) {
    const none = document.createElement('div');
    none.className = 'dashboard-dormant-none';
    none.textContent = '所有领域都很活跃！';
    card.appendChild(none);
  } else {
    const body = document.createElement('div');
    body.className = 'dashboard-dormant';
    dormant.forEach(cat => {
      const tag = document.createElement('span');
      tag.className = 'dashboard-dormant-tag';
      tag.textContent = cat;
      body.appendChild(tag);
    });
    card.appendChild(body);
  }

  dashboardContainer.appendChild(card);
}

/** 收藏趋势（近 6 个月迷你柱状图） */
function renderDashboardTrend() {
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: m.getFullYear(), month: m.getMonth(), label: (m.getMonth() + 1) + '月' });
  }

  const monthlyCounts = months.map(m => {
    return comments.filter(c => {
      const d = new Date(c.savedAt);
      return d.getFullYear() === m.year && d.getMonth() === m.month;
    }).length;
  });

  const maxCount = Math.max(...monthlyCounts, 1);
  const total = monthlyCounts.reduce((a, b) => a + b, 0);

  const card = document.createElement('div');
  card.className = 'dashboard-card';

  const title = document.createElement('div');
  title.className = 'dashboard-card-title';
  title.textContent = '收藏趋势（近 6 个月）';
  card.appendChild(title);

  // 迷你柱状图
  const barsRow = document.createElement('div');
  barsRow.className = 'dashboard-trend';

  monthlyCounts.forEach((count, i) => {
    const bar = document.createElement('div');
    bar.className = 'dashboard-trend-bar';
    bar.style.height = Math.max(count / maxCount * 72, 3) + 'px';
    bar.title = months[i].label + ': ' + count + '条';
    barsRow.appendChild(bar);
  });

  card.appendChild(barsRow);

  // 月份标签
  const labelsRow = document.createElement('div');
  labelsRow.className = 'dashboard-trend-label';
  months.forEach(m => {
    const lbl = document.createElement('span');
    lbl.className = 'dashboard-trend-month';
    lbl.textContent = m.label;
    labelsRow.appendChild(lbl);
  });
  card.appendChild(labelsRow);

  // 总结
  const summary = document.createElement('div');
  summary.className = 'dashboard-trend-summary';
  const firstHalf = monthlyCounts.slice(0, 3).reduce((a, b) => a + b, 0);
  const secondHalf = monthlyCounts.slice(3, 6).reduce((a, b) => a + b, 0);
  let arrow = '→', cls = 'flat';
  if (secondHalf > firstHalf) { arrow = '↑'; cls = 'up'; }
  else if (secondHalf < firstHalf) { arrow = '↓'; cls = 'down'; }
  summary.innerHTML = '近 3 个月 ' + secondHalf + ' 条 '
    + '<span class="dashboard-trend-arrow ' + cls + '">' + arrow + '</span>'
    + ' 前 3 个月 ' + firstHalf + ' 条';
  card.appendChild(summary);

  dashboardContainer.appendChild(card);
}

/* ===== 配置加载 ===== */

/** 从 .env + apiconfig.json 加载配置 */
async function loadApiConfig() {
  try {
    // 读取 .env 解析密钥
    const envResp = await fetch('../.env');
    const envText = await envResp.text();
    const envVars = {};
    envText.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) return;
      envVars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    });

    // 读取 apiconfig.json 解析参数
    const jsonResp = await fetch('apiconfig.json');
    const jsonConfig = await jsonResp.json();

    const activeProvider = jsonConfig.activeProvider;
    const providerConfig = jsonConfig.providers[activeProvider];
    if (!providerConfig) {
      console.warn('apiconfig.json 中未找到 activeProvider: ' + activeProvider);
      return;
    }

    const apiKey = envVars[providerConfig.apiKeyRef] || '';
    if (!apiKey) {
      console.warn('.env 中未找到密钥: ' + providerConfig.apiKeyRef);
    }

    window.__apiConfig = {
      provider: activeProvider,
      apiKey,
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.model
    };
  } catch (e) {
    console.warn('API 配置加载失败: ' + e.message);
  }
}

/* ========== 图谱事件处理 ========== */

graphCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  const newScale = Math.min(3, Math.max(0.3, graphScale * delta));
  const rect = graphCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  graphOffsetX = mx - (mx - graphOffsetX) * (newScale / graphScale);
  graphOffsetY = my - (my - graphOffsetY) * (newScale / graphScale);
  graphScale = newScale;
  renderGraph();
});

graphCanvas.addEventListener('mousedown', (e) => {
  const pos = screenToGraph(e);
  const node = hitTestNode(pos.x, pos.y);
  if (node) {
    graphDraggingNode = node;
    graphSelectedNode = node;
    showGraphDetailPopup(node);
    renderGraph();
  } else {
    graphPanning = true;
    graphSelectedNode = null;
    graphDetailPopup.classList.add('hidden');
    renderGraph();
  }
  graphLastX = e.clientX;
  graphLastY = e.clientY;
});

graphCanvas.addEventListener('mousemove', (e) => {
  const pos = screenToGraph(e);
  if (graphDraggingNode) {
    graphDraggingNode.x = pos.x;
    graphDraggingNode.y = pos.y;
    renderGraph();
  } else if (graphPanning) {
    graphOffsetX += e.clientX - graphLastX;
    graphOffsetY += e.clientY - graphLastY;
    graphLastX = e.clientX;
    graphLastY = e.clientY;
    renderGraph();
  } else {
    const node = hitTestNode(pos.x, pos.y);
    if (node !== graphHoveredNode) {
      graphHoveredNode = node;
      if (node) {
        graphTooltip.textContent = node.label + ': ' + node.data.text.slice(0, 30) + '...';
        graphTooltip.classList.remove('hidden');
        const rect = graphCanvas.getBoundingClientRect();
        graphTooltip.style.left = (e.clientX - rect.left + 14) + 'px';
        graphTooltip.style.top = (e.clientY - rect.top - 14) + 'px';
      } else {
        graphTooltip.classList.add('hidden');
      }
      renderGraph();
    }
  }
});

document.addEventListener('mouseup', () => {
  graphDraggingNode = null;
  graphPanning = false;
});

graphDetailClose.addEventListener('click', () => {
  graphDetailPopup.classList.add('hidden');
  graphSelectedNode = null;
  renderGraph();
});

/* ========== 视图切换按钮事件 ========== */
document.querySelectorAll('.view-switch-btn').forEach(btn => {
  btn.addEventListener('click', () => switchGraphView(btn.dataset.view));
});

/* ========== 网格图 hover 事件 ========== */
gridCanvas.addEventListener('mousemove', (e) => {
  const layout = gridCanvas._gridLayout;
  if (!layout) return;
  const rect = gridCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const { activeCats, weekStarts, matrix, leftPad, topPad, actualCellW, actualCellH, cellGap } = layout;

  const wi = Math.floor((mx - leftPad) / (actualCellW + cellGap));
  const ci = Math.floor((my - topPad) / (actualCellH + cellGap));

  if (ci >= 0 && ci < activeCats.length && wi >= 0 && wi < weekStarts.length) {
    const count = matrix[ci][wi];
    const ws = new Date(weekStarts[wi]);
    const we = new Date(weekStarts[wi] + 6 * 24 * 60 * 60 * 1000);
    const fmt = d => (d.getMonth() + 1) + '/' + d.getDate();
    gridTooltip.textContent = activeCats[ci] + ' · ' + fmt(ws) + ' - ' + fmt(we) + ' · ' + count + '条';
    gridTooltip.classList.remove('hidden');
    gridTooltip.style.left = Math.min(mx + 12, rect.width - 150) + 'px';
    gridTooltip.style.top = Math.max(0, my - 30) + 'px';
  } else {
    gridTooltip.classList.add('hidden');
  }
});

gridCanvas.addEventListener('mouseleave', () => {
  gridTooltip.classList.add('hidden');
});

window.addEventListener('resize', () => {
  if (currentGraphView === 'graph') {
    if (graphNodes.length >= 3 && graphCanvas.style.display !== 'none') {
      resizeGraphCanvas();
      renderGraph();
    }
  } else if (currentGraphView === 'river') {
    renderRiverView();
  } else if (currentGraphView === 'grid') {
    renderGridView();
  }
});

/* ========== AI 总结按钮事件 ========== */
btnSummaryEdit.addEventListener('click', () => {
  if (currentCategory === '全部') return;
  if (summaryGenerating) return;
  if (summaryEditMode) {
    flushAutoSave();
    exitSummaryEdit();
  } else {
    enterSummaryEdit();
  }
});

btnSummaryAi.addEventListener('click', () => {
  if (currentCategory === '全部') return;
  if (summaryGenerating) return;
  if (summaryEditMode) {
    if (!confirm('AI 生成将覆盖当前编辑内容，确定继续？')) return;
  }
  aiGenerateSummary();
});

btnSummaryExport.addEventListener('click', () => {
  if (currentCategory === '全部') return;
  exportSummaryMd();
});

// 编辑区输入 → 自动保存
summaryEditor.addEventListener('input', () => {
  autoSaveSummary();
});

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

// 显示导入/导出结果弹窗
function showResultModal(title, body, onOk) {
  resultModalTitle.textContent = title;
  resultModalBody.textContent = body;
  resultModal.classList.remove('hidden');
  const okBtn = document.getElementById('btn-result-modal-ok');
  if (okBtn) {
    okBtn.focus();
    okBtn._onOk = onOk || null;
  }
}

// 关闭结果弹窗
function closeResultModal() {
  const okBtn = document.getElementById('btn-result-modal-ok');
  const onOk = okBtn ? okBtn._onOk : null;
  resultModal.classList.add('hidden');
  if (onOk && typeof onOk === 'function') {
    if (okBtn) okBtn._onOk = null;
    onOk();
  }
  // 若按钮已被 API 错误弹窗替换，恢复默认按钮
  if (!document.getElementById('btn-result-modal-ok')) {
    restoreResultModalButtons();
  }
}

// 结果弹窗 — 确定
btnResultModalOk.addEventListener('click', closeResultModal);

// 结果弹窗 — 点击遮罩关闭
resultModal.addEventListener('click', (e) => {
  if (e.target === resultModal) closeResultModal();
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

// 全局点击：关闭所有分类下拉面板
document.addEventListener('click', closeAllDropdowns);

// 全局 Esc：按优先级关闭弹窗：清空 > 评论删除 > 分类删除 > 导入结果 > API 配置 > 取消内联编辑
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
    if (!resultModal.classList.contains('hidden')) {
      closeResultModal();
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
