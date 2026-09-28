# 小红书评论收藏

浏览小红书时收藏和分类用户评论的 Chrome 浏览器插件（Manifest V3），支持 Google 账号登录和 Firestore 跨设备云同步。

## 功能

**评论收藏**
- 小红书帖子评论区自动注入收藏按钮，支持单条或批量勾选收藏
- 收藏时选择分类，一键保存评论正文、作者、帖子链接
- 自动提取评论中的配图（支持多图）和语音（<audio> 标签）
- 相同帖子批量收藏的评论共享同一「评论组」，管理页聚合展示

**分类管理**
- 预设「未分类」「好物」「避雷」「搞笑」四个分类
- 支持自定义新建、重命名、删除分类
- 卡片中每条评论可随时切换分类（马卡龙色块下拉面板）

**管理页**
- 点击浏览器工具栏扩展图标，在新标签页打开独立管理页
- 使用“灵感剪贴簿”视觉：奶油纸张底色、胭脂红强调色和深色双层顶部栏；桌面端为左侧分类、中间评论、右侧洞察三栏，中等与窄屏会自动重排
- 左侧分类栏完整保留新建、重命名和删除分类；右侧明确分为 AI 总结与数据分析两个区域
- 评论支持按分类筛选、关键词搜索（高亮匹配）和按收藏时间排序（最新/最早）
- 评论组展开/折叠，查看同帖关联评论上下文（含图片、语音）
- 收藏帖子 URL 自动规范化处理，去除临时查询参数，确保链接可访问
- 页面顶部显示 Google 账号、同步状态、待上传数量和最近同步时间；状态指示点区分本地、待同步、同步中、已同步和失败
- 顶部集中提供 AI 配置、导入、导出、清空、立即同步、迁移、冲突处理、清除本机缓存、退出登录和内置配置帮助
- 页面底部显示本地缓存工作副本大小，并明确区分浏览器本机数据与 Firebase 云端配额

**笔记**
- 每条收藏支持添加私人笔记，hover 卡片底部即可输入
- 有笔记的评论始终显示笔记内容，hover 可继续编辑

**数据导入/导出**
- JSON 格式导出备份，支持导入合并（按 ID 自动去重）
- 导入采用两阶段交互：选择文件后先弹出预览统计（新增分类/评论、跳过重复数），确认后才合并写入
- 导入成功后评论直接显示，页面顶部 toast 提示结果（无需刷新）
- 导出包含评论、分类、AI 总结数据
- 数据存储在 chrome.storage.local，离线可用

