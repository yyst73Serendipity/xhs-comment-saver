/**
 * 验证分类拖拽排序的纯顺序计算，不依赖浏览器 DOM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('manager/category-order.js', 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const { moveCategory } = context.globalThis.XHS_CATEGORY_ORDER;

test('把分类插入目标上方并固定未分类', () => {
  assert.deepEqual(
    Array.from(moveCategory(['未分类', '好物', '避雷', '搞笑'], '搞笑', '好物', true)),
    ['未分类', '搞笑', '好物', '避雷']
  );
});

test('把分类插入目标下方', () => {
  assert.deepEqual(
    Array.from(moveCategory(['未分类', '好物', '避雷', '搞笑'], '好物', '避雷', false)),
    ['未分类', '避雷', '好物', '搞笑']
  );
});

test('拒绝拖动未分类、未知分类和原地拖放', () => {
  const original = ['未分类', '好物', '避雷'];
  for (const args of [
    ['未分类', '好物', true],
    ['未知', '好物', true],
    ['好物', '未知', true],
    ['好物', '好物', true]
  ]) {
    assert.deepEqual(Array.from(moveCategory(original, ...args)), original);
  }
});
