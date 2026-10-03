<!--
  本文档给出小红书评论收藏分类拖拽排序的测试先行实施步骤。
-->

# Category Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让小红书评论收藏管理页中的自定义分类可通过拖拽手柄调整顺序，并把顺序保存到本机及当前登录账号的同步队列。

**Architecture:** 新增一个无 DOM 依赖的分类顺序计算模块，管理页只负责拖拽事件、乐观渲染和后台消息。现有 `reorderCategories` 业务动作继续负责校验完整分类集合、更新 `settings/main.categoryOrder`，因此不改动同步协议。

**Tech Stack:** 原生 JavaScript、Chrome Extension Manifest V3、HTML5 Drag and Drop、Node.js `node:test`、现有版本化账号存储与 Firebase 同步队列。

## Global Constraints

- “全部”始终固定在顶部，不写入分类顺序。
- “未分类”固定在“全部”之后，不可拖拽、重命名或删除。
- 其余预设分类和用户新建分类均可拖拽排序。
- 拖动只能从手柄开始；普通分类点击继续用于筛选。
- 保留现有新建、重命名、删除、筛选、AI 总结与评论分类切换行为。
- 保存失败时显示中文提示并重新读取后台权威顺序。
- 不新增第三方依赖，不实现移动端触控排序。
- 新增 JavaScript 文件顶部使用中文多行注释，核心函数和关键拖放判断使用中文注释。
- README 与功能代码同步更新；每个独立任务使用中文 Git 提交信息。

---

### Task 1: 可测试的分类顺序计算

**Files:**
- Create: `manager/category-order.js`
- Create: `tests/category-order.test.js`
- Modify: `manager/manager.html`（在 `manager.js` 前加载顺序模块）

**Interfaces:**
- Consumes: `categories: string[]`，其中包含固定分类 `未分类`；`dragged` 和 `target` 为自定义分类名；`before` 表示插入目标上方或下方。
- Produces: `globalThis.XHS_CATEGORY_ORDER.moveCategory(categories, dragged, target, before): string[]`，返回以 `未分类` 开头的完整新顺序；无效拖放返回原顺序副本。

- [ ] **Step 1: 写失败测试**

在 `tests/category-order.test.js` 中写入：

```js
/**
 * 验证分类拖拽排序的纯顺序计算，不依赖浏览器 DOM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('manager/category-order.js', 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const { moveCategory } = context.globalThis.XHS_CATEGORY_ORDER;

test('把分类插入目标上方并固定未分类', () => {
  assert.deepEqual(
    Array.from(moveCategory(['未分类', '好物', '避雷', '搞笑'], '搞笑', '好物', true)),
    ['未分类', '搞笑', '好物', '避雷']
  );
});

test('把分类插入目标下方', () => {
  assert.deepEqual(
    Array.from(moveCategory(['未分类', '好物', '避雷', '搞笑'], '好物', '避雷', false)),
    ['未分类', '避雷', '好物', '搞笑']
  );
});

test('拒绝拖动未分类、未知分类和原地拖放', () => {
  const original = ['未分类', '好物', '避雷'];
  for (const args of [
    ['未分类', '好物', true],
    ['未知', '好物', true],
    ['好物', '未知', true],
    ['好物', '好物', true]
  ]) {
    assert.deepEqual(Array.from(moveCategory(original, ...args)), original);
  }
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/category-order.test.js`

Expected: FAIL，错误指出 `manager/category-order.js` 不存在或 `moveCategory` 未定义。

- [ ] **Step 3: 实现最小顺序模块**

创建 `manager/category-order.js`：

```js
/**
 * 分类排序纯逻辑：计算拖放后的完整分类顺序。
 */
(function initializeCategoryOrder(global) {
  const FIXED_CATEGORY = '未分类';

  /** 将 dragged 插入 target 上方或下方，无效拖放返回原顺序副本。 */
  function moveCategory(categories, dragged, target, before) {
    const original = [...categories];
    const sortable = original.filter(name => name !== FIXED_CATEGORY);
    if (dragged === FIXED_CATEGORY || target === FIXED_CATEGORY || dragged === target
        || !sortable.includes(dragged) || !sortable.includes(target)) return original;

    const next = sortable.filter(name => name !== dragged);
    let insertAt = next.indexOf(target);
    if (!before) insertAt += 1;
    next.splice(insertAt, 0, dragged);
    return [FIXED_CATEGORY, ...next];
  }

  global.XHS_CATEGORY_ORDER = Object.freeze({ moveCategory });
})(globalThis);
```

在 `manager/manager.html` 的脚本区加入：

