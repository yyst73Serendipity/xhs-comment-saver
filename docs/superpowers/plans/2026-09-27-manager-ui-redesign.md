# 管理页“灵感剪贴簿”UI 改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将评论收藏管理页改造成已确认的“灵感剪贴簿”三栏界面，同时完整保留分类、云同步、评论管理、AI 总结和数据分析行为。

**Architecture:** 保留所有业务元素 ID 和现有消息入口，通过调整 `manager.html` 的语义分组、增加专用主题样式文件和补充少量 UI 状态属性完成改版。既有 `manager.css` 继续提供组件基础样式，新增的 `inspiration-theme.css` 最后加载，只负责新视觉、三栏布局、响应式与可访问状态；云同步 JavaScript 仅增加状态类和忙碌属性，不改变数据流。

**Tech Stack:** Chrome Manifest V3、原生 HTML/CSS/JavaScript、Node.js 原生测试运行器、现有 esbuild 构建脚本。

## Global Constraints

- 不改变收藏、分类、同步、AI 总结、导入导出和数据分析的业务规则。
- 保留现有元素 ID，业务 JavaScript 不通过查询新文案工作。
- 不引入 UI 框架、图标包、远程字体或新的运行时依赖。
- 颜色收敛到 CSS 自定义属性，不在新增组件中散落硬编码主题色。
- 桌面端只滚动评论列表；顶部栏、分类栏、搜索工具栏和右侧分析区保持可见。
- 所有图标按钮必须有 `aria-label` 与 `title`，支持 `:focus-visible` 和 `prefers-reduced-motion`。
- 面向用户的新增文案使用中文。
- 新增源码文件顶部使用中文多行注释说明用途。

---

### Task 1: 锁定完整管理页结构契约

**Files:**
- Create: `tests/manager-ui.test.js`
- Modify: `manager/manager.html:14-292`

**Interfaces:**
- Consumes: 既有 DOM ID，以及 `manager.js`、`cloud-panel.js` 对这些 ID 的查询。
- Produces: `.header-primary`、`.header-utility`、`.workspace-shell`、`data-ui-region` 语义边界，供主题样式和结构测试使用。

- [ ] **Step 1: 编写失败的结构契约测试**

```js
/**
 * 验证“灵感剪贴簿”管理页的信息结构和既有行为入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('manager/manager.html', 'utf8');

function occurrences(id) {
  return html.match(new RegExp(`id="${id}"`, 'g'))?.length || 0;
}

test('顶部完整展示账号、同步与全部全局操作', () => {
  assert.match(html, /class="header-primary"/);
  assert.match(html, /class="header-utility"/);
  for (const id of [
    'cloud-account', 'cloud-status', 'cloud-sync', 'btn-api-config',
    'btn-import', 'btn-export', 'cloud-cache', 'btn-clear',
    'cloud-help', 'cloud-logout'
  ]) assert.equal(occurrences(id), 1, `${id} 应且只应出现一次`);
});

test('三栏区域和分类管理入口保持完整', () => {
  assert.match(html, /data-ui-region="categories"/);
  assert.match(html, /data-ui-region="comments"/);
  assert.match(html, /data-ui-region="insights"/);
  for (const id of ['btn-add-cat', 'input-cat-name', 'btn-confirm-cat', 'btn-cancel-cat']) {
    assert.equal(occurrences(id), 1);
  }
});

test('AI 总结和四个数据视图具有可读名称', () => {
  assert.match(html, /data-ui-region="ai-summary"/);
  assert.match(html, /data-ui-region="data-analysis"/);
  for (const label of ['河流图', '网格图', '仪表盘', '关系图']) {
    assert.match(html, new RegExp(`aria-label="${label}"`));
  }
});
```

- [ ] **Step 2: 运行结构测试并确认失败**

Run: `node --test tests/manager-ui.test.js`

Expected: FAIL，提示缺少 `header-primary` 或 `cloud-help`。

- [ ] **Step 3: 重组顶部栏并补齐配置帮助入口**

