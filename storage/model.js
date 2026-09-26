/**
 * 评论、分类和总结的版本化同步模型，负责迁移、冲突合并与旧界面投影。
 */
import { requireRecordBudget } from './sync-limits.js';

export const COLLECTIONS = ['comments', 'categories', 'summaries', 'settings'];
export const MAX_CONFLICT_TEXT_LENGTH = 100_000;
export const MAX_CONFLICTS = 5;
const MAX_RECORD_ID_BYTES = 512;

const DEFAULT_CATEGORY_IDS = new Map([
  ['未分类', 'uncategorized'],
  ['好物', 'good-things'],
  ['避雷', 'warnings'],
  ['搞笑', 'funny']
]);
const DEFAULT_CATEGORIES = [...DEFAULT_CATEGORY_IDS.keys()];
const ALLOWED_FIELDS = new Map([
  ['comments', new Set([
    'commentId', 'text', 'author', 'postUrl', 'postTitle', 'images', 'audio', 'groupId', 'groupIndex',
    'categoryId', 'note', 'savedAt', 'key', 'legacyId', 'legacyKey'
  ])],
  ['categories', new Set(['name', 'createdAt', 'updatedAt'])],
  ['summaries', new Set(['content', 'updatedAt', 'generatedBy', 'model', 'provider'])],
  ['settings', new Set(['categoryOrder', 'order'])]
]);
const COLLECTION_LABELS = new Map([
  ['comments', '评论'], ['categories', '分类'], ['summaries', '总结'], ['settings', '设置']
]);
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const clone = value => structuredClone(value);

function safeData(source = {}) {
  const target = Object.create(null);
  for (const [key, value] of Object.entries(source || {})) setOwn(target, key, clone(value));
  return target;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return newRecord({});
  const result = { ...record, data: safeData(record.data), conflicts: clone(record.conflicts || []) };
  requireRecordBudget(result, '同步');
  return result;
}

const newRecord = data => {
  const result = { data: safeData(data), revision: 0, deleted: false, conflicts: [] };
  requireRecordBudget(result, '同步');
  return result;
};

