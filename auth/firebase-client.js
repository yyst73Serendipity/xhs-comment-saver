/**
 * 延迟初始化扩展专用 Firebase 客户端，未配置时保持纯本地模式。
 */
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth/web-extension';
import { getFirestore } from 'firebase/firestore/lite';
import { config } from '../config/firebase-config.js';
import { isConfigured } from './auth-guard.js';

let client;

/** 延迟创建唯一 Firebase App、Auth 和 Firestore 实例。 */
export function firebaseClient() {
  if (!isConfigured(config)) return null;
  if (!client) {
    const app = initializeApp(config);
    client = { app, auth: getAuth(app), db: getFirestore(app) };
  }
  return client;
}
