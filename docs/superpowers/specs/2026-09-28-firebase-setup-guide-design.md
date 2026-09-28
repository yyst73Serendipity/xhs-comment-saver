# Firebase 云同步新手配置页设计

## 目标

为获得项目源码的新使用者提供一份随扩展构建产物分发的完整新手教程。使用者无需理解现有同步实现，即可按页面步骤创建自己的 Firebase 项目、绑定自己的 Google 账号、部署安全规则并验证跨设备同步。

该页面解决的是“每位使用者独立搭建个人云端”的问题。每个人都必须使用自己的 Firebase 项目和 `ownerUid`，从而让评论、分类、私人笔记和 AI 总结彼此隔离。页面不提供共享 Firebase 项目的流程。

## 已确认方案

采用方案 A：在扩展内新增静态分步教程页 `manager/setup.html`，点击管理页顶部“配置帮助”后在新标签页打开。

教程只展示说明、命令、公开配置模板和官方控制台链接，不读取、不收集、不上传用户配置，也不尝试从扩展页面直接修改源码文件。页面不引入运行时依赖、远程脚本或自动配置流程。

现有简略配置帮助弹窗由独立教程页替代，避免同一说明存在两个版本。

## 适用对象与前置假设

教程面向拿到完整源码目录的普通使用者，默认其具备以下条件：

- 一台可以运行 Chrome 的电脑。
- 一个准备绑定云同步的 Google 账号。
- 可以在终端执行复制、安装和构建命令。
- 拥有项目源码，而不是只有 `dist/extension`。

页面开头明确说明：每位使用者需要创建自己的 Firebase 项目；直接复用他人的 Firebase 配置会导致权限冲突，也不符合数据隔离目标。

## 页面入口与导航

管理页顶部“配置帮助”从按钮改为指向 `setup.html` 的链接，并使用：

- `target="_blank"`，在新标签页打开教程。
- `rel="noopener"`，隔离新页面与原管理页。
- 清晰的 `title` 和可见文字“配置帮助”。

删除原有 `cloud-help-modal`、关闭按钮以及 `cloud-panel.js` 中对应的打开和关闭事件。登录、同步、迁移、缓存和冲突处理逻辑不受影响。

教程页顶部提供“返回管理页”链接。链接目标使用相对路径 `manager.html`，无需硬编码扩展 ID。

## 信息结构

页面采用“左侧步骤目录 + 右侧教程正文”的文档布局。

```text
┌──────────────────────────────────────────────────────────────┐
│ 云同步配置指南                       返回管理页              │
├────────────────┬─────────────────────────────────────────────┤
│ 开始之前       │ 标题、目标、费用和数据隔离说明              │
│ 1 创建项目     │ 当前步骤正文                                │
│ 2 注册应用     │ 命令、配置模板、控制台路径和注意事项        │
│ 3 启用登录     │                                             │
│ …              │                                             │
│ 完成检查       │                                             │
│ 常见问题       │                                             │
└────────────────┴─────────────────────────────────────────────┘
```

桌面宽度下目录保持可见，正文独立形成阅读列。窄屏下目录变成顶部横向步骤导航，正文单列排列，不隐藏任何步骤。

页面沿用管理页“灵感剪贴簿”视觉：深莓色页头、奶油纸张背景、胭脂红重点色、低对比边框和系统字体。教程不复用管理页庞大的业务样式文件，而使用独立的 `setup.css`，避免样式耦合。

## 教程步骤

### 0. 开始之前

说明最终结果、免费方案和隐私边界：

- 使用 Firebase Spark 免费方案即可完成个人使用配置。
- 评论数据进入使用者自己的 Firestore 项目。
- `firebase.local.json` 不应提交到 Git 或发给其他人。
- Firebase Web 客户端配置和 UID 不是密码，但服务账号私钥、Firebase CLI 登录令牌、Google 密码和 AI API Key 绝不能写入该文件或教程页面。

列出所需工具：Chrome、Node.js、npm、Firebase CLI 和 Google 账号。提供检查命令：

```bash
node --version
npm --version
npx firebase-tools --version
```

### 1. 创建 Firebase 项目

引导打开 Firebase 控制台并创建独立项目：

- 项目名称可以自定义。
- Google Analytics 对扩展同步不是必需项，可不启用。
- 保持 Spark 免费方案。

