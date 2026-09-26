/**
 * 防止升级说明遗漏卸载前备份，避免切换 unpacked 路径时丢失本机数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('升级流程要求先导出落盘再切换并导入恢复', async () => {
  const readme = await readFile('README.md', 'utf8');
  const sectionStart = readme.indexOf('### 从源码目录升级到构建版');
  const sectionEnd = readme.indexOf('\n### ', sectionStart + 4);
  const section = readme.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);

  assert.notEqual(sectionStart, -1);
  const exportPosition = section.indexOf('导出');
  const diskPosition = section.indexOf('确认文件已落盘');
  const uninstallPosition = section.indexOf('卸载');
  const switchPosition = section.indexOf('切换');
  const importPosition = section.indexOf('导入');
  assert.ok(exportPosition >= 0 && diskPosition > exportPosition);
  assert.ok(uninstallPosition > diskPosition);
  assert.ok(switchPosition > diskPosition);
  assert.ok(importPosition > uninstallPosition);
  assert.match(section, /恢复评论、分类和 AI 总结/);
  assert.match(section, /重新输入.*API Key/);
});
