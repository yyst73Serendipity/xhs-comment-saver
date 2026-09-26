/**
 * 暴露构建期注入的 Firebase 公共配置和固定扩展 ID。
 */
export const config = typeof __FIREBASE_CONFIG__ === 'undefined' ? {} : __FIREBASE_CONFIG__;
export const extensionId = typeof __EXTENSION_ID__ === 'undefined' ? '' : __EXTENSION_ID__;
