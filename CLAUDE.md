# xhs-comment-saver

小红书评论收藏 Chrome 插件 — 浏览小红书时收藏和分类用户评论。

## 当前进度

已完成基础功能开发，Chrome 扩展可加载测试。

## 已实现功能

- 评论区注入收藏按钮（放在操作栏，和点赞/评论同排）
- 多选批量收藏：方框勾选多条评论后一键收藏为评论组（方案 C 设计）
- 分类管理：预设 5 个分类 + 自定义新建/重命名/删除
- 独立管理页面：左侧分类栏 + 右侧评论列表，评论组聚合展示上下文
- URL 判断：仅帖子详情页生效，首页/列表页不注入
- 测试页面：tests/storage.test.html

## 关键技术决策

- 纯 HTML/CSS/JS，无框架
- Chrome Extension Manifest V3
- chrome.storage.local 存储
- 选择框：14px 圆角方框，默认隐藏 hover 浮现，选中红底白勾
- 评论组：共享 groupId + groupIndex，管理页缩进显示上下文
- 详情页判断：URL 正则匹配 /explore/{id}、/discovery/item/、/detail/
