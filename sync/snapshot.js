/**
 * 合并云端分页快照，并保留由投影层重放的本地待上传操作。
 */
import { COLLECTIONS } from '../storage/model.js';

function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true
  });
}

/** 把一页云端记录写入远端基线，旧版本不能覆盖新版本。 */
export function applyPage(workspace, collection, page) {
  if (!workspace || !COLLECTIONS.includes(collection)) throw new Error('同步集合无效');
  if (!page || !Array.isArray(page.records)) throw new Error('云端分页格式无效');
  for (const item of page.records) {
    if (!item || typeof item.id !== 'string' || !item.record || !Number.isSafeInteger(item.record.revision)) {
      throw new Error('云端记录格式无效');
    }
    const previous = workspace.remote[collection][item.id];
    if (!previous || item.record.revision >= previous.revision) {
      setOwn(workspace.remote[collection], item.id, structuredClone(item.record));
    }
  }
  if (page.cursor) workspace.cursors[collection] = structuredClone(page.cursor);
  return workspace;
}