**Google 账号云同步**
- 评论依次使用小红书 `commentId`、可靠旧 `key`、帖子 URL 与正文或媒体组合生成稳定标识，旧本地 `id` 仅作为迁移兜底；标识统一检查 UTF-8 长度，过长或缺少帖子 URL 且无法兜底的记录会进入迁移问题清单
- 分类使用稳定 ID，重命名分类不会改写评论关系，AI 总结按分类 ID 继续关联
- 已建立旧数据迁移预览、访客数据按稳定分类 ID 和评论字段线性批量合并、笔记与总结冲突保留以及删除墓碑模型；操作字段经过集合白名单检查，动态数据使用无原型映射，过长或无法识别的旧记录会逐条隔离并显示中文原因
- 首次旧数据迁移失败时，仅把失败评论、分类或总结的完整原文与中文原因写入版本化状态的 `migrationQuarantine`；兼容投影覆盖旧键后仍可恢复或供后续导出，成功数据不会在隔离区重复备份
- `chrome.storage.local` 作为本地工作副本，访客与每个 Google UID 使用独立命名空间；切换账号只切换当前空间，不会把访客数据或其他账号的待上传修改自动搬入
- 访客修改只在本机落盘，不产生云端队列；登录账号的评论、分类、总结与顺序修改会进入独立待上传队列，导入数据也遵循同一规则
- 评论与总结在入队前按 UTF-8 字节校验：包含冲突与版本包装的完整记录最多 700 KiB、单条评论最多 100 张图片、媒体 URL 最多 16 KiB，正文、笔记及总结元数据另有逐字段上限；这些常量将由 Firestore Rules 使用相同或更严格的边界
- 本地写入通过串行存储层提交，版本化状态和旧界面兼容投影在同一次 `chrome.storage.local.set` 中更新；同步引擎负责 Firestore 增量拉取、队列上传和失败续传
- Service Worker 已统一通过账号存储层处理评论、分类和总结的读取与修改，并继续返回现有内容脚本和管理页可直接使用的卡片、分类及总结结构
- 数据修改后会通知已打开的小红书页面重新读取收藏 ID 和组合键，无需刷新页面即可更新收藏标记；私人笔记和总结不会写入小红书页面 DOM
- 已接入 Firebase Google 登录桥：Service Worker 通过唯一 offscreen 文档加载独立 Hosting 页面，托管页只向固定扩展来源返回短期 ID token，请求号、来源和 0～120 秒签发时间会被严格校验
- `cloudLogin`、`cloudLogout`、`cloudStatus` 已统一进入后台认证入口；Firebase 首次会话状态落盘前，账号范围消息会等待，避免 Service Worker 重启时误写上次账号空间；退出登录只回到访客空间并保留账号本地数据
- 隐藏认证文档使用 Chrome 116 已支持的 `runtime.getContexts` 检查，不依赖仅在 Chrome 150 起提供的 `offscreen.hasDocument`
- 配置 `ownerUid` 后会拒绝其他 Google 账号；没有 Firebase 本机配置时不会初始化 SDK 或创建登录文档，扩展继续以纯本地模式工作
- Firestore 只开放所有者路径下的评论、分类、总结、设置和幂等操作回执；业务文档由服务端时间排序，未知集合、额外顶层字段、客户端伪造时间和越界字段会被规则拒绝
- 云端提交在单个事务中先读取操作回执和目标记录，再一次性写入合并记录与回执；重复操作不会二次修改数据，增量读取按服务器时间与文档 ID 稳定分页，每页最多 200 条
- 同步引擎先拉取四类云快照再上传本地队列，单轮最多提交 100 项；每页快照和每条确认都会独立落盘，切换账号后旧请求不能写入新账号空间
- 登录恢复、账号内业务修改、手动同步、迁移确认和定时闹钟都会触发续传；失败保留本地队列并从 30 秒开始指数退避，最长一小时
- 管理页的评论、分类、笔记、总结、导入和清空操作统一通过后台版本化存储执行；登录后这些修改自动进入当前 Google 账号的待上传队列
- 首次登录可预览本机访客数据迁移数量；“确认迁移”只有在 JSON 备份下载后才可点击，原访客工作区仍保留在本机
- 私人笔记或 AI 总结在多设备并发编辑时会保留另一版本，管理页可逐项比较并选择最终内容
- “清除本机缓存”只清当前账号已下载的云快照并重新拉取；存在待上传修改时会拒绝清理，避免丢失尚未同步的数据

**AI 总结**
- 右侧面板上半部分，按分类存储 Markdown 总结笔记
- 支持手动编写（实时自动保存）和 AI 自动生成（调用大模型 API）
- 一键导出为 `.md` 文件
- 管理页提供「AI 配置」入口，API Key 和当前服务商仅保存在本机 `chrome.storage.local`

**成长视图（多维度数据分析）**
- 右侧面板下半部分，四种可视化视图一键切换：
  - 🌊 **河流图**：Canvas 堆叠面积图，按月展示各分类收藏量的此消彼长，图例可交互
  - 📊 **网格图**：Canvas 热力图，行=分类、列=周，色块深浅反映收藏密度
  - 📈 **成长仪表盘**：本月活跃领域 / 新兴关注（14天）/ 沉寂领域 / 收藏趋势
  - 🔗 **关系图谱**：力导向图，按评论间关系（同帖/同作者/同组）连线
- 河流图、网格图、仪表盘使用全部数据；关系图谱仅看当前分类

**SPA 适配**
- 监听小红书单页路由变化，切换帖子时自动重新注入控件
- 定时扫描 + 重试机制，确保评论区加载后控件及时出现

