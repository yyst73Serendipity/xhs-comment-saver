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
let savedCommentKeys = new Set();  // 已收藏评论的组合键（url|author|text）
let savedCommentIds = new Set();   // 已收藏评论的 XHS commentId（优先匹配）
let activePicker = null;

/* 多选状态 */
let selectedElements = new Set();  // 当前选中的评论 DOM 元素集合

/**
 * 尝试多种选择器查找评论区的最外层评论元素
 * 返回叶子评论节点列表（每个节点代表一条独立评论）
 * @returns {Array} 评论容器元素列表
 */
function findCommentElements() {
  const selectors = [
    '[class*="comment-item"]',
    '[class*="CommentItem"]',
    '[class*="commentItem"]',
    '[class*="note-comment"]',
    '[class*="comment"]',
  ];

  // 先找评论区外层容器，缩小搜索范围
  let searchRoot = document.body;
  const zoneSelectors = [
    '[class*="comment-container"]', '[class*="comments-container"]',
    '[class*="comment-area"]', '[class*="CommentsContainer"]',
    '[class*="note-comments"]', '[id*="comment"]',
  ];
  for (const sel of zoneSelectors) {
    const zone = document.querySelector(sel);
    if (zone && zone.querySelectorAll(selectors[0]).length > 0) {
      searchRoot = zone;
      break;
    }
  }

  for (const selector of selectors) {
    const allMatches = searchRoot.querySelectorAll(selector);
    if (allMatches.length === 0) continue;

    const result = Array.from(allMatches).filter(el => {
      if (el.hasAttribute(`data-${PREFIX}-processed`)) return false;

      // 排除过大容器元素
      const childCount = el.querySelectorAll('*').length;
      if (childCount > 300) return false;

      // 排除含多个同选择器的容器
      const sameTagChildren = el.querySelectorAll(selector).length;
      if (sameTagChildren >= 2) return false;

      // 必须有合理文本长度（语音评论允许短文本）
      const textLen = el.textContent.trim().length;
      const hasAudio = el.querySelector('audio, [class*="voice"], [class*="audio"]');
      if ((textLen < 5 && !hasAudio) || textLen > 5000) return false;

      return true;
    });

    if (result.length > 0) return result;
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
    '[class*="avatar"]', 'img', 'svg', 'button', 'audio',
  ];
  removeSelectors.forEach(sel => {
    clone.querySelectorAll(sel).forEach(child => child.remove());
  });
  return clone.textContent.trim();
}

/**
 * 从评论元素中提取评论配图 URL 列表
 * 排除：头像、内联表情包（emoji/sticker）、过小的图
 * @param {Element} commentEl - 评论 DOM 元素
 * @returns {string[]}
 */
function extractCommentImages(commentEl) {
  const images = [];
  const imgElements = commentEl.querySelectorAll('img');
  const emojiRe = /emoji|sticker|expression|emotion|icon/i;
  for (const img of imgElements) {
    const imgCls = img.className || '';
    // 排除: img 自身 class 含 emoji/sticker 等表情关键词
    if (typeof imgCls === 'string' && emojiRe.test(imgCls)) continue;
    // 排除: 祖先元素 class 含 avatar / emoji / sticker 等关键词
    let parent = img.parentElement;
    let skip = false;
    while (parent && parent !== commentEl) {
      const cls = parent.className || '';
      if (typeof cls === 'string' && (/avatar/i.test(cls) || emojiRe.test(cls))) {
        skip = true;
        break;
      }
      parent = parent.parentElement;
    }
    if (skip) continue;
    // 排除过小的图（表情包通常 ≤ 60px）
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && h > 0 && (w < 60 || h < 60)) continue;
    // 取 src 属性
    const src = img.src || img.getAttribute('data-src') || '';
    if (src && /^https?:\/\//i.test(src)) {
      images.push(src);
    }
  }
  return images;
}

/**
 * 从评论元素中提取语音 URL
 * 查找 <audio> 标签，提取 src 属性
 * @param {Element} commentEl - 评论 DOM 元素
 * @returns {Object|null} { url } 或 null
 */
