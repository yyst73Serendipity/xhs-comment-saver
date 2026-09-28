# OpenAI 兼容 API 动态授权设计

## 目标

让管理页 AI 总结支持任意公网 HTTPS 的 OpenAI 兼容接口，包括 Qwen、Kimi、智谱、硅基流动等服务，同时避免扩展在安装时获得“访问所有网站”的永久权限。

## 范围

本次支持符合以下约定的接口：

- API 地址使用公网 `https://` URL。
- 请求使用 `POST` 和 `Content-Type: application/json`。
- API Key 通过 `Authorization: Bearer <API Key>` 发送。
- 请求体包含 `model` 与 `messages`。
- 响应正文位于 `choices[0].message.content`。

保留现有 Anthropic 原生协议支持，避免已经保存的 Anthropic 配置失效。本次不支持普通 HTTP、localhost、本机模型接口、OAuth 登录、自定义请求头和不同于 OpenAI/Anthropic 的私有响应格式。

## 方案选择

采用按 API 域名动态授权的方案：

1. `manifest.json` 在 `optional_host_permissions` 中声明 `https://*/*`，不把它加入永久 `host_permissions`。
2. 用户在 AI 配置卡片中输入服务商名称、API 地址、模型名称和 API Key。
3. 保存时解析 API 地址，生成精确到来源的权限模式，例如 `https://dashscope.aliyuncs.com/*`。
4. 页面在用户点击“保存配置”的交互中调用 `chrome.permissions.request()`。
5. Chrome 只向用户申请当前 API 域名；授权成功后才保存配置。

不采用永久 `https://*/*` 主机权限，也不引入代理服务器。

## 配置模型

配置继续保存在 `chrome.storage.local`，不上传 Firebase：

```json
{
  "activeProvider": "qwen",
  "providers": {
    "qwen": {
      "protocol": "openai-compatible",
      "apiKey": "用户输入的密钥",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      "model": "qwen-plus"
    }
  }
}
```

`activeProvider` 是用户输入的显示名称经过修剪和小写化后的键，不再决定域名白名单。`protocol` 决定请求格式：普通服务商使用 `openai-compatible`，现有 Anthropic 配置迁移为 `anthropic`。旧配置缺少 `protocol` 时，根据服务商名称兼容读取。

## 配置卡片

AI 配置卡片包含：

- AI 服务商：自由文本，仅作为本机配置名称，例如 `qwen`、`kimi`、`zhipu`。
- 接口类型：默认“OpenAI 兼容接口”；Anthropic 使用“Anthropic 原生接口”。
- API Key：密码输入框，已有密钥不回显，留空保留。
- API 地址：必须是完整公网 HTTPS 地址。
- 模型名称：由用户填写服务商实际支持的模型 ID。

卡片说明明确提示：保存时 Chrome 会请求访问该 API 域名；API Key 不随评论数据同步，换电脑、浏览器、Chrome 用户资料或重新安装扩展后需要重新配置。

## 保存和调用流程

保存流程：

1. 修剪并校验服务商名称、API Key、API 地址和模型名称。
2. 拒绝非 HTTPS、包含用户名或密码、缺少主机名，以及明显指向 localhost、`.local` 或私有 IP 的 URL。
3. 由 URL 生成精确到 HTTPS 主机名的权限模式；Chrome 匹配模式不区分端口，路径不进入权限模式。
4. 在本次保存点击中直接调用 `chrome.permissions.request()`，避免异步预检查丢失 Chrome 要求的用户手势；已有权限时 Chrome 直接返回成功。
5. 用户拒绝后保持弹窗打开并显示说明，不写入配置。
6. 授权成功后写入 `chrome.storage.local`，更新运行时配置并关闭弹窗。

调用流程：

1. AI 总结读取当前配置。
2. 根据 `protocol` 选择 OpenAI 兼容适配器或 Anthropic 适配器。
3. 请求前再次用 `chrome.permissions.contains()` 检查该来源权限。
4. 权限被用户撤销时停止请求，并提示重新打开 AI 配置授权。
5. 网络错误、HTTP 错误和无效响应继续转换为中文错误，不显示 API Key。

## 安全边界

- 只接受公网 HTTPS API 地址；直接填写 localhost、`.local` 或私有 IP 会被拒绝。
- 每次只申请用户当前填写的 API 来源，不申请所有网站的永久访问权限。
- API Key 只进入请求头和本机扩展存储，不进入日志、Toast、Firebase、导出文件或页面文本。
- 服务商名称只用于显示和本机配置索引，不参与 HTML 拼接。
- URL 校验和权限模式生成集中在 `api-config-core.js`，避免 UI 与请求层产生不同规则。

## 兼容和迁移

- DeepSeek、OpenAI、MiniMax 旧配置按 OpenAI 兼容协议读取。
- Anthropic 旧配置按原生协议读取。
- 旧配置第一次打开卡片时继续显示已有地址和模型。
- 如果旧配置对应的域名不再拥有权限，AI 总结提示用户重新保存配置并完成授权。
- 不自动弹出 Chrome 权限请求；权限请求只发生在用户点击“保存配置”时。

## 测试标准

单元和静态契约测试至少覆盖：

- 任意合法公网 HTTPS OpenAI 兼容地址可以标准化。
- Qwen、Kimi、智谱示例地址不受固定服务商名单限制。
- HTTP、localhost、带凭证 URL 和无效 URL 被拒绝。
- 主机权限由 URL 精确生成，路径不进入权限模式。
- 用户拒绝域名授权时不保存配置。
- 保存配置时只向 Chrome 请求当前 API 主机；已有权限时直接成功，不出现新增授权提示。
- OpenAI 兼容请求头、请求体和响应解析正确。
- Anthropic 旧配置和原生请求继续工作。
- API Key 不出现在构建产物的默认配置、错误文案或日志中。
- 完整测试套件和扩展构建通过。

## 预计修改文件

- `manifest.json`：声明动态 HTTPS 主机权限。
- `manager/api-config-core.js`：通用 URL 校验、权限模式和配置标准化。
- `manager/api-permission.js`：封装权限检查和按主机申请授权。
- `manager/apiconfig.js`：通用 OpenAI 兼容适配器并保留 Anthropic 适配器。
- `manager/manager.html`：增加接口类型和动态授权说明。
- `manager/manager.js`：表单保存、权限申请与中文错误处理。
- `tests/api-config.test.js`：通用端点、迁移和权限边界测试。
- `tests/api-permission.test.js`：授权成功、拒绝和已有权限测试。
- `tests/manager-ui.test.js`：配置卡片结构和交互契约测试。
- `tests/build-output.test.js`：构建后的权限和敏感信息边界测试。
- `README.md`：更新功能说明、配置步骤和项目结构。

## 参考

- [Chrome Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)：运行时申请可选主机权限。
- [Chrome 扩展权限声明](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)：`host_permissions` 与 `optional_host_permissions` 的权限边界。
