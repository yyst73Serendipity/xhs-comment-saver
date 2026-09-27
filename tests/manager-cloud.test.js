/**
 * 验证管理页云同步入口、迁移备份和统一业务写入约束。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('manager/manager.html', 'utf8');
const manager = await readFile('manager/manager.js', 'utf8');
const cloudPanel = await readFile('manager/cloud-panel.js', 'utf8').catch(() => '');
const summaryStoreSource = await readFile('manager/summary-store.js', 'utf8');
const build = await readFile('scripts/build.js', 'utf8');
await import('../manager/cloud-panel.js');
await import('../manager/summary-store.js');
const cloudApi = globalThis.XHS_CLOUD_PANEL;
const summaryStore = globalThis.XHS_SUMMARY_STORE;

test('管理页提供全部云同步控件且保留三栏主体', () => {
  for (const id of [
    'cloud-account', 'cloud-status', 'cloud-login', 'cloud-copy-uid', 'cloud-sync', 'cloud-cache',
    'cloud-logout', 'cloud-migrate', 'cloud-conflicts'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /class="sidebar"/);
  assert.match(html, /class="content"/);
  assert.match(html, /class="right-panel"/);
  assert.match(html, /cloud-panel\.css/);
  assert.match(html, /cloud-panel\.js/);
  assert.match(html, /summary-store\.js/);
  assert.match(build, /manager\/cloud-panel\.css/);
  assert.match(build, /manager\/cloud-panel\.js/);
  assert.match(build, /manager\/summary-store\.js/);
});

test('配置帮助使用内置弹窗打开和关闭', () => {
  for (const id of ['cloud-help', 'cloud-help-modal', 'cloud-help-close']) {
    assert.match(cloudPanel, new RegExp(`byId\\('${id}'\\)`));
  }
  assert.match(cloudPanel, /help\.addEventListener\('click',[\s\S]*helpModal\.classList\.remove\(HIDDEN\)/);
  assert.match(cloudPanel, /helpClose\.addEventListener\('click',[\s\S]*helpModal\.classList\.add\(HIDDEN\)/);
});

test('未填写 ownerUid 时仍可登录获取 UID但不能访问云数据', () => {
  assert.deepEqual(cloudApi.controlsFor({ configured: true, ownerConfigured: false, signedIn: false }), {
    login: true, copyUid: false, sync: false, migrate: false, conflicts: false, cache: false, logout: false
  });
  assert.deepEqual(cloudApi.controlsFor({
    configured: true, ownerConfigured: false, signedIn: true, user: { uid: 'owner' }
  }), {
    login: false, copyUid: true, sync: false, migrate: false, conflicts: false, cache: false, logout: true
  });
  assert.match(cloudApi.statusText({ configured: true, ownerConfigured: false, signedIn: true }), /ownerUid/);
});

test('管理页不再直接写入或删除同步业务键', () => {
  assert.doesNotMatch(manager, /chrome\.storage\.local\.set\s*\(\s*\{[^}]*xhs_(comments|categories|summaries)/s);
  assert.doesNotMatch(manager, /chrome\.storage\.local\.remove\s*\([^)]*xhs_(comments|categories|summaries)/s);
  assert.match(manager, /async function sendAction/);
  for (const action of [
    'updateNote', 'updateCategory', 'deleteComment', 'deleteCategory', 'renameCategory',
    'addCategory', 'saveSummary', 'importData', 'clearAll'
  ]) {
    assert.match(`${manager}\n${summaryStoreSource}`, new RegExp(`sendAction\\('${action}'`));
  }
});

test('云同步区只用安全文本 API 并要求备份后才能确认迁移', () => {
  assert.doesNotMatch(cloudPanel, /\.innerHTML\s*=/);
  assert.match(cloudPanel, /textContent/);
  assert.match(cloudPanel, /migrationConfirm\.disabled\s*=\s*true/);
  assert.match(cloudPanel, /await createBackup\(\)/);
  assert.match(cloudPanel, /migrationConfirm\.disabled\s*=\s*false/);
  assert.match(cloudPanel, /resolveConflict/);
  assert.match(cloudPanel, /conflictIds:\s*\[version\.id\]/);
  assert.doesNotMatch(cloudPanel, /conflictIds:\s*versions\.map/);
});

test('本地用量文案明确表示缓存工作副本而不是云端配额', () => {
  assert.match(manager, /本地缓存工作副本/);
  assert.doesNotMatch(manager, /空间即将耗尽|空间即将用尽/);
});

test('总结自动保存和 AI 生成绑定操作开始时的明确分类', () => {
  assert.match(manager, /autoSaveSummary\(summaryEditingCategory, summaryEditor\.value\.trim\(\)\)/);
  assert.match(manager, /autoSaveSummary\.cancel\(\)/);
  assert.match(manager, /async function saveSummaryToStorage\(category\)/);
  assert.doesNotMatch(manager, /saveSummaryToStorage\(\)/);
  assert.match(manager, /const category = currentCategory;[\s\S]*summaries\[category\] = \{/);
});

test('总结后台保存失败会继续抛错且界面只在成功后显示已保存', async () => {
  await assert.rejects(() => summaryStore.persistCategory({
    category: '学习', summary: { content: '草稿' }, sendAction: async () => { throw new Error('写入失败'); }
  }), /写入失败/);
  assert.match(manager, /const saved = await saveSummaryToStorage\(category\)/);
  assert.match(manager, /if \(!saved\) \{[\s\S]*保存失败/);
  assert.match(manager, /AI 总结尚未保存/);
  assert.match(manager, /sendAction\('getSummaries'\)/);
});

test('AI 跨分类保存失败时按生成分类保留草稿', () => {
  const drafts = summaryStore.createDraftStore();
  drafts.set('分类 A', '未保存的 AI 总结');
  assert.equal(drafts.get('分类 A'), '未保存的 AI 总结');
  assert.equal(drafts.has('分类 B'), false);
  assert.match(manager, /summaryDrafts\.set\(category, result\)/);
  assert.match(manager, /summaryDrafts\.has\(name\)[\s\S]*enterSummaryEdit\(\)/);
});