在 `manager/manager.html` 中把原 `.header` 内容改为以下分组；所有既有 ID 原样移动，不重命名：

```html
<header class="header">
  <div class="header-primary">
    <div class="header-left">
      <h1 class="header-title">我的评论灵感簿</h1>
      <span class="header-count" id="total-count">空空如也</span>
    </div>
    <section class="cloud-panel" id="cloud-panel" aria-label="Google 云同步">
      <div class="cloud-identity">
        <span class="cloud-avatar" aria-hidden="true">云</span>
        <span class="cloud-copy">
          <strong id="cloud-account">本地模式</strong>
          <span id="cloud-status">正在读取同步状态…</span>
        </span>
      </div>
      <div class="cloud-primary-actions">
        <button id="cloud-login" type="button">使用 Google 登录</button>
        <button id="cloud-copy-uid" type="button" class="hidden">复制 UID</button>
        <button id="cloud-sync" type="button" class="hidden">立即同步</button>
        <button class="btn-api-config" id="btn-api-config" title="配置本机 AI 服务">AI 配置</button>
      </div>
    </section>
  </div>
  <div class="header-utility" aria-label="数据与账号操作">
    <button class="btn-import" id="btn-import" title="从 JSON 文件导入">导入</button>
    <button class="btn-export" id="btn-export" title="导出为 JSON 文件">导出</button>
    <button id="cloud-migrate" type="button" class="hidden">迁移本机数据</button>
    <button id="cloud-conflicts" type="button" class="hidden">处理冲突</button>
    <button id="cloud-cache" type="button" class="hidden">清除本机缓存</button>
    <button class="btn-clear" id="btn-clear" title="清空所有收藏数据">清空全部数据</button>
    <button id="cloud-help" class="header-help" type="button" title="查看云同步配置帮助">配置帮助</button>
    <button id="cloud-logout" type="button" class="hidden header-logout">退出登录</button>
    <input type="file" class="import-file" id="import-file" accept=".json" hidden>
  </div>
</header>
```

在现有云同步弹窗之后加入内置帮助弹窗，避免扩展尝试打开没有进入构建产物的源码文档：

```html
<div class="modal-overlay hidden" id="cloud-help-modal" role="dialog" aria-modal="true" aria-labelledby="cloud-help-title">
  <div class="modal-dialog cloud-dialog">
    <div class="modal-title" id="cloud-help-title">Google 云同步使用说明</div>
    <div class="modal-body cloud-help-body">
      <p>登录同一个 Google 账号，即可在不同电脑和浏览器间同步评论、分类、私人笔记和 AI 总结。</p>
      <ol>
        <li>首次登录后，如有旧本机收藏，先使用“迁移本机数据”下载备份并确认迁移。</li>
        <li>账号内新增、编辑、导入和删除会自动加入同步队列。</li>
        <li>“清除本机缓存”只重新拉取当前账号数据，不会删除云端收藏。</li>
      </ol>
    </div>
    <div class="modal-actions">
      <button class="btn-modal-confirm" id="cloud-help-close" type="button">知道了</button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: 标注三栏、AI 与数据区域并改善视图按钮名称**

```html
<aside class="sidebar" data-ui-region="categories">…</aside>
<section class="content" data-ui-region="comments">…</section>
<aside class="right-panel" id="right-panel" data-ui-region="insights">
  <div class="panel-section panel-summary" id="panel-summary" data-ui-region="ai-summary">…</div>
  <div class="panel-section panel-graph" id="panel-graph" data-ui-region="data-analysis">
    …
    <button class="view-switch-btn" data-view="river" aria-label="河流图" title="河流图"><span aria-hidden="true">🌊</span><span>河流图</span></button>
    <button class="view-switch-btn" data-view="grid" aria-label="网格图" title="网格图"><span aria-hidden="true">▦</span><span>网格图</span></button>
    <button class="view-switch-btn" data-view="dashboard" aria-label="仪表盘" title="仪表盘"><span aria-hidden="true">▥</span><span>仪表盘</span></button>
    <button class="view-switch-btn active" data-view="graph" aria-label="关系图" title="关系图"><span aria-hidden="true">⌘</span><span>关系图</span></button>
  </div>
