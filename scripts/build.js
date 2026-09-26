/**
 * 构建可加载扩展、认证页面和个人专用规则，并保留固定扩展 ID。
 */
import { access, cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { isConfigured, isOwnerConfigured } from '../auth/auth-guard.js';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const firebaseConfigPath = process.env.XHS_FIREBASE_CONFIG_PATH || 'config/firebase.local.json';
const projectRoot = await realpath('.');

/**
 * 只允许正式 dist 或测试工具创建的专属临时目录，避免递归删除任意路径。
 */
async function resolveOutputRoot() {
  const requested = process.env.XHS_BUILD_OUTPUT_DIR;
  if (requested === undefined) {
    const defaultOutput = join(projectRoot, 'dist');
    const existing = await lstat(defaultOutput).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing?.isSymbolicLink()) throw new Error('默认构建目录不能是符号链接');
    return defaultOutput;
  }

  if (!isAbsolute(requested)) throw new Error('测试构建输出目录必须是绝对路径');
  const temporaryRoot = await realpath(tmpdir());
  const requestedPath = resolve(requested);
  const entry = await lstat(requestedPath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('测试构建输出目录必须是 mkdtemp 创建的真实目录');
  }
  const realOutput = await realpath(requestedPath);
  const homeRoot = await realpath(homedir());
  if (
    realOutput === projectRoot
    || projectRoot.startsWith(`${realOutput}${sep}`)
    || realOutput === homeRoot
    || homeRoot.startsWith(`${realOutput}${sep}`)
  ) {
    throw new Error('测试构建输出目录不能是项目或主目录及其祖先');
  }
  if (dirname(realOutput) !== temporaryRoot || !/^xhs-comment-saver-build-[A-Za-z0-9]{6}$/.test(basename(realOutput))) {
    throw new Error('测试构建输出目录不在允许的系统临时目录白名单中');
  }
  return realOutput;
}

const outputRoot = await resolveOutputRoot();
const extensionOutput = `${outputRoot}/extension`;
const hostingOutput = `${outputRoot}/hosting`;
const firebaseConfig = JSON.parse(await readFile(firebaseConfigPath, 'utf8').catch(error => {
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

await rm(outputRoot, { recursive: true, force: true });
await mkdir(extensionOutput, { recursive: true });
await mkdir(hostingOutput, { recursive: true });

// 管理页只复制公开运行文件，避免本机 API 配置或今后新增的密钥文件进入产物。
const publicFiles = [
  'content/content.css',
  'content/content.js',
  'manager/apiconfig.js',
  'manager/manager.css',
  'manager/manager.html',
  'manager/manager.js'
];
for (const file of publicFiles) {
  const target = `${extensionOutput}/${file}`;
  await mkdir(dirname(target), { recursive: true });
  await cp(file, target);
}

// 静态图片允许递归复制，但排除系统隐藏文件。
await cp('assets', `${extensionOutput}/assets`, {
  recursive: true,
  filter: source => !source.split('/').at(-1).startsWith('.')
});

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
  outfile: `${extensionOutput}/background/background.js`,
  format: 'esm'
});

// 认证入口会在后续任务加入；存在时自动纳入同一构建流程。
if (await exists('offscreen/offscreen.js')) {
  await mkdir(`${extensionOutput}/offscreen`, { recursive: true });
  await build({
    ...browserBuild,
    entryPoints: ['offscreen/offscreen.js'],
    outfile: `${extensionOutput}/offscreen/offscreen.js`,
    format: 'iife'
  });
  await cp('offscreen/offscreen.html', `${extensionOutput}/offscreen/offscreen.html`);
}
if (await exists('auth-page/sign-in.js')) {
  await build({
    ...browserBuild,
    entryPoints: ['auth-page/sign-in.js'],
    outfile: `${hostingOutput}/sign-in.js`,
    format: 'iife'
  });
  await cp('auth-page/index.html', `${hostingOutput}/index.html`);
}

const builtManifest = structuredClone(manifest);
if (firebaseConfig.authPageUrl) {
  const origin = new URL(firebaseConfig.authPageUrl).origin;
  if (!origin.startsWith('https://')) throw new Error('登录页面必须使用 HTTPS');
  if (!builtManifest.host_permissions.includes(`${origin}/*`)) {
    builtManifest.host_permissions.push(`${origin}/*`);
  }
}
await writeFile(`${extensionOutput}/manifest.json`, `${JSON.stringify(builtManifest, null, 2)}\n`);

const denyAllRules = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n";
const rules = await readFile('firestore.rules', 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return denyAllRules;
});
await writeFile(`${outputRoot}/firestore.rules`, rules.replaceAll('__OWNER_UID__', firebaseConfig.ownerUid || '__OWNER_UID__'));
await writeFile(`${outputRoot}/extension-id.txt`, `${extensionId}\n`);

console.log([
  `构建完成：${extensionOutput}`,
  `扩展 ID：${extensionId}`,
  `云配置：${isConfigured(firebaseConfig) ? '已配置' : '未配置，使用本地模式'}`,
  `所有者：${isOwnerConfigured(firebaseConfig) ? '已限制' : '尚未配置，云端规则默认拒绝所有访问'}`
].join('\n'));
