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
import { MAX_CONFLICT_TEXT_LENGTH, migrateLegacy, project, visibleRecords } from '../storage/model.js';
import { createLocalDispatcher, respondToLocalMessage } from '../background/local-dispatch.js';

function createMemoryStore(initialState) {
  let state = structuredClone(initialState);
  return {
    async read() {
      return structuredClone(state);
    },
    async update(callback) {
      const draft = structuredClone(state);
      const result = await callback(draft);
      state = draft;
      return result;
    }
  };
}

test('后台路由保持评论组和旧版消息返回结构', async () => {
  const store = createMemoryStore(await createState([], ['未分类', '学习'], {}));
  const dispatch = createLocalDispatcher(store);

  const saved = await dispatch({ action: 'saveCommentGroup', data: { comments: [
    { commentId: '1', text: '第一条', author: '甲', postUrl: 'https://www.xiaohongshu.com/explore/a', category: '学习' },
    { commentId: '2', text: '第二条', author: '乙', postUrl: 'https://www.xiaohongshu.com/explore/a', category: '学习' }
  ] } });
  assert.equal(saved.length, 2);
  assert.equal(saved[0].groupId, saved[1].groupId);

  const moved = await dispatch({ action: 'updateCategory', id: saved[0].id, category: '未分类' });
  assert.equal(moved.length, 2);
  assert.equal(moved.every(comment => comment.category === '未分类'), true);

  const comments = await dispatch({ action: 'getComments' });
  const first = comments.find(comment => comment.commentId === '1');
  assert.equal(typeof first.id, 'string');
  assert.equal(first.text, '第一条');
  assert.equal(first.category, '未分类');
  assert.equal(first.note, '');
  assert.equal(comments.some(comment => Object.hasOwn(comment, 'data')), false);
  assert.equal(comments.some(comment => Object.hasOwn(comment, 'revision')), false);
  assert.equal(comments.some(comment => Object.hasOwn(comment, 'deleted')), false);
});

test('后台删除分类后评论回到未分类并返回最新投影', async () => {
  const state = await createState([
    { commentId: '1', text: '待归类', category: '学习' }
  ], ['未分类', '学习'], { 学习: { content: '分类总结' } });
  const dispatch = createLocalDispatcher(createMemoryStore(state));

  const categories = await dispatch({ action: 'deleteCategory', name: '学习' });
  assert.deepEqual(categories, ['未分类']);
  assert.equal((await dispatch({ action: 'getComments' }))[0].category, '未分类');
  assert.deepEqual(Object.keys(await dispatch({ action: 'getSummaries' })), []);
});

test('后台写入成功响应不等待页面数据变更通知', async () => {
  let response;
  const neverSettles = new Promise(() => {});
  await respondToLocalMessage(
    async () => ({ id: 'saved' }),
    () => neverSettles,
    { action: 'saveComment' },
    value => { response = value; }
  );

  assert.deepEqual(response, { success: true, data: { id: 'saved' } });
});

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

  await mutate(state, { action: 'saveSummary', category: '未分类', content: '当前总结' });
  const summaryRecords = visibleRecords(currentWorkspace(state));
  summaryRecords.summaries.uncategorized.conflicts = [
    { id: 'summary-conflict', field: 'content', local: '另一份总结' }
  ];
  currentWorkspace(state).remote.summaries.uncategorized = summaryRecords.summaries.uncategorized;
  currentWorkspace(state).pending = [];
  await mutate(state, {
    action: 'resolveConflict', collection: 'summaries', category: '未分类',
    conflictId: 'summary-conflict', field: 'content', value: '采用另一份总结'
  });
  assert.equal(visibleRecords(currentWorkspace(state)).summaries.uncategorized.data.content, '采用另一份总结');
  assert.deepEqual(visibleRecords(currentWorkspace(state)).summaries.uncategorized.conflicts, []);

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