## 项目结构

```
xhs-comment-saver/
├── package.json                  # 测试、构建、模拟器与部署命令
├── firebase.json                 # Firestore Emulator 与 Hosting 配置
├── firestore.rules               # 个人所有者访问和字段边界规则
├── manifest.json                 # Chrome 扩展配置（Manifest V3）
├── .env.example                  # 旧版 API 配置迁移模板（不进入构建产物）
├── auth/
│   ├── auth-guard.js             # Firebase 配置、认证消息边界和中文错误转换
│   ├── auth-service.js           # Google 登录、所有者校验和账号状态分发
│   └── firebase-client.js        # 延迟初始化 Firebase Auth 与 Firestore
├── auth-page/
│   ├── index.html                # 部署到 Firebase Hosting 的登录桥页面
│   └── sign-in.js                # Google 弹窗登录和最小令牌回传
├── config/
│   ├── firebase-config.js        # 构建期 Firebase 公共配置入口
│   └── firebase.example.json     # Firebase 本机配置示例
├── docs/
│   └── firebase-setup.md         # Firebase 控制台、首次 UID 与部署流程
├── scripts/
│   ├── build.js                  # 生成可加载扩展并保留固定扩展 ID
│   └── deploy.js                 # 校验项目与所有者后确定性部署
├── sync/
│   ├── cloud-store.js            # Firestore 幂等事务与增量分页读取
│   ├── snapshot.js               # 云端分页与本地快照合并
│   └── sync-engine.js            # 有界同步、账号保护、迁移与重试调度
├── storage/
│   ├── model.js                  # 评论、分类、总结的版本化模型与旧数据迁移
│   ├── sync-limits.js            # 本地同步与 Firestore Rules 共用的数据边界
│   ├── account-state.js          # 访客/账号命名空间和统一业务动作
│   └── local-store.js            # 串行原子保存状态与兼容投影
├── assets/                       # 静态资源
│   ├── icon-16.png               # 扩展图标 16x16
│   ├── icon-48.png               # 扩展图标 48x48
│   ├── icon-128.png              # 扩展图标 128x128
├── background/                   # Service Worker
│   ├── background.js             # 存储初始化、消息响应与页面数据变更通知
│   └── local-dispatch.js         # 统一业务分发与旧版消息返回结构适配
├── offscreen/
│   ├── offscreen.html            # 扩展隐藏认证文档
│   └── offscreen.js              # 托管页面加载与认证响应校验
├── content/                      # 内容脚本（注入小红书页面）
│   ├── content.js                # 评论区控件注入、作者/正文提取、批量收藏
│   └── content.css               # 收藏按钮、多选框、分类选择器浮层样式
├── manager/                      # 管理页面（独立标签页）
│   ├── manager.html              # 三栏布局页面结构
│   ├── manager.css               # 视觉样式（v2 浅暖色 + 成长视图 + 仪表盘卡片）
│   ├── inspiration-theme.css     # 灵感剪贴簿主题、三栏布局、状态反馈与响应式覆盖
│   ├── manager.js                # 分类筛选、搜索高亮、笔记、AI 总结、四视图成长分析
│   ├── cloud-panel.css           # Google 账号、同步状态与冲突弹窗样式
│   ├── cloud-panel.js            # 登录、同步、迁移备份与冲突处理交互
│   ├── summary-store.js          # 分类总结的统一后台保存和删除适配
│   ├── api-config-core.js        # AI 服务商默认值与官方来源校验
│   ├── api-config-store.js       # AI 本机配置读取和旧版配置迁移
│   ├── apiconfig.js              # LLM API 提供商预设（Anthropic / OpenAI / MiniMax / DeepSeek）
│   └── apiconfig.example.json    # 旧版本机配置迁移示例（不含密钥）
├── tests/                        # 测试文件
│   ├── auth-config.test.js       # Firebase 配置和 Manifest 权限测试
│   ├── api-config.test.js        # AI 配置迁移和 API 来源边界测试
│   ├── build-output.test.js      # 构建产物、固定 ID 与敏感文件边界测试
│   ├── readme-upgrade.test.js    # 升级前导出与恢复顺序契约测试
│   ├── sync-model.test.js        # 稳定标识、迁移、合并、冲突与墓碑测试
│   ├── account-state.test.js     # 账号隔离、导入排队和业务动作测试
│   ├── storage-layout.test.js    # 串行原子写入与单副本边界测试
│   ├── cloud-store.test.js       # 云端事务、路径和分页单元测试
│   ├── sync-engine.test.js       # 快照、批次、账号保护和退避测试
│   ├── manager-cloud.test.js      # 管理页云同步入口与统一业务写入约束测试
│   ├── manager-ui.test.js         # 管理页结构、主题、分析区和响应式契约测试
│   ├── integration/
│   │   └── firestore-rules.test.js # Firestore Emulator 安全规则测试
│   └── storage.test.html         # 存储操作单元测试

```