function safeRecordMap(source = {}) {
  const target = Object.create(null);
  for (const [key, value] of Object.entries(source)) setOwn(target, key, normalizeRecord(value));
  return target;
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function validatePatchFields(collection, patch) {
  const allowed = ALLOWED_FIELDS.get(collection);
  if (!allowed) throw new Error('同步集合无效');
  for (const field of Object.keys(patch || {})) {
    if (!allowed.has(field)) throw new Error(`${COLLECTION_LABELS.get(collection)}字段 ${field} 不允许同步`);
  }
}

function validateRecordId(recordId, label = '记录 ID') {
  if (typeof recordId !== 'string' || !/^(?!\.{1,2}$)[^/]+$/.test(recordId)) throw new Error('记录 ID 无效');
  if (new TextEncoder().encode(recordId).byteLength > MAX_RECORD_ID_BYTES) {
    const subject = label === '记录 ID' ? '记录 ID 过长' : `${label}过长`;
    throw new Error(`${subject}，UTF-8 编码后不能超过 ${MAX_RECORD_ID_BYTES} 字节`);
  }
  return recordId;
}

function normalizeConflicts(conflicts, data = {}) {
  const unique = [];
  for (const conflict of Array.isArray(conflicts) ? conflicts : []) {
    if (!conflict || !['note', 'content'].includes(conflict.field)) continue;
    if (typeof conflict.local !== 'string') continue;
    const local = conflict.local.slice(0, MAX_CONFLICT_TEXT_LENGTH);
    if (same(local, data[conflict.field])) continue;
    if (unique.some(item => item.field === conflict.field && item.local === local)) continue;
    unique.push({ id: conflict.id || crypto.randomUUID(), field: conflict.field, local });
  }
  return unique.slice(-MAX_CONFLICTS);
}

/** 创建不包含任何账号数据的同步工作区。 */
export function emptyWorkspace() {
  return {
    remote: {
      comments: Object.create(null),
      categories: Object.create(null),
      summaries: Object.create(null),
      settings: Object.create(null)
    },
    pending: [],
    cursors: { comments: null, categories: null, summaries: null, settings: null },
    lastSync: 0,
    migrationIssues: []
  };
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizePostUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    const noteId = url.searchParams.get('note_id');
    url.search = '';
    url.hash = '';
    // note_id 决定分享卡片对应的帖子；xsec_token、source 等参数只用于追踪或临时鉴权。
    if (noteId) url.searchParams.set('note_id', noteId);
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.trim().split(/[?#]/, 1)[0].replace(/\/$/, '');
  }
}

/** 根据平台评论编号或规范化内容生成跨设备稳定标识。 */
export async function commentIdentity(comment) {
  const platformId = String(comment?.commentId ?? '').trim().toLowerCase();
  if (platformId) {
    const safeId = encodeURIComponent(platformId).replace(/%[0-9A-F]{2}/g, value => value.toLowerCase());
    return validateRecordId(`comment-${safeId}`, '评论标识');
  }
  const hash = async (prefix, input) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return validateRecordId(
      `${prefix}-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`,
      '评论标识'
    );
  };
  const legacyKey = typeof comment?.key === 'string' ? comment.key.trim() : '';
  if (legacyKey) return hash('key', legacyKey);

  const postUrl = normalizePostUrl(comment?.postUrl);
  const author = normalizeText(comment?.author);
  const text = normalizeText(comment?.text);
  const mediaIdentity = value => {
    if (typeof value === 'string') return normalizeText(value);
    return value && typeof value.url === 'string' ? normalizeText(value.url) : '';
  };
  const images = Array.isArray(comment?.images) ? comment.images.map(mediaIdentity).filter(Boolean) : [];
  const audioValues = Array.isArray(comment?.audio) ? comment.audio : [comment?.audio];
  const audio = audioValues.map(mediaIdentity).filter(Boolean);
  if (postUrl && text) {
    // 文本评论不包含延迟加载的媒体，避免同一评论因图片或语音稍后出现而改变 ID。
    return hash('fallback', [postUrl, author, text].join('\u001f'));
  }
  if (postUrl && (images.length || audio.length)) {
    return hash('fallback', [postUrl, author, JSON.stringify(images), JSON.stringify(audio)].join('\u001f'));
  }

  const legacyId = typeof comment?.id === 'string' || typeof comment?.id === 'number'
    ? String(comment.id).trim()
    : '';
  if (legacyId) return hash('legacy', legacyId);
  throw new Error('评论缺少可用于去重的稳定标识');
}

function categoryName(value) {
  if (typeof value === 'string') return value.trim();
  return typeof value?.name === 'string' ? value.name.trim() : '';
}

function validLegacyComment(comment) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return false;
  return [comment.commentId, comment.key, comment.id, comment.text, comment.author, comment.postUrl, comment.audio]
    .some(value => String(value ?? '').trim())
    || Array.isArray(comment.images) && comment.images.length > 0;
}

function validateTextBoundary(collection, patch) {
  const checks = collection === 'comments'
    ? [['text', '评论正文'], ['note', '笔记']]
    : collection === 'summaries' ? [['content', '总结']] : [];
  for (const [field, label] of checks) {
    if (typeof patch?.[field] === 'string' && patch[field].length > MAX_CONFLICT_TEXT_LENGTH) {
      throw new Error(`${label}不能超过 ${MAX_CONFLICT_TEXT_LENGTH} 个字符`);
    }
  }
}