test('评论边界逐字段拒绝错误类型、无效媒体和危险字段', async () => {
  const invalidValues = [
    { commentId: 1 },
    { commentId: '1', key: [] },
    { commentId: '1', text: 1 },
    { commentId: '1', author: {} },
    { commentId: '1', postUrl: 1 },
    { commentId: '1', postTitle: false },
    { commentId: '1', groupId: 2 },
    { commentId: '1', note: [] },
    { commentId: '1', category: 3 },
    { commentId: '1', savedAt: Number.NaN },
    { commentId: '1', savedAt: -1 },
    { commentId: '1', groupIndex: 1.5 },
    { commentId: '1', images: [{ url: 'https://img.example/a.jpg' }] },
    { commentId: '1', images: ['javascript:alert(1)'] },
    { commentId: '1', audio: { url: 'file:///tmp/a.mp3' } },
    { commentId: '1', tags: ['未知字段'] },
    JSON.parse('{"commentId":"1","__proto__":{"polluted":true}}')
  ];

  for (const data of invalidValues) {
    const state = await createState([], ['未分类'], {});
    await assert.rejects(() => mutate(state, { action: 'saveComment', data }), /无效|格式|必须|不允许/);
    assert.equal(project(currentWorkspace(state)).comments.length, 0);
  }
});

test('导入总结要求安全普通对象并在完整预校验失败时保持零修改', async () => {
  const invalidSummaries = [
    { 学习: 1 },
    { 学习: [] },
    { 学习: { content: 1 } },
    { 学习: { content: '总结', updatedAt: -1 } },
    { 学习: { content: '总结', updatedAt: null } },
    { 学习: { content: '总结', generatedBy: [] } },
    { 学习: { content: '总结', generatedBy: null } },
    { 学习: JSON.parse('{"content":"总结","__proto__":{"polluted":true}}') }
  ];

  for (const summaries of invalidSummaries) {
    const state = await createState([], ['未分类'], {});
    activateAccount(state, { uid: 'a' });
    const before = JSON.stringify(currentWorkspace(state));
    await assert.rejects(() => mutate(state, {
      action: 'importData',
      data: { comments: [{ commentId: 'ok' }], categories: ['未分类', '学习'], summaries }
    }), /导入数据无效/);
    assert.equal(JSON.stringify(currentWorkspace(state)), before);
  }
});

test('评论组跳过已有活跃项和组内重复，只给新增与墓碑恢复项建立新组', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a' });
  const activeId = await mutate(state, { action: 'saveComment', data: { commentId: 'active', text: '旧评论' } });
  const deletedId = await mutate(state, { action: 'saveComment', data: { commentId: 'deleted', text: '待恢复' } });
  await mutate(state, { action: 'deleteComment', id: deletedId });
  const activeOperationsBefore = currentWorkspace(state).pending.filter(item => item.recordId === activeId).length;

  const added = await mutate(state, { action: 'saveCommentGroup', data: { comments: [
    { commentId: 'active', text: '不应改组' },
    { commentId: 'new', text: '新评论' },
    { commentId: 'new', text: '组内重复' },
    { commentId: 'deleted', text: '恢复评论' }
  ] } });

  assert.equal(added.length, 2);
  assert.equal(currentWorkspace(state).pending.filter(item => item.recordId === activeId).length, activeOperationsBefore);
  const comments = project(currentWorkspace(state)).comments;
  assert.equal(comments.find(item => item.id === activeId).groupId ?? null, null);
  const grouped = comments.filter(item => added.includes(item.id));
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].groupId, grouped[1].groupId);
  assert.deepEqual(grouped.map(item => item.groupIndex).sort(), [0, 1]);
});

test('超大评论和总结元数据会在入队前拒绝且保持账号状态不变', async () => {
  const invalidMessages = [
    { action: 'saveComment', data: { commentId: 'large-author', author: '作'.repeat(1_100_000) } },
    {
      action: 'saveComment',
      data: { commentId: 'many-images', images: Array.from({ length: 20_000 }, (_, index) => `https://img.example/${index}`) }
    },
    {
      action: 'saveComment',
      data: {
        commentId: 'large-record',
        images: Array.from({ length: 100 }, (_, index) => `https://img.example/${index}/${'a'.repeat(8_000)}`)
      }
    },
    {
      action: 'saveSummary', category: '未分类',
      data: { content: '总结', model: '型'.repeat(1_000), provider: 'test', generatedBy: 'ai' }
    }
  ];

  for (const message of invalidMessages) {
    const state = await createState([], ['未分类'], {});
    activateAccount(state, { uid: 'a' });
    const before = JSON.stringify(currentWorkspace(state));
    await assert.rejects(() => mutate(state, message), /不能超过|过大/);
    assert.equal(JSON.stringify(currentWorkspace(state)), before);
  }
});

