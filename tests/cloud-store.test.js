/**
 * 验证 Firestore 事务幂等、路径校验和增量分页游标。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore } from '../sync/cloud-store.js';
import { buildEnvironment, firebaseCliArguments } from '../scripts/deploy.js';

function fakeApi({ receipt, target, rows = [] } = {}) {
  const events = [];
  class FakeTimestamp {
    constructor(seconds, nanoseconds) {
      this.seconds = seconds;
      this.nanoseconds = nanoseconds;
    }
  }
  const api = {
    doc: (...parts) => ({ path: parts.slice(1).join('/') }),
    collection: (...parts) => ({ path: parts.slice(1).join('/') }),
    serverTimestamp: () => ({ server: true }),
    runTransaction: async (_db, callback) => callback({
      get: async ref => {
        events.push(`read:${ref.path}`);
        const value = ref.path.includes('/operations/') ? receipt : target;
        return { exists: () => value !== undefined, data: () => structuredClone(value) };
      },
      set: (ref, value) => events.push(`write:${ref.path}:${JSON.stringify(value)}`)
    }),
    orderBy: (...args) => ['orderBy', ...args],
    documentId: () => '__name__',
    startAt: (...args) => ['startAt', ...args],
    limit: value => {
      events.push(`limit:${value}`);
      return ['limit', value];
    },
    query: (...args) => args,
    getDocs: async () => ({ docs: rows.map(row => ({ id: row.id, data: () => row.data })) }),
    Timestamp: FakeTimestamp
  };
  return { api, events };
}

test('提交先完成全部读取，再写业务记录和回执', async () => {
  const { api, events } = fakeApi({ target: { data: {}, revision: 0, deleted: false, conflicts: [] } });
  const store = new CloudStore({}, api);
  const record = await store.commit('owner', {
    id: 'op-1', collection: 'comments', recordId: 'c1', patch: { text: '内容' }, baseRevision: 0, baseData: {}
  });
  assert.equal(record.data.text, '内容');
  assert.deepEqual(events.slice(0, 2), [
    'read:users/owner/operations/op-1', 'read:users/owner/comments/c1'
  ]);
  assert.equal(events.slice(2).every(value => value.startsWith('write:')), true);
});

test('已有回执时不重复写入并返回当前记录', async () => {
  const current = { data: { text: '云端' }, revision: 2, deleted: false, conflicts: [] };
  const { api, events } = fakeApi({ receipt: { collection: 'comments', recordId: 'c1' }, target: current });
  const result = await new CloudStore({}, api).commit('owner', {
    id: 'op-1', collection: 'comments', recordId: 'c1', patch: { text: '本地' }
  });
  assert.deepEqual(result, current);
  assert.equal(events.some(value => value.startsWith('write:')), false);
});

test('已有回执但目标记录不存在时拒绝错误确认', async () => {
  const { api } = fakeApi({ receipt: { collection: 'comments', recordId: 'c1' } });
  await assert.rejects(new CloudStore({}, api).commit('owner', {
    id: 'op-1', collection: 'comments', recordId: 'c1', patch: { text: '本地' }
  }), /回执对应的云端记录不存在/);
});

test('墓碑保护跳过字段修改时仍生成单调递增的云端版本', async () => {
  const { api, events } = fakeApi({
    target: { data: { text: '已删除' }, revision: 3, deleted: true, conflicts: [] }
  });
  const result = await new CloudStore({}, api).commit('owner', {
    id: 'op-1', collection: 'comments', recordId: 'c1', patch: { note: '过期修改' },
    baseRevision: 2, baseData: { note: '' }
  });
  assert.equal(result.deleted, true);
  assert.equal(result.revision, 4);
  assert.equal(events.some(value => value.includes('users/owner/comments/c1')), true);
});

test('重复操作 ID 指向不同记录时拒绝确认', async () => {
  const { api } = fakeApi({
    receipt: { collection: 'comments', recordId: 'other' },
    target: { data: {}, revision: 1, deleted: false, conflicts: [] }
  });
  await assert.rejects(new CloudStore({}, api).commit('owner', {
    id: 'op-1', collection: 'comments', recordId: 'c1', patch: {}
  }), /操作回执与目标记录不一致/);
});

test('严格拒绝非法用户、集合和文档路径', async () => {
  const store = new CloudStore({}, fakeApi().api);
  const operation = { id: 'op-1', collection: 'comments', recordId: 'c1', patch: {} };
  await assert.rejects(store.commit('../owner', operation), /用户 ID/);
  await assert.rejects(store.commit('owner', { ...operation, collection: 'operations' }), /集合/);
  await assert.rejects(store.commit('owner', { ...operation, recordId: 'a\/b' }), /记录 ID/);
  await assert.rejects(store.commit('owner', { ...operation, id: '.' }), /操作 ID/);
});

test('拉取按服务器时间和文档 ID 分页，返回不超过 200 条', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => ({
    id: `id-${String(index).padStart(3, '0')}`,
    data: { data: {}, revision: index, deleted: false, conflicts: [], updatedAt: { seconds: 10, nanoseconds: 20 } }
  }));
  const { api, events } = fakeApi({ rows });
  const page = await new CloudStore({}, api).pull('owner', 'comments', {
    seconds: 10, nanoseconds: 20, id: 'id-000'
  });
  assert.equal(page.records.length, 200);
  assert.equal(events.includes('limit:201'), true);
  assert.equal(page.records.some(item => item.id === 'id-000'), false);
  assert.deepEqual(page.cursor, { seconds: 10, nanoseconds: 20, id: 'id-200' });
});

test('部署命令使用经过校验的参数数组', () => {
  assert.deepEqual(firebaseCliArguments('xhs-owner-123'), [
    'deploy', '--project', 'xhs-owner-123', '--only', 'firestore:rules,hosting'
  ]);
  assert.throws(() => firebaseCliArguments('project; rm -rf data'), /projectId/);
});

test('部署构建强制使用刚校验的配置并清除外部输出目录', () => {
  const environment = buildEnvironment({
    XHS_FIREBASE_CONFIG_PATH: '/tmp/other.json',
    XHS_BUILD_OUTPUT_DIR: '/tmp/other-output',
    KEEP_ME: 'yes'
  }, '/repo/config/firebase.local.json');
  assert.equal(environment.XHS_FIREBASE_CONFIG_PATH, '/repo/config/firebase.local.json');
  assert.equal(Object.hasOwn(environment, 'XHS_BUILD_OUTPUT_DIR'), false);
  assert.equal(environment.KEEP_ME, 'yes');
});
