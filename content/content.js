/**
 * content.js - 内容脚本
 * 在小红书帖子的评论区注入选择框和「收藏」按钮，支持多选评论后批量收藏
 */

/* 类名前缀，避免与页面样式冲突 */
const PREFIX = 'xhs-cs';

/* 书签图标（空心） */
const BOOKMARK_ICON = `
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
</svg>`;

/* 书签图标（实心） */
const BOOKMARK_FILLED_ICON = `
<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2">
  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
</svg>`;

/* 选中图标（勾） */
const CHECK_ICON = `
<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
  <polyline points="20 6 9 17 4 12"/>
</svg>`;

/* 全局状态 */
let categories = [];
let savedCommentMap = new Map();   // commentId → 已收藏评论对象（按 XHS 评论 ID 索引）
let savedCommentTexts = new Set(); // 评论文本集合（fallback，commentId 不可用时使用）
let activePicker = null;

/* 多选状态 */
let selectedElements = new Set();  // 当前选中的评论 DOM 元素集合

/**
 * 尝试多种选择器查找评论区的最外层评论容器元素
 * 只返回最外层且包含作者信息的评论元素，排除容器和列表元素
 * @returns {Array} 评论容器元素列表
 */
function findCommentElements() {
  // 优先用更精确的选择器，逐步降级
  const selectors = [
    '[class*="comment-item"]:not([class*="list"]):not([class*="group"])',
    '[class*="CommentItem"]',
    '[class*="commentItem"]',
    '[class*="note-comment"]',
    '[class*="comment"]:not([class*="comment-list"]):not([class*="comments"])',
  ];

  // 先找到评论区外层容器（缩小查找范围）
  let parentContainer = document.body;
  const containerSelectors = [
    '[class*="comment-list"]', '[class*="comments-container"]',
    '[class*="note-comments"]', '[class*="Comments"]',
  ];
  for (const sel of containerSelectors) {
    const container = document.querySelector(sel);
    if (container && container.children.length >= 1) {
      parentContainer = container;
      break;
    }
  }

  for (const selector of selectors) {
    const allMatches = parentContainer.querySelectorAll(selector);
    if (allMatches.length === 0) continue;

    const outermost = Array.from(allMatches).filter(el => {
      if (el.hasAttribute(`data-${PREFIX}-processed`)) return false;

      // 排除过大元素（可能是列表容器）
      const childCount = el.querySelectorAll('*').length;
      if (childCount > 500) return false;

      // 必须是叶子评论块：不包含其他评论元素
      const hasNestedComment = Array.from(el.children).some(child => {
        return selectors.some(s => child.matches(s) || child.querySelector(s));
      });
      if (hasNestedComment) return false;

      // 必须有作者信息或合理的文本长度
      const hasAuthor = el.querySelector('[class*="author"], [class*="name"], [class*="nickname"], [class*="username"], a[href*="user"]');
      const textLen = el.textContent.trim().length;
      if (!hasAuthor && textLen < 10) return false;
      if (textLen > 5000) return false;

      return true;
    });

    if (outermost.length > 0) return outermost;
  }
  return [];
}

/**
 * 从评论元素中提取评论正文（排除作者名、IP 属地、时间、操作按钮等干扰文字）
 * @param {Element} el - 评论 DOM 元素
 * @returns {string}
 */
function extractCommentText(el) {
  // 1) 尝试找到评论正文的专属容器
  const bodySelectors = [
    '[class*="comment-content"]',
    '[class*="commentContent"]',
    '[class*="CommentContent"]',
    '[class*="comment-body"]',
    '[class*="commentBody"]',
  ];
  for (const sel of bodySelectors) {
    const body = el.querySelector(sel);
    if (body && body.textContent.trim().length >= 2) {
      return body.textContent.trim();
    }
  }

  // 2) 克隆节点后移除操作栏、作者信息等干扰元素，取剩余文本
  const clone = el.cloneNode(true);
  const removeSelectors = [
    '[class*="action"]', '[class*="footer"]', '[class*="bottom"]',
    '[class*="toolbar"]', '[class*="bar"]', '[class*="operation"]',
    '[class*="interact"]', '[class*="button-group"]',
    '[class*="author"]', '[class*="name"]', '[class*="nickname"]',
    '[class*="username"]', '[class*="user"]',
    '[class*="ip"]', '[class*="location"]', '[class*="time"]', '[class*="date"]',
    '[class*="avatar"]', 'img', 'svg', 'button',
  ];
  removeSelectors.forEach(sel => {
    clone.querySelectorAll(sel).forEach(child => child.remove());
  });
  return clone.textContent.trim();
}

