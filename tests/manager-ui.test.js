/**
 * 验证“灵感剪贴簿”管理页的信息结构和既有行为入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile('manager/manager.html', 'utf8');
const theme = await readFile('manager/inspiration-theme.css', 'utf8');

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
