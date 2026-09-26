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
 * 将 Firebase 错误转换为用户可理解的中文提示。
 */
export function friendlyError(error) {
  if (error?.code === 'permission-denied') return '云端权限被拒绝，请检查登录账号和数据库规则';
  if (error?.code === 'auth/network-request-failed') return '网络连接失败，本地修改会保留并稍后重试';
  if (error?.code === 'resource-exhausted') return '云端免费配额暂时不足，本地修改已保留';
  return error?.message || '云同步暂时不可用，本地修改已保留';
}