```html
<script src="category-order.js"></script>
<script src="manager.js"></script>
```

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test tests/category-order.test.js`

Expected: 3 tests PASS。

- [ ] **Step 5: 提交纯逻辑**

```bash
git add manager/category-order.js manager/manager.html tests/category-order.test.js
git commit -m "新增: 分类拖拽顺序计算"
```

---

### Task 2: 侧边栏拖拽交互与持久化

**Files:**
- Modify: `manager/manager.js`（状态区、`renderCategories`、`createCategoryItem`、分类管理区）
- Modify: `manager/manager.css`（通用手柄和拖放反馈）
- Modify: `manager/inspiration-theme.css`（当前主题颜色覆盖）
- Modify: `tests/manager-ui.test.js`
- Modify: `tests/account-state.test.js`

**Interfaces:**
- Consumes: `XHS_CATEGORY_ORDER.moveCategory(categories, dragged, target, before)`；现有 `sendAction('reorderCategories', { categories })`。
- Produces: `reorderCategory(dragged, target, before): Promise<void>`；成功后 `categories` 等于后台返回的权威顺序，失败后调用 `reloadBusinessData()` 恢复顺序。

- [ ] **Step 1: 写管理页失败测试**

在 `tests/manager-ui.test.js` 增加：

```js
test('自定义分类支持拖拽排序且系统分类保持固定', () => {
  assert.match(html, /<script src="category-order\.js"><\/script>[\s\S]*<script src="manager\.js"><\/script>/);
  assert.match(managerScript, /let dragCategory = null/);
  assert.match(managerScript, /createCategoryItem\(cat, count, true, true\)/);
  assert.match(managerScript, /handle\.draggable = true/);
  assert.match(managerScript, /sendAction\('reorderCategories', \{ categories: next \}\)/);
  assert.match(managerScript, /await reloadBusinessData\(\)/);
  assert.match(theme, /\.cat-drag-handle/);
  assert.match(theme, /\.category-item\.drag-over-top::before/);
  assert.match(theme, /\.category-item\.drag-over-bottom::after/);
});
```

在 `tests/account-state.test.js` 增加两个独立场景：

```js
test('分类重排保存完整顺序并在登录态进入同步队列', async () => {
  const state = await createState([], ['未分类', '好物', '避雷'], {});
  activateAccount(state, { uid: 'a' });
  const before = currentWorkspace(state).pending.length;
  await mutate(state, { action: 'reorderCategories', categories: ['未分类', '避雷', '好物'] });
  assert.deepEqual(project(currentWorkspace(state)).categories, ['未分类', '避雷', '好物']);
  assert.equal(currentWorkspace(state).pending.length, before + 1);
  assert.equal(currentWorkspace(state).pending.at(-1).collection, 'settings');
});

test('分类重排拒绝缺失、重复和未知分类', async () => {
  const state = await createState([], ['未分类', '好物', '避雷'], {});
  for (const categories of [
    ['未分类', '好物'],
    ['未分类', '好物', '好物'],
    ['未分类', '好物', '未知']
  ]) {
    await assert.rejects(
      mutate(state, { action: 'reorderCategories', categories }),
      /分类不存在|分类顺序必须包含全部分类且不能重复/
    );
  }
});
```

- [ ] **Step 2: 运行测试并确认界面测试失败**

Run: `node --test tests/manager-ui.test.js tests/account-state.test.js`

Expected: 新增管理页拖拽测试 FAIL；数据层测试 PASS，因为后台排序协议已经存在。

- [ ] **Step 3: 添加拖拽状态和固定分类渲染**

在 `manager/manager.js` 状态区加入：

```js
let dragCategory = null;       // 当前被拖动的自定义分类
```

把 `renderCategories()` 的分类部分改为先单独渲染固定的“未分类”，再渲染可排序分类：

```js
const uncat = '未分类';
const uncatItem = createCategoryItem(
  uncat,
  comments.filter(comment => comment.category === uncat).length,
  false
);
if (currentCategory === uncat) uncatItem.classList.add('active');
uncatItem.addEventListener('click', () => selectCategory(uncat));
categoryList.appendChild(uncatItem);