## 安装和使用

### 安装

1. 打开 Chrome，地址栏输入 `chrome://extensions` 并回车
2. 右上角开启「开发者模式」
3. 在项目目录运行 `npm install` 和 `npm run build`
4. 点击「加载已解压的扩展程序」
5. 选择 `xhs-comment-saver/dist/extension`，确认
6. 扩展图标出现在浏览器工具栏，即安装成功

### 从源码目录升级到构建版

更换 unpacked 加载目录可能清除 `chrome.storage.local` 中的评论、分类、AI 总结和本机设置。必须严格按以下顺序操作：

1. 保持旧源码版扩展仍处于安装状态，打开旧管理页并点击「导出」，下载完整 JSON 备份
2. 在 Finder 或下载目录中确认文件已落盘，并确认该 JSON 文件可以正常找到；没有确认前不要卸载扩展
3. 运行 `npm run build` 生成 `dist/extension`
4. 完成备份确认后，再卸载旧扩展，并在 Chrome 扩展管理页加载 `dist/extension`，完成加载目录切换
5. 打开新管理页点击「导入」，选择刚才的 JSON 文件，恢复评论、分类和 AI 总结，并检查数量是否符合预期
6. 点击顶部「AI 配置」，重新输入 API Key 和服务商配置

固定扩展 ID 不能保证数据跨卸载保留；JSON 备份是此次升级的数据迁移依据。

### 使用

- **收藏评论**：打开任意小红书帖子页面，在评论区勾选评论，点击弹出的收藏按钮并选择分类
- **管理收藏**：点击浏览器工具栏扩展图标，在新标签页中查看、搜索、管理所有收藏
- **管理分类**：在左侧分类栏点击 `+` 新建分类；分类项上的操作按钮可重命名或删除分类
- **添加笔记**：hover 评论卡片底部即出现笔记输入框，编辑后自动保存
- **AI 总结**：选择具体分类后，点击右侧面板 🤖 按钮自动生成评论摘要（需配置 API Key）
- **成长视图**：点击右侧面板下方 🌊📊📈🔗 按钮切换四种可视化视图，分析收藏趋势
- **导出备份**：管理页点击「导出」按钮下载 JSON 备份文件；点击「导入」合并已有备份
- **登录与同步**：Firebase 配置完成后，点击顶部「使用 Google 登录」；登录成功后账号内的新增、编辑、导入和删除都会自动同步，也可点击「立即同步」手动触发
- **查看同步状态**：顶部账号旁会显示最近同步时间或待上传数量；同步中会暂时禁用「立即同步」，失败时保留待上传队列供再次同步
- **配置帮助**：点击顶部「配置帮助」，可在管理页内查看 Google 登录、首次迁移和换机恢复步骤
- **迁移本机收藏**：登录后点击「迁移本机数据」，先下载 JSON 备份，随后点击「确认迁移」；迁移数据进入当前 Google 账号的同步队列
- **处理冲突**：顶部出现「处理冲突」时，逐项查看当前版本和另一台设备版本，并选择要保留的内容
- **换电脑恢复**：在新电脑加载相同构建版扩展并登录同一 Google 账号，点击「立即同步」即可拉取该账号的评论、分类、笔记和总结