</aside>
```

- [ ] **Step 5: 运行结构与原云同步测试**

Run: `node --test tests/manager-ui.test.js tests/manager-cloud.test.js`

Expected: PASS，且既有云同步控件测试继续通过。

- [ ] **Step 6: 提交结构改造**

```bash
git add manager/manager.html tests/manager-ui.test.js
git commit -m "重构: 调整管理页信息结构"
```

---

### Task 2: 建立“灵感剪贴簿”主题和桌面三栏布局

**Files:**
- Create: `manager/inspiration-theme.css`
- Modify: `manager/manager.html:8-12`
- Modify: `scripts/build.js`
- Modify: `tests/manager-ui.test.js`
- Modify: `tests/build-output.test.js`

**Interfaces:**
- Consumes: Task 1 的结构类名和 `data-ui-region`。
- Produces: 主题 CSS 变量、桌面三栏布局、顶部两行布局、分类和评论卡片视觉，供后续状态和响应式任务扩展。

- [ ] **Step 1: 扩展测试，要求主题进入源码与构建产物**

```js
const theme = await readFile('manager/inspiration-theme.css', 'utf8');

test('灵感剪贴簿主题使用统一变量并最后加载', () => {
  assert.match(html, /manager\.css[\s\S]*cloud-panel\.css[\s\S]*inspiration-theme\.css/);
  for (const token of ['--inspiration-ink', '--inspiration-paper', '--inspiration-accent']) {
    assert.match(theme, new RegExp(token));
  }
  assert.match(theme, /grid-template-columns:\s*190px\s+minmax\(0,\s*1fr\)\s+335px/);
});
```

在 `tests/build-output.test.js` 的构建文件断言中加入：

```js
assert.ok(await exists(join(outputDir, 'manager', 'inspiration-theme.css')));
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test tests/manager-ui.test.js tests/build-output.test.js`

Expected: FAIL，提示找不到 `manager/inspiration-theme.css`。

- [ ] **Step 3: 创建主题变量与基础布局**

`manager/inspiration-theme.css` 以以下完整变量和布局边界开头：

```css
/**
 * 管理页“灵感剪贴簿”主题，统一覆盖顶部、三栏、卡片和分析区视觉。
 */
:root {
  --inspiration-ink: #392d31;
  --inspiration-muted: #987b76;
  --inspiration-paper: #fffaf6;
  --inspiration-page: #fff9f5;
  --inspiration-sidebar: #f9ece5;
  --inspiration-line: #ead6ce;
  --inspiration-header: #35282d;
  --inspiration-header-deep: #2e2227;
  --inspiration-accent: #e84c5b;
  --inspiration-accent-deep: #bc3546;
  --inspiration-accent-soft: #ffe2e3;
  --inspiration-success: #2f9a6b;
  --inspiration-danger: #d13f4f;
  --inspiration-shadow: 0 7px 18px rgba(88, 55, 55, 0.07);
}

body.app-body {
  background: #eee9e6;
  color: var(--inspiration-ink);
}

.app {
  max-width: none;
  padding: 0;
  background: var(--inspiration-page);
}

.header { display: block; margin: 0; padding: 0; border: 0; }
.header-primary {
  min-height: 58px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 20px;
  background: var(--inspiration-header);
  color: #fff8f4;
}
.header-utility {
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 20px;
  background: var(--inspiration-header-deep);
}

