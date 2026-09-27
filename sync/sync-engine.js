/**
 * 协调可恢复云同步、账号切换保护、迁移确认和指数退避重试。
 */
import { currentWorkspace } from '../storage/account-state.js';
import {
  COLLECTIONS,
  acknowledge,
  emptyWorkspace,
  mergeGuest,
  migrationPreview
} from '../storage/model.js';
import { PAGE_SIZE } from './cloud-store.js';
import { applyPage } from './snapshot.js';

export const SYNC_ALARM = 'cloud-sync-next';
export const SYNC_ACTIONS = new Set(['syncNow', 'clearCache', 'migrationPreview', 'confirmMigration']);
const INITIAL_RETRY_DELAY = 30_000;
const MAX_RETRY_DELAY = 60 * 60 * 1_000;
const MAX_UPLOADS_PER_RUN = 100;

function activeAccount(state, uid = state?.activeAccountUid) {
  if (!state || uid == null || !state.accounts?.[uid]?.workspace) throw new Error('请先登录 Google 账号');
  return state.accounts[uid];
}

function sameCursor(left, right) {
  return left?.seconds === right?.seconds
    && left?.nanoseconds === right?.nanoseconds
    && left?.id === right?.id;
}

function friendlySyncError(error) {
  if (error?.message === '请先登录 Google 账号') return error.message;
  if (error?.code === 'permission-denied') return '云端权限被拒绝，请检查登录账号和数据库规则';
  if (error?.code === 'unauthenticated') return '登录状态已失效，请重新登录';
  if (error?.code === 'resource-exhausted') return '云端配额暂时不足，请稍后重试';
  return '同步失败，请稍后重试';
}

/** 仅当当前账号仍是同步开始时的账号，才写入上传确认。 */
export function applyAcknowledgement(state, capturedUid, operationId, record) {
  if (state?.activeAccountUid !== capturedUid || !state.accounts?.[capturedUid]?.workspace) return false;
  const account = state.accounts[capturedUid];
  account.workspace = acknowledge(account.workspace, operationId, record);
  return true;
}

function applyCloudPage(state, capturedUid, collection, page) {
  if (state?.activeAccountUid !== capturedUid || !state.accounts?.[capturedUid]?.workspace) return false;
  applyPage(state.accounts[capturedUid].workspace, collection, page);
  return true;
}

/** 清除当前账号的云快照和游标；待上传队列存在时拒绝执行。 */
export function clearCurrentCache(state, capturedUid = state?.activeAccountUid) {
  if (state?.activeAccountUid !== capturedUid) throw new Error('登录账号已切换，请重试');
  const workspace = activeAccount(state, capturedUid).workspace;
  if (workspace.pending.length) throw new Error('仍有待上传修改，暂时不能清除本机缓存');
  const clean = emptyWorkspace();
  workspace.remote = clean.remote;
  workspace.cursors = clean.cursors;
  workspace.lastSync = 0;
  workspace.syncStatus = 'pending';
  workspace.syncError = '';
  workspace.syncRetryDelay = INITIAL_RETRY_DELAY;
  return workspace;
}

/** 返回当前账号的访客数据迁移预览和确认状态。 */
export function migrationStatus(state) {
  const account = activeAccount(state);
  return {
    preview: migrationPreview(state.guest, account.workspace),
    confirmed: account.migrationConfirmed === true,
    complete: account.migrationComplete === true
  };
}

/** 返回管理页可展示的当前同步状态，不暴露其他账号数据。 */
export function currentSyncStatus(state) {
  if (!state || state.activeAccountUid == null) {
    return { syncStatus: 'local', pending: 0, lastSync: 0, syncError: '' };
  }
  const workspace = activeAccount(state).workspace;
  return {
    syncStatus: workspace.syncStatus || (workspace.pending.length ? 'pending' : 'synced'),
    pending: workspace.pending.length,
    lastSync: workspace.lastSync || 0,
    syncError: workspace.syncError || ''
  };
}

/** 把访客数据一次性转换为当前账号队列，原始访客工作区继续保留。 */
export function confirmMigration(state) {
  const account = activeAccount(state);
  if (!account.migrationConfirmed) {
    account.workspace = mergeGuest(state.guest, account.workspace);
    account.migrationConfirmed = true;
    account.migrationComplete = account.workspace.pending.length === 0;
  }
  return migrationStatus(state);
}

/** 以有限批次同步当前账号，并在失败后安排可恢复重试。 */
export class SyncEngine {
  constructor({ store, cloud, alarms, logger = console, now = Date.now, onDataChanged = async () => {} }) {
    if (!store || !cloud || !alarms) throw new Error('同步服务尚未初始化');
    this.store = store;
    this.cloud = cloud;
    this.alarms = alarms;
    this.logger = logger;
    this.now = now;
    this.onDataChanged = onDataChanged;
    this.running = null;
    this.rerunRequested = false;
  }