页面提供 Firebase 控制台官方链接，不硬编码当前维护者的项目 ID。

### 2. 注册 Web 应用

引导进入“项目设置 → 常规 → 您的应用”，注册 Web 应用并取得公开客户端配置。

明确列出需要复制的字段：

- `apiKey`
- `authDomain`
- `projectId`
- `storageBucket`
- `messagingSenderId`
- `appId`

`measurementId` 不参与本项目功能，不要求填写。教程不建议启用 Analytics SDK。

### 3. 启用 Google 登录

引导进入“Authentication → 登录方法”，启用 Google 提供商并选择项目支持邮箱。说明这一步只开放 Google 身份验证，真正的数据访问仍由 `ownerUid` 和 Firestore Rules 限制。

### 4. 创建 Firestore 数据库

引导创建 `(default)` Firestore Standard 数据库：

- 使用生产模式。
- 选择离自己较近且创建后可长期使用的区域。
- 不要求升级到付费方案。
- 不手动放宽数据库规则。

### 5. 创建本机配置

引导在源码根目录执行：

```bash
cp config/firebase.example.json config/firebase.local.json
```

展示与项目真实字段一致的 JSON 模板。第一阶段保持 `ownerUid` 为空，`authPageUrl` 使用使用者自己的 `https://项目ID.web.app` 地址。

页面明确说明 `config/firebase.local.json` 已被 Git 忽略，只保存在使用者电脑上。

### 6. 首次部署登录页

引导安装依赖并部署只用于 Google 登录的 Hosting 页面：

```bash
npm install
npx firebase-tools login
npm run deploy:hosting
```

解释 `deploy:hosting` 不会在 `ownerUid` 为空时开放云端业务数据，只负责部署登录桥。Firebase CLI 登录属于本机开发授权，教程不要求使用者复制或分享登录令牌。

### 7. 构建并加载扩展

引导运行：

```bash
npm run build
```

随后打开 `chrome://extensions`，启用开发者模式，加载 `dist/extension`。明确要求选择构建目录，不选择源码根目录。

说明固定扩展 ID 会由构建脚本生成和校验，使用者不需要手工修改 `manifest.json`。

### 8. 登录并取得 UID

引导在扩展管理页点击“使用 Google 登录”，使用以后要同步数据的账号完成登录。

由于管理页不再公开显示 UID，教程要求使用者前往“Firebase 控制台 → Authentication → 用户”，复制对应账号的“用户 UID”。页面说明 UID 只是账号标识，不是密码或登录令牌。

### 9. 绑定所有者并部署规则

引导把 UID 写入 `config/firebase.local.json` 的 `ownerUid`，然后执行：

```bash
npm run deploy
```

解释该命令会重新构建扩展并部署 Hosting 与 Firestore Rules。规则只允许该 UID 访问项目内的个人数据路径，其他 Google 账号会被拒绝。

部署完成后，回到 `chrome://extensions` 重新加载扩展，重新打开管理页并登录。

### 10. 迁移与验证

提供两条路径：

- 新用户没有旧收藏：直接保存一条评论并点击“立即同步”。
- 已有本机收藏：点击“迁移本机数据”，先下载 JSON 备份，再确认迁移。

最终验证清单：

- 顶部显示自己的 Google 邮箱。
- 同步状态最终显示“已同步”和时间。
- Firebase Firestore 中出现当前 UID 对应的数据。
- 在另一台电脑或另一个 Chrome 配置中加载同一份个人构建，登录同一账号后能拉取收藏。
- 登录其他 Google 账号时无法访问该项目的数据。

## 常见问题

页面底部提供面向新手的故障索引：

- Google 登录弹窗无法完成：检查 Hosting 是否部署、Google 登录是否启用、`authPageUrl` 是否为 HTTPS。
- 显示仅保存在本机：检查 Firebase 配置是否完整并重新构建。
- 登录后云按钮不可用：检查 `ownerUid` 是否填写、是否重新运行 `npm run deploy` 和重新加载扩展。
- 权限不足：确认当前 Google 账号 UID 与配置完全一致。
- 换电脑没有数据：确认两台电脑使用同一份个人构建、同一个 Google 账号，并点击“立即同步”。
- 费用问题：说明个人轻量使用通常可处于 Spark 免费额度，但实际用量以 Firebase 控制台为准。