test('重复收藏活跃评论直接返回标识且不覆盖历史字段或增加队列', async () => {
  const state = await createState([], ['未分类', '学习'], {});
  activateAccount(state, { uid: 'a' });
  await mutate(state, { action: 'addCategory', name: '学习' });
  const id = await mutate(state, {
    action: 'saveComment',
    data: { commentId: 'same', text: '原正文', note: '原笔记', category: '学习', savedAt: 10 }
  });
  const before = JSON.stringify(currentWorkspace(state));
  const duplicateId = await mutate(state, {
    action: 'saveComment',
    data: { commentId: 'same', text: '新正文', note: '新笔记', category: '未分类', savedAt: 20 }
  });

  assert.equal(duplicateId, id);
  assert.equal(JSON.stringify(currentWorkspace(state)), before);
  const saved = project(currentWorkspace(state)).comments.find(comment => comment.id === id);
  assert.equal(saved.text, '原正文');
  assert.equal(saved.note, '原笔记');
  assert.equal(saved.category, '学习');
  assert.equal(saved.savedAt, 10);
});

test('导入两边单独合法但合并后超预算时保持账号状态不变', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a' });
  await mutate(state, {
    action: 'saveComment',
    data: {
      commentId: 'combined-budget',
      text: 't'.repeat(100_000),
      note: 'n'.repeat(100_000),
      author: 'a'.repeat(8_000),
      postTitle: 'p'.repeat(32_000),
      key: 'k'.repeat(16_000),
      images: Array.from({ length: 100 }, (_, index) => `https://img.example/${index}/${'x'.repeat(2_500)}`)
    }
  });
  const before = JSON.stringify(currentWorkspace(state));

  await assert.rejects(() => mutate(state, {
    action: 'importData',
    data: {
      comments: [{ commentId: 'combined-budget', note: '字'.repeat(100_000) }],
      categories: ['未分类'],
      summaries: {}
    }
  }), /记录过大/);
  assert.equal(JSON.stringify(currentWorkspace(state)), before);
});

test('批量收藏五百条评论只克隆一次完整工作区', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a' });
  const comments = Array.from({ length: 500 }, (_, index) => ({ commentId: `batch-${index}`, text: `评论 ${index}` }));
  const originalStructuredClone = globalThis.structuredClone;
  let workspaceCloneCount = 0;
  globalThis.structuredClone = value => {
    if (value?.remote && Array.isArray(value.pending) && value.cursors) workspaceCloneCount += 1;
    return originalStructuredClone(value);
  };
  const startedAt = performance.now();
  try {
    await mutate(state, { action: 'saveCommentGroup', data: { comments } });
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }

  assert.equal(workspaceCloneCount, 1);
  assert.equal(currentWorkspace(state).pending.filter(item => item.collection === 'comments').length, 500);
  assert.equal(performance.now() - startedAt < 5_000, true);
});

test('清空两千条评论使用一次完整克隆并生成线性墓碑队列', async () => {
  const comments = Array.from({ length: 2_000 }, (_, index) => ({ commentId: `clear-${index}`, text: `评论 ${index}` }));
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a' });
  state.accounts.a.workspace = await migrateLegacy(comments, ['未分类'], {});
  const originalStructuredClone = globalThis.structuredClone;
  let workspaceCloneCount = 0;
  globalThis.structuredClone = value => {
    if (value?.remote && Array.isArray(value.pending) && value.cursors) workspaceCloneCount += 1;
    return originalStructuredClone(value);
  };
  const startedAt = performance.now();
  try {
    await mutate(state, { action: 'clearAll' });
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }

  assert.equal(workspaceCloneCount, 1);
  assert.equal(currentWorkspace(state).pending.filter(item => item.collection === 'comments').length, 2_000);
  assert.equal(performance.now() - startedAt < 5_000, true);
});