function legacyCommentData(source, categoryId) {
  const data = {
    commentId: source.commentId == null ? '' : String(source.commentId),
    text: typeof source.text === 'string' ? source.text : '',
    author: typeof source.author === 'string' ? source.author : '',
    postUrl: typeof source.postUrl === 'string' ? source.postUrl : '',
    postTitle: typeof source.postTitle === 'string' ? source.postTitle : '',
    images: Array.isArray(source.images) ? clone(source.images) : [],
    audio: source.audio ?? null,
    groupId: source.groupId ?? null,
    groupIndex: Number.isFinite(source.groupIndex) ? source.groupIndex : null,
    categoryId,
    ...(source.key == null ? {} : { key: source.key }),
    ...(source.id == null ? {} : { legacyId: source.id }),
    ...(source.key == null ? {} : { legacyKey: source.key })
  };
  if (Object.hasOwn(source, 'note') && typeof source.note === 'string') data.note = source.note;
  if (Number.isFinite(source.savedAt) && source.savedAt > 0) data.savedAt = source.savedAt;
  return data;
}

function hasMigrationValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && value !== undefined;
}

function mergeDuplicateComment(existing, incoming, recordId) {
  const incomingIsNewer = (incoming.data.savedAt || 0) >= (existing.data.savedAt || 0);
  const newer = incomingIsNewer ? incoming : existing;
  const older = incomingIsNewer ? existing : incoming;
  const data = {};
  for (const field of new Set([...Object.keys(older.data), ...Object.keys(newer.data)])) {
    if (field === 'note') {
      if (Object.hasOwn(newer.data, field)) data[field] = clone(newer.data[field]);
      else if (Object.hasOwn(older.data, field)) data[field] = clone(older.data[field]);
      continue;
    }
    data[field] = clone(hasMigrationValue(newer.data[field]) ? newer.data[field] : older.data[field]);
  }
  data.categoryId ||= 'uncategorized';

  const conflicts = [...(existing.conflicts || []), ...(incoming.conflicts || [])];
  const newerNote = newer.data.note;
  const olderNote = older.data.note;
  if (Object.hasOwn(newer.data, 'note') && Object.hasOwn(older.data, 'note')
    && typeof newerNote === 'string' && typeof olderNote === 'string' && newerNote !== olderNote) {
    const local = String(olderNote).slice(0, MAX_CONFLICT_TEXT_LENGTH);
    if (!conflicts.some(conflict => conflict.field === 'note' && conflict.local === local)) {
      conflicts.push({ id: `migration-${recordId}-${crypto.randomUUID()}`, field: 'note', local });
    }
  }
  return { ...newRecord(data), conflicts: conflicts.slice(-MAX_CONFLICTS) };
}

/** 把旧数组和分类名称转换成稳定 ID 的版本化工作区。 */
export async function migrateLegacy(comments = [], categories = DEFAULT_CATEGORIES, summaries = {}) {
  const workspace = emptyWorkspace();
  const suppliedNames = Array.isArray(categories) ? categories.map(categoryName).filter(Boolean) : [];
  const names = [...new Set(['未分类', ...suppliedNames])];
  const idsByName = new Map();

  for (const name of names) {
    const id = DEFAULT_CATEGORY_IDS.get(name) || crypto.randomUUID();
    idsByName.set(name, id);
    workspace.remote.categories[id] = newRecord({ name });
  }
  workspace.remote.settings.main = newRecord({ categoryOrder: names.map(name => idsByName.get(name)) });

  for (const source of Array.isArray(comments) ? comments : []) {
    if (!validLegacyComment(source)) continue;
    try {
      const sourceCategory = categoryName(source.category);
      const categoryId = sourceCategory ? idsByName.get(sourceCategory) || 'uncategorized' : '';
      const data = legacyCommentData(source, categoryId);
      validateTextBoundary('comments', data);
      const id = await commentIdentity(source);
      const incoming = newRecord(data);
      const existing = workspace.remote.comments[id];
      workspace.remote.comments[id] = existing
        ? mergeDuplicateComment(existing, incoming, id)
        : newRecord({ ...data, categoryId: data.categoryId || 'uncategorized' });
    } catch (error) {
      workspace.migrationIssues.push({
        type: 'comment',
        legacyId: source.id ?? source.commentId ?? null,
        reason: error?.message || '评论无法迁移'
      });
    }
  }

  if (summaries && typeof summaries === 'object' && !Array.isArray(summaries)) {
    for (const [name, legacySummary] of Object.entries(summaries)) {
      const id = idsByName.get(categoryName(name));
      if (!id || legacySummary == null) continue;
      try {
        const data = typeof legacySummary === 'string' ? { content: legacySummary } : clone(legacySummary);
        if (Object.hasOwn(data, 'content') && typeof data.content !== 'string') throw new Error('总结内容格式无效');
        validatePatchFields('summaries', data);
        validateTextBoundary('summaries', data);
        workspace.remote.summaries[id] = newRecord(data);
      } catch (error) {
        workspace.migrationIssues.push({
          type: 'summary',
          category: name,
          reason: error?.message || '分类总结无法迁移'
        });
      }
    }
  }
  return workspace;
}