每项只提供可执行的检查路径，不显示项目维护者自己的项目 ID、邮箱、UID 或配置值。

## 文件与构建范围

新增文件：

- `manager/setup.html`：教程语义结构和完整正文。
- `manager/setup.css`：教程独立视觉、目录、代码块、提示卡和响应式布局。
- `tests/setup-guide.test.js`：教程结构、安全边界、入口和构建产物测试。

修改文件：

- `manager/manager.html`：把“配置帮助”改为独立页面链接并删除帮助弹窗。
- `manager/cloud-panel.js`：删除帮助弹窗元素查询和打开、关闭事件。
- `scripts/build.js`：把 `setup.html` 和 `setup.css` 加入扩展公开文件列表。
- `README.md`：增加“分享给其他使用者”章节，并指向扩展内教程与 `docs/firebase-setup.md`。
- `docs/firebase-setup.md`：保持为开发者详细资料，与教程中的步骤和命令一致。

不修改同步模型、Firebase Auth 流程、Firestore Rules、账号隔离或迁移业务逻辑。不新增第三方依赖。

## 安全边界

- 页面不包含输入 Firebase 密码、Google 密码、服务账号私钥、CLI 令牌或 AI API Key 的表单。
- 页面不执行 Firebase API 请求，不读取 `chrome.storage`，不探测使用者账号状态。
- 所有外部链接使用 HTTPS、`target="_blank"` 和 `rel="noopener noreferrer"`。
- 命令和 JSON 模板使用静态文本，用户需要在本机终端和编辑器中执行。
- 构建测试必须确认教程页不包含当前维护者的 Firebase 项目 ID、邮箱或 UID。
- CSP 继续只允许扩展自身脚本；教程页不加载远程字体、图片或脚本。

## 可访问性与响应式

- 使用语义化的 `header`、`nav`、`main`、`section`、`ol` 和 `code`。
- 步骤目录链接到页面内锚点，键盘可以按顺序访问。
- 当前阅读位置不依赖 JavaScript判断，浏览器原生锚点即可工作。
- 所有链接有明确文字，不能只显示图标。
- 代码块支持横向滚动，不截断配置内容。
- `:focus-visible` 提供清晰焦点环。
- 尊重 `prefers-reduced-motion`。
- `>= 900px` 使用固定侧栏和正文阅读列；`< 900px` 变为顶部横向目录和单列正文。

## 测试与验收

自动测试需要覆盖：

- 管理页存在指向 `setup.html` 的“配置帮助”链接。
- 原帮助弹窗及其 JavaScript 事件已删除。
- 教程包含十个配置阶段、最终检查和常见问题。
- 教程包含 `firebase.local.json`、`ownerUid`、`deploy:hosting`、`npm run deploy` 和 `dist/extension` 的准确说明。
- 教程没有密码、私钥、令牌输入框，没有远程脚本。
- 外部链接具有安全属性。
- 构建脚本复制 `setup.html` 和 `setup.css`，正式构建产物中可以打开教程。
- README 和 Firebase 详细文档与教程命令一致。
- `npm test` 全部通过，`npm run build` 成功。

人工验收需要覆盖：

- 点击管理页“配置帮助”能够在新标签页打开教程。
- 桌面宽度下目录和正文层级清楚，长代码不破坏布局。
- 窄屏下步骤完整、链接和代码块可操作。
- 从零阅读时，使用者能够明确区分首次 Hosting 部署、取得 UID、最终规则部署三个阶段。
- 教程中没有任何属于项目维护者的个人 Firebase 配置。

## 风险与控制

- **步骤过长**：使用固定目录、编号章节、完成检查和常见问题降低查找成本。
- **Firebase 控制台界面变化**：同时提供功能名称和导航路径，README 与 `docs/firebase-setup.md` 保持同一事实来源。
- **用户误把 Web 配置当作秘密**：明确区分公开客户端配置与绝不能分享的凭据。
- **用户在绑定 UID 前尝试同步**：教程解释两阶段部署，并说明此时云按钮不可用是安全设计。
- **用户加载错误目录**：在构建和加载步骤中重复强调必须选择 `dist/extension`。
- **分享同一构建导致权限冲突**：页面开头和完成检查均明确要求每个人创建并构建自己的 Firebase 项目。
