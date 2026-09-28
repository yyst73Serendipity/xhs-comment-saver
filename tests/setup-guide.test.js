/**
 * 验证 Firebase 新手手册包含完整流程且不收集敏感凭据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const setup = await readFile('manager/setup.html', 'utf8').catch(() => '');
const build = await readFile('scripts/build.js', 'utf8');

test('新手手册覆盖个人 Firebase 配置的关键流程', () => {
  for (const text of [
    '创建 Firebase 项目', '注册 Web 应用', '启用 Google 登录', '创建 Firestore',
    'firebase.local.json', 'deploy:hosting', 'dist/extension', 'Authentication → 用户',
    'ownerUid', 'npm run deploy', '迁移本机数据', '常见问题'
  ]) assert.match(setup, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('新手手册是无敏感输入和远程脚本的静态页面', () => {
  assert.doesNotMatch(setup, /<input|<textarea|<script/i);
  assert.doesNotMatch(setup, /serviceAccount|private[_ -]?key|登录令牌/i);
  assert.match(setup, /target="_blank" rel="noopener noreferrer"/);
  assert.match(build, /manager\/setup\.html/);
});
