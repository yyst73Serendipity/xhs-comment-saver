# OpenAI 兼容 API 动态授权实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 总结支持任意公网 HTTPS 的 OpenAI 兼容接口，并只在保存配置时申请当前 API 主机的 Chrome 权限。

**Architecture:** `api-config-core.js` 负责服务商名称、协议、HTTPS URL 和权限模式的纯函数校验；`api-permission.js` 封装可注入测试的 Chrome 主机权限操作；`apiconfig.js` 按协议提供 OpenAI 兼容与 Anthropic 两种适配器；`manager.js` 负责表单状态并组合这些边界。旧配置在标准化时补齐协议，无需另建数据迁移脚本。

**Tech Stack:** Chrome Extension Manifest V3、`chrome.permissions`、原生 JavaScript、`chrome.storage.local`、Node.js `node:test`

## Global Constraints

- 只支持公网 HTTPS API；拒绝 HTTP、localhost、`.local`、明显的私有或回环 IP。
- OpenAI 兼容协议使用 Bearer API Key、`model`、`messages` 和 `choices[0].message.content`。
- 保留 Anthropic 原生请求格式和旧配置读取。
- `https://*/*` 只能出现在 `optional_host_permissions`，不得成为永久 `host_permissions`。
- API Key 不得进入 Firebase、导出文件、错误文案、日志或默认构建产物。
- 不新增第三方依赖。
- 新增逻辑先写失败测试；全部测试放在项目根目录 `tests/`。
- 每项任务独立提交，提交信息使用中文。

---

### Task 1: 通用端点校验与可选主机权限

**Files:**
- Modify: `manifest.json`
- Modify: `manager/api-config-core.js`
- Modify: `manager/api-config-store.js`
- Modify: `tests/api-config.test.js`

**Interfaces:**
- Produces: `normalizeProviderName(value: unknown): string`
- Produces: `validateApiUrl(value: string): string`
- Produces: `createHostPermissionPattern(value: string): string`
- Produces: `normalizeApiConfig(value: unknown): RuntimeApiConfig | null`
- `RuntimeApiConfig` fields: `{ provider, protocol, apiKey, baseUrl, model }`

- [ ] **Step 1: Write failing endpoint and manifest tests**

Replace the fixed four-provider boundary test with table-driven assertions and retain the existing storage migration tests:

```js
test('任意公网 HTTPS OpenAI 兼容端点可生成精确主机权限', async () => {
  const context = await loadApiModules();
  const core = context.XHS_API_CONFIG_CORE;
  const examples = [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'https://dashscope.aliyuncs.com/*'],
    ['https://api.moonshot.cn/v1/chat/completions', 'https://api.moonshot.cn/*'],
    ['https://open.bigmodel.cn/api/paas/v4/chat/completions', 'https://open.bigmodel.cn/*']
  ];
  for (const [url, permission] of examples) {
    assert.equal(core.validateApiUrl(url), url);
    assert.equal(core.createHostPermissionPattern(url), permission);
  }

  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.equal(manifest.host_permissions.includes('https://*/*'), false);
  assert.equal(manifest.host_permissions.some(value => /api\.(openai|deepseek|minimax|anthropic)/.test(value)), false);
});

test('非公网 HTTPS API 地址被拒绝', async () => {
  const { validateApiUrl } = (await loadApiModules()).XHS_API_CONFIG_CORE;
  for (const value of [
    'http://api.example.com/v1/chat/completions',
    'https://localhost/v1/chat/completions',
    'https://model.local/v1/chat/completions',
    'https://127.0.0.1/v1/chat/completions',
    'https://192.168.1.2/v1/chat/completions',
    'https://user:secret@api.example.com/v1/chat/completions'
  ]) assert.throws(() => validateApiUrl(value));
});

test('任意服务商名称按 OpenAI 兼容协议标准化', async () => {
  const { normalizeApiConfig } = (await loadApiModules()).XHS_API_CONFIG_CORE;
  const result = normalizeApiConfig({
    activeProvider: ' Qwen ',
    providers: {
      qwen: {
        protocol: 'openai-compatible',
        apiKey: 'secret',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        model: 'qwen-plus'
      }
    }
  });
  assert.equal(result.provider, 'qwen');
  assert.equal(result.protocol, 'openai-compatible');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test tests/api-config.test.js`

