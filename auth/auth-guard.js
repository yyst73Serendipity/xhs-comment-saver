/**
 * 检查 Firebase 构建配置并把外部错误转换为中文提示。
 */
const REQUIRED = ['apiKey', 'authDomain', 'projectId', 'appId', 'authPageUrl'];

/**
 * 判断配置是否足以初始化 Firebase 登录。
 */
export function isConfigured(value) {
  return !!value && REQUIRED.every(key => typeof value[key] === 'string' && value[key].trim());
}

/**
 * 判断配置是否已绑定允许访问云端数据的用户 UID。
 */
export function isOwnerConfigured(value) {
  return isConfigured(value)
    && typeof value.ownerUid === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(value.ownerUid);
}

/**
 * 只接受固定扩展、当前请求且签发时间在 0 到 120 秒内的认证响应。
 */
export function acceptAuthMessage(message, expected) {
  if (!message || !expected) return false;
  if (typeof expected.extensionId !== 'string' || !expected.extensionId) return false;
  if (message.origin !== `chrome-extension://${expected.extensionId}`) return false;
  if (typeof expected.requestId !== 'string' || !expected.requestId || message.requestId !== expected.requestId) {
    return false;
  }
  if (!Number.isFinite(message.issuedAt) || !Number.isFinite(expected.now)) return false;
  const age = expected.now - message.issuedAt;
  return age >= 0 && age <= 120_000;
}

/** 构造托管页面允许返回的最小认证载荷。 */
export function createAuthResponse(idToken, requestId, issuedAt) {
  return { idToken, requestId, issuedAt };
}

/**
 * 将 Firebase 错误转换为用户可理解的中文提示。
 */
export function friendlyError(error) {
  if (error?.code === 'permission-denied') return '云端权限被拒绝，请检查登录账号和数据库规则';
  if (error?.code === 'auth/network-request-failed') return '网络连接失败，本地修改会保留并稍后重试';
  if (error?.code === 'resource-exhausted') return '云端免费配额暂时不足，本地修改已保留';
  return error?.message || '云同步暂时不可用，本地修改已保留';
}
