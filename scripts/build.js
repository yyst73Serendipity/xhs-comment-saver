/**
 * 构建可加载扩展、认证页面和个人专用规则，并保留固定扩展 ID。
 */
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { isConfigured, isOwnerConfigured } from '../auth/auth-guard.js';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const firebaseConfig = JSON.parse(await readFile('config/firebase.local.json', 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return '{}';
}));

const extensionId = createHash('sha256')
  .update(Buffer.from(manifest.key, 'base64'))
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + Number.parseInt(value, 16)));

if (Object.keys(firebaseConfig).length && !isConfigured(firebaseConfig)) {
  throw new Error('Firebase 配置不完整，请检查 config/firebase.local.json');
}
if (firebaseConfig.ownerUid && !isOwnerConfigured(firebaseConfig)) {
  throw new Error('所有者 UID 格式无效');
}

/**
 * 判断后续任务提供的可选入口是否已经存在。
 */
async function exists(path) {
  return access(path).then(() => true, () => false);
}

await rm('dist', { recursive: true, force: true });
await rm('build', { recursive: true, force: true });
await mkdir('build', { recursive: true });
await mkdir('dist/extension', { recursive: true });
await mkdir('dist/hosting', { recursive: true });

for (const directory of ['assets', 'content', 'manager']) {
  await cp(directory, `dist/extension/${directory}`, { recursive: true });
}

const define = {
  __FIREBASE_CONFIG__: JSON.stringify(firebaseConfig),
  __EXTENSION_ID__: JSON.stringify(extensionId)
};
const browserBuild = {
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  define,
  legalComments: 'eof',
  minify: true
};

await build({
  ...browserBuild,
  entryPoints: ['background/background.js'],
  outfile: 'dist/extension/background/background.js',
  format: 'esm'
});

// 认证入口会在后续任务加入；存在时自动纳入同一构建流程。
if (await exists('offscreen/offscreen.js')) {
  await mkdir('dist/extension/offscreen', { recursive: true });
  await build({
    ...browserBuild,
    entryPoints: ['offscreen/offscreen.js'],
    outfile: 'dist/extension/offscreen/offscreen.js',
    format: 'iife'
  });
  await cp('offscreen/offscreen.html', 'dist/extension/offscreen/offscreen.html');
}
if (await exists('auth-page/sign-in.js')) {
  await build({
    ...browserBuild,
    entryPoints: ['auth-page/sign-in.js'],
    outfile: 'dist/hosting/sign-in.js',
    format: 'iife'
  });
  await cp('auth-page/index.html', 'dist/hosting/index.html');
}

const builtManifest = structuredClone(manifest);
if (firebaseConfig.authPageUrl) {
  const origin = new URL(firebaseConfig.authPageUrl).origin;
  if (!origin.startsWith('https://')) throw new Error('登录页面必须使用 HTTPS');
  if (!builtManifest.host_permissions.includes(`${origin}/*`)) {
    builtManifest.host_permissions.push(`${origin}/*`);
  }
}
await writeFile('dist/extension/manifest.json', `${JSON.stringify(builtManifest, null, 2)}\n`);

const denyAllRules = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n";
const rules = await readFile('firestore.rules', 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return denyAllRules;
});
await writeFile('dist/firestore.rules', rules.replaceAll('__OWNER_UID__', firebaseConfig.ownerUid || '__OWNER_UID__'));
await writeFile('dist/extension-id.txt', `${extensionId}\n`);

console.log([
  '构建完成：dist/extension',
  `扩展 ID：${extensionId}`,
  `云配置：${isConfigured(firebaseConfig) ? '已配置' : '未配置，使用本地模式'}`,
  `所有者：${isOwnerConfigured(firebaseConfig) ? '已限制' : '尚未配置，云端规则默认拒绝所有访问'}`
].join('\n'));
