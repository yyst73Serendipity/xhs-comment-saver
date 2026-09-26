/**
 * 验证评论云同步的纯数据模型、旧数据迁移与冲突边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../storage/model.js';

const record = (data, extra = {}) => ({ data, revision: 1, deleted: false, conflicts: [], ...extra });

test('旧评论优先使用规范化 commentId 并合并重复记录', async () => {
  const space = await model.migrateLegacy([
    { id: 'old-a', commentId: ' ABC123 ', text: '同一条', category: '好物', savedAt: 2 },
    { id: 'old-b', commentId: 'abc123', text: '同一条', category: '好物', savedAt: 1 }
  ], ['未分类', '好物'], {});

  assert.deepEqual(Object.keys(space.remote.comments), ['comment-abc123']);
  assert.equal(space.remote.comments['comment-abc123'].data.legacyId, 'old-a');
});

test('缺少 commentId 时使用确定性的 SHA-256 标识', async () => {
  const source = { postUrl: 'https://www.xiaohongshu.com/explore/1?xsec_token=one', author: ' 甲 ', text: ' 内容 ' };
  const alternate = { postUrl: 'https://www.xiaohongshu.com/explore/1?xsec_token=two', author: '甲', text: '内容' };

  const first = await model.commentIdentity(source);
  assert.equal(first, await model.commentIdentity(alternate));
  assert.match(first, /^fallback-[a-f0-9]{64}$/);
});

test('fallback 标识保留 note_id 并忽略追踪参数', async () => {
  const base = { author: '甲', text: '相同正文' };
  const first = await model.commentIdentity({
    ...base,
    postUrl: 'https://www.xiaohongshu.com/explore/card?note_id=abc&xsec_token=one&source=web'
  });
  const samePost = await model.commentIdentity({
    ...base,
    postUrl: 'https://www.xiaohongshu.com/explore/card?xsec_token=two&note_id=abc'
  });
  const otherPost = await model.commentIdentity({
    ...base,
    postUrl: 'https://www.xiaohongshu.com/explore/card?note_id=def&xsec_token=one'
  });

  assert.equal(first, samePost);
  assert.notEqual(first, otherPost);
});

test('平台 commentId 会转义路径分隔符', async () => {
  const identity = await model.commentIdentity({ commentId: '../Other/Comment' });

  assert.equal(identity, 'comment-..%2fother%2fcomment');
  assert.equal(identity.includes('/'), false);
});

test('重复 fallback 标识只迁移最新评论', async () => {
  const comments = [
    { postUrl: 'https://www.xiaohongshu.com/explore/1', author: '甲', text: '内容', savedAt: 1 },
    { postUrl: 'https://www.xiaohongshu.com/explore/1#reply', author: '甲', text: '内容', savedAt: 3, note: '新笔记' }
  ];
  const space = await model.migrateLegacy(comments, ['未分类'], {});

  assert.equal(Object.keys(space.remote.comments).length, 1);
  assert.equal(Object.values(space.remote.comments)[0].data.note, '新笔记');
});

test('重复评论按字段合并并保留冲突笔记', async () => {
  const space = await model.migrateLegacy([
    {
      id: 'older', commentId: 'merge', text: '旧正文', note: '旧笔记', images: ['https://img/old'],
      audio: 'https://audio/old', category: '好物', key: 'old-key', savedAt: 1
    },
    {
      id: 'newer', commentId: 'merge', text: '新正文', note: '新笔记', images: [],
      audio: '', category: '', key: '', savedAt: 2
    }
  ], ['未分类', '好物'], {});
  const value = space.remote.comments['comment-merge'];

  assert.equal(value.data.text, '新正文');
  assert.equal(value.data.note, '新笔记');
  assert.deepEqual(value.data.images, ['https://img/old']);
  assert.equal(value.data.audio, 'https://audio/old');
  assert.equal(value.data.categoryId, 'good-things');
  assert.equal(value.data.key, 'old-key');
  assert.equal(value.conflicts[0].field, 'note');
  assert.equal(value.conflicts[0].local, '旧笔记');
});

test('多个同时间的不同旧笔记都不会在迁移中静默丢失', async () => {
  const space = await model.migrateLegacy([
    { commentId: 'notes', text: '正文', note: '版本一', savedAt: 1 },
    { commentId: 'notes', text: '正文', note: '版本二', savedAt: 1 },
    { commentId: 'notes', text: '正文', note: '版本三', savedAt: 1 }
  ], ['未分类'], {});
  const value = space.remote.comments['comment-notes'];

  assert.equal(value.data.note, '版本三');
  assert.deepEqual(value.conflicts.map(item => item.local).sort(), ['版本一', '版本二']);
});

test('默认分类 ID 固定且自定义分类使用 UUID', async () => {
  const space = await model.migrateLegacy([], ['未分类', '好物', '避雷', '搞笑', '学习'], {});

  assert.equal(space.remote.categories.uncategorized.data.name, '未分类');
  assert.equal(space.remote.categories['good-things'].data.name, '好物');
  assert.equal(space.remote.categories.warnings.data.name, '避雷');
  assert.equal(space.remote.categories.funny.data.name, '搞笑');
  const customId = Object.keys(space.remote.categories).find(id => space.remote.categories[id].data.name === '学习');
  assert.match(customId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('分类重命名不改评论关系且总结按 categoryId 跟随', async () => {
  let space = await model.migrateLegacy(
    [{ id: 'a', commentId: '1', text: '内容', category: '好物' }],
    ['未分类', '好物'],
    { 好物: { content: '总结', updatedAt: 9 } }
  );
  const categoryId = 'good-things';
  const commentId = 'comment-1';
  space = model.enqueueOperation(space, 'categories', categoryId, { name: '值得买' }, { id: 'rename' });

  assert.equal(model.visibleRecords(space).comments[commentId].data.categoryId, categoryId);
  assert.equal(model.visibleRecords(space).summaries[categoryId].data.content, '总结');
  assert.equal(model.project(space).comments[0].category, '值得买');
  assert.equal(model.project(space).summaries['值得买'].content, '总结');
});

test('迁移保留评论组、媒体与旧记录元数据', async () => {
  const space = await model.migrateLegacy([{
    id: 'legacy', commentId: '7', key: 'old-key', text: '正文', author: '作者', postTitle: '标题',
    postUrl: 'https://www.xiaohongshu.com/explore/7', images: ['https://img/1'], audio: 'https://audio/1',
    groupId: 'group', groupIndex: 2, savedAt: 8
  }], ['未分类'], {});

  assert.deepEqual(space.remote.comments['comment-7'].data.images, ['https://img/1']);
  assert.equal(space.remote.comments['comment-7'].data.audio, 'https://audio/1');
  assert.equal(space.remote.comments['comment-7'].data.groupId, 'group');
  assert.equal(space.remote.comments['comment-7'].data.groupIndex, 2);
  assert.equal(space.remote.comments['comment-7'].data.key, 'old-key');
  assert.equal(space.remote.comments['comment-7'].data.legacyKey, 'old-key');
  assert.equal(model.project(space).comments[0].key, 'old-key');
});

test('无效评论被忽略且不存在的分类归入未分类', async () => {
  const space = await model.migrateLegacy([
    null,
    {},
    { commentId: 'valid', text: '可用', category: '已删除分类' }
  ], ['未分类'], {});

  assert.deepEqual(Object.keys(space.remote.comments), ['comment-valid']);
  assert.equal(space.remote.comments['comment-valid'].data.categoryId, 'uncategorized');
});

test('超长旧记录被逐项隔离且迁移问题可预览', async () => {
  const sourceComments = [
    { commentId: 'valid', text: '正常评论', category: '未分类' },
    { commentId: 'too-long', text: '字'.repeat(100_001), category: '未分类' }
  ];
  const sourceSummaries = {
    未分类: { content: '字'.repeat(100_001) },
    好物: { content: '正常总结' }
  };
  const originalText = sourceComments[1].text;
  const space = await model.migrateLegacy(sourceComments, ['未分类', '好物'], sourceSummaries);

  assert.deepEqual(Object.keys(space.remote.comments), ['comment-valid']);
  assert.equal(space.remote.summaries['good-things'].data.content, '正常总结');
  assert.equal(space.migrationIssues.length, 2);
  assert.match(space.migrationIssues[0].reason, /不能超过 100000 个字符/);
  assert.equal(sourceComments[1].text, originalText);

  const preview = model.migrationPreview(space, model.emptyWorkspace());
  assert.equal(preview.rejected, 2);
  assert.deepEqual(preview.issues, space.migrationIssues);
});

test('不同字段并发修改按字段合并', () => {
  const remote = record({ note: '旧值', categoryId: 'warnings', text: '正文' }, { revision: 2 });
  const operation = {
    id: 'op', collection: 'comments', recordId: 'c', baseRevision: 1,
    patch: { note: '本地笔记' }, baseData: { note: '旧值', categoryId: 'uncategorized', text: '正文' }
  };

  const merged = model.mergeOperation(remote, operation);
  assert.equal(merged.data.note, '本地笔记');
  assert.equal(merged.data.categoryId, 'warnings');
});

test('并发私人笔记保留本地版本作为冲突', () => {
  const operation = {
    id: 'op', collection: 'comments', recordId: 'c', baseRevision: 1,
    patch: { note: '本地' }, baseData: { note: '旧值' }
  };
  const merged = model.mergeOperation(record({ note: '另一台设备' }, { revision: 2 }), operation);

  assert.equal(merged.data.note, '另一台设备');
  assert.equal(merged.conflicts[0].field, 'note');
  assert.equal(merged.conflicts[0].local, '本地');
});

test('并发 AI 总结保留本地版本作为冲突', () => {
  const operation = {
    id: 'summary-op', collection: 'summaries', recordId: 'good-things', baseRevision: 1,
    patch: { content: '本地总结' }, baseData: { content: '旧总结' }
  };
  const merged = model.mergeOperation(record({ content: '云端总结' }, { revision: 2 }), operation);

  assert.equal(merged.data.content, '云端总结');
  assert.equal(merged.conflicts[0].field, 'content');
  assert.equal(merged.conflicts[0].local, '本地总结');
});

test('并发清空笔记和总结会保留空字符串冲突版本', () => {
  const comment = model.mergeOperation(record({ note: '设备 B' }, { revision: 2 }), {
    id: 'clear-note', collection: 'comments', recordId: 'c', baseRevision: 1,
    patch: { note: '' }, baseData: { note: '旧值' }
  });
  const summary = model.mergeOperation(record({ content: '设备 B 总结' }, { revision: 2 }), {
    id: 'clear-summary', collection: 'summaries', recordId: 'good-things', baseRevision: 1,
    patch: { content: '' }, baseData: { content: '旧总结' }
  });

  assert.equal(comment.data.note, '设备 B');
  assert.equal(comment.conflicts[0].local, '');
  assert.equal(summary.data.content, '设备 B 总结');
  assert.equal(summary.conflicts[0].local, '');
});

test('访客清空总结会进入迁移预览并作为冲突版本上传', async () => {
  const guest = await model.migrateLegacy([], ['未分类', '好物'], { 好物: { content: '' } });
  const account = await model.migrateLegacy([], ['未分类', '好物'], { 好物: { content: '账号总结' } });

  assert.equal(model.migrationPreview(guest, account).summaryConflicts, 1);
  const merged = model.mergeGuest(guest, account);
  const operation = merged.pending.find(item => item.collection === 'summaries');
  const cloud = model.mergeOperation(account.remote.summaries['good-things'], operation);
  assert.equal(cloud.data.content, '账号总结');
  assert.equal(cloud.conflicts[0].local, '');
});

test('缺失 note 不产生清空冲突而明确空字符串会产生', async () => {
  const account = await model.migrateLegacy([
    { commentId: 'optional-note', text: '正文', note: '账号笔记' }
  ], ['未分类'], {});
  const missing = await model.migrateLegacy([
    { commentId: 'optional-note', text: '正文' }
  ], ['未分类'], {});
  const clearing = await model.migrateLegacy([
    { commentId: 'optional-note', text: '正文', note: '' }
  ], ['未分类'], {});

  assert.equal(Object.hasOwn(missing.remote.comments['comment-optional-note'].data, 'note'), false);
  assert.equal(model.project(missing).comments[0].note, '');
  assert.equal(model.migrationPreview(missing, account).noteConflicts, 0);
  assert.equal(model.mergeGuest(missing, account).pending.some(item => item.collection === 'comments'), false);

  assert.equal(Object.hasOwn(clearing.remote.comments['comment-optional-note'].data, 'note'), true);
  assert.equal(model.migrationPreview(clearing, account).noteConflicts, 1);
  const operation = model.mergeGuest(clearing, account).pending.find(item => item.collection === 'comments');
  assert.equal(model.mergeOperation(account.remote.comments['comment-optional-note'], operation).conflicts[0].local, '');
});

test('缺失 summary content 不产生清空冲突而明确空字符串会产生', async () => {
  const account = await model.migrateLegacy([], ['未分类', '好物'], { 好物: { content: '账号总结' } });
  const missing = await model.migrateLegacy([], ['未分类', '好物'], { 好物: { updatedAt: 1 } });
  const clearing = await model.migrateLegacy([], ['未分类', '好物'], { 好物: { content: '' } });

  assert.equal(Object.hasOwn(missing.remote.summaries['good-things'].data, 'content'), false);
  assert.equal(model.project(missing).summaries['好物'].content, '');
  assert.equal(model.migrationPreview(missing, account).summaryConflicts, 0);
  assert.equal(model.mergeGuest(missing, account).pending.some(item => item.collection === 'summaries'), false);

  assert.equal(Object.hasOwn(clearing.remote.summaries['good-things'].data, 'content'), true);
  assert.equal(model.migrationPreview(clearing, account).summaryConflicts, 1);
});

test('冲突文本截断到十万字符且最多保留五个版本', () => {
  let remote = record({ note: '云端' }, { revision: 2 });
  for (let index = 0; index < 7; index++) {
    remote = model.mergeOperation(remote, {
      id: `op-${index}`, collection: 'comments', recordId: 'c', baseRevision: 1,
      patch: { note: `${index}${'字'.repeat(100_010)}` }, baseData: { note: '旧值' }
    });
  }

  assert.equal(remote.conflicts.length, 5);
  assert.equal(remote.conflicts.at(-1).local.length, 100_000);
});

test('操作入口拒绝超过十万字符的笔记和总结', () => {
  assert.throws(
    () => model.enqueueOperation(model.emptyWorkspace(), 'comments', 'c', { note: '字'.repeat(100_001) }),
    /笔记不能超过 100000 个字符/
  );
  assert.throws(
    () => model.enqueueOperation(model.emptyWorkspace(), 'summaries', 'c', { content: '字'.repeat(100_001) }),
    /总结不能超过 100000 个字符/
  );
});

test('操作入口拒绝可能越过 Firestore 文档路径的记录 ID', () => {
  assert.throws(
    () => model.enqueueOperation(model.emptyWorkspace(), 'comments', '../other', { note: '内容' }),
    /记录 ID 无效/
  );
});

test('过期编辑不能恢复墓碑，显式重新收藏可以恢复', () => {
  const tombstone = record({}, { revision: 4, deleted: true });
  const edit = { id: 'edit', collection: 'comments', recordId: 'c', baseRevision: 2, patch: { note: '离线编辑' }, baseData: {} };
  const restore = { id: 'restore', collection: 'comments', recordId: 'c', baseRevision: 4, patch: { text: '恢复' }, baseData: {}, restore: true };

  assert.equal(model.mergeOperation(tombstone, edit).deleted, true);
  assert.equal(model.mergeOperation(tombstone, restore).deleted, false);
  assert.equal(model.mergeOperation(tombstone, restore).data.text, '恢复');
});

test('确认上传操作后保留后来排队的编辑', () => {
  let space = model.emptyWorkspace();
  space = model.enqueueOperation(space, 'comments', 'comment-1', { text: '第一版' }, { id: 'first' });
  space = model.enqueueOperation(space, 'comments', 'comment-1', { note: '第二版' }, { id: 'second' });
  space = model.acknowledge(space, 'first', record({ text: '第一版' }));

  assert.deepEqual(space.pending.map(item => item.id), ['second']);
  assert.equal(model.visibleRecords(space).comments['comment-1'].data.note, '第二版');
});

test('迁移预览统计评论、分类、总结、重复项与笔记冲突', async () => {
  const guest = await model.migrateLegacy([
    { commentId: '1', text: '一', note: '本地', category: '学习' },
    { commentId: '2', text: '二', category: '学习' }
  ], ['未分类', '学习'], { 学习: { content: '本地总结' } });
  const account = await model.migrateLegacy([
    { commentId: '1', text: '一', note: '云端', category: '学习' }
  ], ['未分类', '学习'], { 学习: { content: '云端总结' } });

  assert.deepEqual(model.migrationPreview(guest, account), {
    comments: 2,
    categories: 1,
    summaries: 1,
    duplicates: 1,
    additions: 1,
    noteConflicts: 1,
    summaryConflicts: 1,
    rejected: 0,
    issues: []
  });
});

test('访客合并把新增数据与冲突内容放入账号操作队列', async () => {
  const guest = await model.migrateLegacy([
    { commentId: '1', text: '一', note: '本地', category: '学习' },
    { commentId: '2', text: '二', category: '学习' }
  ], ['未分类', '学习'], { 学习: { content: '本地总结' } });
  const account = await model.migrateLegacy([
    { commentId: '1', text: '一', note: '云端', category: '学习' }
  ], ['未分类', '学习'], { 学习: { content: '云端总结' } });

  const result = model.mergeGuest(guest, account);
  const commentOps = result.pending.filter(item => item.collection === 'comments');
  assert.equal(commentOps.some(item => item.recordId === 'comment-2'), true);
  const noteOp = commentOps.find(item => item.recordId === 'comment-1');
  assert.equal(model.mergeOperation(account.remote.comments['comment-1'], noteOp).conflicts[0].local, '本地');
  const summaryOp = result.pending.find(item => item.collection === 'summaries');
  assert.equal(model.mergeOperation(account.remote.summaries[summaryOp.recordId], summaryOp).conflicts[0].local, '本地总结');
});

test('访客重复评论补齐账号空字段但不覆盖账号非空字段', async () => {
  const guest = await model.migrateLegacy([{
    commentId: 'shared', text: '访客正文', author: '访客作者', postTitle: '帖子标题',
    postUrl: 'https://www.xiaohongshu.com/explore/shared', images: ['https://img/guest'],
    audio: 'https://audio/guest', groupId: 'guest-group', groupIndex: 0, key: 'guest-key',
    category: '好物', note: '访客笔记'
  }], ['未分类', '好物'], {});
  const account = await model.migrateLegacy([{
    commentId: 'shared', text: '账号正文', author: '账号作者', images: [], audio: '',
    category: '未分类', note: '账号笔记'
  }], ['未分类', '好物'], {});
  account.remote.comments['comment-shared'].data.categoryId = '';

  const merged = model.mergeGuest(guest, account);
  const operation = merged.pending.find(item => item.collection === 'comments');
  const visible = model.visibleRecords(merged).comments['comment-shared'];
  const cloud = model.mergeOperation(account.remote.comments['comment-shared'], operation);

  assert.equal(operation.patch.text, undefined);
  assert.equal(operation.patch.author, undefined);
  assert.equal(visible.data.text, '账号正文');
  assert.equal(visible.data.author, '账号作者');
  assert.equal(visible.data.postTitle, '帖子标题');
  assert.equal(visible.data.postUrl, 'https://www.xiaohongshu.com/explore/shared');
  assert.deepEqual(visible.data.images, ['https://img/guest']);
  assert.equal(visible.data.audio, 'https://audio/guest');
  assert.equal(visible.data.groupId, 'guest-group');
  assert.equal(visible.data.groupIndex, 0);
  assert.equal(visible.data.key, 'guest-key');
  assert.equal(visible.data.categoryId, 'good-things');
  assert.equal(cloud.conflicts.some(item => item.field === 'note' && item.local === '访客笔记'), true);
});

test('缺失 savedAt 不写入零值且访客正时间可补齐账号', async () => {
  const account = await model.migrateLegacy([
    { commentId: 'saved-time', text: '正文' }
  ], ['未分类'], {});
  const guest = await model.migrateLegacy([
    { commentId: 'saved-time', text: '正文', savedAt: 123 }
  ], ['未分类'], {});

  assert.equal(Object.hasOwn(account.remote.comments['comment-saved-time'].data, 'savedAt'), false);
  assert.equal(model.project(account).comments[0].savedAt, undefined);
  account.remote.comments['comment-saved-time'].data.savedAt = 0;
  const merged = model.mergeGuest(guest, account);
  const operation = merged.pending.find(item => item.collection === 'comments');
  assert.equal(operation.patch.savedAt, 123);
  assert.equal(model.visibleRecords(merged).comments['comment-saved-time'].data.savedAt, 123);
});

test('分类合并优先稳定 ID 且不会把账号重命名改回旧名称', async () => {
  const guest = await model.migrateLegacy([
    { commentId: 'category', text: '正文', category: '好物' }
  ], ['未分类', '好物'], {});
  const account = await model.migrateLegacy([], ['未分类', '好物'], {});
  account.remote.categories['good-things'].data.name = '值得买';

  const merged = model.mergeGuest(guest, account);
  const categoryOperation = merged.pending.find(item => item.collection === 'categories' && item.recordId === 'good-things');
  const commentOperation = merged.pending.find(item => item.collection === 'comments');

  assert.equal(categoryOperation, undefined);
  assert.equal(commentOperation.patch.categoryId, 'good-things');
  assert.equal(model.visibleRecords(merged).categories['good-things'].data.name, '值得买');
});

test('重复旧笔记从预览到访客迁移确认后仍保留冲突', async () => {
  const guest = await model.migrateLegacy([
    { commentId: 'legacy-notes', text: '正文', note: '旧笔记', savedAt: 1 },
    { commentId: 'legacy-notes', text: '正文', note: '新笔记', savedAt: 2 }
  ], ['未分类'], {});
  const account = model.emptyWorkspace();

  assert.equal(model.migrationPreview(guest, account).noteConflicts, 1);
  let merged = model.mergeGuest(guest, account);
  const operation = merged.pending.find(item => item.collection === 'comments' && item.recordId === 'comment-legacy-notes');
  assert.equal(model.visibleRecords(merged).comments['comment-legacy-notes'].conflicts[0].local, '旧笔记');

  const cloudRecord = model.mergeOperation(undefined, operation);
  merged = model.acknowledge(merged, operation.id, cloudRecord);
  assert.equal(model.visibleRecords(merged).comments['comment-legacy-notes'].conflicts[0].local, '旧笔记');
});

test('导入操作携带的冲突仍受数量与文本边界限制', () => {
  const conflicts = Array.from({ length: 7 }, (_, index) => ({
    id: `legacy-${index}`,
    field: 'note',
    local: `${index}${'字'.repeat(100_010)}`
  }));
  const workspace = model.enqueueOperation(
    model.emptyWorkspace(),
    'comments',
    'comment-imported',
    { text: '正文', note: '当前笔记' },
    { conflicts }
  );

  const operation = workspace.pending[0];
  const record = model.mergeOperation(undefined, operation);
  assert.equal(record.conflicts.length, 5);
  assert.equal(record.conflicts.at(-1).local.length, 100_000);
});