.main {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr) 335px;
  gap: 0;
  min-height: 0;
}
```

继续在同一文件实现设计规格中的分类选中态、内联分类输入、搜索栏、评论卡片、评论组、标签、媒体、私人笔记和空状态。现有类名继续使用，不复制业务 HTML。

- [ ] **Step 4: 最后加载主题并加入构建清单**

在 `manager.html` 中：

```html
<link rel="stylesheet" href="manager.css">
<link rel="stylesheet" href="cloud-panel.css">
<link rel="stylesheet" href="inspiration-theme.css">
```

在 `scripts/build.js` 的管理页静态文件列表中加入：

```js
'manager/inspiration-theme.css'
```

- [ ] **Step 5: 运行主题与构建测试**

Run: `node --test tests/manager-ui.test.js tests/build-output.test.js`

Expected: PASS，构建临时目录包含新主题文件。

- [ ] **Step 6: 提交桌面主题**

```bash
git add manager/inspiration-theme.css manager/manager.html scripts/build.js tests/manager-ui.test.js tests/build-output.test.js
git commit -m "优化: 重做管理页灵感剪贴簿主题"
```

---

### Task 3: 让同步状态驱动顶部栏反馈

**Files:**
- Modify: `manager/cloud-panel.js:14-119`
- Modify: `manager/cloud-panel.css`
- Modify: `manager/inspiration-theme.css`
- Modify: `tests/manager-cloud.test.js`

**Interfaces:**
- Consumes: 后台 `cloudStatus` 返回的 `configured`、`ownerConfigured`、`signedIn`、`syncStatus`、`pending`、`lastSync`。
- Produces: `stateFor(status): 'local' | 'ready' | 'pending' | 'syncing' | 'error'`，以及 `#cloud-panel[data-state]`、`aria-busy`、按钮禁用状态。

- [ ] **Step 1: 编写状态映射和忙碌状态失败测试**

在 `tests/manager-cloud.test.js` 增加：

```js
test('顶部栏用稳定状态名表达同步阶段', () => {
  assert.equal(cloudApi.stateFor({ configured: false }), 'local');
  assert.equal(cloudApi.stateFor({ configured: true, ownerConfigured: true, signedIn: true, syncStatus: 'syncing' }), 'syncing');
  assert.equal(cloudApi.stateFor({ configured: true, ownerConfigured: true, signedIn: true, syncStatus: 'error' }), 'error');
  assert.equal(cloudApi.stateFor({ configured: true, ownerConfigured: true, signedIn: true, pending: 2 }), 'pending');
  assert.equal(cloudApi.stateFor({ configured: true, ownerConfigured: true, signedIn: true, pending: 0 }), 'ready');
});

test('刷新状态会设置面板状态和同步按钮忙碌属性', () => {
  assert.match(cloudPanel, /panel\.dataset\.state\s*=\s*stateFor\(currentStatus\)/);
  assert.match(cloudPanel, /sync\.setAttribute\('aria-busy'/);
  assert.match(cloudPanel, /sync\.disabled\s*=\s*syncing/);
});
```

- [ ] **Step 2: 运行云同步测试并确认失败**

Run: `node --test tests/manager-cloud.test.js`

Expected: FAIL，提示 `stateFor` 未定义。

- [ ] **Step 3: 实现稳定同步状态映射**

在 `statusText` 之前增加：

```js
/** 把后台状态压缩为顶部栏可复用的视觉状态。 */
function stateFor(status) {
  if (!status.configured || !status.ownerConfigured || !status.signedIn) return 'local';
  if (status.syncStatus === 'syncing') return 'syncing';
  if (status.syncStatus === 'error') return 'error';
  if ((Number.isSafeInteger(status.pending) ? status.pending : 0) > 0 || status.syncStatus === 'pending') return 'pending';
  return 'ready';
}
```

在 `init` 中读取面板并更新状态：

```js
const panel = byId('cloud-panel');
const help = byId('cloud-help');
const helpModal = byId('cloud-help-modal');
const helpClose = byId('cloud-help-close');

// refreshStatus 成功分支
const visualState = stateFor(currentStatus);
panel.dataset.state = visualState;
const syncing = visualState === 'syncing';
sync.setAttribute('aria-busy', String(syncing));
sync.disabled = syncing;
```

注册帮助弹窗交互，不经过后台数据接口：

