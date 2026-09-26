# 小红书评论收藏

浏览小红书时收藏和分类用户评论的 Chrome 浏览器插件（Manifest V3），并已建立 Google 账号云同步所需的构建与配置基础。

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
- 固定视口布局：左侧分类栏 + 中间评论卡片列表 + 右侧分析面板，标题栏/工具栏/侧栏/面板始终可见，仅评论列表滚动
- 评论支持按分类筛选、关键词搜索（高亮匹配）和按收藏时间排序（最新/最早）
- 评论组展开/折叠，查看同帖关联评论上下文（含图片、语音）
- 收藏帖子 URL 自动规范化处理，去除临时查询参数，确保链接可访问
- 页面底部显示本地存储配额进度条，按已用百分比分段变色（<80% 绿 / 80~95% 橙 / >95% 红），接近上限时提示清理

**笔记**
- 每条收藏支持添加私人笔记，hover 卡片底部即可输入
- 有笔记的评论始终显示笔记内容，hover 可继续编辑

**数据导入/导出**
- JSON 格式导出备份，支持导入合并（按 ID 自动去重）
- 导入采用两阶段交互：选择文件后先弹出预览统计（新增分类/评论、跳过重复数），确认后才合并写入
- 导入成功后评论直接显示，页面顶部 toast 提示结果（无需刷新）
- 导出包含评论、分类、AI 总结数据
- 数据存储在 chrome.storage.local，离线可用

**云同步数据模型（接入中）**
- 评论优先使用小红书 `commentId` 作为稳定标识；缺失时根据帖子地址、作者和正文生成 SHA-256 标识
- 分类使用稳定 ID，重命名分类不会改写评论关系，AI 总结按分类 ID 继续关联
- 已建立旧数据迁移预览、访客数据按稳定分类 ID 和评论字段合并、笔记与总结冲突保留以及删除墓碑模型；清空文本也作为有效冲突版本，旧笔记冲突会随迁移操作进入账号空间，过长旧记录会逐条隔离并在预览中显示中文原因
- `chrome.storage.local` 仍将作为本地工作副本；Google 登录和 Firestore 传输将在后续任务接入

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
├── manifest.json                 # Chrome 扩展配置（Manifest V3）
├── .env.example                  # 旧版 API 配置迁移模板（不进入构建产物）
├── auth/
│   └── auth-guard.js             # Firebase 配置检查和中文错误转换
├── config/
│   ├── firebase-config.js        # 构建期 Firebase 公共配置入口
│   └── firebase.example.json     # Firebase 本机配置示例
├── scripts/
│   └── build.js                  # 生成可加载扩展并保留固定扩展 ID
├── storage/
│   └── model.js                  # 评论、分类、总结的版本化模型与旧数据迁移
├── assets/                       # 静态资源
│   ├── icon-16.png               # 扩展图标 16x16
│   ├── icon-48.png               # 扩展图标 48x48
│   ├── icon-128.png              # 扩展图标 128x128
├── background/                   # Service Worker
│   └── background.js             # 存储初始化、评论/分类 CRUD、消息通信
├── content/                      # 内容脚本（注入小红书页面）
│   ├── content.js                # 评论区控件注入、作者/正文提取、批量收藏
│   └── content.css               # 收藏按钮、多选框、分类选择器浮层样式
├── manager/                      # 管理页面（独立标签页）
│   ├── manager.html              # 三栏布局页面结构
│   ├── manager.css               # 视觉样式（v2 浅暖色 + 成长视图 + 仪表盘卡片）
│   ├── manager.js                # 分类筛选、搜索高亮、笔记、AI 总结、四视图成长分析
│   ├── api-config-core.js        # AI 服务商默认值与官方来源校验
│   ├── api-config-store.js       # AI 本机配置读取和旧版配置迁移
│   ├── apiconfig.js              # LLM API 提供商预设（Anthropic / OpenAI / MiniMax / DeepSeek）
│   └── apiconfig.example.json    # 旧版本机配置迁移示例（不含密钥）
├── tests/                        # 测试文件
│   ├── auth-config.test.js       # Firebase 配置和 Manifest 权限测试
│   ├── api-config.test.js        # AI 配置迁移和 API 来源边界测试
│   ├── build-output.test.js      # 构建产物、固定 ID 与敏感文件边界测试
│   ├── readme-upgrade.test.js     # 升级前导出与恢复顺序契约测试
│   ├── sync-model.test.js         # 稳定标识、迁移、合并、冲突与墓碑测试
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
- **添加笔记**：hover 评论卡片底部即出现笔记输入框，编辑后自动保存
- **AI 总结**：选择具体分类后，点击右侧面板 🤖 按钮自动生成评论摘要（需配置 API Key）
- **成长视图**：点击右侧面板下方 🌊📊📈🔗 按钮切换四种可视化视图，分析收藏趋势
- **导出备份**：管理页点击「导出」按钮下载 JSON 备份文件；点击「导入」合并已有备份

### 配置 AI 总结

1. 打开管理页，点击顶部「AI 配置」
2. 依次填写服务商、API Key、该服务商官方 API 地址和模型名称；扩展会拒绝 Manifest 未授权的自建域名
3. 配置仅写入当前浏览器的 `chrome.storage.local`，不会进入 Git、构建产物或 Firebase
4. 选择具体分类后点击 🤖 即可生成 AI 总结

如果是从源码目录升级到 `dist/extension`，必须先完成上面的“导出备份 → 确认落盘 → 卸载并加载构建版 → 导入恢复”流程，再在构建版顶部「AI 配置」重新输入一次 API Key 和服务商；之后配置只保存在当前安装实例中。

如果始终沿用同一个源码加载路径，只更新代码并点击 Chrome 的“重新加载”，新版管理页可以把旧 `.env` 与 `manager/apiconfig.json`（或 `manager/apiconfig.local.json`）迁移到该安装实例的本机存储，并显示迁移成功提示。此便利迁移不适用于卸载后切换目录。

构建产物不会包含或直接读取上述旧配置文件。不要把密钥复制进构建目录、Git 或 Firebase。

### 运行测试

运行 `npm test` 执行 Node.js 自动测试。构建产物测试只允许使用系统临时目录下带专用前缀的独立目录并自动清理，不会覆盖可交付的 `dist`；正式构建只能输出到项目内固定的 `dist`。原有浏览器存储测试仍可在源码模式下打开 `chrome-extension://<扩展ID>/tests/storage.test.html` 执行。

### Firebase 构建配置

复制 `config/firebase.example.json` 为 `config/firebase.local.json` 并填写独立 Firebase 项目的公开客户端配置。此本机文件已被 Git 忽略；未创建时仍可运行 `npm run build`，扩展会以本地模式构建。Google 登录和云同步将在后续任务接入。

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
