# Firebase 云同步新手手册设计

## 目标

给拿到项目源码的新使用者一份直接可读的配置手册，让每个人都能创建并绑定自己的 Firebase 项目，避免不同使用者共享评论数据。

## 实现方式

- 新增一个静态页面 `manager/setup.html`。
- 页面使用内联 CSS，不增加 JavaScript、第三方依赖或额外样式文件。
- 管理页点击“配置帮助”后，通过 `target="_blank"` 在新标签页打开该手册。
- 删除原来的简略帮助弹窗和相关事件代码，避免两份说明并存。
- 构建脚本把 `setup.html` 复制到 `dist/extension/manager/`。

## 手册内容

按实际执行顺序写清楚：

1. 准备 Chrome、Node.js、npm、Google 账号和项目源码。
2. 创建个人 Firebase Spark 项目。
3. 注册 Web 应用并取得公开客户端配置。
4. 启用 Google 登录。
5. 创建 Firestore Standard 数据库。
6. 复制并填写 `config/firebase.local.json`，首次保持 `ownerUid` 为空。
7. 登录 Firebase CLI，构建并执行 `npm run deploy:hosting`。
8. 在 Chrome 加载 `dist/extension`。
9. 登录 Google 账号，并从 Firebase Authentication 用户列表取得 UID。
10. 填写 `ownerUid`，执行 `npm run deploy`，重新加载扩展。
11. 迁移本机数据并在另一台电脑验证同步。
12. 列出完成检查和常见问题。

## 页面样式

页面保持简单文档形式：深色标题栏、居中的白色正文区域、清晰的标题、列表、提示框和代码块。手机宽度下正文自动收窄。页面不需要侧边导航、步骤进度、表单或动态效果。

## 安全要求

- 每位使用者创建自己的 Firebase 项目。
- 手册不收集或保存任何配置。
- 不提供密码、授权码或 API Key 输入框。
- 外部链接使用 HTTPS，并带 `noopener noreferrer`。
- 不写入维护者自己的 Firebase 项目 ID、邮箱或 UID。

## 修改范围

- 新增 `manager/setup.html`。
- 修改 `manager/manager.html`、`manager/cloud-panel.js`、`manager/inspiration-theme.css`。
- 修改 `scripts/build.js`，将手册加入构建产物。
- 新增或更新对应测试。
- 更新 README 中的配置帮助说明。

## 验收标准

- 点击“配置帮助”会打开独立新标签页。
- 手册完整覆盖从创建 Firebase 项目到跨设备验证的流程。
- 页面没有脚本、敏感信息输入或复杂交互。
- `npm test` 全部通过。
- `npm run build` 成功，构建产物包含 `manager/setup.html`。
