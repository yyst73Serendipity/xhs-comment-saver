/**
 * 管理页 Google 云同步状态、迁移确认和文本冲突处理。
 */
(function registerCloudPanel(global) {
  const HIDDEN = 'hidden';

  function byId(id) {
    return document.getElementById(id);
  }

  function toggle(element, visible) {
    element.classList.toggle(HIDDEN, !visible);
  }

  function timeText(timestamp) {
    return timestamp ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  }

  /** 把后台同步状态转换为面向用户的简短文案。 */
  function statusText(status) {
    if (!status.configured) return '未配置云服务 · 当前保存在本机';
    if (!status.ownerConfigured) {
      return status.signedIn
        ? '已登录 · 请将 UID 填入 ownerUid 后重新构建'
        : '云服务待绑定所有者 · 请先登录获取 UID';
    }
    if (!status.signedIn) return '仅保存在本机';
    const pending = Number.isSafeInteger(status.pending) ? status.pending : 0;
    if (status.syncStatus === 'syncing') return `正在同步… · ${pending} 项待上传`;
    if (status.syncStatus === 'error') {
      return `${status.syncError || '同步失败，请稍后重试'} · ${pending} 项待上传`;
    }
    if (pending > 0 || status.syncStatus === 'pending') return `等待同步 · ${pending} 项待上传`;
    return `已同步 · ${timeText(status.lastSync) || '等待首次同步'}`;
  }

  /** 按 Firebase 配置阶段限制数据按钮，同时保留首次获取 UID 的登录路径。 */
  function controlsFor(status, conflictCount = 0) {
    const signedIn = Boolean(status.signedIn);
    const dataReady = Boolean(status.configured && status.ownerConfigured && signedIn);
    return {
      login: Boolean(status.configured && !signedIn),
      copyUid: Boolean(status.configured && signedIn && status.user?.uid),
      sync: dataReady,
      migrate: dataReady,
      conflicts: Boolean(dataReady && conflictCount),
      cache: dataReady,
      logout: Boolean(status.configured && signedIn)
    };
  }

  /** 初始化云同步面板，并通过后台消息完成所有账号和数据操作。 */
  function init({ sendAction, createBackup, reloadData, showToast }) {
    const account = byId('cloud-account');
    const statusLabel = byId('cloud-status');
    const login = byId('cloud-login');
    const copyUid = byId('cloud-copy-uid');
    const sync = byId('cloud-sync');
    const migrate = byId('cloud-migrate');
    const conflictsButton = byId('cloud-conflicts');
    const cache = byId('cloud-cache');
    const logout = byId('cloud-logout');
    const migrationModal = byId('cloud-migration-modal');
    const migrationBody = byId('cloud-migration-body');
    const migrationCancel = byId('cloud-migration-cancel');
    const migrationBackup = byId('cloud-backup');
    const migrationConfirm = byId('cloud-migration-confirm');
    const conflictModal = byId('cloud-conflict-modal');
    const conflictTitle = byId('cloud-conflict-title');
    const conflictCurrent = byId('cloud-conflict-current');
    const conflictAlternate = byId('cloud-conflict-alternate');
    const conflictCancel = byId('cloud-conflict-cancel');
    const useCurrent = byId('cloud-use-current');
    const useAlternate = byId('cloud-use-alternate');
    let currentStatus = null;
    let conflicts = [];
    let conflictIndex = 0;

    async function run(action, payload = {}, successMessage = '') {
      try {
        const result = await sendAction(action, payload);
        if (successMessage) showToast(successMessage, 'success');
        await refreshStatus();
        return result;
      } catch (error) {
        showToast(error.message || '云同步操作失败', 'error');
        return null;
      }
    }

    async function refreshStatus() {
      try {
        currentStatus = await sendAction('cloudStatus');
        account.textContent = currentStatus.signedIn
          ? `${currentStatus.user?.email || 'Google 账号'} · UID: ${currentStatus.user?.uid || '未知'}`
          : '本地模式';
        statusLabel.textContent = statusText(currentStatus);
        const controls = controlsFor(currentStatus, conflicts.length);
        toggle(login, controls.login);
        toggle(copyUid, controls.copyUid);
        toggle(sync, controls.sync);
        toggle(migrate, controls.migrate);
        toggle(conflictsButton, controls.conflicts);
        toggle(cache, controls.cache);
        toggle(logout, controls.logout);
      } catch (error) {
        account.textContent = '本地模式';
        statusLabel.textContent = error.message || '同步状态读取失败';
      }
    }

    function closeMigration() {
      migrationModal.classList.add(HIDDEN);
      migrationConfirm.disabled = true;
    }

    async function openMigration() {
      const result = await run('migrationPreview');
      if (!result) return;
      const preview = result.preview || {};
      migrationBody.textContent = result.confirmed
        ? '本机访客数据已经迁移过，无需重复操作。'
        : `将迁移 ${preview.comments || 0} 条评论、${preview.categories || 0} 个分类和 ${preview.summaries || 0} 份总结；预计有 ${(preview.noteConflicts || 0) + (preview.summaryConflicts || 0)} 处文本冲突。`;
      migrationConfirm.disabled = true;
      toggle(migrationConfirm, !result.confirmed);
      toggle(migrationBackup, !result.confirmed);
      migrationModal.classList.remove(HIDDEN);
    }

    function renderConflict() {
      const item = conflicts[conflictIndex];
      if (!item) {
        conflictModal.classList.add(HIDDEN);
        toggle(conflictsButton, false);
        return;
      }
      conflictTitle.textContent = `处理同步冲突（${conflictIndex + 1}/${conflicts.length}）`;
      conflictCurrent.value = item.current;
      conflictAlternate.value = item.alternate;
      conflictModal.classList.remove(HIDDEN);
    }

    async function resolve(value) {
      const item = conflicts[conflictIndex];
      if (!item) return;
      try {
        await sendAction('resolveConflict', {
          collection: item.collection,
          id: item.id,
          category: item.category,
          field: item.field,
          value,
          conflictIds: item.conflictIds
        });
        conflicts.splice(conflictIndex, 1);
        if (conflictIndex >= conflicts.length) conflictIndex = 0;
        await reloadData();
        renderConflict();
        await refreshStatus();
        showToast('冲突版本已保存', 'success');
      } catch (error) {
        showToast(error.message || '冲突处理失败', 'error');
      }
    }

    login.addEventListener('click', async () => {
      const user = await run('cloudLogin', {}, 'Google 账号登录成功');
      if (user) await reloadData();
    });
    copyUid.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(currentStatus?.user?.uid || '');
        showToast('UID 已复制', 'success');
      } catch {
        showToast('UID 复制失败，请手动选择账号栏中的 UID', 'error');
      }
    });
    logout.addEventListener('click', async () => {
      const result = await run('cloudLogout', {}, '已退出 Google 账号');
      if (result !== null) await reloadData();
    });
    sync.addEventListener('click', async () => {
      const result = await run('syncNow', {}, '同步完成');
      if (result) await reloadData();
    });
    cache.addEventListener('click', async () => {
      const result = await run('clearCache', {}, '本机缓存已重新拉取');
      if (result) await reloadData();
    });
    migrate.addEventListener('click', openMigration);
    migrationCancel.addEventListener('click', closeMigration);
    migrationBackup.addEventListener('click', async () => {
      const saved = await createBackup();
      if (saved !== false) migrationConfirm.disabled = false;
    });
    migrationConfirm.addEventListener('click', async () => {
      const result = await run('confirmMigration', {}, '本机数据已加入同步队列');
      if (!result) return;
      closeMigration();
      await reloadData();
    });
    conflictsButton.addEventListener('click', () => {
      conflictIndex = 0;
      renderConflict();
    });
    conflictCancel.addEventListener('click', () => conflictModal.classList.add(HIDDEN));
    useCurrent.addEventListener('click', () => resolve(conflicts[conflictIndex]?.current || ''));
    useAlternate.addEventListener('click', () => resolve(conflicts[conflictIndex]?.alternate || ''));

    function setConflicts(commentItems, summaryItems) {
      conflicts = [];
      for (const comment of commentItems || []) {
        const versions = comment.noteConflicts || [];
        for (const version of versions) {
          conflicts.push({
            collection: 'comments', id: comment.id, field: 'note', current: comment.note || '',
            alternate: version.value ?? version.local ?? '', conflictIds: [version.id]
          });
        }
      }
      for (const [category, summary] of Object.entries(summaryItems || {})) {
        const versions = summary.contentConflicts || [];
        for (const version of versions) {
          conflicts.push({
            collection: 'summaries', category, field: 'content', current: summary.content || '',
            alternate: version.value ?? version.local ?? '', conflictIds: [version.id]
          });
        }
      }
      conflictsButton.textContent = conflicts.length ? `处理冲突（${conflicts.length}）` : '处理冲突';
      toggle(conflictsButton, controlsFor(currentStatus || {}, conflicts.length).conflicts);
    }

    void refreshStatus();
    window.addEventListener('focus', refreshStatus);
    return { refreshStatus, setConflicts };
  }

  global.XHS_CLOUD_PANEL = { controlsFor, init, statusText };
})(globalThis);