  /** 并发请求共享同一个运行 Promise，避免重复拉取和提交。 */
  sync(options = {}) {
    if (this.running) {
      // 运行期间可能已经切换账号或产生新操作；当前任务结束后补跑一次即可合并所有触发。
      if (options.rerunIfRunning !== false) this.rerunRequested = true;
      return this.running;
    }
    const task = this.run(options).finally(() => {
      if (this.running !== task) return;
      this.running = null;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        queueMicrotask(() => {
          void this.sync().catch(error => {
            this.logger.error('[评论收藏] 补充同步失败:', error?.cause?.code || error?.name || 'unknown');
          });
        });
      }
    });
    this.running = task;
    return task;
  }

  async run(_options = {}) {
    let capturedUid = null;
    try {
      const initial = await this.store.read();
      capturedUid = initial?.activeAccountUid;
      activeAccount(initial, capturedUid);
      await this.store.update(state => {
        if (state.activeAccountUid !== capturedUid) return;
        const workspace = activeAccount(state, capturedUid).workspace;
        workspace.syncStatus = 'syncing';
        workspace.syncError = '';
      });
      // 先保存唤醒点；即使 MV3 Service Worker 在网络请求中被回收，浏览器也会再次启动同步。
      await this.alarms.create(SYNC_ALARM, { when: this.now() + INITIAL_RETRY_DELAY });

      // 拉取优先于上传，让每项本地操作都基于最新云端版本进行三方合并。
      for (const collection of COLLECTIONS) {
        let state = await this.store.read();
        if (state.activeAccountUid !== capturedUid) return { aborted: true, pending: 0 };
        let cursor = activeAccount(state, capturedUid).workspace.cursors[collection];
        while (true) {
          const page = await this.cloud.pull(capturedUid, collection, cursor);
          const applied = await this.store.update(current => (
            applyCloudPage(current, capturedUid, collection, page)
          ));
          if (!applied) return { aborted: true, pending: 0 };
          if (page.records.length) await this.notifyDataChanged();
          if (page.records.length < PAGE_SIZE) break;
          if (!page.cursor || sameCursor(cursor, page.cursor)) throw new Error('云端分页游标没有前进');
          cursor = page.cursor;
        }
      }

      const pulled = await this.store.read();
      if (pulled.activeAccountUid !== capturedUid) return { aborted: true, pending: 0 };
      const operations = activeAccount(pulled, capturedUid).workspace.pending.slice(0, MAX_UPLOADS_PER_RUN);
      for (const operation of operations) {
        const current = await this.store.read();
        if (current.activeAccountUid !== capturedUid) return { aborted: true, pending: 0 };
        const record = await this.cloud.commit(capturedUid, operation);
        const applied = await this.store.update(state => (
          applyAcknowledgement(state, capturedUid, operation.id, record)
        ));
        if (!applied) return { aborted: true, pending: 0 };
        await this.notifyDataChanged();
      }

      const pending = await this.store.update(state => {
        if (state.activeAccountUid !== capturedUid) return null;
        const account = activeAccount(state, capturedUid);
        const workspace = account.workspace;
        workspace.syncRetryDelay = INITIAL_RETRY_DELAY;
        workspace.syncError = '';
        workspace.syncStatus = workspace.pending.length ? 'pending' : 'synced';
        if (!workspace.pending.length) {
          workspace.lastSync = this.now();
          if (account.migrationConfirmed) account.migrationComplete = true;
        }
        return workspace.pending.length;
      });
      if (pending == null) return { aborted: true, pending: 0 };
      if (pending > 0) await this.alarms.create(SYNC_ALARM, { when: this.now() + INITIAL_RETRY_DELAY });
      else await this.alarms.clear(SYNC_ALARM);
      return { aborted: false, pending };
    } catch (error) {
      if (capturedUid) await this.recordFailure(capturedUid, error);
      const message = friendlySyncError(error);
      this.logger.error('[评论收藏] 云同步失败:', error?.code || error?.name || 'unknown');
      throw new Error(message, { cause: error });
    }
  }

  async recordFailure(capturedUid, error) {
    const delay = await this.store.update(state => {
      if (state.activeAccountUid !== capturedUid) return null;
      const workspace = activeAccount(state, capturedUid).workspace;
      const current = Number.isSafeInteger(workspace.syncRetryDelay)
        ? workspace.syncRetryDelay
        : INITIAL_RETRY_DELAY;
      workspace.syncStatus = 'error';
      workspace.syncError = friendlySyncError(error);
      workspace.syncRetryDelay = Math.min(current * 2, MAX_RETRY_DELAY);
      return current;
    });
    if (delay != null) await this.alarms.create(SYNC_ALARM, { when: this.now() + delay });
  }

  async notifyDataChanged() {
    try {
      await this.onDataChanged();
    } catch (error) {
      this.logger.warn?.('[评论收藏] 云端数据已落盘，但页面刷新通知失败:', error?.name || 'unknown');
    }
  }
}

/** 创建后台同步动作分发器。 */
export function createSyncDispatcher({ store, engine, logger = console }) {
  return async function dispatchSync(message) {
    if (!message || !SYNC_ACTIONS.has(message.action)) throw new Error('未知同步操作');
    if (message.action === 'migrationPreview') {
      const state = await store.read();
      return migrationStatus(state);
    }
    if (!engine) throw new Error('请先完成 Firebase 和 ownerUid 配置，当前仍可使用本地评论收藏');
    if (message.action === 'syncNow') return engine.sync({ force: true });
    if (message.action === 'confirmMigration') {
      const result = await store.update(state => confirmMigration(state));
      void engine.sync({ force: true }).catch(error => {
        logger.error('[评论收藏] 迁移后的云同步失败:', error?.cause?.code || error?.name || 'unknown');
      });
      return result;
    }
    const capturedUid = (await store.read())?.activeAccountUid;
    await store.update(state => clearCurrentCache(state, capturedUid));
    return engine.sync({ force: true });
  };
}
