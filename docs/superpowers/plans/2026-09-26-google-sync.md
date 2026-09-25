# Google 账号云同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `xhs-comment-saver` 增加独立 Firebase 项目支持，让同一 Google 账号在不同电脑和浏览器中同步评论、分类、私人笔记和 AI 总结，同时保留离线可用能力。

**Architecture:** 使用 `chrome.storage.local` 保存按 UID 隔离的本地工作区、待上传操作与同步游标，所有业务写入统一进入 Service Worker；Firebase Authentication 负责 Google 登录，Firestore 事务负责幂等增量同步，Hosting 与 offscreen 文档完成 Manifest V3 登录桥接。现有页面继续消费兼容投影，逐步移除管理页对业务存储键的直接写入。

**Tech Stack:** Chrome Extension Manifest V3、原生 JavaScript ES Modules、Firebase Authentication、Firestore Lite、Firebase Hosting、esbuild、Node.js test runner、Firebase Emulator。

## Global Constraints

- 使用独立 Firebase 项目，不复用 `x-note-saver` 的 Firebase 项目。
- 保持“加载未打包的扩展程序”工作流，最终加载目录为 `dist/extension`。
- 保留固定扩展公钥和扩展 ID。
- 不引入前端框架，不改写现有三栏布局，不增加评论导航轨道。
- 同步评论、分类、私人笔记和 AI 总结；只保存图片与音频 URL，不上传媒体文件。
- 大模型 API Key、`.env` 和 `apiconfig.json` 不进入 Firestore、构建产物或 Git。
- 所有业务写入经过 Service Worker；网络请求不能阻塞本地写入。
- 访客数据必须预览并确认后才迁移到 Google 账号。
- 新增功能遵循 TDD，测试统一放在根目录 `tests/`。
- 用户可见错误信息使用中文；关键同步、迁移和云端调用记录开发者日志。

---

## File Structure

### Create

- `package.json`：依赖、测试、构建、模拟器与部署命令。
- `package-lock.json`：锁定 Firebase、esbuild 和测试工具版本。
- `config/firebase.example.json`：公开客户端配置示例。
- `config/firebase-config.js`：读取构建期注入的 Firebase 配置。
- `auth/auth-guard.js`：配置检查和中文错误转换。
- `auth/firebase-client.js`：延迟创建 Firebase App、Auth 与 Firestore。
- `auth/auth-service.js`：登录、退出和所有者 UID 校验。
- `auth-page/index.html`：Firebase Hosting 登录桥接页面。
- `auth-page/sign-in.js`：Google 弹窗登录并向扩展回传 ID token。
- `offscreen/offscreen.html`：扩展隐藏认证文档。
- `offscreen/offscreen.js`：加载托管页面并验证认证消息。
- `storage/model.js`：记录模型、迁移、合并、墓碑与投影。
- `storage/account-state.js`：访客/账号命名空间和统一业务动作。
- `storage/local-store.js`：串行、原子地持久化状态。
- `sync/cloud-store.js`：Firestore 事务提交和增量分页读取。
- `sync/snapshot.js`：合并云端分页并保留待上传修改。
- `sync/sync-engine.js`：可恢复同步调度与退避重试。
- `manager/cloud-panel.js`：账号、同步、迁移、缓存和冲突交互。
- `manager/cloud-panel.css`：同步区样式。
- `scripts/build.js`：生成扩展、Hosting 页面和所有者规则。
- `scripts/deploy.js`：从本机配置读取项目 ID 后部署规则与 Hosting。
- `firebase.json`：Firebase Hosting、Firestore 和 Emulator 配置。
- `firestore.rules`：个人所有者访问规则和字段边界。
- `docs/firebase-setup.md`：独立 Firebase 项目创建与登录配置说明。
- `tests/auth-config.test.js`：配置、来源与过期响应测试。
- `tests/sync-model.test.js`：迁移、合并、去重、冲突和墓碑测试。
- `tests/account-state.test.js`：账号隔离和业务动作测试。
- `tests/sync-engine.test.js`：快照与同步状态机测试。
- `tests/storage-layout.test.js`：本地状态单副本和 manifest 权限测试。
- `tests/manager-cloud.test.js`：同步区和禁止直接写存储的静态约束。
- `tests/integration/firestore-rules.test.js`：真实 Emulator 规则测试。

### Modify

- `.gitignore`：忽略本机 Firebase 配置、构建目录和 Firebase 缓存。
- `manifest.json`：增加模块 Service Worker、offscreen、alarms、unlimitedStorage 和 Firebase 网络权限。
- `background/background.js`：改为统一存储、认证与同步消息路由。
- `content/content.js`：通过后台投影刷新收藏状态，不直接依赖旧数组写入。
- `manager/manager.html`：增加同步区、迁移与冲突对话框并加载脚本。
- `manager/manager.css`：接入同步区样式，保留三栏布局。
- `manager/manager.js`：删除业务键直接写入 fallback，导入、总结、清空和分类操作全部走后台。
- `README.md`：更新功能、目录、安装、构建、登录、同步和缓存说明。

---

### Task 1: Build and configuration foundation

**Files:**
- Create: `package.json`
- Create: `config/firebase.example.json`
- Create: `config/firebase-config.js`
- Create: `auth/auth-guard.js`
- Create: `scripts/build.js`
- Create: `tests/auth-config.test.js`
- Modify: `.gitignore`
- Modify: `manifest.json`