```js
help.addEventListener('click', () => helpModal.classList.remove(HIDDEN));
helpClose.addEventListener('click', () => helpModal.classList.add(HIDDEN));
```

错误分支设置 `panel.dataset.state = 'error'`。导出改为：

```js
global.XHS_CLOUD_PANEL = { controlsFor, init, stateFor, statusText };
```

- [ ] **Step 4: 为五种状态增加视觉反馈**

```css
.cloud-panel::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--inspiration-muted);
}
.cloud-panel[data-state='ready']::before { background: var(--inspiration-success); }
.cloud-panel[data-state='pending']::before { background: #e3a43b; }
.cloud-panel[data-state='syncing']::before { background: #75c9ef; animation: sync-pulse 1.2s ease-in-out infinite; }
.cloud-panel[data-state='error']::before { background: #ff8390; }

@keyframes sync-pulse { 50% { opacity: .35; transform: scale(.8); } }
```

- [ ] **Step 5: 运行测试并提交**

Run: `node --test tests/manager-cloud.test.js tests/manager-ui.test.js`

Expected: PASS。

```bash
git add manager/cloud-panel.js manager/cloud-panel.css manager/inspiration-theme.css tests/manager-cloud.test.js
git commit -m "优化: 完善顶部同步状态反馈"
```

---

### Task 4: 完成右栏、弹窗、响应式和键盘可访问性

**Files:**
- Modify: `manager/inspiration-theme.css`
- Modify: `manager/manager.html`
- Modify: `tests/manager-ui.test.js`

**Interfaces:**
- Consumes: 既有 `.panel-summary`、`.panel-graph`、`.modal-*`、`.toast`、`.view-switch-btn` 状态类。
- Produces: 44%/56% 右栏分区、带文字的视图切换条、统一弹窗、三个响应式区间和键盘焦点样式。

- [ ] **Step 1: 编写可访问性和响应式失败测试**

```js
test('主题覆盖键盘焦点、减弱动画和三个布局区间', () => {
  assert.match(theme, /:focus-visible/);
  assert.match(theme, /prefers-reduced-motion:\s*reduce/);
  assert.match(theme, /@media\s*\(max-width:\s*1179px\)/);
  assert.match(theme, /@media\s*\(max-width:\s*899px\)/);
});

test('右栏明确分为 AI 总结和数据分析', () => {
  assert.match(theme, /grid-template-rows:\s*44%\s+56%/);
  assert.match(html, />AI 总结</);
  assert.match(html, />数据分析</);
});
```

- [ ] **Step 2: 运行 UI 测试并确认失败**

Run: `node --test tests/manager-ui.test.js`

Expected: FAIL，提示缺少响应式或 `数据分析` 标题。

- [ ] **Step 3: 完成右栏与统一弹窗样式**

```css
.right-panel {
  display: grid;
  grid-template-rows: 44% 56%;
  min-width: 0;
  border-left: 1px solid var(--inspiration-line);
  background: #f4e7e1;
}
.panel-section { min-height: 0; border: 0; border-radius: 0; background: transparent; }
.panel-summary { border-bottom: 1px solid #dfcac2; }
.view-switch-group { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.view-switch-btn { width: auto; min-height: 30px; padding: 5px 6px; border-radius: 7px; }
.view-switch-btn.active { background: var(--inspiration-accent); color: #fff; }

.modal-dialog {
  border: 1px solid var(--inspiration-line);
  border-radius: 16px;
  background: var(--inspiration-paper);
  box-shadow: 0 24px 70px rgba(74, 47, 51, .22);
}
```

把关系图区域标题文案改为“数据分析”，保留 `id="graph-view-title"` 供现有 JavaScript更新当前视图名称；可以新增独立 `.panel-section-kicker` 显示当前作用范围。

- [ ] **Step 4: 完成响应式与可访问性**

