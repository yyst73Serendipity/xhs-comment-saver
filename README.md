# 小红书评论收藏

浏览小红书时收藏和分类用户评论的 Chrome 浏览器插件。

## 项目目标

在小红书网页版浏览帖子时，能够方便地收藏感兴趣的评论，并对收藏的评论进行分类管理，方便日后查阅和回顾。

## 功能要点

- **评论收藏**：在小红书帖子评论区，每条评论旁自动注入「收藏」按钮，点击即可收藏
- **分类管理**：预设「干货」「好物」「攻略」「避雷」「其他」五个分类，支持自定义新建、重命名、删除分类
- **独立管理页**：点击浏览器工具栏的扩展图标，打开独立标签页，查看和管理所有收藏的评论
- **搜索筛选**：在管理页支持按关键词搜索评论，按分类筛选
- **评论详情**：每条收藏记录保存评论内容、作者、来源帖子链接、收藏时间

## 目录结构

```
xhs-comment-saver/
├── README.md                    # 项目说明文档
├── CLAUDE.md                    # 项目约定
├── manifest.json                # Chrome 扩展配置（Manifest V3）
├── assets/                      # 静态资源
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── background/                  # Service Worker
│   └── background.js            # 存储操作、消息通信
├── content/                     # 内容脚本
│   ├── content.js               # 注入收藏按钮和分类选择器
│   └── content.css              # 按钮与浮窗样式
├── manager/                     # 管理页面
│   ├── manager.html             # 管理页结构
│   ├── manager.css              # 管理页样式
│   └── manager.js               # 管理页逻辑
└── tests/                       # 测试文件
    └── storage.test.html        # 存储操作单元测试
```

## 启动方式

1. 打开 Chrome 浏览器，在地址栏输入 `chrome://extensions` 并回车
2. 在页面右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `xhs-comment-saver` 项目根目录，确认
5. 扩展图标会出现在浏览器工具栏中

### 使用方式

- **收藏评论**：打开任意小红书帖子页面，在评论区找到评论旁的「收藏」按钮，点击后选择分类即可收藏
- **查看收藏**：点击浏览器工具栏中的扩展图标，在新打开的标签页中管理和搜索收藏的评论

### 运行测试

在浏览器中打开 `chrome-extension://<扩展ID>/tests/storage.test.html`，点击「运行全部测试」按钮即可。

## 技术栈

- Chrome Extension Manifest V3
- 纯 HTML / CSS / JavaScript（无框架依赖）
- chrome.storage.local 存储数据