/** 依次重放本地待上传操作，生成当前界面应看到的记录。 */
export function visibleRecords(workspace) {
  const snapshot = clone(workspace.remote);
  const records = Object.fromEntries(COLLECTIONS.map(collection => [collection, safeRecordMap(snapshot[collection])]));
  for (const operation of workspace.pending || []) {
    if (!COLLECTIONS.includes(operation.collection)) continue;
    const previous = records[operation.collection][operation.recordId] || newRecord({});
    const applied = applyVisibleOperation(previous, operation);
    if (applied !== previous) setOwn(records[operation.collection], operation.recordId, applied);
  }
  return records;
}

function applyVisibleOperation(previous, operation) {
  validatePatchFields(operation.collection, operation.patch);
  if (previous.deleted && !operation.restore && !operation.deleted) return previous;
  const unresolved = operation.resolveIds
    ? previous.conflicts.filter(conflict => !operation.resolveIds.includes(conflict.id))
    : previous.conflicts;
  const data = safeData(previous.data);
  for (const [field, value] of Object.entries(operation.patch || {})) setOwn(data, field, clone(value));
  const result = {
    ...previous,
    data,
    deleted: operation.deleted === true ? true : operation.restore ? false : previous.deleted,
    conflicts: normalizeConflicts([...unresolved, ...(operation.conflicts || [])], data)
  };
  requireRecordBudget(result, COLLECTION_LABELS.get(operation.collection));
  return result;
}

function orderedCategories(records) {
  const active = Object.entries(records.categories).filter(([, value]) => !value.deleted);
  const order = records.settings.main?.data.categoryOrder || [];
  active.sort(([left], [right]) => {
    if (left === 'uncategorized') return -1;
    if (right === 'uncategorized') return 1;
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
      - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
      || left.localeCompare(right);
  });
  return active;
}

/** 生成现有管理页可以直接读取的评论、分类和总结结构。 */
export function project(workspace) {
  const records = visibleRecords(workspace);
  const activeCategories = orderedCategories(records);
  const namesById = Object.create(null);
  for (const [id, value] of activeCategories) namesById[id] = value.data.name;
  const comments = Object.entries(records.comments)
    .filter(([, value]) => !value.deleted)
    .map(([id, value]) => ({
      id,
      ...clone(value.data),
      note: value.data.note ?? '',
      category: namesById[value.data.categoryId] || '未分类',
      noteConflicts: clone(value.conflicts || []).filter(conflict => conflict.field === 'note')
    }))
    .sort((left, right) => (right.savedAt || 0) - (left.savedAt || 0) || left.id.localeCompare(right.id));
  const projectedSummaries = Object.create(null);
  for (const [id, value] of Object.entries(records.summaries)) {
    if (value.deleted || !namesById[id]) continue;
    projectedSummaries[namesById[id]] = {
      content: '',
      ...clone(value.data),
      contentConflicts: clone(value.conflicts || []).filter(conflict => conflict.field === 'content')
    };
  }
  const names = activeCategories.map(([, value]) => value.data.name);
  return { comments, categories: [...new Set(['未分类', ...names])], summaries: projectedSummaries };
}