Expected: FAIL because `validateApiUrl` and `createHostPermissionPattern` do not exist, arbitrary providers normalize to `null`, and the manifest still has fixed AI hosts.

- [ ] **Step 3: Implement the pure configuration boundary**

In `manifest.json`, retain Xiaohongshu and Google/Firebase hosts, remove the four fixed AI hosts, and add:

```json
"optional_host_permissions": [
  "https://*/*"
]
```

In `manager/api-config-core.js`, keep `PROVIDER_DEFAULTS` as UI presets and add focused helpers:

```js
const PROTOCOLS = Object.freeze({
  OPENAI: 'openai-compatible',
  ANTHROPIC: 'anthropic'
});

function normalizeProviderName(value) {
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!provider || provider.length > 64 || ['__proto__', 'prototype', 'constructor'].includes(provider)) {
    throw new Error('AI 服务商名称无效');
  }
  return provider;
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::' || host === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/.test(host)) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function validateApiUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('API 地址格式无效'); }
  if (parsed.protocol !== 'https:') throw new Error('API 地址必须使用 HTTPS');
  if (parsed.username || parsed.password) throw new Error('API 地址不能包含账号或密码');
  if (!parsed.hostname || isPrivateHostname(parsed.hostname)) throw new Error('API 地址必须是公网 HTTPS 地址');
  return parsed.href;
}

function createHostPermissionPattern(value) {
  const parsed = new URL(validateApiUrl(value));
  return `https://${parsed.hostname}/*`;
}
```

Update `normalizeApiConfig()` to normalize the provider before reading `providers[provider]`, require an own property, infer `anthropic` only for old Anthropic records, default every other old record to `openai-compatible`, validate the URL with `validateApiUrl()`, and return `protocol`.

Update `manager/api-config-store.js` to call `validateApiUrl()` during legacy-file migration and write `protocol: provider === 'anthropic' ? 'anthropic' : 'openai-compatible'` into the migrated record.

- [ ] **Step 4: Run the focused tests**

Run: `node --test tests/api-config.test.js`

Expected: all `tests/api-config.test.js` tests PASS, including legacy migration tests.

- [ ] **Step 5: Commit the endpoint boundary**

```bash
git add manifest.json manager/api-config-core.js manager/api-config-store.js tests/api-config.test.js
git commit -m "新增: 支持通用 HTTPS AI 端点"
```

---

### Task 2: 按协议统一请求适配器

**Files:**
- Modify: `manager/apiconfig.js`
- Create: `tests/api-adapters.test.js`

**Interfaces:**
- Consumes: `RuntimeApiConfig.protocol` from Task 1
- Produces: `globalThis.XHS_API_ADAPTERS.getAdapter(protocol)`
- Adapter interface: `{ headers(apiKey), buildBody(model, prompt), parseResponse(data) }`

- [ ] **Step 1: Write failing adapter tests**

Create `tests/api-adapters.test.js` with the required file summary comment and VM loader:

```js
test('OpenAI 兼容适配器可用于任意服务商', async () => {
  const adapters = await loadAdapters();
  const adapter = adapters.getAdapter('openai-compatible');
  assert.deepEqual(adapter.headers('key'), {
    'Content-Type': 'application/json',
    Authorization: 'Bearer key'
  });
  assert.deepEqual(adapter.buildBody('qwen-plus', '总结内容'), {
    model: 'qwen-plus',
    messages: [{ role: 'user', content: '总结内容' }]
  });
  assert.equal(adapter.parseResponse({ choices: [{ message: { content: '结果' } }] }), '结果');
});

test('Anthropic 原生适配器继续可用', async () => {
  const adapter = (await loadAdapters()).getAdapter('anthropic');
  assert.equal(adapter.headers('key')['x-api-key'], 'key');
  assert.equal(adapter.parseResponse({ content: [{ text: '结果' }] }), '结果');
});

