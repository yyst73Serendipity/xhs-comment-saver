/**
 * 验证云端分页合并、账号切换保护、同步上限和失败重试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activateAccount, createState, currentWorkspace } from '../storage/account-state.js';
import { COLLECTIONS, emptyWorkspace, enqueueOperation, project } from '../storage/model.js';
import { applyPage } from '../sync/snapshot.js';
import {
  SyncEngine,
  applyAcknowledgement,
  clearCurrentCache,
  createSyncDispatcher,
  migrationStatus
} from '../sync/sync-engine.js';

function accountState(uid = 'owner') {
  return {
    version: 2,
    activeAccountUid: uid,
    guest: emptyWorkspace(),
    accounts: {
      [uid]: { uid, email: `${uid}@example.com`, workspace: emptyWorkspace() }
    }
  };
}

class MemoryStore {
  constructor(state) {
    this.state = structuredClone(state);
    this.updates = 0;
  }

  async read() {
    return structuredClone(this.state);
  }

  async update(callback) {
    const next = structuredClone(this.state);
    const result = await callback(next);
    this.state = next;
    this.updates += 1;
    return result;
  }
}

function fakeAlarms() {
  const scheduled = [];
  return {
    scheduled,
    create: async (name, options) => scheduled.push({ name, ...options }),
    clear: async name => scheduled.push({ clear: name })
  };
}

test('较旧云快照不能覆盖较新的本地远端版本', () => {
  const workspace = emptyWorkspace();
  workspace.remote.comments.c = {
    data: { note: '新版' }, revision: 3, deleted: false, conflicts: []
  };
  applyPage(workspace, 'comments', {
    records: [{
      id: 'c', record: { data: { note: '旧版' }, revision: 2, deleted: false, conflicts: [] }
    }],
    cursor: { seconds: 1, nanoseconds: 0, id: 'c' }
  });
  assert.equal(project(workspace).comments[0].note, '新版');
  assert.deepEqual(workspace.cursors.comments, { seconds: 1, nanoseconds: 0, id: 'c' });
});

test('云端拉取后仍会重放尚未上传的本地修改', () => {
  const workspace = enqueueOperation(emptyWorkspace(), 'comments', 'c', { note: '本地未发送' });
  applyPage(workspace, 'comments', {
    records: [{
      id: 'c', record: { data: { note: '云端' }, revision: 1, deleted: false, conflicts: [] }
    }],
    cursor: { seconds: 1, nanoseconds: 0, id: 'c' }
  });
  assert.equal(project(workspace).comments[0].note, '本地未发送');
});

test('上传期间切换账号后不会把确认写入新账号', () => {
  const state = accountState('a');
  state.accounts.b = { uid: 'b', email: 'b@example.com', workspace: emptyWorkspace() };
  state.accounts.a.workspace = enqueueOperation(
    state.accounts.a.workspace, 'comments', 'c', { note: 'A' }, { id: 'op-a' }
  );
  state.activeAccountUid = 'b';
  assert.equal(applyAcknowledgement(state, 'a', 'op-a', {
    data: { note: '云端 A' }, revision: 1, deleted: false, conflicts: []
  }), false);
  assert.equal(state.accounts.a.workspace.pending.length, 1);
  assert.equal(state.accounts.b.workspace.pending.length, 0);
});

test('同步先拉取全部集合，每轮最多提交一百项并安排下一轮', async () => {
  const state = accountState();
  for (let index = 0; index < 101; index += 1) {
    state.accounts.owner.workspace = enqueueOperation(
      state.accounts.owner.workspace,
      'comments',
      `c-${index}`,
      { note: `本地 ${index}` },
      { id: `op-${index}` }
    );
  }
  const store = new MemoryStore(state);
  const alarms = fakeAlarms();
  const events = [];
  const cloud = {
    pull: async (_uid, collection) => {
      events.push(`pull:${collection}`);
      return { records: [], cursor: null };
    },
    commit: async (_uid, operation) => {
      events.push(`commit:${operation.id}`);
      return { data: operation.patch, revision: 1, deleted: false, conflicts: [] };
    }
  };
  const engine = new SyncEngine({ store, cloud, alarms, now: () => 1_000 });

  const result = await engine.sync();

  assert.deepEqual(events.slice(0, COLLECTIONS.length), COLLECTIONS.map(value => `pull:${value}`));
  assert.equal(events.filter(value => value.startsWith('commit:')).length, 100);
  assert.equal(store.state.accounts.owner.workspace.pending.length, 1);
  assert.equal(store.state.accounts.owner.workspace.syncStatus, 'pending');
  assert.deepEqual(alarms.scheduled.at(-1), { name: 'cloud-sync-next', when: 31_000 });
  assert.equal(result.pending, 1);
});

test('并发同步复用同一个运行 Promise', async () => {
  const store = new MemoryStore(accountState());
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const cloud = {
    pull: async () => {
      await wait;
      return { records: [], cursor: null };
    },
    commit: async () => { throw new Error('不应提交'); }
  };
  const engine = new SyncEngine({ store, cloud, alarms: fakeAlarms() });
  const first = engine.sync();
  const second = engine.sync({ force: true });
  assert.equal(first, second);
  release();
  await first;
});

test('网络请求开始前先创建三十秒保险闹钟', async () => {
  const store = new MemoryStore(accountState());
  const alarms = fakeAlarms();
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const cloud = {
    pull: async () => {
      await wait;
      return { records: [], cursor: null };
    },
    commit: async () => { throw new Error('不应提交'); }
  };
  const engine = new SyncEngine({ store, cloud, alarms, now: () => 5_000 });
  const running = engine.sync();
  for (let index = 0; index < 20 && !alarms.scheduled.length; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.deepEqual(alarms.scheduled[0], { name: 'cloud-sync-next', when: 35_000 });
  release();
  await running;
});

test('慢请求期间保险闹钟触发不会绕过失败退避立即重试', async () => {
  const store = new MemoryStore(accountState());
  const alarms = fakeAlarms();
  let rejectPull;
  const wait = new Promise((_resolve, reject) => { rejectPull = reject; });
  let pullCalls = 0;
  const cloud = {
    pull: async () => {
      pullCalls += 1;
      await wait;
      return { records: [], cursor: null };
    },
    commit: async () => { throw new Error('不应提交'); }
  };
  const engine = new SyncEngine({
    store, cloud, alarms, now: () => 10_000, logger: { error() {} }
  });
  const running = engine.sync();
  for (let index = 0; index < 20 && pullCalls === 0; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(engine.sync({ rerunIfRunning: false }), running);
  rejectPull(Object.assign(new Error('offline'), { code: 'unavailable' }));
  await assert.rejects(running, /同步失败/);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pullCalls, 1);
  assert.equal(store.state.accounts.owner.workspace.syncRetryDelay, 60_000);
  assert.deepEqual(alarms.scheduled.at(-1), { name: 'cloud-sync-next', when: 40_000 });
});

test('云端分页落盘后通知已打开页面刷新收藏状态', async () => {
  const store = new MemoryStore(accountState());
  const alarms = fakeAlarms();
  let notifications = 0;
  const cloud = {
    pull: async (_uid, collection) => ({
      records: collection === 'comments'
        ? [{
            id: 'remote',
            record: { data: { text: '另一台设备' }, revision: 1, deleted: false, conflicts: [] }
          }]
        : [],
      cursor: null
    }),
    commit: async () => { throw new Error('不应提交'); }
  };
  await new SyncEngine({
    store,
    cloud,
    alarms,
    onDataChanged: async () => { notifications += 1; }
  }).sync();
  assert.equal(project(store.state.accounts.owner.workspace).comments[0].text, '另一台设备');
  assert.equal(notifications, 1);
});

test('同步运行中切换账号会在旧任务结束后补跑新账号', async () => {
  const state = accountState('a');
  state.accounts.b = { uid: 'b', email: 'b@example.com', workspace: emptyWorkspace() };
  const store = new MemoryStore(state);
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const pulledUsers = [];
  let firstPull = true;
  const cloud = {
    pull: async uid => {
      pulledUsers.push(uid);
      if (firstPull) {
        firstPull = false;
        await wait;
      }
      return { records: [], cursor: null };
    },
    commit: async () => { throw new Error('不应提交'); }
  };
  const engine = new SyncEngine({ store, cloud, alarms: fakeAlarms(), logger: { error() {} } });
  const first = engine.sync();
  await new Promise(resolve => setTimeout(resolve, 0));
  store.state.activeAccountUid = 'b';
  const second = engine.sync();
  assert.equal(first, second);
  release();
  await first;
  for (let index = 0; index < 20 && !pulledUsers.includes('b'); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(pulledUsers.includes('b'), true);
});

test('同步失败保留队列并从三十秒开始指数退避', async () => {
  const state = accountState();
  state.accounts.owner.workspace = enqueueOperation(
    state.accounts.owner.workspace, 'comments', 'c', { note: '保留' }, { id: 'op' }
  );
  const store = new MemoryStore(state);
  const alarms = fakeAlarms();
  const cloud = { pull: async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }); } };
  const engine = new SyncEngine({ store, cloud, alarms, now: () => 2_000, logger: { error() {} } });

  await assert.rejects(engine.sync(), /同步失败/);
  assert.equal(store.state.accounts.owner.workspace.pending.length, 1);
  assert.equal(store.state.accounts.owner.workspace.syncStatus, 'error');
  assert.equal(store.state.accounts.owner.workspace.syncRetryDelay, 60_000);
  assert.deepEqual(alarms.scheduled.at(-1), { name: 'cloud-sync-next', when: 32_000 });

  await assert.rejects(engine.sync(), /同步失败/);
  assert.equal(store.state.accounts.owner.workspace.syncRetryDelay, 120_000);
  assert.deepEqual(alarms.scheduled.at(-1), { name: 'cloud-sync-next', when: 62_000 });
});

test('清缓存只清当前账号快照且待上传时拒绝', () => {
  const state = accountState('a');
  state.accounts.b = { uid: 'b', email: '', workspace: emptyWorkspace() };
  state.accounts.a.workspace.remote.comments.c = {
    data: { note: 'A' }, revision: 1, deleted: false, conflicts: []
  };
  state.accounts.b.workspace.remote.comments.c = {
    data: { note: 'B' }, revision: 1, deleted: false, conflicts: []
  };
  clearCurrentCache(state, 'a');
  assert.equal(Object.keys(state.accounts.a.workspace.remote.comments).length, 0);
  assert.equal(Object.keys(state.accounts.b.workspace.remote.comments).length, 1);
  state.accounts.a.workspace = enqueueOperation(
    state.accounts.a.workspace, 'comments', 'pending', { note: '待上传' }
  );
  assert.throws(() => clearCurrentCache(state, 'a'), /待上传/);
});

test('迁移状态按当前账号保存且原始访客数据继续保留', async () => {
  const state = await createState([{ commentId: 'legacy', text: '旧评论' }], ['未分类'], {});
  activateAccount(state, { uid: 'owner', email: 'owner@example.com' });
  const beforeGuest = structuredClone(state.guest);
  const status = migrationStatus(state);
  assert.equal(status.preview.comments, 1);
  assert.equal(status.confirmed, false);
  assert.equal(JSON.stringify(state.guest), JSON.stringify(beforeGuest));
  assert.equal(currentWorkspace(state).pending.length, 0);
});

test('确认迁移只排队一次并在落盘后触发同步', async () => {
  const state = await createState([{ commentId: 'legacy', text: '旧评论' }], ['未分类'], {});
  activateAccount(state, { uid: 'owner', email: 'owner@example.com' });
  const store = new MemoryStore(state);
  let syncCalls = 0;
  const dispatch = createSyncDispatcher({
    store,
    engine: { sync: async () => { syncCalls += 1; return { pending: 0 }; } },
    logger: { error() {} }
  });

  const first = await dispatch({ action: 'confirmMigration' });
  const pendingAfterFirst = store.state.accounts.owner.workspace.pending.length;
  const second = await dispatch({ action: 'confirmMigration' });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(first.confirmed, true);
  assert.equal(second.confirmed, true);
  assert.equal(pendingAfterFirst > 0, true);
  assert.equal(store.state.accounts.owner.workspace.pending.length, pendingAfterFirst);
  assert.equal(syncCalls, 2);
  assert.equal(project(store.state.guest).comments.length, 1);
});

test('Service Worker 接入同步动作、业务写入、登录恢复和闹钟触发', async () => {
  const source = await readFile('background/background.js', 'utf8');
  assert.match(source, /createSyncDispatcher/);
  assert.match(source, /LOCAL_MUTATION_ACTIONS/);
  assert.match(source, /cloudLogin/);
  assert.match(source, /authBinding\.ready\.then/);
  assert.match(source, /chrome\.alarms\.onAlarm/);
  assert.match(source, /SYNC_ALARM/);
  assert.match(source, /onDataChanged:\s*notifyDataChanged/);
});
