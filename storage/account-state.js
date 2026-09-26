/**
 * 管理访客与 Google 账号隔离的本地工作区，并把业务动作映射为版本化操作。
 */
import {
  COLLECTIONS,
  MAX_CONFLICT_TEXT_LENGTH,
  commentIdentity,
  emptyWorkspace,
  enqueueOperation,
  mergeGuest,
  mergeOperation,
  migrateLegacy,
  visibleRecords
} from './model.js';

const DEFAULT_CATEGORIES = [
  ['uncategorized', '未分类'],
  ['good-things', '好物'],
  ['warnings', '避雷'],
  ['funny', '搞笑']
];
const COMMENT_FIELDS = [
  'commentId', 'text', 'author', 'postUrl', 'postTitle', 'images', 'audio', 'groupId', 'groupIndex',
  'note', 'savedAt', 'key', 'legacyId', 'legacyKey'
];
const COMMENT_INPUT_FIELDS = new Set([...COMMENT_FIELDS, 'id', 'category']);
const COMMENT_STRING_FIELDS = [
  'commentId', 'key', 'text', 'author', 'postUrl', 'postTitle', 'groupId', 'note', 'legacyId', 'legacyKey'
];
const SUMMARY_FIELDS = new Set(['content', 'updatedAt', 'generatedBy', 'model', 'provider']);
const DANGEROUS_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);
// 这些边界要在 Firestore Rules 中使用相同或更严格的值，给文档元数据和规则开销留足余量。
export const SYNC_INPUT_LIMITS = Object.freeze({
  recordDataBytes: 700 * 1024,
  imagesPerComment: 100,
  mediaUrlBytes: 16 * 1024,
  commentStringBytes: Object.freeze({
    id: 16 * 1024,
    commentId: 512,
    key: 16 * 1024,
    text: 300 * 1024,
    author: 8 * 1024,
    postUrl: 16 * 1024,
    postTitle: 32 * 1024,
    groupId: 512,
    note: 300 * 1024,
    legacyId: 16 * 1024,
    legacyKey: 16 * 1024
  }),
  summaryStringBytes: Object.freeze({
    content: 300 * 1024,
    generatedBy: 256,
    model: 2 * 1024,
    provider: 256
  })
});
const ACTIONS = new Set([
  'saveComment', 'saveCommentGroup', 'deleteComment', 'updateNote', 'updateCategory', 'addCategory',
  'renameCategory', 'deleteCategory', 'reorderCategories', 'saveSummary', 'deleteSummary', 'importData',
  'clearAll', 'resolveConflict'
]);

const clone = value => structuredClone(value);
const utf8Bytes = value => new TextEncoder().encode(value).byteLength;

function requireUtf8Boundary(value, label, maximum) {
  if (utf8Bytes(value) > maximum) throw new Error(`${label}不能超过 ${maximum} 字节`);
}

