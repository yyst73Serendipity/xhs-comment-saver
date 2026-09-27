/**
 * 校验本机 Firebase 项目配置，构建后使用参数数组部署规则与认证页面。
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfigured, isOwnerConfigured } from '../auth/auth-guard.js';

function requireProjectId(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) {
    throw new Error('Firebase projectId 格式无效');
  }
  return value;
}

/** 使用已校验项目 ID 构造不会经过 Shell 展开的 Firebase CLI 参数。 */
export function firebaseCliArguments(projectId) {
  return ['deploy', '--project', requireProjectId(projectId), '--only', 'firestore:rules,hosting'];
}

/** 首次绑定所有者前只部署登录桥，不触碰 Firestore Rules。 */
export function firebaseHostingArguments(projectId) {
  return ['deploy', '--project', requireProjectId(projectId), '--only', 'hosting'];
}

/** 固定构建使用的配置和输出目录，避免继承环境变量混用另一个项目。 */
export function buildEnvironment(environment, configPath) {
  const result = { ...environment, XHS_FIREBASE_CONFIG_PATH: configPath };
  delete result.XHS_BUILD_OUTPUT_DIR;
  return result;
}

/** 完成部署前校验，并通过本机依赖执行 Firebase CLI。 */
export async function deploy() {
  const configPath = resolve('config/firebase.local.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const projectId = requireProjectId(config.projectId);
  if (!isOwnerConfigured(config)) throw new Error('部署前必须配置有效的 ownerUid');

  execFileSync(process.execPath, ['scripts/build.js'], {
    stdio: 'inherit',
    env: buildEnvironment(process.env, configPath)
  });
  const builtRules = await readFile('dist/firestore.rules', 'utf8');
  if (builtRules.includes('__OWNER_UID__')) throw new Error('构建后的规则仍含所有者占位符，已停止部署');
  if (!builtRules.includes(`uid == '${config.ownerUid}'`)) {
    throw new Error('构建后的规则与当前所有者 UID 不一致，已停止部署');
  }

  const cliPath = fileURLToPath(new URL('../node_modules/firebase-tools/lib/bin/firebase.js', import.meta.url));
  const args = firebaseCliArguments(projectId);
  execFileSync(process.execPath, [cliPath, ...args], { cwd: 'dist', stdio: 'inherit' });
}

/** 使用基础 Firebase 配置部署 Hosting，供首次 Google 登录取得 ownerUid。 */
export async function deployHosting() {
  const configPath = resolve('config/firebase.local.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const projectId = requireProjectId(config.projectId);
  if (!isConfigured(config)) throw new Error('部署登录页前必须填写完整 Firebase Web 配置');

  execFileSync(process.execPath, ['scripts/build.js'], {
    stdio: 'inherit',
    env: buildEnvironment(process.env, configPath)
  });
  const cliPath = fileURLToPath(new URL('../node_modules/firebase-tools/lib/bin/firebase.js', import.meta.url));
  execFileSync(process.execPath, [cliPath, ...firebaseHostingArguments(projectId)], {
    cwd: 'dist',
    stdio: 'inherit'
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const operation = process.argv.includes('--hosting-only') ? deployHosting() : deploy();
  operation.catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