完整的项目创建、Google 登录、Firestore、首次取得 UID 和部署步骤见 [Firebase 配置指南](docs/firebase-setup.md)。

### 配置 AI 总结

1. 打开管理页，点击顶部「AI 配置」
2. 依次填写服务商、API Key、该服务商官方 API 地址和模型名称；扩展会拒绝 Manifest 未授权的自建域名
3. 配置仅写入当前浏览器的 `chrome.storage.local`，不会进入 Git、构建产物或 Firebase
4. 选择具体分类后点击 🤖 即可生成 AI 总结

如果是从源码目录升级到 `dist/extension`，必须先完成上面的“导出备份 → 确认落盘 → 卸载并加载构建版 → 导入恢复”流程，再在构建版顶部「AI 配置」重新输入一次 API Key 和服务商；之后配置只保存在当前安装实例中。

如果始终沿用同一个源码加载路径，只更新代码并点击 Chrome 的“重新加载”，新版管理页可以把旧 `.env` 与 `manager/apiconfig.json`（或 `manager/apiconfig.local.json`）迁移到该安装实例的本机存储，并显示迁移成功提示。此便利迁移不适用于卸载后切换目录。

构建产物不会包含或直接读取上述旧配置文件。不要把密钥复制进构建目录、Git 或 Firebase。

### 运行测试

运行 `npm test` 执行 Node.js 自动测试。安装 Java 后可运行 `npm run test:integration`，由 Firebase Emulator 验证所有者访问、字段类型、集合白名单和服务器时间规则。构建产物测试只允许使用系统临时目录下带专用前缀的独立目录并自动清理，不会覆盖可交付的 `dist`；正式构建只能输出到项目内固定的 `dist`。原有浏览器存储测试仍可在源码模式下打开 `chrome-extension://<扩展ID>/tests/storage.test.html` 执行。

### Firebase 构建配置

复制 `config/firebase.example.json` 为 `config/firebase.local.json` 并填写独立 Firebase 项目的公开客户端配置、HTTPS `authPageUrl` 和可选 `ownerUid`。此本机文件已被 Git 忽略；未创建时仍可运行 `npm run build`，扩展会以本地模式构建，并且不会初始化 Firebase 或创建登录文档。

构建会同时生成 `dist/extension` 和 `dist/hosting`。管理页已接入 `cloudLogin`、`cloudLogout`、`cloudStatus`、手动同步、迁移和缓存重拉入口；在部署 Hosting、启用 Google 登录并填写 `ownerUid` 前，扩展仍以本地模式运行。基础 Firebase 配置完成但尚未填写 `ownerUid` 时，管理页只开放登录、复制 UID 和退出登录；把复制的 UID 填入配置并重新构建后，才开放云数据按钮，其他 Google 账号随后会被扩展拒绝。

首次配置时保持 `ownerUid` 为空，运行 `npm run deploy:hosting` 只部署登录桥，加载 `dist/extension` 并登录后从管理页复制真实 UID。把 UID 写回配置后运行 `npm run deploy`；部署脚本会重新构建并确认 `dist/firestore.rules` 不含所有者占位符，再通过项目内 Firebase CLI 参数数组部署 Firestore Rules 与 Hosting。不要把本机配置加入 Git，详细顺序见 [Firebase 配置指南](docs/firebase-setup.md)。

## 技术栈

- Chrome Extension Manifest V3
- 纯 HTML / CSS / JavaScript（无框架依赖）
- Firebase Web SDK（Google 登录与 Firestore 云同步基础）
- esbuild（生成 `dist/extension` 可加载目录）
- Node.js 原生测试运行器、Firebase Emulator 测试工具
- Canvas 2D（河流图 / 网格图 / 关系图谱绘制）
- 力导向布局算法（Fruchterman-Reingold 简化版）
- chrome.storage.local 本地存储
- LLM API（Anthropic / OpenAI / OpenAI 兼容，用于 AI 总结）