test('响应缺少正文时抛出中文错误', async () => {
  const adapter = (await loadAdapters()).getAdapter('openai-compatible');
  assert.throws(() => adapter.parseResponse({ choices: [] }), /未返回可用内容/);
});
```

- [ ] **Step 2: Run the adapter tests and verify they fail**

Run: `node --test tests/api-adapters.test.js`

Expected: FAIL because `XHS_API_ADAPTERS` and `getAdapter()` do not exist.

- [ ] **Step 3: Replace provider duplication with two protocol adapters**

Refactor `manager/apiconfig.js` to define one OpenAI-compatible adapter and one Anthropic adapter:

```js
const ADAPTERS = Object.freeze({
  'openai-compatible': Object.freeze({
    headers(apiKey) {
      return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    },
    buildBody(model, prompt) {
      return { model, messages: [{ role: 'user', content: prompt }] };
    },
    parseResponse(data) {
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('AI 接口未返回可用内容');
      return content;
    }
  }),
  anthropic: Object.freeze({
    headers(apiKey) {
      return { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    },
    buildBody(model, prompt) {
      return { model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] };
    },
    parseResponse(data) {
      const content = data?.content?.[0]?.text;
      if (typeof content !== 'string' || !content.trim()) throw new Error('AI 接口未返回可用内容');
      return content;
    }
  })
});

function getAdapter(protocol) {
  const adapter = ADAPTERS[protocol];
  if (!adapter) throw new Error('不支持该接口类型');
  return adapter;
}

globalThis.XHS_API_ADAPTERS = Object.freeze({ getAdapter });
```

- [ ] **Step 4: Run adapter and existing API configuration tests**

Run: `node --test tests/api-adapters.test.js tests/api-config.test.js`

Expected: all targeted tests PASS.

- [ ] **Step 5: Commit the adapter refactor**

```bash
git add manager/apiconfig.js tests/api-adapters.test.js
git commit -m "重构: 统一 OpenAI 兼容请求适配器"
```

---

### Task 3: 配置卡片动态授权与调用前复核

**Files:**
- Modify: `manager/manager.html`
- Modify: `manager/manager.js`
- Modify: `manager/inspiration-theme.css`
- Create: `manager/api-permission.js`
- Modify: `scripts/build.js`
- Modify: `tests/manager-ui.test.js`
- Create: `tests/api-permission.test.js`

**Interfaces:**
- Consumes: `createHostPermissionPattern(baseUrl)` from Task 1
- Consumes: `XHS_API_ADAPTERS.getAdapter(protocol)` from Task 2
- Produces: `XHS_API_PERMISSION.createPermissionController({ permissions, core })`
- Permission controller methods: `request(baseUrl): Promise<boolean>` and `has(baseUrl): Promise<boolean>`

- [ ] **Step 1: Write failing UI and permission-flow tests**

Extend `tests/manager-ui.test.js`:

```js
test('AI 配置允许自由服务商名称并选择接口类型', () => {
  assert.match(html, /<input id="api-provider"[^>]*type="text"/);
  assert.match(html, /<select id="api-protocol"/);
  assert.match(html, /value="openai-compatible"/);
  assert.match(html, /value="anthropic"/);
  assert.match(html, /保存时[^<]*申请访问该 API 域名/);
});

test('保存配置先申请精确主机权限且拒绝时不落盘', () => {
  assert.match(managerScript, /apiPermission\.request\(validatedUrl\)/);
  assert.match(managerScript, /apiPermission\.has\(baseUrl\)/);
  assert.match(managerScript, /if \(!granted\)[\s\S]*return;/);
  assert.match(managerScript, /getAdapter\(cfg\.protocol\)/);
});
```

Create `tests/api-permission.test.js` with injected fake Chrome permissions:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function createController(permissions) {
  const context = vm.createContext({ URL });
  context.globalThis = context;
  vm.runInContext(await readFile('manager/api-config-core.js', 'utf8'), context);
  vm.runInContext(await readFile('manager/api-permission.js', 'utf8'), context);
  return context.XHS_API_PERMISSION.createPermissionController({
    permissions,
    core: context.XHS_API_CONFIG_CORE
  });
}

test('保存动作直接申请精确主机权限', async () => {
  let requestCount = 0;
  const controller = await createController({
    contains: async () => false,
    request: async request => {
      requestCount += 1;
      assert.equal(request.origins[0], 'https://api.example.com/*');
      return true;
    }
  });
  assert.equal(await controller.request('https://api.example.com/v1/chat/completions'), true);
  assert.equal(requestCount, 1);
});

test('用户拒绝主机权限时返回 false', async () => {
  const controller = await createController({
    contains: async () => false,
    request: async request => {
      assert.equal(request.origins[0], 'https://api.example.com/*');
      return false;
    }
  });
  assert.equal(await controller.request('https://api.example.com/v1/chat/completions'), false);
});
```