/** 创建带基准快照的不可变本地操作，供后续三方合并。 */
export function enqueueOperation(workspace, collection, recordId, patch, options = {}) {
  const current = visibleRecords(workspace)[collection]?.[recordId];
  const operation = createOperation(current, collection, recordId, patch, options);
  const next = clone(workspace);
  next.pending.push(operation);
  return next;
}

function createOperation(current, collection, recordId, patch, options = {}) {
  if (!COLLECTIONS.includes(collection)) throw new Error('同步集合无效');
  validateRecordId(recordId);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('修改内容无效');
  validatePatchFields(collection, patch);
  validateTextBoundary(collection, patch);
  const operation = {
    id: options.id || crypto.randomUUID(),
    collection,
    recordId,
    baseRevision: options.baseRevision ?? current?.revision ?? 0,
    patch: safeData(patch),
    baseData: safeData(options.baseData ?? current?.data ?? {}),
    deleted: options.deleted === true,
    restore: options.restore === true,
    ...(options.resolveIds ? { resolveIds: clone(options.resolveIds) } : {})
  };
  if (options.conflicts?.length) {
    const data = safeData(current?.data);
    for (const [field, value] of Object.entries(patch)) setOwn(data, field, clone(value));
    operation.conflicts = normalizeConflicts(options.conflicts, data);
  }
  // 同时验证本地可见结果和最终云端合并结果；后者可能新增并发冲突。
  applyVisibleOperation(current || newRecord({}), operation);
  mergeOperation(current, operation);
  return operation;
}

function workingRecords(workspace) {
  const records = Object.fromEntries(COLLECTIONS.map(collection => [collection, safeRecordMap(workspace.remote[collection])]));
  for (const operation of workspace.pending || []) {
    if (!COLLECTIONS.includes(operation.collection)) continue;
    const previous = records[operation.collection][operation.recordId] || newRecord({});
    const applied = applyVisibleOperation(previous, operation);
    if (applied !== previous) setOwn(records[operation.collection], operation.recordId, applied);
  }
  return records;
}

function appendOperation(workspace, records, collection, recordId, patch, options = {}) {
  const previous = records[collection][recordId];
  const operation = createOperation(previous, collection, recordId, patch, options);
  workspace.pending.push(operation);
  const applied = applyVisibleOperation(previous || newRecord({}), operation);
  if (applied !== previous) setOwn(records[collection], recordId, applied);
  return operation;
}

function conflictField(collection, field) {
  return collection === 'comments' && field === 'note'
    || collection === 'summaries' && field === 'content';
}

/** 合并单项离线操作，保护墓碑并保留笔记和总结的冲突版本。 */
export function mergeOperation(record, operation) {
  validatePatchFields(operation.collection, operation.patch);
  const previous = normalizeRecord(record || newRecord({}));
  if (previous.deleted && !operation.restore && !operation.deleted) return previous;

  const result = normalizeRecord(previous);
  result.revision = (previous.revision || 0) + 1;
  result.deleted = operation.deleted === true ? true : operation.restore ? false : previous.deleted;
  result.conflicts ||= [];
  if (operation.resolveIds) {
    result.conflicts = result.conflicts.filter(conflict => !operation.resolveIds.includes(conflict.id));
  }

  for (const [field, localValue] of Object.entries(operation.patch || {})) {
    const baseValue = operation.baseData?.[field];
    const remoteValue = previous.data?.[field];
    const concurrent = (previous.revision || 0) !== (operation.baseRevision || 0)
      && !same(remoteValue, baseValue)
      && !same(remoteValue, localValue);
    if (concurrent && conflictField(operation.collection, field) && !operation.restore) {
      if (!result.conflicts.some(conflict => conflict.id === operation.id && conflict.field === field)) {
        result.conflicts.push({
          id: operation.id,
          field,
          local: String(localValue ?? '').slice(0, MAX_CONFLICT_TEXT_LENGTH)
        });
        result.conflicts = result.conflicts.slice(-MAX_CONFLICTS);
      }
      continue;
    }
    setOwn(result.data, field, clone(localValue));
  }
  result.conflicts = normalizeConflicts([...result.conflicts, ...(operation.conflicts || [])], result.data);
  requireRecordBudget(result, COLLECTION_LABELS.get(operation.collection));
  return result;
}

