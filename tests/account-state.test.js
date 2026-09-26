/**
 * 验证访客与 Google 账号的数据、队列和业务动作边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateAccount,
  createState,
  currentWorkspace,
  mutate
} from '../storage/account-state.js';
import { MAX_CONFLICT_TEXT_LENGTH, project, visibleRecords } from '../storage/model.js';

test('切换账号只切命名空间且不会搬运待上传修改', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a', email: 'a@example.com' });
  await mutate(state, { action: 'saveComment', data: { commentId: '1', text: 'A', category: '未分类' } });
  const accountA = currentWorkspace(state);

  activateAccount(state, { uid: 'b', email: 'b@example.com' });
  assert.equal(currentWorkspace(state).pending.length, 0);
  assert.notEqual(currentWorkspace(state), accountA);
  activateAccount(state, { uid: 'a', email: 'new-a@example.com' });
  assert.equal(currentWorkspace(state), accountA);
  assert.equal(currentWorkspace(state).pending.length, 1);
  assert.equal(state.accounts.a.email, 'new-a@example.com');
});

test('访客修改直接写入本地工作区且不创建云队列', async () => {
  const state = await createState([], ['未分类'], {});
  await mutate(state, { action: 'saveComment', data: { commentId: '1', text: '访客', category: '未分类' } });

  assert.equal(state.guest.pending.length, 0);
  assert.equal(project(state.guest).comments[0].text, '访客');
});

test('导入为登录账号排队评论、分类、总结和设置', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a' });
  await mutate(state, {
    action: 'importData',
    data: {
      comments: [{ id: 'x', commentId: '1', category: '好物' }],
      categories: ['未分类', '好物'],
      summaries: { 好物: { content: '总结' } }
    }
  });

  const kinds = new Set(currentWorkspace(state).pending.map(item => item.collection));
  assert.deepEqual(kinds, new Set(['comments', 'categories', 'summaries', 'settings']));
});

test('导入会在首次修改前完整校验输入', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a' });
  const before = structuredClone(currentWorkspace(state));

  await assert.rejects(() => mutate(state, {
    action: 'importData',
    data: {
      comments: [{ commentId: 'ok', text: '可用' }, { author: '缺少身份' }],
      categories: ['未分类'],
      summaries: {}
    }
  }), /导入数据无效/);
  assert.equal(JSON.stringify(currentWorkspace(state)), JSON.stringify(before));
});

test('评论、分类、总结与冲突动作均映射到版本化模型', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a' });
  await mutate(state, { action: 'addCategory', name: '  学习  ' });
  await mutate(state, { action: 'saveCommentGroup', data: { comments: [
    { commentId: '1', text: '一', category: '学习' },
    { commentId: '2', text: '二', category: '学习' }
  ] } });
  const comments = project(currentWorkspace(state)).comments;
  assert.equal(comments.length, 2);
  assert.equal(comments[0].groupId, comments[1].groupId);

  const firstId = comments[0].id;
  await mutate(state, { action: 'updateNote', id: firstId, note: '笔记' });
  await mutate(state, { action: 'updateCategory', id: firstId, category: '未分类' });
  await mutate(state, { action: 'saveSummary', category: '学习', content: '总结' });
  await mutate(state, { action: 'renameCategory', oldName: '学习', newName: '资料' });
  await mutate(state, { action: 'reorderCategories', categories: ['资料', '未分类'] });
  assert.equal(project(currentWorkspace(state)).comments.find(item => item.id === firstId).note, '笔记');
  assert.equal(project(currentWorkspace(state)).summaries['资料'].content, '总结');

  await mutate(state, { action: 'deleteSummary', category: '资料' });
  await mutate(state, { action: 'deleteComment', id: firstId });
  await mutate(state, { action: 'deleteCategory', name: '资料' });
  const projected = project(currentWorkspace(state));
  assert.equal(projected.comments.some(item => item.id === firstId), false);
  assert.equal(projected.categories.includes('资料'), false);
  assert.equal(projected.summaries['资料'], undefined);

  const records = visibleRecords(currentWorkspace(state));
  const remainingId = Object.keys(records.comments).find(id => !records.comments[id].deleted);
  records.comments[remainingId].conflicts = [{ id: 'conflict-1', field: 'note', local: '旧笔记' }];
  currentWorkspace(state).remote.comments[remainingId] = records.comments[remainingId];
  currentWorkspace(state).pending = [];
  await mutate(state, {
    action: 'resolveConflict', collection: 'comments', id: remainingId,
    conflictId: 'conflict-1', field: 'note', value: '采用版本'
  });
  assert.equal(visibleRecords(currentWorkspace(state)).comments[remainingId].data.note, '采用版本');
  assert.deepEqual(visibleRecords(currentWorkspace(state)).comments[remainingId].conflicts, []);

  await mutate(state, { action: 'clearAll' });
  assert.equal(project(currentWorkspace(state)).comments.length, 0);
  assert.deepEqual(project(currentWorkspace(state)).categories, ['未分类']);
});

test('业务动作在系统边界拒绝未知、越界和不存在的数据', async () => {
  const state = await createState([], ['未分类'], {});
  for (const [message, pattern] of [
    [{ action: 'unknown' }, /未知操作/],
    [{ action: 'addCategory', name: ' '.repeat(2) }, /分类名称不能为空/],
    [{ action: 'addCategory', name: 'x'.repeat(41) }, /40/],
    [{ action: 'updateNote', id: 'missing', note: 'a' }, /评论不存在/],
    [{ action: 'saveSummary', category: '不存在', content: 'a' }, /分类不存在/],
    [{ action: 'saveComment', data: { commentId: '1', note: 'x'.repeat(MAX_CONFLICT_TEXT_LENGTH + 1) } }, /笔记不能超过/]
  ]) {
    await assert.rejects(() => mutate(state, message), pattern);
  }
});

test('评论组会先校验全部记录再执行首次修改', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a' });
  await assert.rejects(() => mutate(state, {
    action: 'saveCommentGroup',
    data: { comments: [{ commentId: 'ok', text: '有效' }, { author: '缺少身份' }] }
  }), /缺少可用于去重的稳定标识/);

  assert.equal(currentWorkspace(state).pending.length, 0);
  assert.equal(project(currentWorkspace(state)).comments.length, 0);
});