function requireRecordBudget(value, label) {
  const bytes = utf8Bytes(JSON.stringify(value));
  if (bytes > SYNC_INPUT_LIMITS.recordDataBytes) {
    throw new Error(`${label}记录过大，不能超过 ${SYNC_INPUT_LIMITS.recordDataBytes} 字节`);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateSafeFields(value, allowed, label) {
  if (!isPlainObject(value)) throw new Error(`${label}格式无效`);
  for (const field of Object.keys(value)) {
    if (DANGEROUS_FIELDS.has(field) || !allowed.has(field)) throw new Error(`${label}字段 ${field} 不允许`);
  }
}

function mediaUrl(value, label, allowObject = false) {
  const raw = typeof value === 'string'
    ? value
    : allowObject && isPlainObject(value) && Object.keys(value).length === 1 && typeof value.url === 'string'
      ? value.url
      : null;
  if (raw === null) throw new Error(`${label}格式无效`);
  requireUtf8Boundary(raw, `${label} URL`, SYNC_INPUT_LIMITS.mediaUrlBytes);
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    throw new Error(`${label} URL 无效`);
  }
}

function validateSummary(value, label = '总结') {
  validateSafeFields(value, SUMMARY_FIELDS, label);
  if (Object.hasOwn(value, 'content') && value.content != null) {
    requireText(value.content, '总结');
    requireUtf8Boundary(value.content, '总结', SYNC_INPUT_LIMITS.summaryStringBytes.content);
  }
  if (Object.hasOwn(value, 'content') && value.content == null) throw new Error('总结内容格式无效');
  if (Object.hasOwn(value, 'updatedAt')
    && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) throw new Error('总结更新时间无效');
  for (const field of ['generatedBy', 'model', 'provider']) {
    if (Object.hasOwn(value, field) && typeof value[field] !== 'string') {
      throw new Error(`总结字段 ${field} 格式无效`);
    }
    if (Object.hasOwn(value, field)) {
      requireUtf8Boundary(value[field], `总结字段 ${field}`, SYNC_INPUT_LIMITS.summaryStringBytes[field]);
    }
  }
  requireRecordBudget(value, '总结');
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function baseWorkspace() {
  const workspace = emptyWorkspace();
  workspace.remote.categories.uncategorized = {
    data: { name: '未分类' }, revision: 0, deleted: false, conflicts: []
  };
  workspace.remote.settings.main = {
    data: { categoryOrder: ['uncategorized'] },
    revision: 0,
    deleted: false,
    conflicts: []
  };
  return workspace;
}

function activeEntry(workspace, collection, id) {
  const value = visibleRecords(workspace)[collection]?.[id];
  return value && !value.deleted ? value : null;
}

function categoryName(value) {
  if (typeof value !== 'string') throw new Error('分类名称格式无效');
  const name = value.trim();
  if (!name) throw new Error('分类名称不能为空');
  if (name.length > 40) throw new Error('分类名称不能超过 40 个字符');
  return name;
}

function categoryEntries(workspace) {
  return Object.entries(visibleRecords(workspace).categories).filter(([, value]) => !value.deleted);
}

function categoryIdByName(workspace, name) {
  return categoryEntries(workspace).find(([, value]) => value.data.name === name)?.[0] || null;
}

function requireCategory(workspace, name) {
  const normalized = categoryName(name);
  const id = categoryIdByName(workspace, normalized);
  if (!id) throw new Error('分类不存在');
  return { id, name: normalized };
}

function requireId(value, label = '记录 ID') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}无效`);
  return value.trim();
}

function requireText(value, label, maximum = MAX_CONFLICT_TEXT_LENGTH) {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  if (value.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符`);
  return value;
}

function commentPatch(comment, categoryId, extra = {}) {
  validateSafeFields(comment, COMMENT_INPUT_FIELDS, '评论');
  for (const field of COMMENT_STRING_FIELDS) {
    if (Object.hasOwn(comment, field) && comment[field] != null && typeof comment[field] !== 'string') {
      throw new Error(`评论字段 ${field} 必须是字符串`);
    }
    if (Object.hasOwn(comment, field) && comment[field] != null) {
      requireUtf8Boundary(comment[field], `评论字段 ${field}`, SYNC_INPUT_LIMITS.commentStringBytes[field]);
    }
  }
  if (Object.hasOwn(comment, 'category') && comment.category != null && typeof comment.category !== 'string') {
    throw new Error('评论字段 category 必须是字符串');
  }
  if (Object.hasOwn(comment, 'savedAt') && comment.savedAt != null
    && (!Number.isSafeInteger(comment.savedAt) || comment.savedAt < 0)) throw new Error('评论收藏时间无效');
  if (Object.hasOwn(comment, 'groupIndex') && comment.groupIndex != null
    && (!Number.isSafeInteger(comment.groupIndex) || comment.groupIndex < 0)) throw new Error('评论组序号无效');
  if (Object.hasOwn(comment, 'id') && comment.id != null
    && typeof comment.id !== 'string' && !(typeof comment.id === 'number' && Number.isSafeInteger(comment.id))) {
    throw new Error('评论旧标识格式无效');
  }
  if (typeof comment.id === 'string') {
    requireUtf8Boundary(comment.id, '评论字段 id', SYNC_INPUT_LIMITS.commentStringBytes.id);
  }
  if (Object.hasOwn(comment, 'images') && comment.images != null) {
    if (!Array.isArray(comment.images)) throw new Error('评论图片格式无效');
    if (comment.images.length > SYNC_INPUT_LIMITS.imagesPerComment) {
      throw new Error(`评论图片不能超过 ${SYNC_INPUT_LIMITS.imagesPerComment} 张`);
    }
    for (const image of comment.images) mediaUrl(image, '评论图片');
  }
  if (Object.hasOwn(comment, 'audio') && comment.audio != null) mediaUrl(comment.audio, '评论语音', true);
  const patch = {};
  for (const field of COMMENT_FIELDS) {
    if (Object.hasOwn(comment, field) && comment[field] != null) patch[field] = clone(comment[field]);
  }
  if (Object.hasOwn(patch, 'text')) requireText(patch.text, '评论正文');
  if (Object.hasOwn(patch, 'note')) requireText(patch.note, '笔记');
  const result = { ...patch, ...extra, categoryId, savedAt: patch.savedAt ?? Date.now() };
  requireRecordBudget(result, '评论');
  return result;
}

