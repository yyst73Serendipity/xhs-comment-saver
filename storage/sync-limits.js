/**
 * 定义本地同步与 Firestore Rules 共同镜像的数据大小边界。
 */

// Firestore 单文档上限为 1 MiB；这里保留约 30% 空间给字段名、索引和服务端元数据。
export const SYNC_INPUT_LIMITS = Object.freeze({
  recordBytes: 700 * 1024,
  imagesPerComment: 100,
  mediaUrlBytes: 16 * 1024,
  commentStringBytes: Object.freeze({
    id: 16 * 1024,
    commentId: 512,
    key: 16 * 1024,
    text: 300 * 1024,
    author: 8 * 1024,
    postUrl: 16 * 1024,
    postTitle: 32 * 1024,
    groupId: 512,
    note: 300 * 1024,
    legacyId: 16 * 1024,
    legacyKey: 16 * 1024
  }),
  summaryStringBytes: Object.freeze({
    content: 300 * 1024,
    generatedBy: 256,
    model: 2 * 1024,
    provider: 256
  })
});

export const utf8Bytes = value => new TextEncoder().encode(value).byteLength;

/** 校验字符串的 UTF-8 大小，避免字符数与云端字节数不一致。 */
export function requireUtf8Boundary(value, label, maximum) {
  if (utf8Bytes(value) > maximum) throw new Error(`${label}不能超过 ${maximum} 字节`);
}

/** 校验即将持久化的完整记录包装，包含 data、conflicts、revision 和墓碑字段。 */
export function requireRecordBudget(record, label = '同步') {
  const serialized = JSON.stringify(record);
  if (typeof serialized !== 'string' || utf8Bytes(serialized) > SYNC_INPUT_LIMITS.recordBytes) {
    throw new Error(`${label}记录过大，不能超过 ${SYNC_INPUT_LIMITS.recordBytes} 字节`);
  }
}