function extractCommentAudio(commentEl) {
  const audio = commentEl.querySelector('audio');
  if (!audio) return null;
  const src = audio.src || audio.getAttribute('data-src') || '';
  if (!src || !/^https?:\/\//i.test(src)) return null;
  return { url: src };
}

/**
 * 提取评论作者昵称
 * @param {Element} commentEl
 * @returns {string}
 */
function extractAuthor(commentEl) {
  const authorSelectors = [
    '.name .username',
    'a.name',
    '.username',
    '[class*="username"]',
    'a[href*="/user/profile/"]',
    '[class*="author"]',
    '[class*="name"]',
    '[class*="nickname"]',
    'a[href*="user"]',
  ];

  // 先在 commentEl 内找，再逐级向上到父级容器找
  let el = commentEl;
  for (let depth = 0; depth < 3 && el; depth++) {
    for (const sel of authorSelectors) {
      const authorEl = el.querySelector(sel);
      if (authorEl && authorEl.textContent.trim()) {
        return authorEl.textContent.trim();
      }
    }
    el = el.parentElement;
  }

  return '';
}

/**
 * 从评论 DOM 元素中提取小红书的评论 ID
 * 评论元素自身的 id 格式为 "comment-{24位hex}"，如 comment-6a2bd0f2000000002a03300b
 * 子元素上的 data-user-id 是用户 ID（同一用户所有评论共享），不能使用
 * @param {Element} commentEl
 * @returns {string|null} 纯 hex 评论 ID，或 null
 */
function extractCommentId(commentEl) {
  const m = commentEl.id && commentEl.id.match(/^comment-([a-f0-9]{20,})$/i);
  return m ? m[1] : null;
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
 * 规范化帖子 URL：去掉查询参数和哈希，保留干净的可访问链接
 * @param {string} url
 * @returns {string}
 */
function normalizePostUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/**
 * 生成评论的组合去重键（帖子URL + 作者 + 正文）
 * 用作已收藏评论的唯一标识，比纯文本匹配可靠
 * @param {string} postUrl
 * @param {string} author
 * @param {string} text
 * @returns {string}
 */
function makeCommentKey(postUrl, author, text) {
  return [normalizePostUrl(postUrl), author, text].map(s => (s || '').trim()).join('||');
}

/**
 * 判断评论是否已收藏
 * 优先按 XHS commentId 匹配，回退到组合键匹配
 * @param {Element} commentEl
 * @returns {boolean}
 */
function isCommentSaved(commentEl) {
  const text = extractCommentText(commentEl);
  // 文本太短无法可靠去重，保守地返回 false（避免误判为已收藏）
  if (!text || text.length < 3) return false;

  const cid = extractCommentId(commentEl);
  if (cid && savedCommentIds.has(cid)) return true;
  // 回退：按组合键匹配
  const key = makeCommentKey(normalizePostUrl(window.location.href), extractAuthor(commentEl), text);
  return savedCommentKeys.has(key);
}

/**
 * 从评论元素中提取完整数据
 * @param {Element} commentEl
 * @returns {Object}
 */
function extractCommentData(commentEl) {
  const author = extractAuthor(commentEl);
  const text = extractCommentText(commentEl);
  const postUrl = normalizePostUrl(window.location.href);
  return {
    commentId: extractCommentId(commentEl),
    text: text,
    author: author,
    postUrl: postUrl,
    postTitle: extractPostTitle(),
    key: makeCommentKey(postUrl, author, text),
    images: extractCommentImages(commentEl),
    audio: extractCommentAudio(commentEl)
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
  // 移除旧 picker 及其事件监听，防止重复保存
  if (activePicker) {
    const oldHandler = activePicker._closeHandler;
    if (oldHandler) document.removeEventListener('click', oldHandler);
    activePicker.remove();
    activePicker = null;
  }

  let saving = false; // 防并发保存

  const picker = document.createElement('div');
  picker.className = `${PREFIX}-picker`;

  // 标题：显示收藏数量，提示可点击外部自动归入未分类
  const header = document.createElement('div');
  header.className = `${PREFIX}-picker-header`;
  header.textContent = commentsData.length > 1
    ? `收下 ${commentsData.length} 条评论`
    : '选择分类，或点击外部自动归入「未分类」';
  picker.appendChild(header);

  // 分类列表
  const list = document.createElement('div');
  list.className = `${PREFIX}-picker-list`;

  categories.forEach(cat => {
    const item = document.createElement('div');
    item.className = `${PREFIX}-picker-item`;
    item.textContent = cat;

    item.addEventListener('click', async () => {
      if (saving) return;
      if (activePicker !== picker) return;
      saving = true;
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
            if (c.commentId) savedCommentIds.add(c.commentId);
            if (c.key) savedCommentKeys.add(c.key);
          });
          if (picker._closeHandler) {
            document.removeEventListener('click', picker._closeHandler);
          }
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
      saving = false;
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

  // 保存到未分类的通用函数
  const saveToDefault = async () => {
    if (saving) return;
    if (activePicker !== picker) return;
    saving = true;
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'saveCommentGroup',
        data: { comments: commentsData.map(c => ({ ...c, category: '未分类' })) }
      });
      if (response.success) {
        commentsData.forEach(c => {
          if (c.commentId) savedCommentIds.add(c.commentId);
          if (c.key) savedCommentKeys.add(c.key);
        });
        if (picker._closeHandler) {
          document.removeEventListener('click', picker._closeHandler);
        }
        picker.remove();
        activePicker = null;
        clearSelection();
        refreshButtons();
        showToast(`已收入囊中 ${commentsData.length} 条 → 未分类`);
      }
    } catch (err) {
      showToast('收藏失败，请重试');
    }
    saving = false;
  };

  // 点击外部 → 自动归入「未分类」
  picker.addEventListener('click', (e) => e.stopPropagation());
  const closeHandler = (e) => {
    if (!picker.contains(e.target)) {
      if (saving) return;
      if (activePicker !== picker) return;
      picker.remove();
      activePicker = null;
      document.removeEventListener('click', closeHandler);
      saveToDefault();
    }
  };
  picker._closeHandler = closeHandler;
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

  // 创建收藏按钮
  const btn = createSaveButton(saved);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    // 已收藏的评论不允许再次收藏
    if (isCommentSaved(commentEl)) {
      showToast('该评论已收藏');
      return;
    }

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

  // 已收藏的评论不显示选择框，未收藏的才显示
  const actionBar = findActionBar(commentEl);
  const target = actionBar || commentEl;

  if (!saved) {
    const checkbox = createCheckbox();
    checkbox.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSelection(commentEl);
    });
    target.appendChild(checkbox);
  }

  target.appendChild(btn);
  commentEl.setAttribute(`data-${PREFIX}-processed`, 'true');
}