**Interfaces:**
- Produces: `config`, `isConfigured(value)`, `isOwnerConfigured(value)`, `friendlyError(error)`, `npm test`, `npm run build`.
- Consumes: existing fixed `manifest.key` and current asset/content/manager directories.

- [ ] **Step 1: Write failing configuration and manifest tests**

```js
/**
 * 验证 Firebase 配置边界和 Manifest V3 云同步权限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const guard = await import('../auth/auth-guard.js').catch(() => ({}));

test('complete Firebase config is accepted', () => {
  assert.equal(typeof guard.isConfigured, 'function');
  assert.equal(guard.isConfigured({
    apiKey: 'key', authDomain: 'project.firebaseapp.com', projectId: 'project',
    appId: 'app', authPageUrl: 'https://project.web.app', ownerUid: 'uid'
  }), true);
});

test('missing owner uid permits login setup but keeps data access disabled', () => {
  const value = { apiKey: 'key', authDomain: 'a', projectId: 'p', appId: 'a', authPageUrl: 'https://p.web.app' };
  assert.equal(guard.isConfigured(value), true);
  assert.equal(guard.isOwnerConfigured(value), false);
});

test('manifest grants required extension capabilities', async () => {
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  for (const permission of ['storage', 'unlimitedStorage', 'alarms', 'offscreen']) {
    assert.equal(manifest.permissions.includes(permission), true);
  }
  assert.equal(manifest.background.type, 'module');
  assert.equal(typeof manifest.key, 'string');
});
```

- [ ] **Step 2: Run the tests and verify the missing module failure**

Run: `node --test tests/auth-config.test.js`

Expected: FAIL because `auth/auth-guard.js` does not exist and the manifest lacks required permissions.

- [ ] **Step 3: Add package metadata and approved dependencies**

```json
{
  "name": "xhs-comment-saver",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/*.test.js",
    "build": "node scripts/build.js",
    "test:integration": "firebase emulators:exec --project demo-xhs-comment-saver --only firestore \"node --test tests/integration/*.test.js\"",
    "deploy": "node scripts/deploy.js"
  },
  "dependencies": {
    "firebase": "^12.19.0"
  },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^5.0.2",
    "esbuild": "^0.28.2",
    "firebase-tools": "^15.30.2"
  }
}
```

Run: `npm install`

Expected: `package-lock.json` is created without audit errors that block installation.

- [ ] **Step 4: Implement configuration guards**

```js
/**
 * 检查 Firebase 构建配置并把外部错误转换为中文提示。
 */
const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'appId', 'authPageUrl'];

export function isConfigured(value) {
  return !!value && REQUIRED.every(key => typeof value[key] === 'string' && value[key].trim());
}

export function isOwnerConfigured(value) {
  return isConfigured(value) && typeof value.ownerUid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.ownerUid);
}

export function friendlyError(error) {
  if (error?.code === 'permission-denied') return '云端权限被拒绝，请检查登录账号和数据库规则';
  if (error?.code === 'auth/network-request-failed') return '网络连接失败，本地修改会保留并稍后重试';
  if (error?.code === 'resource-exhausted') return '云端免费配额暂时不足，本地修改已保留';
  return error?.message || '云同步暂时不可用，本地修改已保留';
}
```

`config/firebase-config.js` 导出构建时的常量；未构建源码测试时返回空对象：

```js
/**
 * 暴露构建期注入的 Firebase 公共配置。
 */
export const config = typeof __FIREBASE_CONFIG__ === 'undefined' ? {} : __FIREBASE_CONFIG__;
export const extensionId = typeof __EXTENSION_ID__ === 'undefined' ? '' : __EXTENSION_ID__;
```

- [ ] **Step 5: Update manifest and build script**

Manifest 使用模块 Service Worker，增加 `unlimitedStorage`、`alarms`、`offscreen`，允许 Google APIs 与独立 Hosting 域。`scripts/build.js` 必须：

```js
/**
 * 构建可加载扩展、Firebase Hosting 页面和绑定所有者的规则。
 */
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { isConfigured } from '../auth/auth-guard.js';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const firebaseConfig = JSON.parse(await readFile('config/firebase.local.json', 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return '{}';
}));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + Number.parseInt(value, 16)));
if (Object.keys(firebaseConfig).length && !isConfigured(firebaseConfig)) throw new Error('Firebase 配置不完整');
await rm('dist', { recursive: true, force: true });
await mkdir('dist/extension', { recursive: true });
await mkdir('dist/hosting', { recursive: true });
for (const directory of ['assets', 'content', 'manager']) await cp(directory, `dist/extension/${directory}`, { recursive: true });
const define = { __FIREBASE_CONFIG__: JSON.stringify(firebaseConfig), __EXTENSION_ID__: JSON.stringify(extensionId) };
await build({ entryPoints: ['background/background.js'], outfile: 'dist/extension/background/background.js', bundle: true, format: 'esm', platform: 'browser', target: 'chrome116', define });
await build({ entryPoints: ['offscreen/offscreen.js'], outfile: 'dist/extension/offscreen/offscreen.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', define });
await build({ entryPoints: ['auth-page/sign-in.js'], outfile: 'dist/hosting/sign-in.js', bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', define });
await cp('offscreen/offscreen.html', 'dist/extension/offscreen/offscreen.html');
await cp('auth-page/index.html', 'dist/hosting/index.html');
const builtManifest = structuredClone(manifest);
builtManifest.background.service_worker = 'background/background.js';
await writeFile('dist/extension/manifest.json', JSON.stringify(builtManifest, null, 2) + '\n');
await writeFile('dist/firestore.rules', (await readFile('firestore.rules', 'utf8')).replaceAll('__OWNER_UID__', firebaseConfig.ownerUid || '__OWNER_UID__'));
await writeFile('dist/extension-id.txt', extensionId + '\n');
console.log(`构建完成：dist/extension\n扩展 ID：${extensionId}`);
```