/** 接收云端确认，同时保留上传期间产生的后续本地操作。 */
export function acknowledge(workspace, operationId, record) {
  const next = clone(workspace);
  const operation = next.pending.find(item => item.id === operationId);
  if (!operation) return next;
  const current = next.remote[operation.collection][operation.recordId];
  if (!current || (record.revision || 0) >= (current.revision || 0)) {
    setOwn(next.remote[operation.collection], operation.recordId, normalizeRecord(record));
  }
  next.pending = next.pending.filter(item => item.id !== operationId);
  return next;
}

function activeEntries(records, collection) {
  return Object.entries(records[collection]).filter(([, value]) => !value.deleted);
}

function categoryNamesById(records) {
  const names = Object.create(null);
  for (const [id, value] of activeEntries(records, 'categories')) names[id] = value.data.name;
  return names;
}

function hasMergeValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && value !== undefined;
}

function hasMergeFieldValue(field, value) {
  if (field === 'savedAt' || field === 'updatedAt') return Number.isFinite(value) && value > 0;
  return hasMergeValue(value);
}

/** 只读统计访客数据迁入账号后会新增、去重或产生冲突的数量。 */
export function migrationPreview(guest, account) {
  const local = visibleRecords(guest);
  const cloud = visibleRecords(account);
  const localComments = activeEntries(local, 'comments');
  const cloudComments = new Map(activeEntries(cloud, 'comments'));
  const localNames = categoryNamesById(local);
  const cloudSummariesByName = new Map(activeEntries(cloud, 'summaries').map(([id, value]) => [categoryNamesById(cloud)[id], value]));
  const localSummaries = activeEntries(local, 'summaries').filter(([id]) => localNames[id]);
  const duplicates = localComments.filter(([id]) => cloudComments.has(id));
  let noteConflicts = 0;
  for (const [id, value] of localComments) {
    const baseline = cloudComments.get(id)?.data.note ?? value.data.note;
    const alternatives = new Set(
      (value.conflicts || [])
        .filter(conflict => conflict.field === 'note' && typeof conflict.local === 'string' && conflict.local !== baseline)
        .map(conflict => conflict.local)
    );
    if (cloudComments.has(id) && typeof value.data.note === 'string' && value.data.note !== baseline) alternatives.add(value.data.note);
    noteConflicts += alternatives.size;
  }
  let summaryConflicts = 0;
  for (const [id, value] of localSummaries) {
    const direct = cloud.categories[id] && !cloud.categories[id].deleted
      && cloud.summaries[id] && !cloud.summaries[id].deleted
      ? cloud.summaries[id]
      : null;
    const cloudValue = direct || cloudSummariesByName.get(localNames[id]);
    const baseline = cloudValue?.data.content ?? value.data.content;
    const alternatives = new Set(
      (value.conflicts || [])
        .filter(conflict => conflict.field === 'content' && typeof conflict.local === 'string' && conflict.local !== baseline)
        .map(conflict => conflict.local)
    );
    if (cloudValue && typeof value.data.content === 'string' && value.data.content !== baseline) {
      alternatives.add(value.data.content);
    }
    summaryConflicts += alternatives.size;
  }
  return {
    comments: localComments.length,
    categories: activeEntries(local, 'categories').filter(([id]) => id !== 'uncategorized').length,
    summaries: localSummaries.length,
    duplicates: duplicates.length,
    additions: localComments.length - duplicates.length,
    noteConflicts,
    summaryConflicts,
    rejected: guest.migrationIssues?.length || 0,
    issues: clone(guest.migrationIssues || [])
  };
}