Keep the existing assertions that the API Key input is a password field and native `prompt()`/`alert()` are absent from the configuration flow.

- [ ] **Step 2: Run the UI tests and verify they fail**

Run: `node --test tests/manager-ui.test.js tests/api-permission.test.js`

Expected: FAIL because `api-protocol`, the permission controller, and protocol adapter lookup are absent.

- [ ] **Step 3: Add interface type and permission copy to the card**

In `manager/manager.html`, add this field beside the service name:

```html
<label class="api-config-field" for="api-protocol">
  <span>接口类型</span>
  <select id="api-protocol">
    <option value="openai-compatible">OpenAI 兼容接口</option>
    <option value="anthropic">Anthropic 原生接口</option>
  </select>
</label>
```

将服务商提示改为“可填写 qwen、kimi、zhipu 或其他名称”，并将说明改为“保存时 Chrome 会申请访问该 API 域名。API Key 只保存在本机，换电脑、浏览器或重新安装后需要重新配置。”现有 `.api-config-field select` 样式继续覆盖新控件。

- [ ] **Step 4: Implement the testable permission controller**

Create `manager/api-permission.js`:

```js
(() => {
  function createPermissionController({ permissions, core }) {
    function permissionFor(baseUrl) {
      return core.createHostPermissionPattern(baseUrl);
    }
    async function has(baseUrl) {
      return permissions.contains({ origins: [permissionFor(baseUrl)] });
    }
    async function request(baseUrl) {
      const origins = [permissionFor(baseUrl)];
      return permissions.request({ origins });
    }
    return Object.freeze({ has, request });
  }
  globalThis.XHS_API_PERMISSION = Object.freeze({ createPermissionController });
})();
```

Load it after `api-config-core.js` and before `manager.js` in `manager/manager.html`, and add `manager/api-permission.js` to the copied manager files in `scripts/build.js`.

Run: `node --test tests/api-permission.test.js`

Expected: all permission-controller tests PASS.

- [ ] **Step 5: Connect the form save flow**

In `manager/manager.js`, add the `apiProtocol` DOM lookup and construct the controller once:

```js
const apiPermission = globalThis.XHS_API_PERMISSION.createPermissionController({
  permissions: chrome.permissions,
  core: globalThis.XHS_API_CONFIG_CORE
});
```

Update `fillApiProviderDefaults()` so recognized presets still fill URL/model, while unknown names leave user-entered URL/model unchanged. Update `configureApi()` to populate `apiProtocol` from the runtime config, defaulting to `openai-compatible`.

Update `saveApiConfig()` in this order:

```js
const provider = globalThis.XHS_API_CONFIG_CORE.normalizeProviderName(apiProvider.value);
const protocol = apiProtocol.value;
const validatedUrl = globalThis.XHS_API_CONFIG_CORE.validateApiUrl(apiBaseUrl.value.trim());
const granted = await apiPermission.request(validatedUrl);
if (!granted) {
  showApiConfigError('需要允许扩展访问该 API 域名，才能保存并调用模型');
  return;
}
```

Store `protocol` next to `apiKey`, `baseUrl`, and `model`. Convert thrown validation and Chrome permission errors to inline Chinese messages and keep the modal open.

- [ ] **Step 6: Update model invocation and permission-revocation handling**

Replace provider-name adapter selection in `callLLMApi()`:

```js
const adapter = globalThis.XHS_API_ADAPTERS.getAdapter(cfg.protocol);
const baseUrl = globalThis.XHS_API_CONFIG_CORE.validateApiUrl(cfg.baseUrl);
if (!await apiPermission.has(baseUrl)) {
  throw { code: '需要 API 权限', message: '该 API 域名的访问权限已被撤销，请重新打开“AI 配置”并保存授权' };
}
const resp = await fetch(baseUrl, {
  method: 'POST',
  headers: adapter.headers(cfg.apiKey),
  body: JSON.stringify(adapter.buildBody(cfg.model, prompt))
});
```

Parse the successful response with `adapter.parseResponse(data)`. Preserve current Chinese HTTP error extraction, ensuring neither request headers nor API Key are logged.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test tests/manager-ui.test.js tests/api-config.test.js tests/api-adapters.test.js tests/api-permission.test.js`

Expected: all focused tests PASS.

Run: `npm test`

Expected: the complete suite PASS.

- [ ] **Step 8: Commit the dynamic authorization UI**

```bash
git add manager/manager.html manager/manager.js manager/inspiration-theme.css manager/api-permission.js scripts/build.js tests/manager-ui.test.js tests/api-permission.test.js
git commit -m "新增: AI 接口按域名动态授权"
```

---

### Task 4: Build contract, README and final verification

**Files:**
- Modify: `tests/build-output.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: manifest and runtime behavior from Tasks 1–3
- Produces: documented end-user setup flow and build-level regression coverage

- [ ] **Step 1: Add the build contract**

Extend the first build-output test:

```js
assert.deepEqual(builtManifest.optional_host_permissions, ['https://*/*']);
assert.equal(builtManifest.host_permissions.includes('https://*/*'), false);
assert.equal(builtManifest.host_permissions.some(value => /api\.(anthropic|openai|minimax|deepseek)/.test(value)), false);
assert.match(builtApiCore, /createHostPermissionPattern/);
assert.match(builtApiConfig, /openai-compatible/);
assert.match(builtManagerHtml, /id="api-protocol"/);
```

- [ ] **Step 2: Run the build-output test and verify the new contract**

Run: `node --test tests/build-output.test.js`

Expected: PASS. If it fails, repair only the missing build-copy or manifest output from Tasks 1–3 before continuing.

- [ ] **Step 3: Update README usage and file descriptions**

Update the AI section to state:

```markdown
1. 点击顶部「AI 配置」。
2. 输入服务商名称，例如 `qwen`、`kimi` 或 `zhipu`。
3. 选择“OpenAI 兼容接口”，填写公网 HTTPS API 地址、模型名称和 API Key。
4. 点击“保存配置”，在 Chrome 提示中允许访问该 API 域名。

扩展只申请当前填写的 API 主机权限。API Key 和 AI 配置保存在当前浏览器，不会同步；更换电脑、浏览器、Chrome 用户资料或重新安装后需要重新配置。
```

Update the directory tree descriptions for `api-config-core.js`, `api-permission.js`, `apiconfig.js`, `api-adapters.test.js`, `api-permission.test.js`, and `api-config.test.js` so they describe general HTTPS endpoints, permissions, and protocol adapters instead of the four-provider whitelist.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: all tests PASS, build finishes under `dist/extension`, the fixed extension ID remains unchanged, cloud configuration remains configured, owner access remains restricted, and `git diff --check` prints no errors.

- [ ] **Step 5: Inspect the built manifest and sensitive-data boundary**

Run:

```bash
node -e "const m=require('./dist/extension/manifest.json'); console.log(m.host_permissions); console.log(m.optional_host_permissions)"
rg -n "AIza|sk-[A-Za-z0-9]|Bearer [A-Za-z0-9]" dist/extension || true
```

Expected: required hosts contain no permanent wildcard AI access, optional hosts print `['https://*/*']`, and the secret scan prints no bundled private API keys.

- [ ] **Step 6: Commit documentation and build contract**

```bash
git add README.md tests/build-output.test.js
git commit -m "文档: 补充通用 AI 接口配置说明"
```

- [ ] **Step 7: Confirm the worktree is clean**

Run: `git status --short`

Expected: no output.