- [ ] **Step 6: Ignore local and generated files**

Append exactly:

```gitignore
# Firebase 本机配置与缓存
config/firebase.local.json
.firebase/
.firebaserc
firebase-debug.log

# 构建产物
dist/
build/
*.tsbuildinfo
```

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run build && git diff --check`

Expected: configuration tests pass; build succeeds in local-only mode and creates `dist/extension-id.txt`.

```bash
git add package.json package-lock.json manifest.json .gitignore config auth/auth-guard.js scripts/build.js tests/auth-config.test.js
git commit -m "新增: 建立云同步构建基础"
```

---

### Task 2: Versioned comment data model and legacy migration

**Files:**
- Create: `storage/model.js`
- Create: `tests/sync-model.test.js`

**Interfaces:**
- Produces: `COLLECTIONS`, `emptyWorkspace()`, `commentIdentity(comment)`, `migrateLegacy(comments, categories, summaries)`, `enqueueOperation(workspace, collection, recordId, patch, options)`, `mergeOperation(record, operation)`, `acknowledge(workspace, operationId, record)`, `visibleRecords(workspace)`, `project(workspace)`, `mergeGuest(guest, account)`, `migrationPreview(guest, account)`.
- Consumes: current comment fields `commentId`, `key`, `text`, `author`, `postUrl`, `postTitle`, `images`, `audio`, `groupId`, `groupIndex`, `category`, `note`, `savedAt`.

- [ ] **Step 1: Write focused model tests**

```js
/**
 * 验证评论云同步的纯数据模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../storage/model.js';

test('legacy comments with the same comment id migrate to one record', async () => {
  const space = await model.migrateLegacy([
    { id: 'old-a', commentId: 'abc123', text: '同一条', category: '好物', savedAt: 2 },
    { id: 'old-b', commentId: 'abc123', text: '同一条', category: '好物', savedAt: 1 }
  ], ['未分类', '好物'], {});
  assert.equal(Object.keys(space.remote.comments).length, 1);
});

test('missing comment id uses a deterministic fallback identity', async () => {
  const source = { postUrl: 'https://www.xiaohongshu.com/explore/1', author: '甲', text: '内容' };
  assert.equal(await model.commentIdentity(source), await model.commentIdentity({ ...source }));
});

test('renaming a category preserves comment membership and summary', async () => {
  const space = await model.migrateLegacy([{ id: 'a', key: 'k', category: '好物' }], ['未分类', '好物'], { 好物: { content: '总结' } });
  const category = Object.entries(space.remote.categories).find(([, value]) => value.data.name === '好物');
  const comment = Object.values(space.remote.comments)[0];
  assert.equal(comment.data.categoryId, category[0]);
  assert.equal(space.remote.summaries[category[0]].data.content, '总结');
});

test('concurrent private notes preserve the losing version as a conflict', () => {
  const remote = { data: { note: '云端' }, revision: 1, deleted: false, conflicts: [] };
  const op = { id: 'op', collection: 'comments', recordId: 'c', baseRevision: 1, patch: { note: '本地' }, baseData: { note: '旧值' } };
  const merged = model.mergeOperation({ ...remote, revision: 2, data: { note: '另一台设备' } }, op);
  assert.equal(merged.data.note, '另一台设备');
  assert.equal(merged.conflicts[0].local, '本地');
});

test('a stale edit cannot resurrect a tombstone', () => {
  const tombstone = { data: {}, revision: 4, deleted: true, conflicts: [] };
  const edit = { id: 'op', collection: 'comments', recordId: 'c', baseRevision: 2, patch: { note: '离线编辑' }, baseData: {} };
  assert.equal(model.mergeOperation(tombstone, edit).deleted, true);
});

test('explicit recollection restores a deleted comment', () => {
  const tombstone = { data: {}, revision: 4, deleted: true, conflicts: [] };
  const restore = { id: 'op', collection: 'comments', recordId: 'c', baseRevision: 4, patch: { text: '恢复' }, baseData: {}, restore: true };
  assert.equal(model.mergeOperation(tombstone, restore).deleted, false);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/sync-model.test.js`

Expected: FAIL because `storage/model.js` does not exist.

- [ ] **Step 3: Implement the model with immutable operations**

Use these exact collection names and workspace shape:

```js
/**
 * 评论、分类和总结的版本化同步模型。
 */
