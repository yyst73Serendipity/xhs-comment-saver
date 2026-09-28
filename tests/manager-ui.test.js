/**
 * 验证“灵感剪贴簿”管理页的信息结构和既有行为入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('manager/manager.html', 'utf8');
const theme = await readFile('manager/inspiration-theme.css', 'utf8');
const managerScript = await readFile('manager/manager.js', 'utf8');

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

test('顶部按钮按账号行和工具行分组排序', () => {
  const primary = html.match(/<div class="header-primary">([\s\S]*?)<\/div>\s*<div class="header-utility"/)?.[1] || '';
  const utility = html.match(/<div class="header-utility"[^>]*>([\s\S]*?)<input type="file"/)?.[1] || '';
  assert.match(primary, /cloud-account[\s\S]*cloud-sync[\s\S]*cloud-logout/);
  assert.doesNotMatch(primary, /btn-api-config/);
  assert.match(utility, /btn-import[\s\S]*btn-export[\s\S]*btn-clear[\s\S]*cloud-migrate[\s\S]*cloud-cache[\s\S]*btn-api-config[\s\S]*cloud-help/);
  assert.match(theme, /\.header-utility\s*\{[\s\S]*justify-content:\s*flex-end/);
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

test('灵感剪贴簿主题使用统一变量并最后加载', () => {
  assert.match(html, /manager\.css[\s\S]*cloud-panel\.css[\s\S]*inspiration-theme\.css/);
  for (const token of ['--inspiration-ink', '--inspiration-paper', '--inspiration-accent']) {
    assert.match(theme, new RegExp(token));
  }
  assert.match(theme, /grid-template-columns:\s*190px\s+minmax\(0,\s*1fr\)\s+335px/);
});

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
  assert.match(html, /id="graph-view-title"/);
});

test('配置帮助不在管理页保留重复弹窗样式', () => {
  assert.doesNotMatch(html, /cloud-help-dialog|cloud-help-steps|cloud-help-note/);
  assert.doesNotMatch(theme, /\.cloud-help-dialog|\.cloud-help-step-number|\.cloud-help-note/);
});

test('AI 配置使用页面中央卡片并提供完整表单', () => {
  for (const id of [
    'api-config-modal', 'api-config-form', 'api-provider', 'api-key',
    'api-base-url', 'api-model', 'api-config-error',
    'api-config-cancel', 'api-config-save'
  ]) assert.equal(occurrences(id), 1, `${id} 应且只应出现一次`);

  assert.match(html, /id="api-config-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /<input id="api-provider"[^>]*type="text"/);
  assert.doesNotMatch(html, /<select id="api-provider"/);
  assert.match(html, /id="api-key"[^>]*type="password"/);
  assert.match(theme, /\.api-config-dialog\s*\{[\s\S]*max-width:\s*560px/);
});

test('AI 配置通过页面表单保存且不再调用浏览器原生弹窗', () => {
  const configureSection = managerScript.match(/function configureApi\(\)[\s\S]*?\/\*\* 从本机扩展存储加载配置/)?.[0] || '';
  assert.notEqual(configureSection, '');
  assert.doesNotMatch(configureSection, /\bprompt\s*\(/);
  assert.doesNotMatch(configureSection, /\balert\s*\(/);
  assert.match(managerScript, /apiConfigForm\.addEventListener\('submit'/);
  assert.match(managerScript, /apiProvider\.value\.trim\(\)\.toLowerCase\(\)/);
  assert.match(managerScript, /validateProviderUrl\(provider, apiBaseUrl\.value\.trim\(\)\)/);
});