function materialize(workspace) {
  const result = clone(workspace);
  for (const operation of result.pending) {
    const previous = result.remote[operation.collection][operation.recordId];
    result.remote[operation.collection][operation.recordId] = mergeOperation(previous, operation);
  }
  result.pending = [];
  return result;
}

function replaceCurrent(state, workspace) {
  if (state.activeAccountUid === null) state.guest = workspace;
  else state.accounts[state.activeAccountUid].workspace = workspace;
}

function queue(state, collection, recordId, patch, options = {}) {
  if (!options.deleted && ['comments', 'summaries'].includes(collection)) {
    const current = visibleRecords(currentWorkspace(state))[collection]?.[recordId];
    requireRecordBudget({ ...(current?.data || {}), ...patch }, collection === 'comments' ? '评论' : '总结');
  }
  const next = enqueueOperation(currentWorkspace(state), collection, recordId, patch, options);
  replaceCurrent(state, state.activeAccountUid === null ? materialize(next) : next);
}

async function prepareComment(workspace, source, extra = {}) {
  if (!isPlainObject(source)) throw new Error('评论数据无效');
  const category = source.category == null ? '未分类' : categoryName(source.category);
  const categoryId = categoryIdByName(workspace, category);
  if (!categoryId) throw new Error('分类不存在');
  const patch = commentPatch(source, categoryId, extra);
  const id = await commentIdentity(source);
  const existing = visibleRecords(workspace).comments[id];
  return { id, patch, restore: existing?.deleted === true, active: !!existing && !existing.deleted };
}

async function saveOne(state, source, extra = {}) {
  const prepared = await prepareComment(currentWorkspace(state), source, extra);
  if (prepared.active) return prepared.id;
  queue(state, 'comments', prepared.id, prepared.patch, { restore: prepared.restore });
  return prepared.id;
}

function orderedCategoryIds(workspace) {
  const records = visibleRecords(workspace);
  const active = new Set(Object.entries(records.categories).filter(([, value]) => !value.deleted).map(([id]) => id));
  const configured = records.settings.main?.data.categoryOrder || [];
  return [...new Set(['uncategorized', ...configured, ...active])].filter(id => active.has(id));
}

async function importData(state, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('导入数据无效：文件结构错误');
  if (!Array.isArray(data.comments) || !Array.isArray(data.categories)
    || !data.summaries || typeof data.summaries !== 'object' || Array.isArray(data.summaries)) {
    throw new Error('导入数据无效：必须包含评论、分类和总结');
  }
  for (const name of data.categories) categoryName(typeof name === 'string' ? name : name?.name);
  for (const comment of data.comments) {
    try {
      commentPatch(comment, 'uncategorized');
      await commentIdentity(comment);
    } catch (error) {
      throw new Error(`导入数据无效：${error?.message || '评论无法识别'}`);
    }
  }
  for (const [name, summary] of Object.entries(data.summaries)) {
    categoryName(name);
    try {
      validateSummary(summary, '总结');
    } catch (error) {
      throw new Error(`导入数据无效：${error?.message || '总结格式错误'}`);
    }
  }
  const imported = await migrateLegacy(data.comments, data.categories, data.summaries);
  if (imported.migrationIssues.length) {
    throw new Error(`导入数据无效：${imported.migrationIssues[0].reason}`);
  }
  const merged = mergeGuest(imported, currentWorkspace(state));
  replaceCurrent(state, state.activeAccountUid === null ? materialize(merged) : merged);
}

