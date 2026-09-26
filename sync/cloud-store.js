/**
 * 通过 Firestore 事务幂等提交本地操作，并按服务器更新时间增量拉取记录。
 */
import {
  Timestamp, collection as firestoreCollection, doc as firestoreDoc, documentId,
  getDocs, limit, orderBy, query, runTransaction, serverTimestamp, startAt
} from 'firebase/firestore/lite';
import { COLLECTIONS, mergeOperation } from '../storage/model.js';

const PAGE_SIZE = 200;
const MAX_ID_BYTES = 512;
const DEFAULT_API = {
  Timestamp,
  collection: firestoreCollection,
  doc: firestoreDoc,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAt
};

function requirePathSegment(value, label, maximum = MAX_ID_BYTES) {
  if (typeof value !== 'string' || !/^(?!\.{1,2}$)[A-Za-z0-9_%~+,.=@()-]+$/.test(value)) {
    throw new Error(`${label}无效`);
  }
  if (new TextEncoder().encode(value).byteLength > maximum) throw new Error(`${label}过长`);
  return value;
}

function requireCollection(value) {
  if (!COLLECTIONS.includes(value)) throw new Error('同步集合无效');
  return value;
}

function cleanRecord(value) {
  if (!value) return undefined;
  const { updatedAt: _updatedAt, ...record } = value;
  return record;
}

function requireCursor(cursor) {
  if (cursor == null) return null;
  if (!Number.isSafeInteger(cursor.seconds) || cursor.seconds < 0
    || !Number.isSafeInteger(cursor.nanoseconds) || cursor.nanoseconds < 0 || cursor.nanoseconds > 999_999_999) {
    throw new Error('同步游标时间无效');
  }
  return { ...cursor, id: requirePathSegment(cursor.id, '同步游标 ID') };
}

function timestampParts(value) {
  if (!value || !Number.isSafeInteger(value.seconds) || !Number.isSafeInteger(value.nanoseconds)) {
    throw new Error('云端记录缺少服务器更新时间');
  }
  return { seconds: value.seconds, nanoseconds: value.nanoseconds };
}

/** 封装个人 Firestore 空间的幂等提交和增量读取。 */
export class CloudStore {
  constructor(db, api = DEFAULT_API) {
    if (!db) throw new Error('Firestore 尚未初始化');
    this.db = db;
    this.api = api;
  }

  /** 在单一事务内写入合并后的记录和操作回执。 */
  async commit(uid, operation) {
    const ownerUid = requirePathSegment(uid, '用户 ID', 128);
    if (!operation || typeof operation !== 'object') throw new Error('同步操作无效');
    const operationId = requirePathSegment(operation.id, '操作 ID');
    const kind = requireCollection(operation.collection);
    const recordId = requirePathSegment(operation.recordId, '记录 ID');
    const receiptRef = this.api.doc(this.db, 'users', ownerUid, 'operations', operationId);
    const targetRef = this.api.doc(this.db, 'users', ownerUid, kind, recordId);

    return this.api.runTransaction(this.db, async transaction => {
      // Firestore 要求事务中的读取全部发生在首次写入之前。
      const receiptSnapshot = await transaction.get(receiptRef);
      const targetSnapshot = await transaction.get(targetRef);
      const current = targetSnapshot.exists() ? cleanRecord(targetSnapshot.data()) : undefined;
      if (receiptSnapshot.exists()) {
        const receipt = receiptSnapshot.data();
        if (receipt.collection !== kind || receipt.recordId !== recordId) {
          throw new Error('操作回执与目标记录不一致');
        }
        if (!current) throw new Error('操作回执对应的云端记录不存在');
        return current;
      }

      let merged = mergeOperation(current, operation);
      // 墓碑会忽略过期字段修改，但云端事务仍递增版本，以便规则绑定记录写入与回执创建。
      if (current && merged.revision === current.revision) {
        merged = { ...merged, revision: current.revision + 1 };
      }
      transaction.set(targetRef, { ...merged, updatedAt: this.api.serverTimestamp() });
      transaction.set(receiptRef, {
        collection: kind,
        recordId,
        createdAt: this.api.serverTimestamp()
      });
      return merged;
    });
  }

  /** 按 updatedAt 和文档 ID 稳定读取最多 200 条增量记录。 */
  async pull(uid, kind, cursor = null) {
    const ownerUid = requirePathSegment(uid, '用户 ID', 128);
    const collectionName = requireCollection(kind);
    const boundary = requireCursor(cursor);
    const constraints = [
      this.api.orderBy('updatedAt'),
      this.api.orderBy(this.api.documentId())
    ];
    if (boundary) {
      // startAt 有意重读边界文档，客户端再按完整游标去重，避免同一纳秒边界漏数。
      constraints.push(this.api.startAt(new this.api.Timestamp(boundary.seconds, boundary.nanoseconds), boundary.id));
    }
    constraints.push(this.api.limit(boundary ? PAGE_SIZE + 1 : PAGE_SIZE));
    const snapshot = await this.api.getDocs(this.api.query(
      this.api.collection(this.db, 'users', ownerUid, collectionName),
      ...constraints
    ));
    const records = snapshot.docs
      .filter(item => !boundary || item.id !== boundary.id
        || item.data().updatedAt.seconds !== boundary.seconds
        || item.data().updatedAt.nanoseconds !== boundary.nanoseconds)
      .slice(0, PAGE_SIZE)
      .map(item => {
        const value = item.data();
        timestampParts(value.updatedAt);
        return { id: item.id, record: cleanRecord(value) };
      });
    const last = records.at(-1);
    const lastSource = last ? snapshot.docs.find(item => item.id === last.id)?.data().updatedAt : null;
    const time = lastSource ? timestampParts(lastSource) : null;
    return {
      records,
      cursor: last && time ? { ...time, id: last.id } : boundary
    };
  }
}

export { PAGE_SIZE };