/**
 * 提取评论作者昵称
 * @param {Element} commentEl
 * @returns {string}
 */
function extractAuthor(commentEl) {
  const authorEl = commentEl.querySelector('[class*="author"], [class*="name"], [class*="nickname"], [class*="username"], a[href*="user"]');
  if (authorEl) return authorEl.textContent.trim();
  const firstLink = commentEl.querySelector('a');
  if (firstLink) return firstLink.textContent.trim();
  return '未知用户';
}

/**
 * 从评论 DOM 元素中提取小红书的评论 ID
 * 评论 ID 是 24 位十六进制字符串，DOM 中可能存放在 data-id、id 或链接中
 * @param {Element} commentEl
 * @returns {string|null}
 */
function extractCommentId(commentEl) {
  // 1) 尝试 data 属性
  const dataId = commentEl.getAttribute('data-id') || commentEl.getAttribute('data-comment-id');
  if (dataId && /[a-f0-9]{15,}/i.test(dataId)) return dataId;

  // 2) 查找内部带 ID 的元素（XHS 评论 ID 特征：以 6a 开头，20+ 位 hex）
  const innerEls = commentEl.querySelectorAll('[id]');
  for (const el of innerEls) {
    if (/^[a-f0-9]{20,}$/i.test(el.id)) return el.id;
  }

  // 3) 查找 href 中包含 comment id 的链接
  const linkEl = commentEl.querySelector('a[href*="comment"]');
  if (linkEl) {
    const match = linkEl.href.match(/[a-f0-9]{20,}/i);
    if (match) return match[0];
  }

  return null;
}

/**
 * 提取帖子标题
 * @returns {string}
 */
function extractPostTitle() {
  const selectors = ['[class*="title"]', '[class*="note-title"]', 'h1', '[class*="post-title"]'];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return document.title || '未知帖子';
}

/**
 * 判断评论是否已收藏（按 XHS 评论 ID 匹配，回退到文本匹配）
 * @param {Element} commentEl
 * @returns {boolean}
 */
function isCommentSaved(commentEl) {
  const cid = extractCommentId(commentEl);
  if (cid && savedCommentMap.has(cid)) return true;
  // fallback：按文本查
  const text = extractCommentText(commentEl);
  return savedCommentTexts.has(text);
}

/**
 * 从评论元素中提取完整数据
 * @param {Element} commentEl
 * @returns {Object}
 */
function extractCommentData(commentEl) {
  return {
    commentId: extractCommentId(commentEl),
    text: extractCommentText(commentEl),
    author: extractAuthor(commentEl),
    postUrl: window.location.href,
    postTitle: extractPostTitle()
  };
}

/**
 * 更新选中计数提示和收藏按钮的状态
 */
function updateSelectionBadge() {
  // 底部浮动计数
  let badge = document.getElementById(`${PREFIX}-selection-badge`);
  if (selectedElements.size === 0) {
    if (badge) badge.remove();
  } else {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = `${PREFIX}-selection-badge`;
      badge.className = `${PREFIX}-selection-badge`;
      badge.addEventListener('click', clearSelection);
      document.body.appendChild(badge);
    }
    badge.textContent = `已选 ${selectedElements.size} 条 ✕`;
  }

  // 更新所有收藏按钮：有选中时变红并显示计数
  const count = selectedElements.size;
  document.querySelectorAll(`.${PREFIX}-btn`).forEach(btn => {
    if (count > 0) {
      btn.classList.add(`${PREFIX}-has-selection`);
      btn.setAttribute('data-count', count);
    } else {
      btn.classList.remove(`${PREFIX}-has-selection`);
    }
  });
}

/**
 * 清除所有选中
 */
function clearSelection() {
  selectedElements.forEach(el => {
    el.classList.remove(`${PREFIX}-selected`);
    const cb = el.querySelector(`.${PREFIX}-check`);
    if (cb) cb.classList.remove(`${PREFIX}-checked`);
  });
  selectedElements.clear();
  updateSelectionBadge();
}

/**
 * 创建选择框 DOM
 * @returns {HTMLElement}
 */
function createCheckbox() {
  const cb = document.createElement('span');
  cb.className = `${PREFIX}-check`;
  cb.innerHTML = CHECK_ICON;
  return cb;
}

/**
 * 创建收藏按钮 DOM
 * @param {boolean} saved
 * @returns {HTMLElement}
 */