/** 从旧版数据创建仅包含一个访客空间的 v2 状态。 */
export async function createState(comments = [], categories = DEFAULT_CATEGORIES.map(([, name]) => name), summaries = {}) {
  return {
    version: 2,
    activeAccountUid: null,
    guest: await migrateLegacy(comments, categories, summaries),
    accounts: Object.create(null)
  };
}

/** 切换当前账号；传入 null 时回到访客空间，绝不搬运任一工作区的数据。 */
export function activateAccount(state, user) {
  if (!state || state.version !== 2) throw new Error('本地状态格式无效');
  if (user == null) {
    state.activeAccountUid = null;
    return state.guest;
  }
  const uid = requireId(user.uid, '用户 UID');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error('用户 UID 无效');
  const email = user.email == null ? '' : String(user.email);
  if (!Object.hasOwn(state.accounts, uid)) {
    setOwn(state.accounts, uid, { uid, email, workspace: baseWorkspace() });
  } else {
    state.accounts[uid].email = email;
  }
  state.activeAccountUid = uid;
  return state.accounts[uid].workspace;
}

/** 返回当前访客或 Google 账号对应的独立工作区。 */
export function currentWorkspace(state) {
  if (!state || state.version !== 2) throw new Error('本地状态格式无效');
  if (state.activeAccountUid === null) return state.guest;
  const account = state.accounts?.[state.activeAccountUid];
  if (!account?.workspace) throw new Error('当前账号工作区不存在');
  return account.workspace;
}