categories.filter(category => category !== uncat).forEach(category => {
  const count = comments.filter(comment => comment.category === category).length;
  const item = createCategoryItem(category, count, true, true);
  if (currentCategory === category) item.classList.add('active');
  item.addEventListener('click', () => {
    if (editingCategory) return;
    selectCategory(category);
  });
  categoryList.appendChild(item);
});
```

- [ ] **Step 4: 在分类项添加手柄和拖放事件**

把 `createCategoryItem` 签名改成：

```js
function createCategoryItem(name, count, showActions, sortable = false) {
```

在名称前添加手柄，并在可排序的 `li` 上绑定目标事件：

```js
if (sortable) {
  const handle = document.createElement('span');
  handle.className = 'cat-drag-handle';
  handle.textContent = '⠿';
  handle.title = '拖拽排序';
  handle.setAttribute('aria-label', `拖动分类 ${name}`);
  handle.draggable = true;
  handle.addEventListener('dragstart', event => {
    dragCategory = name;
    li.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', name);
  });
  handle.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    dragCategory = null;
    clearDragIndicators();
  });
  li.appendChild(handle);
}
```

```js
if (sortable) {
  li.addEventListener('dragover', event => {
    if (!dragCategory || dragCategory === name) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = li.getBoundingClientRect();
    const before = event.clientY - rect.top < rect.height / 2;
    clearDragIndicators();
    li.classList.add(before ? 'drag-over-top' : 'drag-over-bottom');
  });
  li.addEventListener('dragleave', event => {
    if (!li.contains(event.relatedTarget)) li.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  li.addEventListener('drop', event => {
    if (!dragCategory || dragCategory === name) return;
    event.preventDefault();
    const rect = li.getBoundingClientRect();
    reorderCategory(dragCategory, name, event.clientY - rect.top < rect.height / 2);
  });
}
```

- [ ] **Step 5: 实现乐观排序、后台保存和失败恢复**

在分类管理区加入：

```js
function clearDragIndicators() {
  document.querySelectorAll('.category-item.drag-over-top, .category-item.drag-over-bottom')
    .forEach(item => item.classList.remove('drag-over-top', 'drag-over-bottom'));
}

async function reorderCategory(dragged, target, before) {
  const next = globalThis.XHS_CATEGORY_ORDER.moveCategory(categories, dragged, target, before);
  if (next.every((name, index) => name === categories[index])) return;

  dragCategory = null;
  clearDragIndicators();
  categories = next;
  renderCategories();

  try {
    categories = await sendAction('reorderCategories', { categories: next });
    renderCategories();
  } catch (error) {
    showToast(error.message || '分类排序失败，请重试', 'error');
    await reloadBusinessData();
  }
}
```

- [ ] **Step 6: 添加拖拽视觉反馈**

在 `manager/manager.css` 增加通用结构：

```css
.cat-drag-handle {
  flex-shrink: 0;
  margin-right: 6px;
  font-size: 12px;
  line-height: 1;
  cursor: grab;
  user-select: none;
  opacity: 0.45;
  transition: opacity 0.15s;
}
.category-item:hover .cat-drag-handle,
.category-item:focus-within .cat-drag-handle { opacity: 1; }
.cat-drag-handle:active { cursor: grabbing; }
.category-item.dragging { opacity: 0.4; }
.category-item.drag-over-top::before,
.category-item.drag-over-bottom::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  height: 2px;
  border-radius: 1px;
  background: var(--accent);
}
.category-item.drag-over-top::before { top: 0; }
.category-item.drag-over-bottom::after { bottom: 0; }
.category-item.editing .cat-drag-handle { display: none; }
```

在 `manager/inspiration-theme.css` 加入当前主题覆盖：

```css
.cat-drag-handle { color: var(--inspiration-muted); }
.category-item.active .cat-drag-handle { color: var(--inspiration-white); }
.category-item.drag-over-top::before,
.category-item.drag-over-bottom::after { background: var(--inspiration-accent); }
```

- [ ] **Step 7: 运行相关测试并确认通过**

Run: `node --test tests/category-order.test.js tests/manager-ui.test.js tests/account-state.test.js`

Expected: 全部 PASS。

- [ ] **Step 8: 提交交互实现**

```bash
git add manager/manager.js manager/manager.css manager/inspiration-theme.css tests/manager-ui.test.js tests/account-state.test.js
git commit -m "新增: 支持分类拖拽排序"
```

---

### Task 3: README、全量验证与构建

**Files:**
- Modify: `README.md`
- Verify: `dist/extension/manager/category-order.js`
- Verify: `dist/extension/manager/manager.js`
- Verify: `dist/extension/manager/manager.css`
- Verify: `dist/extension/manager/inspiration-theme.css`

**Interfaces:**
- Consumes: Task 1 的顺序模块和 Task 2 的管理页拖拽交互。
- Produces: 可加载的 `dist/extension` 构建产物和同步更新的用户文档。

- [ ] **Step 1: 更新 README**

在“分类管理”增加：

```markdown
- 左侧“全部”和“未分类”固定在顶部；其余分类可拖动左侧手柄调整顺序
- 分类顺序保存在本机工作副本，登录后会随其他分类设置同步到当前 Google 账号
```

在项目结构的 `manager/` 下增加：

```text
│   ├── category-order.js         # 分类拖拽后的纯顺序计算
```

- [ ] **Step 2: 运行全量测试**

Run: `npm test`

Expected: 所有测试 PASS，无失败、取消或跳过。

- [ ] **Step 3: 构建扩展并检查产物**

Run: `npm run build`

Expected: 输出“构建完成”，并生成 `dist/extension/manager/category-order.js`。

Run: `test -f dist/extension/manager/category-order.js && rg -n "category-order.js" dist/extension/manager/manager.html`

Expected: 命令退出码为 0，HTML 在 `manager.js` 前加载 `category-order.js`。

- [ ] **Step 4: 检查最终差异**

Run: `git diff --check && git status --short`

Expected: `git diff --check` 无输出；状态只包含本任务预期的 README 和构建产物变化。若 `dist/` 已被忽略，状态只包含 README。

- [ ] **Step 5: 提交文档和构建结果**

```bash
git add README.md
git add -f dist/extension/manager/category-order.js dist/extension/manager/manager.html dist/extension/manager/manager.js dist/extension/manager/manager.css dist/extension/manager/inspiration-theme.css 2>/dev/null || true
git commit -m "文档: 补充分类排序使用说明"
```

- [ ] **Step 6: 核对最终状态**

Run: `git status --short && git log -4 --oneline`

Expected: 工作区干净；最近提交依次包含设计文档、顺序计算、拖拽交互和 README 更新。
