/**
 * 验证本地状态只保存一份主副本，并保证并发更新串行提交。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalStore, STATE_KEY } from '../storage/local-store.js';

function installStorage(initial = {}) {
  let saved = structuredClone(initial);
  const writes = [];
  globalThis.chrome = { storage: { local: {
    async get(keys) {
      const names = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(names.filter(key => Object.hasOwn(saved, key)).map(key => [key, structuredClone(saved[key])]));
    },
    async set(value) {
      writes.push(structuredClone(value));
      await new Promise(resolve => setTimeout(resolve, 2));
      saved = { ...saved, ...structuredClone(value) };
    }
  } } };
  return { get saved() { return saved; }, writes };
}

test('manifest 启用扩展存储权限且状态不创建第二份旧数据备份', async () => {
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  assert.equal(manifest.permissions.includes('unlimitedStorage'), true);
  const source = await readFile('storage/local-store.js', 'utf8');
  assert.doesNotMatch(source, /backup|legacyBackup|xhs_comments_backup/);
});

test('并发更新严格串行且每次只进行一次原子 set', async () => {
  const storage = installStorage();
  const store = new LocalStore();
  const order = [];
  const first = store.update(async state => {
    order.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 10));
    state.marker = 1;
    order.push('first-end');
  });
  const second = store.update(state => {
    order.push('second');
    state.marker = 2;
  });
  await Promise.all([first, second]);

  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  assert.equal(storage.saved[STATE_KEY].marker, 2);
  assert.equal(storage.writes.length, 2);
  assert.equal(storage.writes.every(value => Object.hasOwn(value, STATE_KEY)), true);
});

test('旧数据只在首次更新时迁移并广播兼容投影', async () => {
  const storage = installStorage({
    xhs_comments: [{ commentId: '1', text: '旧评论', category: '好物' }],
    xhs_categories: ['未分类', '好物'],
    xhs_summaries: { 好物: { content: '旧总结' } }
  });
  const store = new LocalStore();
  await store.update(() => {});

  assert.equal(storage.saved[STATE_KEY].version, 2);
  assert.equal(storage.saved.xhs_comments.length, 1);
  assert.equal(storage.saved.xhs_summaries['好物'].content, '旧总结');
  assert.equal(Object.hasOwn(storage.saved, 'xhs_comments_backup'), false);
});

test('失败更新不会写入半成品且后续更新仍可继续', async () => {
  const storage = installStorage();
  const store = new LocalStore();
  await assert.rejects(() => store.update(state => {
    state.partial = true;
    throw new Error('失败');
  }), /失败/);
  assert.equal(storage.writes.length, 0);

  await store.update(state => { state.recovered = true; });
  assert.equal(storage.saved[STATE_KEY].partial, undefined);
  assert.equal(storage.saved[STATE_KEY].recovered, true);
  assert.equal((await store.read()).recovered, true);
});

test('首次迁移失败项保留完整原文且成功数据不会重复备份', async () => {
  const invalidComment = { author: '无法识别作者', custom: { source: '旧版', value: 7 } };
  const invalidSummary = { content: '总'.repeat(100_001), generatedBy: 'manual', extra: { keep: true } };
  const storage = installStorage({
    xhs_comments: [invalidComment, { commentId: 'ok', text: '成功评论' }],
    xhs_categories: ['未分类', '学习'],
    xhs_summaries: { 学习: invalidSummary }
  });

  await new LocalStore().update(() => {});

  const guest = storage.saved[STATE_KEY].guest;
  assert.equal(guest.migrationQuarantine.comments.length, 1);
  assert.deepEqual(guest.migrationQuarantine.comments[0].raw, invalidComment);
  assert.match(guest.migrationQuarantine.comments[0].reason, /稳定标识/);
  assert.equal(guest.migrationQuarantine.comments[0].index, 0);
  assert.equal(guest.migrationQuarantine.summaries.length, 1);
  assert.deepEqual(guest.migrationQuarantine.summaries[0].raw, invalidSummary);
  assert.equal(guest.migrationQuarantine.summaries[0].category, '学习');
  assert.equal(guest.migrationQuarantine.summaries[0].index, 0);
  assert.equal(guest.migrationQuarantine.categories.length, 0);
  assert.equal(JSON.stringify(guest.migrationQuarantine).includes('成功评论'), false);
  assert.deepEqual(storage.saved.xhs_comments.map(comment => comment.text), ['成功评论']);
});

test('不同 LocalStore 实例共享写锁且失败不会阻塞后续实例', async () => {
  const storage = installStorage();
  const firstStore = new LocalStore();
  const secondStore = new LocalStore();
  const first = firstStore.update(async state => {
    await new Promise(resolve => setTimeout(resolve, 10));
    state.first = true;
  });
  const second = secondStore.update(state => { state.second = true; });
  await Promise.all([first, second]);
  assert.equal(storage.saved[STATE_KEY].first, true);
  assert.equal(storage.saved[STATE_KEY].second, true);

  await assert.rejects(() => firstStore.update(() => { throw new Error('跨实例失败'); }), /跨实例失败/);
  await secondStore.update(state => { state.recoveredAcrossInstances = true; });
  assert.equal(storage.saved[STATE_KEY].recoveredAcrossInstances, true);
});