/** 校验并执行一项业务动作，访客动作本地落盘，账号动作进入待上传队列。 */
export async function mutate(state, message) {
  if (!message || typeof message !== 'object' || !ACTIONS.has(message.action)) throw new Error('未知操作');
  let workspace = currentWorkspace(state);

  switch (message.action) {
    case 'saveComment':
      return saveOne(state, message.data);
    case 'saveCommentGroup': {
      const comments = message.data?.comments ?? message.comments;
      if (!Array.isArray(comments) || comments.length === 0) throw new Error('评论组数据无效');
      // 先验证整组数据，避免中途遇到无效评论时留下半组记录。
      const candidates = await Promise.all(comments.map(comment => prepareComment(workspace, comment)));
      const seen = new Set();
      const prepared = candidates.filter(item => {
        if (item.active || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
      if (!prepared.length) return [];
      const groupId = crypto.randomUUID();
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        queue(state, 'comments', item.id, { ...item.patch, groupId, groupIndex: index }, { restore: item.restore });
      }
      return prepared.map(item => item.id);
    }
    case 'deleteComment': {
      const id = requireId(message.id, '评论 ID');
      if (!activeEntry(workspace, 'comments', id)) throw new Error('评论不存在');
      queue(state, 'comments', id, {}, { deleted: true });
      return;
    }
    case 'updateNote': {
      const id = requireId(message.id, '评论 ID');
      if (!activeEntry(workspace, 'comments', id)) throw new Error('评论不存在');
      queue(state, 'comments', id, { note: requireText(message.note ?? '', '笔记') });
      return;
    }
    case 'updateCategory': {
      const id = requireId(message.id, '评论 ID');
      const comment = activeEntry(workspace, 'comments', id);
      if (!comment) throw new Error('评论不存在');
      const target = requireCategory(workspace, message.category);
      const groupId = comment.data.groupId;
      const ids = groupId
        ? Object.entries(visibleRecords(workspace).comments)
          .filter(([, value]) => !value.deleted && value.data.groupId === groupId).map(([recordId]) => recordId)
        : [id];
      for (const recordId of ids) queue(state, 'comments', recordId, { categoryId: target.id });
      return;
    }
    case 'addCategory': {
      const name = categoryName(message.name);
      if (categoryIdByName(workspace, name)) throw new Error('分类已存在');
      const id = crypto.randomUUID();
      queue(state, 'categories', id, { name, createdAt: Date.now(), updatedAt: Date.now() });
      workspace = currentWorkspace(state);
      queue(state, 'settings', 'main', { categoryOrder: orderedCategoryIds(workspace) });
      return id;
    }
    case 'renameCategory': {
      const source = requireCategory(workspace, message.oldName);
      if (source.id === 'uncategorized') throw new Error('「未分类」不可重命名');
      const name = categoryName(message.newName);
      const duplicate = categoryIdByName(workspace, name);
      if (duplicate && duplicate !== source.id) throw new Error('目标分类名已存在');
      queue(state, 'categories', source.id, { name, updatedAt: Date.now() });
      return;
    }
    case 'deleteCategory': {
      const source = requireCategory(workspace, message.name);
      if (source.id === 'uncategorized') throw new Error('「未分类」不可删除');
      const records = visibleRecords(workspace);
      for (const [id, comment] of Object.entries(records.comments)) {
        if (!comment.deleted && comment.data.categoryId === source.id) queue(state, 'comments', id, { categoryId: 'uncategorized' });
      }
      workspace = currentWorkspace(state);
      if (activeEntry(workspace, 'summaries', source.id)) queue(state, 'summaries', source.id, {}, { deleted: true });
      queue(state, 'categories', source.id, {}, { deleted: true });
      workspace = currentWorkspace(state);
      queue(state, 'settings', 'main', { categoryOrder: orderedCategoryIds(workspace) });
      return;
    }
    case 'reorderCategories': {
      if (!Array.isArray(message.categories)) throw new Error('分类顺序无效');
      const ids = message.categories.map(name => requireCategory(workspace, name).id);
      const active = orderedCategoryIds(workspace);
      if (new Set(ids).size !== ids.length || ids.length !== active.length || active.some(id => !ids.includes(id))) {
        throw new Error('分类顺序必须包含全部分类且不能重复');
      }
      queue(state, 'settings', 'main', { categoryOrder: ids });
      return;
    }
    case 'saveSummary': {
      const category = requireCategory(workspace, message.category);
      const metadata = message.data ?? {};
      validateSummary(metadata, '总结');
      const rawContent = Object.hasOwn(message, 'content') ? message.content : metadata.content;
      const content = requireText(rawContent, '总结');
      const patch = { content, updatedAt: Date.now() };
      for (const field of ['generatedBy', 'model', 'provider']) {
        if (typeof metadata[field] === 'string') patch[field] = metadata[field];
      }
      requireUtf8Boundary(content, '总结', SYNC_INPUT_LIMITS.summaryStringBytes.content);
      requireRecordBudget(patch, '总结');
      queue(state, 'summaries', category.id, patch, { restore: visibleRecords(workspace).summaries[category.id]?.deleted === true });
      return;
    }
    case 'deleteSummary': {
      const category = requireCategory(workspace, message.category);
      if (!activeEntry(workspace, 'summaries', category.id)) return;
      queue(state, 'summaries', category.id, {}, { deleted: true });
      return;
    }
    case 'importData':
      return importData(state, message.data);
    case 'clearAll': {
      const records = visibleRecords(workspace);
      for (const collection of ['comments', 'summaries']) {
        for (const [id, record] of Object.entries(records[collection])) {
          if (!record.deleted) queue(state, collection, id, {}, { deleted: true });
        }
      }
      for (const [id, record] of Object.entries(records.categories)) {
        if (id !== 'uncategorized' && !record.deleted) queue(state, 'categories', id, {}, { deleted: true });
      }
      queue(state, 'settings', 'main', { categoryOrder: ['uncategorized'] });
      return;
    }
    case 'resolveConflict': {
      const collection = message.collection;
      if (!COLLECTIONS.includes(collection)) throw new Error('冲突集合无效');
      const id = requireId(message.id ?? message.recordId);
      const record = activeEntry(workspace, collection, id);
      if (!record) throw new Error('冲突记录不存在');
      const conflictIds = message.conflictIds ?? (message.conflictId ? [message.conflictId] : []);
      if (!Array.isArray(conflictIds) || !conflictIds.length
        || conflictIds.some(conflictId => !record.conflicts.some(item => item.id === conflictId))) {
        throw new Error('冲突版本不存在');
      }
      const field = message.field;
      if (!(collection === 'comments' && field === 'note') && !(collection === 'summaries' && field === 'content')) {
        throw new Error('冲突字段无效');
      }
      queue(state, collection, id, { [field]: requireText(message.value, field === 'note' ? '笔记' : '总结') }, { resolveIds: conflictIds });
      return;
    }
  }
}