export const COLLECTIONS = ['comments', 'categories', 'summaries', 'settings'];
export const emptyWorkspace = () => ({
  remote: { comments: {}, categories: {}, summaries: {}, settings: {} },
  pending: [],
  cursors: { comments: null, categories: null, summaries: null, settings: null },
  lastSync: 0
});

export async function commentIdentity(comment) {
  if (comment.commentId) return `comment-${String(comment.commentId).toLowerCase()}`;
  const input = [comment.postUrl || '', comment.author || '', comment.text || ''].join('\u001f');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return `fallback-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
```

`mergeOperation` must compare `baseRevision` and `baseData`, merge unrelated fields, add bounded conflict entries only for `comments.note` and `summaries.content`, keep tombstones unless `restore === true`, and cap each conflict text at 100,000 characters with at most five unresolved versions.

Default category IDs are fixed as `uncategorized`（未分类）、`good-things`（好物）、`warnings`（避雷）and `funny`（搞笑）; custom categories use `crypto.randomUUID()`.

`project` must return the existing UI contract:

```js
{
  comments: [{ id, ...commentData, category: categoryName, noteConflicts }],
  categories: ['未分类', ...orderedNames],
  summaries: { [categoryName]: summaryData }
}
```

- [ ] **Step 4: Add migration and import edge tests**

Cover invalid comments, duplicate fallback keys, missing categories moving to `未分类`, summaries keyed by old category names, group metadata preservation, note length boundary, conflict count boundary and migration preview counts.

Run: `node --test tests/sync-model.test.js`

Expected: all model tests pass.

- [ ] **Step 5: Commit**

```bash
git add storage/model.js tests/sync-model.test.js
git commit -m "新增: 建立评论同步数据模型"
```

---

### Task 3: Account isolation and atomic local storage

**Files:**
- Create: `storage/account-state.js`
- Create: `storage/local-store.js`
- Create: `tests/account-state.test.js`
- Create: `tests/storage-layout.test.js`

**Interfaces:**
- Produces: `createState(comments, categories, summaries)`, `activateAccount(state, user)`, `currentWorkspace(state)`, `mutate(state, message)`, `LocalStore.read()`, `LocalStore.update(callback)`, `STATE_KEY`.
- Consumes: all model functions from Task 2.

- [ ] **Step 1: Write account boundary tests**

```js
/**
 * 验证访客与 Google 账号的数据和队列隔离。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, activateAccount, currentWorkspace, mutate } from '../storage/account-state.js';

test('switching accounts never moves pending changes into another account', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a', email: 'a@example.com' });
  await mutate(state, { action: 'saveComment', data: { commentId: '1', text: 'A', category: '未分类' } });
  activateAccount(state, { uid: 'b', email: 'b@example.com' });
  assert.equal(currentWorkspace(state).pending.length, 0);
  activateAccount(state, { uid: 'a', email: 'a@example.com' });
  assert.equal(currentWorkspace(state).pending.length, 1);
});

test('guest mutations stay local without a cloud queue', async () => {
  const state = await createState([], ['未分类'], {});
  await mutate(state, { action: 'saveComment', data: { commentId: '1', text: '访客', category: '未分类' } });
  assert.equal(state.guest.pending.length, 0);
});

test('import queues new comments summaries and categories for a signed in user', async () => {
  const state = await createState([], ['未分类'], {});
  activateAccount(state, { uid: 'a' });
  await mutate(state, { action: 'importData', data: { comments: [{ id: 'x', commentId: '1', category: '好物' }], categories: ['未分类', '好物'], summaries: { 好物: { content: '总结' } } } });
  const kinds = new Set(currentWorkspace(state).pending.map(item => item.collection));
  assert.deepEqual(kinds, new Set(['comments', 'categories', 'summaries', 'settings']));
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/account-state.test.js tests/storage-layout.test.js`

Expected: FAIL because account and store modules do not exist.

- [ ] **Step 3: Implement account state and action mapping**

`createState` returns version 2 state; `activateAccount` only switches namespaces. `mutate` supports exactly:

```text
saveComment
saveCommentGroup
deleteComment
updateNote
updateCategory
addCategory
renameCategory
deleteCategory
reorderCategories
saveSummary
deleteSummary
importData
clearAll
resolveConflict
```

All inputs are validated at this boundary. Category names are trimmed and limited to 40 characters; notes and summaries are strings with the model size boundary; imported data is validated completely before the first mutation.

- [ ] **Step 4: Implement serial LocalStore writes**

```js
/**
 * 串行保存账号状态并广播兼容投影。
 */
import { createState, currentWorkspace } from './account-state.js';
import { project } from './model.js';

export const STATE_KEY = 'xhs_comment_state_v2';

export class LocalStore {
  constructor() { this.tail = Promise.resolve(); }
  update(callback) {
    const task = this.tail.then(async () => {
      const saved = await chrome.storage.local.get([STATE_KEY, 'xhs_comments', 'xhs_categories', 'xhs_summaries']);
      const state = saved[STATE_KEY] || await createState(saved.xhs_comments || [], saved.xhs_categories || ['未分类', '好物', '避雷', '搞笑'], saved.xhs_summaries || {});
      const result = await callback(state);
      const projection = project(currentWorkspace(state));
      await chrome.storage.local.set({
        [STATE_KEY]: state,
        xhs_comments: projection.comments,
        xhs_categories: projection.categories,
        xhs_summaries: projection.summaries
      });
      return result;
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async read() {
    await this.tail;
    const saved = await chrome.storage.local.get(STATE_KEY);
    return saved[STATE_KEY] || null;
  }
}
```

- [ ] **Step 5: Verify storage footprint and commit**

`tests/storage-layout.test.js` must assert `unlimitedStorage` is present and the v2 state does not create a second legacy backup key.

Run: `npm test`

Expected: all unit tests pass.

```bash
git add storage tests/account-state.test.js tests/storage-layout.test.js
git commit -m "新增: 隔离账号本地工作区"
```

---

### Task 4: Unified background business routing

**Files:**
- Modify: `background/background.js`
- Modify: `content/content.js`
- Modify: `tests/account-state.test.js`

**Interfaces:**
- Produces background actions: `getComments`, `getCategories`, `getSummaries`, all mutation actions from Task 3, plus cloud actions added later.
- Consumes: `LocalStore`, `mutate`, `project`, `currentWorkspace`.

- [ ] **Step 1: Add tests for legacy message compatibility**

Add tests proving `saveCommentGroup` preserves one `groupId`, `updateCategory` changes every comment in that group, category deletion moves affected comments to `uncategorized`, and `getComments` returns the legacy card shape.

Run: `node --test tests/account-state.test.js`

Expected: FAIL until missing mutations are implemented.

- [ ] **Step 2: Replace direct array CRUD in the Service Worker**

Use a single store and one dispatch function:

```js
/**
 * Service Worker：统一处理本地数据、认证和云同步消息。
 */
import { LocalStore } from '../storage/local-store.js';
import { currentWorkspace, mutate } from '../storage/account-state.js';
import { project } from '../storage/model.js';

const store = new LocalStore();

async function handleLocal(message) {
  if (message.action === 'getComments') return project(currentWorkspace(await store.read())).comments;
  if (message.action === 'getCategories') return project(currentWorkspace(await store.read())).categories;
  if (message.action === 'getSummaries') return project(currentWorkspace(await store.read())).summaries;
  return store.update(state => mutate(state, message));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(data => sendResponse({ success: true, data }))
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
```

Initialize default data through `LocalStore.update`, retain the existing click-to-open-manager behavior, and log mutation failures with action name but without comment contents.

- [ ] **Step 3: Refresh content-script saved state from background**

Keep existing `getComments` and `getCategories` messages. Add a `dataChanged` listener that reruns the saved-ID/key refresh without reloading the page. Do not expose private notes or summaries to page DOM.

- [ ] **Step 4: Verify existing collection behavior and commit**

Run: `npm test && npm run build`

Expected: tests and local-only build pass; existing content-script actions still use their original response shapes.

```bash
git add background/background.js content/content.js tests/account-state.test.js
git commit -m "重构: 统一评论数据写入入口"
```

---

### Task 5: Google authentication bridge

**Files:**
- Create: `auth/firebase-client.js`
- Create: `auth/auth-service.js`
- Create: `auth-page/index.html`
- Create: `auth-page/sign-in.js`
- Create: `offscreen/offscreen.html`
- Create: `offscreen/offscreen.js`
- Modify: `background/background.js`
- Modify: `tests/auth-config.test.js`

**Interfaces:**
- Produces: `firebaseClient()`, `login()`, `logout()`, Firebase auth-state callback, background actions `cloudLogin`, `cloudLogout`, `cloudStatus`.
- Consumes: build-time `config`, `extensionId`, Firebase `initializeApp`, `getAuth`, `GoogleAuthProvider`, `signInWithCredential`.

- [ ] **Step 1: Test origin, request ID and response-age guards**

```js
test('auth bridge rejects another extension origin', () => {
  assert.equal(guard.acceptAuthMessage({ origin: 'chrome-extension://wrong', requestId: 'r', issuedAt: Date.now() }, { extensionId: 'right', requestId: 'r', now: Date.now() }), false);
});

test('auth bridge rejects stale responses', () => {
  const now = Date.now();
  assert.equal(guard.acceptAuthMessage({ origin: 'chrome-extension://right', requestId: 'r', issuedAt: now - 121000 }, { extensionId: 'right', requestId: 'r', now }), false);
});

test('auth bridge accepts matching fresh response', () => {
  const now = Date.now();
  assert.equal(guard.acceptAuthMessage({ origin: 'chrome-extension://right', requestId: 'r', issuedAt: now }, { extensionId: 'right', requestId: 'r', now }), true);
});
```

Run: `node --test tests/auth-config.test.js`

Expected: FAIL because `acceptAuthMessage` is missing.

- [ ] **Step 2: Implement auth message validation**

`acceptAuthMessage` must require exact extension origin, exact request ID and an age from 0 through 120 seconds. `auth-page/sign-in.js` must check the parent origin supplied by the build and return only `idToken`, `requestId` and `issuedAt`.

- [ ] **Step 3: Implement lazy Firebase client and auth service**

```js
/**
 * 延迟创建 Firebase 客户端，未配置时保持纯本地模式。
 */
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth/web-extension';
import { getFirestore } from 'firebase/firestore/lite';
import { config } from '../config/firebase-config.js';
import { isConfigured } from './auth-guard.js';

let client;
export function firebaseClient() {
  if (!isConfigured(config)) return null;
  if (!client) {
    const app = initializeApp(config);
    client = { app, auth: getAuth(app), db: getFirestore(app) };
  }
  return client;
}
```

`login()` creates exactly one offscreen document, sends a unique request ID, signs in with the returned Google credential, checks `signed.user.uid === config.ownerUid`, and always closes the offscreen document in `finally`.

- [ ] **Step 4: Connect auth state to account namespaces**

On Firebase auth state change, call `activateAccount` inside `LocalStore.update`. Logout switches to guest space but retains the signed-out account workspace.

- [ ] **Step 5: Verify local-only and configured builds, then commit**

Run: `npm test && npm run build`

Expected: local-only build succeeds; auth tests pass; no remote script appears in extension CSP.

```bash
git add auth auth-page offscreen background/background.js tests/auth-config.test.js
git commit -m "新增: 接入 Google 账号登录"
```

---

### Task 6: Firestore transactions and personal security rules

**Files:**
- Create: `sync/cloud-store.js`
- Create: `firestore.rules`
- Create: `firebase.json`
- Create: `tests/integration/firestore-rules.test.js`
- Create: `scripts/deploy.js`

**Interfaces:**
- Produces: `CloudStore.commit(uid, operation)`, `CloudStore.pull(uid, collection, cursor)`, deploy command using `config/firebase.local.json.projectId`.
- Consumes: Firebase client DB, Task 2 record schema and collections.

- [ ] **Step 1: Write real Emulator rules tests**

Tests use `initializeTestEnvironment` and cover:

```js
test('unauthenticated user cannot read comments', async () => {
  await assertFails(getDoc(testEnv.unauthenticatedContext().firestore().doc('users/owner/comments/c1')));
});

test('another uid cannot read owner data', async () => {
  await assertFails(getDoc(testEnv.authenticatedContext('other').firestore().doc('users/owner/comments/c1')));
});

test('owner can write a valid comment record', async () => {
  await assertSucceeds(setDoc(testEnv.authenticatedContext('owner').firestore().doc('users/owner/comments/c1'), {
    data: { text: '内容' }, revision: 1, deleted: false, conflicts: [], updatedAt: serverTimestamp()
  }));
});
```

Also reject unknown collections, extra top-level fields, non-integer revision, client timestamps and operation receipts that reference unsupported collections.

- [ ] **Step 2: Run Emulator tests and verify rule failure**

Run: `npm run test:integration`

Expected: FAIL because `firebase.json` and `firestore.rules` do not exist.

- [ ] **Step 3: Implement owner-only rules**

Rules must use this structure:

```text
match /users/{uid}/{kind}/{id}
owner(uid) = authenticated UID equals path UID and __OWNER_UID__
business kinds = comments, categories, summaries, settings
receipt kind = operations
```

Business writes allow only `data`, `revision`, `deleted`, `conflicts`, `updatedAt`; receipt creation allows only `collection`, `recordId`, `createdAt`. `updatedAt` and `createdAt` must equal `request.time`.

- [ ] **Step 4: Implement idempotent CloudStore**

`commit` runs one Firestore transaction:

1. Read `users/{uid}/operations/{operation.id}`.
2. If present, read and return the current target record.
3. Otherwise read target record, call `mergeOperation`, write the new record with `serverTimestamp()` and create the receipt.

`pull` queries by `updatedAt`, then document ID, with a bounded page size of 200 and cursor overlap at the boundary timestamp.

- [ ] **Step 5: Implement deterministic deployment script**

`scripts/deploy.js` reads `config/firebase.local.json`, validates `projectId` and `ownerUid`, runs `npm run build`, then invokes the local Firebase CLI with an argument array built from the validated config:

```js
const firebaseCliArguments = ['deploy', '--project', config.projectId, '--only', 'firestore:rules,hosting'];
```

The script must stop before deployment if `dist/firestore.rules` still contains `__OWNER_UID__`.

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run test:integration && npm run build`

Expected: unit tests, real rules tests and build pass.

```bash
git add sync/cloud-store.js firestore.rules firebase.json scripts/deploy.js tests/integration/firestore-rules.test.js
git commit -m "新增: 实现 Firestore 增量存储"
```

---

### Task 7: Recoverable sync engine

**Files:**
- Create: `sync/snapshot.js`
- Create: `sync/sync-engine.js`
- Create: `tests/sync-engine.test.js`
- Modify: `background/background.js`

**Interfaces:**
- Produces: `applyPage(workspace, collection, page)`, `SyncEngine.sync({ force })`, background actions `syncNow`, `clearCache`, `migrationPreview`, `confirmMigration`.
- Consumes: `LocalStore`, `CloudStore`, auth state, model `acknowledge`, `COLLECTIONS`.

- [ ] **Step 1: Write snapshot and account-switch tests**

```js
/**
 * 验证拉取快照和同步状态机。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkspace, enqueueOperation, project } from '../storage/model.js';
import { applyPage } from '../sync/snapshot.js';

test('older cloud snapshot cannot overwrite a newer local remote version', () => {
  const space = emptyWorkspace();
  space.remote.comments.c = { data: { note: '新版' }, revision: 3, deleted: false, conflicts: [] };
  applyPage(space, 'comments', { records: [{ id: 'c', record: { data: { note: '旧版' }, revision: 2, deleted: false, conflicts: [] } }], cursor: { seconds: 1, nanoseconds: 0, id: 'c' } });
  assert.equal(project(space).comments[0].note, '新版');
});

test('cloud pull preserves pending local edits', () => {
  const space = enqueueOperation(emptyWorkspace(), 'comments', 'c', { note: '本地未发送' });
  applyPage(space, 'comments', { records: [{ id: 'c', record: { data: { note: '云端' }, revision: 1, deleted: false, conflicts: [] } }], cursor: { seconds: 1, nanoseconds: 0, id: 'c' } });
  assert.equal(project(space).comments[0].note, '本地未发送');
});
```

Add a pure state-guard test for `applyAcknowledgement(state, capturedUid, operationId, record)`: switch `state.activeUid` before calling it and assert it leaves the new account untouched. Firestore behavior remains covered by the real Emulator tests without mocking service responses.

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/sync-engine.test.js`

Expected: FAIL because sync modules do not exist.

- [ ] **Step 3: Implement snapshot merge**

```js
/**
 * 合并云分页并重放尚未上传的本地操作。
 */
export function applyPage(workspace, collection, page) {
  for (const { id, record } of page.records) {
    const previous = workspace.remote[collection][id];
    if (!previous || record.revision >= previous.revision) workspace.remote[collection][id] = record;
  }
  if (page.cursor) workspace.cursors[collection] = page.cursor;
}
```

Projection functions must always replay `workspace.pending` after reading `workspace.remote`.

- [ ] **Step 4: Implement bounded sync runs**

The engine must:

- Return the existing promise when a sync is already running.
- Capture UID before network work and recheck it before every applied page and receipt.
- Pull every collection before uploads.
- Commit at most 100 operations per run.
- Persist each page and each acknowledgment separately.
- Set `synced` only when no pending operation remains.
- Schedule `cloud-sync-next` after 30 seconds if work remains.
- On error, retain the queue and use exponential retry from 30 seconds up to one hour.

- [ ] **Step 5: Connect automatic triggers**

Trigger sync after login, after logged-in mutations, on `syncNow`, on `chrome.alarms.onAlarm`, and after migration confirmation. `clearCache` must reject when pending operations exist, clear only the current account remote snapshot/cursors, then force a fresh pull.

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run test:integration && npm run build`

Expected: all checks pass; failed sync leaves local data and queue intact.

```bash
git add sync/snapshot.js sync/sync-engine.js background/background.js tests/sync-engine.test.js
git commit -m "新增: 实现可恢复云同步引擎"
```

---

### Task 8: Manager integration and removal of direct business writes

**Files:**
- Create: `manager/cloud-panel.js`
- Create: `manager/cloud-panel.css`
- Create: `tests/manager-cloud.test.js`
- Modify: `manager/manager.html`
- Modify: `manager/manager.css`
- Modify: `manager/manager.js`

**Interfaces:**
- Produces user controls for login, sync, migration, conflicts, cache and logout.
- Consumes background actions `cloudStatus`, `cloudLogin`, `cloudLogout`, `syncNow`, `migrationPreview`, `confirmMigration`, `clearCache`, `resolveConflict` and all local CRUD actions.

- [ ] **Step 1: Write UI contract tests**

```js
/**
 * 验证管理页云同步入口和统一写入约束。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('manager/manager.html', 'utf8');
const manager = await readFile('manager/manager.js', 'utf8');

test('manager exposes all cloud controls', () => {
  for (const id of ['cloud-account', 'cloud-status', 'cloud-login', 'cloud-sync', 'cloud-cache', 'cloud-logout', 'cloud-migrate']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('manager no longer writes synchronized business keys directly', () => {
  assert.doesNotMatch(manager, /chrome\.storage\.local\.set\s*\(\s*\{[^}]*xhs_(comments|categories|summaries)/s);
  assert.doesNotMatch(manager, /chrome\.storage\.local\.remove\s*\(\s*\[[^\]]*xhs_(comments|categories|summaries)/s);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test tests/manager-cloud.test.js`

Expected: FAIL because cloud controls are absent and direct writes remain.

- [ ] **Step 3: Add the cloud status area without changing the three-column layout**

Place the status row in the existing top header. Use text buttons matching current controls. Do not add a list navigation rail or change sidebar/category behavior.

The status states are exactly:

```text
未配置云服务 · 当前保存在本机
仅保存在本机
等待同步 · N 项待上传
正在同步… · N 项待上传
已同步 · HH:MM:SS
同步失败原因 · N 项待上传
```

- [ ] **Step 4: Implement safe cloud interactions**

`manager/cloud-panel.js` must render user text with `textContent`, never `innerHTML`. Migration requires a downloadable JSON backup before enabling confirmation. Conflict dialogs show current and alternate note/summary versions in textareas and call `resolveConflict` with selected conflict IDs.

- [ ] **Step 5: Route every manager mutation through the background**

Replace these direct writes and fallback branches:

- Initial dedupe write-back.
- Note editing fallback.
- Category-change fallback.
- Comment-delete fallback.
- Category delete/rename/add direct writes.
- Summary autosave.
- Confirmed import.
- Clear-all action.

Use one helper:

```js
/** 向后台发送业务动作，并统一处理错误。 */
async function sendAction(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...payload });
  if (!response?.success) throw new Error(response?.error || '后台暂时不可用，请重新加载扩展');
  return response.data;
}
```

`confirmImport` calls `importData`; `saveSummariesToStorage` calls `saveSummary`; clearing data calls `clearAll`. A background failure displays a Chinese toast and does not perform a second direct storage write.

- [ ] **Step 6: Update storage display semantics**

Keep the existing local storage meter only if it accurately reads unlimited local storage; change its text to explain it is a local cache/work copy and not Firebase quota. Do not present the local number as a cloud limit.

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run build && git diff --check`

Expected: UI contract passes; no synchronized business key is written directly by `manager.js`; three-column layout remains.

```bash
git add manager tests/manager-cloud.test.js
git commit -m "新增: 接入评论云同步管理界面"
```

---

### Task 9: Firebase project setup, documentation and end-to-end validation

**Files:**
- Create: `docs/firebase-setup.md`
- Create locally and ignore: `config/firebase.local.json`
- Modify: `README.md`
- Modify: `config/firebase.example.json`

**Interfaces:**
- Produces a configured independent Firebase project, deployed Hosting bridge and owner-only rules.
- Consumes: user-created Firebase project, Web App config and authenticated Firebase CLI session.

- [ ] **Step 1: Document the exact Firebase console workflow**

`docs/firebase-setup.md` must direct the user to:

1. Create a new Firebase project dedicated to `xhs-comment-saver` on the Spark plan.
2. Add a Web App and copy its public configuration.
3. Enable Authentication → Google provider.
4. Create Firestore in production mode in the preferred region.
5. Enable Firebase Hosting.
6. Build once and read `dist/extension-id.txt`.
7. Deploy Hosting, complete Google login, copy the shown UID into `ownerUid`.
8. Rebuild and deploy owner-bound Firestore rules.
9. Load `dist/extension` through Chrome’s “加载未打包的扩展程序”.

The guide must state that Firebase Web configuration is public client configuration, while `.env` API keys remain local.

- [ ] **Step 2: Add the local config with real console values**

Copy the complete Web App configuration object from the new Firebase console into `config/firebase.local.json`, add `authPageUrl` using that project’s deployed HTTPS Hosting origin, and do not insert dummy values. Build and deploy the login page first without `ownerUid`; after the first successful Google login displays the real UID, add that exact UID as `ownerUid`, rebuild, and deploy the owner-bound rules. The file remains ignored throughout.

- [ ] **Step 3: Deploy and verify rules**

Run: `npm run deploy`

Expected: Hosting and Firestore rules deploy to the `projectId` read from local configuration, and generated rules contain the real owner UID.

- [ ] **Step 4: Run automated verification**

Run:

```bash
npm test
npm run test:integration
npm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Run browser acceptance in two profiles**

Use two Chrome profiles with the same unpacked `dist/extension`:

1. Profile A logs in, migrates existing local data after downloading the offered JSON backup, and waits for “已同步”.
2. Profile B logs into the same Google account and receives comments, categories, notes and summaries.
3. Disconnect Profile B, save a comment and edit a note, reconnect, and verify the queue uploads.
4. Collect the same comment in both profiles and verify only one comment exists.
5. Delete a comment in A while B is offline, edit its old copy in B, reconnect, and verify the tombstone wins.
6. Import a JSON backup in A and verify new records appear in B.
7. Clear local cache in B and verify data downloads again.
8. Log into a different Google account and verify owner-only access is refused without exposing cached owner data.
9. Confirm category create/rename/delete, AI summaries, growth views and the three-column layout still work.
10. Confirm there is no comment navigation rail.

- [ ] **Step 6: Update README**

Update feature description, directory tree, dependencies, build commands, unpacked extension path, Google login flow, local-cache meaning, import synchronization, clear-cache behavior and link to `docs/firebase-setup.md`.

- [ ] **Step 7: Request code review and fix important findings**

Use the `requesting-code-review` skill. Review requirements: account isolation, lost-update risks, Firestore rule bypass, XSS in conflict/migration dialogs, Service Worker restart recovery, direct storage writes and accidental API-key inclusion. Fix every P1/P2 issue and rerun the affected checks.

- [ ] **Step 8: Commit final docs and verified configuration templates**

```bash
git add README.md docs/firebase-setup.md config/firebase.example.json
git commit -m "文档: 补充评论云同步配置指南"
```

Do not add `config/firebase.local.json`, `.env`, Firebase CLI credentials, build output or API keys.

---

## Final Verification Checklist

- [ ] `npm test` passes.
- [ ] `npm run test:integration` passes against the real Firestore Emulator.
- [ ] `npm run build` creates a loadable `dist/extension` and `dist/hosting`.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] `git status --short --ignored` confirms local Firebase and API configurations are ignored.
- [ ] The same Google account restores all synchronized user data in a second browser profile.
- [ ] A different Google account cannot read or write the owner’s Firestore data.
- [ ] Offline writes survive browser and Service Worker restarts.
- [ ] Import synchronizes; local cache clearing does not delete cloud data.
- [ ] Existing collection, classification, note, AI summary and growth-view flows still work.
- [ ] No comment navigation rail is present.
- [ ] README matches the built extension workflow.
