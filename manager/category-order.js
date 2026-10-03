/**
 * 分类排序纯逻辑：计算拖放后的完整分类顺序。
 */
(function initializeCategoryOrder(global) {
  const FIXED_CATEGORY = '未分类';

  /** 将 dragged 插入 target 上方或下方，无效拖放返回原顺序副本。 */
  function moveCategory(categories, dragged, target, before) {
    const original = [...categories];
    const sortable = original.filter(name => name !== FIXED_CATEGORY);
    if (dragged === FIXED_CATEGORY || target === FIXED_CATEGORY || dragged === target
        || !sortable.includes(dragged) || !sortable.includes(target)) return original;

    const next = sortable.filter(name => name !== dragged);
    let insertAt = next.indexOf(target);
    if (!before) insertAt += 1;
    next.splice(insertAt, 0, dragged);
    return [FIXED_CATEGORY, ...next];
  }

  global.XHS_CATEGORY_ORDER = Object.freeze({ moveCategory });
})(globalThis);