/**
 * 扫描并注入控件
 */
let scanTimer = null;
let retryCount = 0;
const MAX_RETRIES = 10;

function scanAndInject() {
  // 非详情页不注入
  if (!isDetailPage()) return;
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    const commentEls = findCommentElements();
    if (commentEls.length > 0) {
      retryCount = 0;
      commentEls.forEach(el => injectControls(el));
    }
  }, 200);
}

/**
 * SPA URL 变化检测 + 注入启动
 */
let lastUrl = window.location.href;
let injectionActive = false;

async function checkUrlChange() {
  const currentUrl = window.location.href;
  if (currentUrl === lastUrl) return;
  lastUrl = currentUrl;
  if (isDetailPage()) {
    // SPA 导航时重新拉取分类，确保导入/新建的分类能及时出现
    try {
      const catResp = await chrome.runtime.sendMessage({ action: 'getCategories' });
      if (catResp.success) categories = catResp.data;
    } catch (err) { /* 保持旧分类 */ }
    if (!injectionActive) {
      console.log('[评论收藏] SPA 导航进入详情页，启动注入');
      startInjection();
    }
  } else {
    injectionActive = false;
  }
}

function startInjection() {
  injectionActive = true;
  scanAndInject();
  let attempts = 0;
  const retryInterval = setInterval(() => {
    if (!injectionActive || !isDetailPage()) { clearInterval(retryInterval); return; }
    const found = findCommentElements();
    if (found.length > 0) {
      found.forEach(el => injectControls(el));
      console.log('[评论收藏] 注入成功，找到', found.length, '条评论');
      clearInterval(retryInterval);
      return;
    }
    if (++attempts > 15) {
      clearInterval(retryInterval);
      console.warn('[评论收藏] 15 次重试后仍未找到评论，可能需要更新选择器');
    }
  }, 1000);
}

/**
 * 判断当前页面是否为帖子详情页
 */
function isDetailPage() {
  const url = window.location.href;
  if (/\/explore\/[a-f0-9]{8,}/i.test(url)) return true;
  if (/\/discovery\/item\//i.test(url)) return true;
  if (/\/detail\//i.test(url)) return true;
  if (/\/a\/[a-zA-Z0-9]{6,}/.test(url)) return true;
  if (/[?&]note_id=[a-f0-9]+/i.test(url)) return true;
  return false;
}

async function init() {
  // 加载数据（始终加载，SPA 导航随时可能进入详情页）
  try {
    const catResp = await chrome.runtime.sendMessage({ action: 'getCategories' });
    if (catResp.success) categories = catResp.data;
    const commentResp = await chrome.runtime.sendMessage({ action: 'getComments' });
    if (commentResp.success) {
      savedCommentIds.clear();
      savedCommentKeys.clear();
      commentResp.data.forEach(c => {
        if (c.commentId) savedCommentIds.add(c.commentId);
        if (c.key) {
          savedCommentKeys.add(c.key);
        } else {
          savedCommentKeys.add(makeCommentKey(c.postUrl, c.author, c.text));
        }
      });
    }
  } catch (err) {
    console.warn('[评论收藏] 加载数据失败:', err.message);
    categories = ['未分类', '好物', '避雷', '搞笑'];
  }

  console.log('[评论收藏] 已加载，', isDetailPage() ? '当前是详情页，立即注入' : '等待 SPA 导航到详情页...');

  if (isDetailPage()) startInjection();

  // DOM 变化监测
  const observer = new MutationObserver(() => { checkUrlChange(); scanAndInject(); });
  observer.observe(document.body, { childList: true, subtree: true });

  // SPA 路由变化监测
  window.addEventListener('popstate', () => setTimeout(checkUrlChange, 300));
  window.addEventListener('hashchange', () => setTimeout(checkUrlChange, 300));
  setInterval(checkUrlChange, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