/** 把访客工作区转成账号待上传操作，不直接覆盖账号快照。 */
export function mergeGuest(guest, account) {
  const local = visibleRecords(guest);
  const result = clone(account);
  const current = workingRecords(result);
  const mapping = new Map([['uncategorized', 'uncategorized']]);
  const categoriesByName = new Map(activeEntries(current, 'categories').map(entry => [entry[1].data.name, entry]));

  for (const [id, category] of activeEntries(local, 'categories')) {
    if (id === 'uncategorized') continue;
    const sameId = current.categories[id] && !current.categories[id].deleted ? [id, current.categories[id]] : null;
    const existing = sameId || categoriesByName.get(category.data.name);
    const targetId = existing?.[0] || id;
    mapping.set(id, targetId);
    if (!existing) {
      appendOperation(result, current, 'categories', targetId, category.data, { restore: true });
      categoriesByName.set(category.data.name, [targetId, current.categories[targetId]]);
    }
  }

  for (const [id, comment] of activeEntries(local, 'comments')) {
    const existing = current.comments[id];
    const guestData = { ...comment.data, categoryId: mapping.get(comment.data.categoryId) || 'uncategorized' };
    if (!existing || existing.deleted) {
      appendOperation(result, current, 'comments', id, guestData, {
        restore: existing?.deleted === true,
        conflicts: comment.conflicts
      });
    } else {
      const patch = {};
      for (const [field, value] of Object.entries(guestData)) {
        if (field !== 'note' && hasMergeFieldValue(field, value) && !hasMergeFieldValue(field, existing.data[field])) {
          patch[field] = clone(value);
        }
      }
      if (Object.hasOwn(guestData, 'note') && guestData.note !== existing.data.note) patch.note = guestData.note;
      if (!Object.keys(patch).length && !comment.conflicts?.length) continue;
      appendOperation(result, current, 'comments', id, patch, {
        // 访客数据没有云端共同祖先，使用早于当前快照的版本让事务保留双方笔记。
        baseRevision: (existing.revision || 0) - 1,
        baseData: {},
        conflicts: comment.conflicts
      });
    }
  }

  const localCategoryNames = categoryNamesById(local);
  for (const [localCategoryId, summary] of activeEntries(local, 'summaries')) {
    const targetId = mapping.get(localCategoryId) || categoriesByName.get(localCategoryNames[localCategoryId])?.[0];
    if (!targetId) continue;
    const existing = current.summaries[targetId];
    if (!existing || existing.deleted) {
      appendOperation(result, current, 'summaries', targetId, summary.data, {
        restore: existing?.deleted === true,
        conflicts: summary.conflicts
      });
    } else {
      const patch = {};
      for (const [field, value] of Object.entries(summary.data)) {
        if (field !== 'content' && hasMergeFieldValue(field, value) && !hasMergeFieldValue(field, existing.data[field])) {
          patch[field] = clone(value);
        }
      }
      if (Object.hasOwn(summary.data, 'content') && summary.data.content !== existing.data.content) {
        patch.content = summary.data.content;
      }
      if (!Object.keys(patch).length && !summary.conflicts?.length) continue;
      appendOperation(result, current, 'summaries', targetId, patch, {
        // 访客总结与账号总结来自独立空间，应明确进入冲突解决流程。
        baseRevision: (existing.revision || 0) - 1,
        baseData: {},
        conflicts: summary.conflicts
      });
    }
  }

  const existingOrder = current.settings.main?.data.categoryOrder || ['uncategorized'];
  const guestOrder = (local.settings.main?.data.categoryOrder || []).map(id => mapping.get(id)).filter(Boolean);
  const categoryOrder = [...new Set([...existingOrder, ...guestOrder])];
  appendOperation(result, current, 'settings', 'main', { categoryOrder });
  return result;
}