function createSaveButton(saved) {
  const btn = document.createElement('button');
  btn.className = `${PREFIX}-btn`;
  btn.innerHTML = saved ? BOOKMARK_FILLED_ICON : BOOKMARK_ICON;
  btn.title = saved ? '已收藏' : '收藏评论';
  if (saved) btn.classList.add(`${PREFIX}-saved`);
  return btn;
}

/**
 * 在评论元素内查找底部操作栏
 * @param {Element} commentEl
 * @returns {Element|null}
 */
function findActionBar(commentEl) {
  const actionSelectors = [
    '[class*="action"]', '[class*="footer"]', '[class*="bottom"]',
    '[class*="toolbar"]', '[class*="bar"]', '[class*="operation"]',
    '[class*="interact"]', '[class*="button-group"]',
  ];
  for (const selector of actionSelectors) {
    const el = commentEl.querySelector(selector);
    if (el && el !== commentEl) {
      const interactive = el.querySelector('svg, img, button, [class*="icon"], [class*="btn"]');
      if (interactive) return el;
    }
  }
  return null;
}

/**
 * 创建分类选择浮窗（支持批量收藏）
 * @param {Array} commentsData - 待收藏的评论数据数组
 * @param {HTMLElement} anchorEl - 定位参考元素
 */
function createCategoryPicker(commentsData, anchorEl) {
  if (activePicker) activePicker.remove();

  const picker = document.createElement('div');
  picker.className = `${PREFIX}-picker`;

  // 标题：显示收藏数量
  const header = document.createElement('div');
  header.className = `${PREFIX}-picker-header`;
  header.textContent = commentsData.length > 1
    ? `收藏 ${commentsData.length} 条评论（含上下文）`
    : '选择收藏分类';
  picker.appendChild(header);

  // 分类列表
  const list = document.createElement('div');
  list.className = `${PREFIX}-picker-list`;

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = `${PREFIX}-picker-item`;
    item.textContent = cat;

    item.addEventListener('click', async () => {
      try {
        // 批量保存
        const response = await chrome.runtime.sendMessage({
          action: 'saveCommentGroup',
          data: {
            comments: commentsData.map(c => ({ ...c, category: cat }))
          }
        });
        if (response.success) {
          commentsData.forEach(c => {
            if (c.commentId) savedCommentMap.set(c.commentId, c);
            savedCommentTexts.add(c.text);
          });
          picker.remove();
          activePicker = null;
          clearSelection();
          refreshButtons();
          showToast(`已收藏 ${commentsData.length} 条评论`);
        } else {
          showToast('收藏失败: ' + response.error);
        }
      } catch (err) {
        showToast('收藏失败，请重试');
      }
    });

    list.appendChild(item);
  });
  picker.appendChild(list);

  // 底部新建分类
  const footer = document.createElement('div');
  footer.className = `${PREFIX}-picker-footer`;

  const input = document.createElement('input');
  input.className = `${PREFIX}-picker-input`;
  input.placeholder = '新建分类...';

  const addBtn = document.createElement('button');
  addBtn.className = `${PREFIX}-picker-add`;
  addBtn.textContent = '新建';

  const doAddCategory = async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'addCategory', name });
      if (response.success) {
        categories = response.data;
        input.value = '';
        picker.remove();
        activePicker = null;
        createCategoryPicker(commentsData, anchorEl);
        document.body.appendChild(activePicker);
        positionPicker(anchorEl);
      } else {
        showToast(response.error);
      }
    } catch (err) {
      showToast('新建分类失败');
    }
  };

  addBtn.addEventListener('click', doAddCategory);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAddCategory();
  });

  footer.appendChild(input);
  footer.appendChild(addBtn);
  picker.appendChild(footer);

  // 点击外部关闭
  picker.addEventListener('click', (e) => e.stopPropagation());
  const closeHandler = (e) => {
    if (!picker.contains(e.target)) {
      picker.remove();
      activePicker = null;
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);

  activePicker = picker;
  return picker;
}

/**
 * 定位选择器浮窗
 * @param {HTMLElement} anchorEl
 */
function positionPicker(anchorEl) {
  if (!activePicker) return;
  const rect = anchorEl.getBoundingClientRect();
  activePicker.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  activePicker.style.left = (rect.right + window.scrollX - 200) + 'px';
}

/**
 * 显示 Toast 提示
 * @param {string} msg
 */
