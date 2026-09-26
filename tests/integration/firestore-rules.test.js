/**
 * 验证 Firestore 个人所有者规则、业务记录边界和操作回执边界。
 */
import test, { after, before } from 'node:test';
import { readFile } from 'node:fs/promises';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, serverTimestamp, setDoc, writeBatch } from 'firebase/firestore';

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-xhs-comment-saver',
    firestore: { rules: (await readFile('firestore.rules', 'utf8')).replaceAll('__OWNER_UID__', 'owner') }
  });
});

after(async () => {
  await testEnv?.cleanup();
});

const ownerDoc = (kind, id = 'c1') => doc(
  testEnv.authenticatedContext('owner').firestore(),
  `users/owner/${kind}/${id}`
);

test('未登录用户不能读取评论', async () => {
  const ref = doc(testEnv.unauthenticatedContext().firestore(), 'users/owner/comments/c1');
  await assertFails(getDoc(ref));
});

test('其他账号不能读取所有者数据', async () => {
  const ref = doc(testEnv.authenticatedContext('other').firestore(), 'users/owner/comments/c1');
  await assertFails(getDoc(ref));
});

test('所有者可以写入有效评论记录', async () => {
  await assertSucceeds(setDoc(ownerDoc('comments'), {
    data: { text: '内容' }, revision: 1, deleted: false, conflicts: [], updatedAt: serverTimestamp()
  }));
});

test('所有者可以写入旧数据迁移生成的可空媒体和评论组字段', async () => {
  await assertSucceeds(setDoc(ownerDoc('comments', 'migrated-comment'), {
    data: {
      commentId: 'legacy-1', text: '旧评论', images: [], audio: null,
      groupId: null, groupIndex: null, categoryId: 'uncategorized'
    },
    revision: 1,
    deleted: false,
    conflicts: [],
    updatedAt: serverTimestamp()
  }));
});

test('拒绝未知集合和额外顶层字段', async () => {
  const valid = { data: {}, revision: 1, deleted: false, conflicts: [], updatedAt: serverTimestamp() };
  await assertFails(setDoc(ownerDoc('secrets'), valid));
  await assertFails(setDoc(ownerDoc('comments', 'extra'), { ...valid, unexpected: true }));
});

test('拒绝非整数版本和客户端时间戳', async () => {
  const base = { data: {}, deleted: false, conflicts: [] };
  await assertFails(setDoc(ownerDoc('comments', 'fraction'), {
    ...base, revision: 1.5, updatedAt: serverTimestamp()
  }));
  await assertFails(setDoc(ownerDoc('comments', 'client-time'), {
    ...base, revision: 1, updatedAt: new Date()
  }));
  await assertFails(setDoc(ownerDoc('comments', 'zero-version'), {
    ...base, revision: 0, updatedAt: serverTimestamp()
  }));
});

test('业务记录版本只能从一开始并在更新时递增一', async () => {
  const ref = ownerDoc('comments', 'revisioned');
  const base = { data: { text: '版本一' }, deleted: false, conflicts: [] };
  await assertSucceeds(setDoc(ref, { ...base, revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(ref, { ...base, revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(ref, { ...base, revision: 3, updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(ref, { ...base, revision: 2, updatedAt: serverTimestamp() }));
});

test('拒绝业务集合不允许的字段和字段类型', async () => {
  const envelope = { revision: 1, deleted: false, conflicts: [], updatedAt: serverTimestamp() };
  await assertFails(setDoc(ownerDoc('comments', 'unknown-data'), {
    ...envelope, data: { text: '内容', apiKey: 'secret' }
  }));
  await assertFails(setDoc(ownerDoc('categories', 'wrong-type'), {
    ...envelope, data: { name: 123 }
  }));
  await assertFails(setDoc(ownerDoc('settings', 'wrong-settings'), {
    ...envelope, data: { categoryOrder: 'not-a-list' }
  }));
});

test('拒绝会毒化本地模型的冲突、媒体和设置结构', async () => {
  const envelope = { revision: 1, deleted: false, updatedAt: serverTimestamp() };
  await assertFails(setDoc(ownerDoc('comments', 'bad-conflict'), {
    ...envelope, data: { text: '内容' }, conflicts: [null]
  }));
  await assertFails(setDoc(ownerDoc('comments', 'bad-images'), {
    ...envelope, data: { images: ['https://example.com/a', { url: 'https://example.com/b' }] }, conflicts: []
  }));
  await assertFails(setDoc(ownerDoc('comments', 'bad-audio'), {
    ...envelope, data: { audio: ['https://example.com/a'] }, conflicts: []
  }));
  await assertFails(setDoc(ownerDoc('comments', 'long-group'), {
    ...envelope, data: { groupId: 'g'.repeat(513) }, conflicts: []
  }));
  await assertFails(setDoc(ownerDoc('settings', 'bad-order'), {
    ...envelope, data: { categoryOrder: ['uncategorized', 1] }, conflicts: []
  }));
});

test('图片列表逐项校验并限制为一百张', async () => {
  const envelope = { revision: 1, deleted: false, conflicts: [], updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(ownerDoc('comments', 'one-hundred-images'), {
    ...envelope,
    data: { images: Array.from({ length: 100 }, (_, index) => `https://example.com/${index}.jpg`) }
  }));
  await assertFails(setDoc(ownerDoc('comments', 'one-hundred-one-images'), {
    ...envelope,
    data: { images: Array.from({ length: 101 }, (_, index) => `https://example.com/${index}.jpg`) }
  }));
  await assertFails(setDoc(ownerDoc('comments', 'oversized-image-url'), {
    ...envelope,
    data: { images: [`https://example.com/${'x'.repeat(16_384)}`] }
  }));
});

test('操作回执只接受受支持集合和服务器时间', async () => {
  const ownerDb = testEnv.authenticatedContext('owner').firestore();
  const batch = writeBatch(ownerDb);
  batch.set(doc(ownerDb, 'users/owner/comments/receipt-target'), {
    data: { text: '原子写入' }, revision: 1, deleted: false, conflicts: [], updatedAt: serverTimestamp()
  });
  batch.set(doc(ownerDb, 'users/owner/operations/op-valid'), {
    collection: 'comments', recordId: 'receipt-target', createdAt: serverTimestamp()
  });
  await assertSucceeds(batch.commit());

  await assertSucceeds(setDoc(ownerDoc('comments', 'existing-target'), {
    data: { text: '已存在' }, revision: 1, deleted: false, conflicts: [], updatedAt: serverTimestamp()
  }));
  await assertFails(setDoc(ownerDoc('operations', 'standalone-receipt'), {
    collection: 'comments', recordId: 'existing-target', createdAt: serverTimestamp()
  }));
  await assertFails(setDoc(ownerDoc('operations', 'op-invalid'), {
    collection: 'secrets', recordId: 'c1', createdAt: serverTimestamp()
  }));
  await assertFails(setDoc(ownerDoc('operations', 'op-client-time'), {
    collection: 'comments', recordId: 'c1', createdAt: new Date()
  }));
  await assertFails(setDoc(ownerDoc('operations', 'op-extra'), {
    collection: 'comments', recordId: 'c1', createdAt: serverTimestamp(), extra: true
  }));
});
