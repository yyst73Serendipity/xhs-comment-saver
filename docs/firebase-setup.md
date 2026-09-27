# xhs-comment-saver Firebase 配置指南

这份指南为 `xhs-comment-saver` 创建一个独立的 Firebase 项目，并按“先部署登录页取得 UID，再部署所有者规则”的顺序完成配置。整个流程适用于 Chrome 的“加载未打包的扩展程序”，无需发布到 Chrome 应用商店。

## 1. 创建独立 Firebase 项目

1. 打开 [Firebase 控制台](https://console.firebase.google.com/)，点击“创建项目”。
2. 使用专属于评论收藏扩展的名称，例如 `xhs-comment-saver-personal`。项目 ID 创建后不能修改，不要复用其他扩展的 Firebase 项目。
3. 选择 Spark 免费方案。Google Analytics 对本扩展不是必需项，可以关闭。
4. 项目创建完成后，在“项目概览”点击 Web 图标 `</>`，应用昵称可填写 `xhs-comment-saver-web`，然后点击“注册应用”。
5. 复制控制台显示的 `firebaseConfig`。这是 Firebase 用于识别 Web 应用的公开客户端配置，可以进入浏览器构建产物；它不是管理员密钥。

官方参考：[注册 Firebase Web 应用](https://firebase.google.com/docs/web/setup)。

## 2. 写入本机配置

在项目根目录执行：

```bash
cp config/firebase.example.json config/firebase.local.json
```

把控制台提供的字段逐项填入 `config/firebase.local.json`，并把 `authPageUrl` 设置为该项目的默认 Hosting 地址：

```json
{
  "apiKey": "控制台中的 apiKey",
  "authDomain": "你的项目ID.firebaseapp.com",
  "projectId": "你的项目ID",
  "storageBucket": "控制台中的 storageBucket",
  "messagingSenderId": "控制台中的 messagingSenderId",
  "appId": "控制台中的 appId",
  "measurementId": "控制台有此字段时填写，否则删除本行",
  "authPageUrl": "https://你的项目ID.web.app",
  "ownerUid": ""
}
```

`config/firebase.local.json` 已被 `.gitignore` 忽略。AI 总结使用的 API Key 继续只保存在本机扩展存储中，不要填入 Firebase 配置、Git 或 Hosting。

## 3. 启用 Google 登录

1. 在 Firebase 控制台进入“构建 → Authentication”。
2. 点击“开始使用”，打开“登录方法”页。
3. 选择 Google，开启该提供方，选择项目支持邮箱并保存。

官方参考：[Firebase Web Google 登录](https://firebase.google.com/docs/auth/web/google-signin)。

## 4. 创建 Firestore

1. 进入“构建 → Firestore Database”，点击“创建数据库”。
2. 选择“生产模式”。仓库内规则在取得所有者 UID 后单独部署；首次部署前默认拒绝所有云数据访问。
3. 选择离自己日常使用地点较近的区域。数据库创建后不能直接更改区域。

不要在控制台临时放宽规则。最终规则只允许配置中的 `ownerUid` 访问其个人路径。

## 5. 登录 Firebase CLI

项目已经把 Firebase CLI 安装为开发依赖。先在项目根目录运行：

```bash
npx firebase login
```

如果浏览器回调显示 `Unable to verify client` 或本机回调失败，重新运行：

```bash
npx firebase login --no-localhost
```

按终端提示在浏览器确认后，把网页给出的授权码粘贴回原终端。授权码属于临时凭据，不要写入文档、聊天记录或 Git。

## 6. 首次构建并只部署登录页

此时 `ownerUid` 必须保持空字符串。运行：

```bash
npm run build
cat dist/extension-id.txt
npm run deploy:hosting
```

`deploy:hosting` 只部署 `dist/hosting` 登录桥，不会部署 Firestore Rules。Firebase Hosting 默认提供 `https://项目ID.web.app` 和 `https://项目ID.firebaseapp.com` 两个 HTTPS 地址；本项目统一使用前者作为 `authPageUrl`。官方参考：[Firebase Hosting 快速开始](https://firebase.google.com/docs/hosting/quickstart)。

## 7. 加载扩展并取得真实 UID

1. 打开 `chrome://extensions`，启用右上角“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择项目中的 `dist/extension`，不要选择源码根目录。
3. 点击扩展图标打开管理页。
4. 顶部会显示“云服务待绑定所有者”，点击“使用 Google 登录”。
5. 使用以后需要跨设备同步的 Google 账号登录。
6. 登录成功后，账号栏会显示邮箱和 Firebase UID。点击“复制 UID”。

在未填写 `ownerUid` 的这一阶段，登录和退出可用，评论云数据的同步、迁移和缓存清理按钮保持关闭。

## 8. 绑定所有者并部署规则

把复制的 UID 原样写入 `config/firebase.local.json` 的 `ownerUid`，然后运行：

```bash
npm run deploy
```

该命令会重新构建，并同时部署 Hosting 与绑定真实 UID 的 Firestore Rules。脚本会拒绝空 UID、无效项目 ID、仍含占位符或与配置不一致的规则。

返回 `chrome://extensions`，点击该扩展的“重新加载”，再重新打开管理页。现在应显示“立即同步”“迁移本机数据”“清除本机缓存”和“退出登录”。

## 9. 首次迁移和跨设备验证

1. 登录后点击“迁移本机数据”。
2. 先点击“下载备份”，确认 JSON 文件已经落盘；只有完成备份后“确认迁移”才可用。
3. 点击“确认迁移”，等待顶部状态变为“已同步”。
4. 在另一台电脑或另一个 Chrome 配置文件中加载同一个 `dist/extension`，登录同一 Google 账号并点击“立即同步”。
5. 检查评论、分类、私人笔记和 AI 总结是否完整出现。
6. 导入 JSON 后也会走统一后台写入并同步；“清除本机缓存”只删除当前账号下载到这台电脑的工作副本，随后会从 Firestore 重新拉取，不会删除云端数据。

如果另一 Google 账号尝试登录，扩展应拒绝所有者不匹配；Firestore Rules 也会拒绝该账号读取或写入数据。

## 10. 验证命令

```bash
npm test
npm run test:integration
npm run build
git diff --check
git status --short --ignored
```

应确认单元测试、Firestore Emulator 规则测试和构建全部通过，并在 ignored 列表中看到 `config/firebase.local.json`、`dist/`、`.firebase/` 等本机或构建文件。