```css
:where(button, a, input, textarea, [tabindex]):focus-visible {
  outline: 3px solid rgba(232, 76, 91, .34);
  outline-offset: 2px;
}

@media (max-width: 1179px) {
  .main { grid-template-columns: 166px minmax(0, 1fr) 292px; }
  .header-primary, .header-utility { flex-wrap: wrap; height: auto; padding-block: 8px; }
}

@media (max-width: 899px) {
  body.app-body { overflow: auto; }
  .app { min-height: 100vh; height: auto; }
  .main { grid-template-columns: 154px minmax(0, 1fr); overflow: visible; }
  .right-panel { grid-column: 1 / -1; min-height: 620px; grid-template-columns: 1fr 1fr; grid-template-rows: none; }
  .panel-summary { border-right: 1px solid var(--inspiration-line); border-bottom: 0; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
}
```

- [ ] **Step 5: 运行 UI、云同步和管理页测试**

Run: `node --test tests/manager-ui.test.js tests/manager-cloud.test.js`

Expected: PASS。

- [ ] **Step 6: 提交右栏与响应式改造**

```bash
git add manager/manager.html manager/inspiration-theme.css tests/manager-ui.test.js
git commit -m "优化: 完善分析区和响应式交互"
```

---

### Task 5: 文档、完整验证和实际页面验收

**Files:**
- Modify: `README.md`
- Modify: `tests/manager-ui.test.js` only if verification finds a missing durable contract

**Interfaces:**
- Consumes: Tasks 1–4 的最终页面、主题和状态行为。
- Produces: 可重新加载的 `dist/extension`、更新后的使用说明和完整验证证据。

- [ ] **Step 1: 更新 README 管理页说明与目录结构**

把“管理页”功能说明更新为：

```markdown
- “灵感剪贴簿”固定视口管理页：深莓色账号与工具栏、左侧分类、中间评论卡片、右侧 AI 总结和数据分析
- 顶部持续显示 Google 登录邮箱、同步状态、待上传数量与最后同步时间，并集中提供同步、导入导出、缓存、配置帮助和退出入口
- 分类侧边栏支持新建、重命名和删除；删除分类后评论继续按既有规则移至“未分类”
```

在项目结构中加入：

```text
│   ├── inspiration-theme.css       # “灵感剪贴簿”主题、响应式和可访问状态
```

- [ ] **Step 2: 运行全部单元测试**

Run: `npm test`

Expected: 所有测试 PASS，失败数为 0。

- [ ] **Step 3: 构建扩展**

Run: `npm run build`

Expected: 成功生成 `dist/extension`，输出“云配置：已配置”和“所有者：已限制”。

- [ ] **Step 4: 检查构建产物和 Git 差异**

Run:

```bash
test -f dist/extension/manager/inspiration-theme.css
git diff --check
git status --short
```

Expected: 主题文件存在，`git diff --check` 无输出，只包含本任务预期的 README 或测试改动。

- [ ] **Step 5: 在浏览器完成实际视觉验收**

重新加载 `dist/extension` 后检查以下场景：

1. 已登录且同步完成：邮箱、状态和时间可见。
2. 正在同步与有待上传项：状态点、文案和按钮禁用正确。
3. 分类悬停与键盘聚焦：重命名、删除均可操作。
4. 新建分类、重命名、删除分类并确认评论仍移至“未分类”。
5. 搜索、排序、评论组展开、笔记编辑和分类切换正常。
6. AI 总结的空态、生成中、阅读、编辑、保存失败状态正常。
7. 河流图、网格图、仪表盘、关系图切换正常。
8. 宽度 1180px 以上、900–1179px、899px 以下均无控件遮挡。

Expected: 行为与设计规格一致，浏览器控制台没有新增错误。

- [ ] **Step 6: 提交文档与最终验证调整**

```bash
git add README.md tests/manager-ui.test.js
git commit -m "文档: 更新灵感剪贴簿界面说明"
```

- [ ] **Step 7: 最终版本检查**

Run:

```bash
git log -5 --oneline
git status --short
```

Expected: 能看到本计划的五个独立提交，工作区无未提交变更。