function showToast(msg) {
  const existing = document.querySelector(`.${PREFIX}-toast`);
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `${PREFIX}-toast`;
  toast.textContent = msg;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add(`${PREFIX}-toast-show`), 10);
  setTimeout(() => {
    toast.classList.remove(`${PREFIX}-toast-show`);
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}

/**
 * 刷新所有收藏按钮的状态
 */
function refreshButtons() {
  document.querySelectorAll(`.${PREFIX}-btn`).forEach(btn => {
    const commentEl = btn.closest(`[data-${PREFIX}-processed]`);
    if (commentEl) {
      const saved = isCommentSaved(commentEl);
      btn.innerHTML = saved ? BOOKMARK_FILLED_ICON : BOOKMARK_ICON;
      btn.title = saved ? '已收藏' : '收藏评论';
      if (saved) {
        btn.classList.add(`${PREFIX}-saved`);
      } else {
        btn.classList.remove(`${PREFIX}-saved`);
      }
    }
  });
}

/**
 * 切换某条评论的选中状态
 * @param {Element} commentEl
 */
function toggleSelection(commentEl) {
  const cb = commentEl.querySelector(`.${PREFIX}-check`);
  if (selectedElements.has(commentEl)) {
    // 取消选中
    selectedElements.delete(commentEl);
    commentEl.classList.remove(`${PREFIX}-selected`);
    if (cb) cb.classList.remove(`${PREFIX}-checked`);
  } else {
    // 选中
    selectedElements.add(commentEl);
    commentEl.classList.add(`${PREFIX}-selected`);
    if (cb) cb.classList.add(`${PREFIX}-checked`);
  }
  updateSelectionBadge();
}

/**
 * 为评论元素注入选择框和收藏按钮
 * @param {Element} commentEl
 */
function injectControls(commentEl) {
  if (commentEl.querySelector(`.${PREFIX}-btn`)) return;

  const text = extractCommentText(commentEl);
  if (!text || text.length < 2) return;

  const saved = isCommentSaved(commentEl);

  // 创建选择框
  const checkbox = createCheckbox();
  checkbox.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSelection(commentEl);
  });

  // 创建收藏按钮
  const btn = createSaveButton(saved);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // 收集要收藏的评论数据：优先使用选中的，否则只收藏当前
    let targetElements;
    if (selectedElements.size > 0 && selectedElements.has(commentEl)) {
      targetElements = Array.from(selectedElements);
    } else {
      targetElements = [commentEl];
    }

    // 过滤掉已收藏的
    const newTargets = targetElements.filter(el => !isCommentSaved(el));
    if (newTargets.length === 0) {
      showToast('所选评论均已收藏');
      return;
    }

    const commentsData = newTargets.map(el => extractCommentData(el));
    const picker = createCategoryPicker(commentsData, btn);
    document.body.appendChild(picker);
    positionPicker(btn);
  });

  // 将选择框和收藏按钮插入操作栏
  const actionBar = findActionBar(commentEl);
  const target = actionBar || commentEl;
  target.appendChild(checkbox);
  target.appendChild(btn);
  commentEl.setAttribute(`data-${PREFIX}-processed`, 'true');
}

/**
 * 扫描并注入控件
 */
let scanTimer = null;

function scanAndInject() {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    const commentEls = findCommentElements();
    commentEls.forEach(el => injectControls(el));
  }, 100);
}

/**
 * 判断当前页面是否为帖子详情页（而非首页/列表页）
 * 小红书的帖子详情页 URL 通常包含 /explore/ 后面接 ID，或 /discovery/item/
 * @returns {boolean}
 */
function isDetailPage() {
  const url = window.location.href;
  // URL 特征：/explore/ 后跟具体帖子 ID（非首页的纯 /explore）
  if (/\/explore\/[a-f0-9]{10,}/i.test(url)) return true;
  if (/\/discovery\/item\//i.test(url)) return true;
  if (/\/detail\//i.test(url)) return true;
  return false;
}

/**
 * 初始化
 */
async function init() {
  // 只在帖子详情页生效，首页/列表页不注入
  if (!isDetailPage()) return;

  try {
    const catResp = await chrome.runtime.sendMessage({ action: 'getCategories' });
    if (catResp.success) categories = catResp.data;
    const commentResp = await chrome.runtime.sendMessage({ action: 'getComments' });
    if (commentResp.success) {
      savedCommentMap.clear();
      savedCommentTexts.clear();
      commentResp.data.forEach(c => {
        if (c.commentId) savedCommentMap.set(c.commentId, c);
        savedCommentTexts.add(c.text);
      });
    }
  } catch (err) {
    categories = ['干货', '好物', '攻略', '避雷', '其他'];
  }

  scanAndInject();

  const observer = new MutationObserver(() => scanAndInject());
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
