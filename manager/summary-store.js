/**
 * 把单个分类总结转换为统一后台保存或删除动作，并让失败继续向界面传播。
 */
(function registerSummaryStore(global) {
  /** 创建按分类隔离的内存草稿仓，供云保存失败后恢复编辑内容。 */
  function createDraftStore() {
    const drafts = new Map();
    return {
      delete: category => drafts.delete(category),
      get: category => drafts.get(category),
      has: category => drafts.has(category),
      set: (category, content) => drafts.set(category, content)
    };
  }

  /** 保存指定分类的总结，返回后台生成的最新投影片段。 */
  async function persistCategory({ category, summary, sendAction }) {
    if (summary?.content) {
      return {
        summary: await sendAction('saveSummary', {
          category,
          content: summary.content,
          data: summary
        }),
        summaries: null
      };
    }
    return {
      summary: null,
      summaries: await sendAction('deleteSummary', { category })
    };
  }

  global.XHS_SUMMARY_STORE = { createDraftStore, persistCategory };
})(globalThis);
