/**
 * 评论、分类和总结的版本化同步模型，负责迁移、冲突合并与旧界面投影。
 */
export const COLLECTIONS = ['comments', 'categories', 'summaries', 'settings'];
export const MAX_CONFLICT_TEXT_LENGTH = 100_000;
export const MAX_CONFLICTS = 5;

const DEFAULT_CATEGORY_IDS = new Map([
  ['未分类', 'uncategorized'],
  ['好物', 'good-things'],
  ['避雷', 'warnings'],
  ['搞笑', 'funny']
]);
const DEFAULT_CATEGORIES = [...DEFAULT_CATEGORY_IDS.keys()];
const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const newRecord = data => ({ data, revision: 0, deleted: false, conflicts: [] });
const clone = value => structuredClone(value);

/** 创建不包含任何账号数据的同步工作区。 */
export function emptyWorkspace() {
  return {
    remote: { comments: {}, categories: {}, summaries: {}, settings: {} },
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
    return `comment-${safeId}`;
  }
  const input = [normalizePostUrl(comment?.postUrl), normalizeText(comment?.author), normalizeText(comment?.text)].join('\u001f');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return `fallback-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function categoryName(value) {
  if (typeof value === 'string') return value.trim();
  return typeof value?.name === 'string' ? value.name.trim() : '';
}

function validLegacyComment(comment) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return false;
  return [comment.commentId, comment.text, comment.author, comment.postUrl].some(value => String(value ?? '').trim());
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
  return {
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
    note: typeof source.note === 'string' ? source.note : '',
    savedAt: Number.isFinite(source.savedAt) ? source.savedAt : 0,
    ...(source.key == null ? {} : { key: source.key }),
    ...(source.id == null ? {} : { legacyId: source.id }),
    ...(source.key == null ? {} : { legacyKey: source.key })
  };
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
    data[field] = clone(hasMigrationValue(newer.data[field]) ? newer.data[field] : older.data[field]);
  }
  data.categoryId ||= 'uncategorized';

  const conflicts = [...(existing.conflicts || []), ...(incoming.conflicts || [])];
  const newerNote = newer.data.note;
  const olderNote = older.data.note;
  if (hasMigrationValue(newerNote) && hasMigrationValue(olderNote) && newerNote !== olderNote) {
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
  const idsByName = {};

  for (const name of names) {
    const id = DEFAULT_CATEGORY_IDS.get(name) || crypto.randomUUID();
    idsByName[name] = id;
    workspace.remote.categories[id] = newRecord({ name });
  }
  workspace.remote.settings.main = newRecord({ categoryOrder: names.map(name => idsByName[name]) });

  for (const source of Array.isArray(comments) ? comments : []) {
    if (!validLegacyComment(source)) continue;
    try {
      const sourceCategory = categoryName(source.category);
      const categoryId = sourceCategory ? idsByName[sourceCategory] || 'uncategorized' : '';
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
      const id = idsByName[categoryName(name)];
      if (!id || legacySummary == null) continue;
      try {
        const data = typeof legacySummary === 'string' ? { content: legacySummary } : clone(legacySummary);
        if (typeof data.content !== 'string') data.content = '';
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
  const records = clone(workspace.remote);
  for (const operation of workspace.pending || []) {
    if (!COLLECTIONS.includes(operation.collection)) continue;
    const previous = records[operation.collection][operation.recordId] || newRecord({});
    if (previous.deleted && !operation.restore && !operation.deleted) continue;
    const conflicts = operation.resolveIds
      ? previous.conflicts.filter(conflict => !operation.resolveIds.includes(conflict.id))
      : previous.conflicts;
    records[operation.collection][operation.recordId] = {
      ...previous,
      data: { ...previous.data, ...clone(operation.patch) },
      deleted: operation.deleted === true ? true : operation.restore ? false : previous.deleted,
      conflicts
    };
  }
  return records;
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
  const namesById = Object.fromEntries(activeCategories.map(([id, value]) => [id, value.data.name]));
  const comments = Object.entries(records.comments)
    .filter(([, value]) => !value.deleted)
    .map(([id, value]) => ({
      id,
      ...clone(value.data),
      category: namesById[value.data.categoryId] || '未分类',
      noteConflicts: clone(value.conflicts || []).filter(conflict => conflict.field === 'note')
    }))
    .sort((left, right) => (right.savedAt || 0) - (left.savedAt || 0) || left.id.localeCompare(right.id));
  const projectedSummaries = {};
  for (const [id, value] of Object.entries(records.summaries)) {
    if (value.deleted || !namesById[id]) continue;
    projectedSummaries[namesById[id]] = {
      ...clone(value.data),
      contentConflicts: clone(value.conflicts || []).filter(conflict => conflict.field === 'content')
    };
  }
  const names = activeCategories.map(([, value]) => value.data.name);
  return { comments, categories: [...new Set(['未分类', ...names])], summaries: projectedSummaries };
}

/** 创建带基准快照的不可变本地操作，供后续三方合并。 */
export function enqueueOperation(workspace, collection, recordId, patch, options = {}) {
  if (!COLLECTIONS.includes(collection)) throw new Error('同步集合无效');
  if (typeof recordId !== 'string' || !/^(?!\.{1,2}$)[^/]{1,512}$/.test(recordId)) throw new Error('记录 ID 无效');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('修改内容无效');
  validateTextBoundary(collection, patch);
  const next = clone(workspace);
  const current = visibleRecords(workspace)[collection][recordId];
  next.pending.push({
    id: options.id || crypto.randomUUID(),
    collection,
    recordId,
    baseRevision: options.baseRevision ?? current?.revision ?? 0,
    patch: clone(patch),
    baseData: clone(options.baseData ?? current?.data ?? {}),
    deleted: options.deleted === true,
    restore: options.restore === true,
    ...(options.resolveIds ? { resolveIds: clone(options.resolveIds) } : {})
  });
  return next;
}

function conflictField(collection, field) {
  return collection === 'comments' && field === 'note'
    || collection === 'summaries' && field === 'content';
}

/** 合并单项离线操作，保护墓碑并保留笔记和总结的冲突版本。 */
export function mergeOperation(record, operation) {
  const previous = clone(record || newRecord({}));
  if (previous.deleted && !operation.restore && !operation.deleted) return previous;

  const result = clone(previous);
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
    result.data[field] = clone(localValue);
  }
  return result;
}

/** 接收云端确认，同时保留上传期间产生的后续本地操作。 */
export function acknowledge(workspace, operationId, record) {
  const next = clone(workspace);
  const operation = next.pending.find(item => item.id === operationId);
  if (!operation) return next;
  const current = next.remote[operation.collection][operation.recordId];
  if (!current || (record.revision || 0) >= (current.revision || 0)) {
    next.remote[operation.collection][operation.recordId] = clone(record);
  }
  next.pending = next.pending.filter(item => item.id !== operationId);
  return next;
}

function activeEntries(records, collection) {
  return Object.entries(records[collection]).filter(([, value]) => !value.deleted);
}

function categoryNamesById(records) {
  return Object.fromEntries(activeEntries(records, 'categories').map(([id, value]) => [id, value.data.name]));
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
  return {
    comments: localComments.length,
    categories: activeEntries(local, 'categories').filter(([id]) => id !== 'uncategorized').length,
    summaries: localSummaries.length,
    duplicates: duplicates.length,
    additions: localComments.length - duplicates.length,
    noteConflicts: duplicates.filter(([id, value]) => {
      const cloudNote = cloudComments.get(id).data.note;
      return value.data.note && cloudNote && value.data.note !== cloudNote;
    }).length,
    summaryConflicts: localSummaries.filter(([id, value]) => {
      const cloudValue = cloudSummariesByName.get(localNames[id]);
      return value.data.content && cloudValue?.data.content && value.data.content !== cloudValue.data.content;
    }).length,
    rejected: guest.migrationIssues?.length || 0,
    issues: clone(guest.migrationIssues || [])
  };
}

/** 把访客工作区转成账号待上传操作，不直接覆盖账号快照。 */
export function mergeGuest(guest, account) {
  const local = visibleRecords(guest);
  let result = clone(account);
  let current = visibleRecords(result);
  const mapping = { uncategorized: 'uncategorized' };

  for (const [id, category] of activeEntries(local, 'categories')) {
    if (id === 'uncategorized') continue;
    const existing = activeEntries(current, 'categories').find(([, value]) => value.data.name === category.data.name);
    const targetId = existing?.[0] || id;
    mapping[id] = targetId;
    if (!existing) result = enqueueOperation(result, 'categories', targetId, category.data, { restore: true });
  }

  current = visibleRecords(result);
  for (const [id, comment] of activeEntries(local, 'comments')) {
    const existing = current.comments[id];
    if (!existing || existing.deleted) {
      result = enqueueOperation(result, 'comments', id, {
        ...comment.data,
        categoryId: mapping[comment.data.categoryId] || 'uncategorized'
      }, { restore: existing?.deleted === true });
    } else if (comment.data.note && comment.data.note !== existing.data.note) {
      result = enqueueOperation(result, 'comments', id, { note: comment.data.note }, {
        // 访客数据没有云端共同祖先，使用早于当前快照的版本让事务保留双方笔记。
        baseRevision: (existing.revision || 0) - 1,
        baseData: { note: '' }
      });
    }
  }

  current = visibleRecords(result);
  const localCategoryNames = categoryNamesById(local);
  for (const [localCategoryId, summary] of activeEntries(local, 'summaries')) {
    const targetId = mapping[localCategoryId]
      || activeEntries(current, 'categories').find(([, value]) => value.data.name === localCategoryNames[localCategoryId])?.[0];
    if (!targetId) continue;
    const existing = current.summaries[targetId];
    if (!existing || existing.deleted) {
      result = enqueueOperation(result, 'summaries', targetId, summary.data, { restore: existing?.deleted === true });
    } else if (summary.data.content && summary.data.content !== existing.data.content) {
      result = enqueueOperation(result, 'summaries', targetId, { content: summary.data.content }, {
        // 访客总结与账号总结来自独立空间，应明确进入冲突解决流程。
        baseRevision: (existing.revision || 0) - 1,
        baseData: { content: '' }
      });
    }
  }

  current = visibleRecords(result);
  const existingOrder = current.settings.main?.data.categoryOrder || ['uncategorized'];
  const guestOrder = (local.settings.main?.data.categoryOrder || []).map(id => mapping[id]).filter(Boolean);
  const categoryOrder = [...new Set([...existingOrder, ...guestOrder])];
  return enqueueOperation(result, 'settings', 'main', { categoryOrder });
}
