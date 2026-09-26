/**
 * 验证构建产物不携带本机密钥，并保留现有 AI 配置入口和固定扩展 ID。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function isMissing(path) {
  return access(path).then(() => false, error => error.code === 'ENOENT');
}

test('未配置 Firebase 时构建安全且 AI 配置入口可用', async () => {
  await run(process.execPath, ['scripts/build.js'], {
    env: {
      ...process.env,
      XHS_FIREBASE_CONFIG_PATH: 'tests/fixtures/missing-firebase-config.json'
    }
  });

  const sourceManifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  const builtManifest = JSON.parse(await readFile('dist/extension/manifest.json', 'utf8'));
  const expectedId = createHash('sha256')
    .update(Buffer.from(sourceManifest.key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + Number.parseInt(value, 16)));

  assert.equal((await readFile('dist/extension-id.txt', 'utf8')).trim(), expectedId);
  assert.equal(builtManifest.host_permissions.some(value => /firebaseapp\.com|web\.app/.test(value)), false);
  assert.equal(await isMissing('dist/extension/.env'), true);
  assert.equal(await isMissing('dist/extension/manager/apiconfig.json'), true);
  assert.equal(await isMissing('dist/extension/manager/apiconfig.local.json'), true);

  const rules = await readFile('dist/firestore.rules', 'utf8');
  assert.match(rules, /allow read, write: if false/);

  const builtManager = await readFile('dist/extension/manager/manager.js', 'utf8');
  const builtApiConfig = await readFile('dist/extension/manager/apiconfig.js', 'utf8');
  const builtManagerHtml = await readFile('dist/extension/manager/manager.html', 'utf8');
  assert.match(builtManager, /xhs_api_config/);
  assert.match(builtManager, /configureApi/);
  assert.match(builtApiConfig, /API_PROVIDER_DEFAULTS/);
  assert.match(builtManagerHtml, /id="btn-api-config"/);
});

test('已配置 Firebase 时只加入登录页的精确来源', async () => {
  const temporaryDirectory = await mkdtemp('/private/tmp/xhs-build-config-');
  const configPath = `${temporaryDirectory}/firebase.json`;
  await writeFile(configPath, JSON.stringify({
    apiKey: 'public-key',
    authDomain: 'xhs-test.firebaseapp.com',
    projectId: 'xhs-test',
    appId: 'test-app',
    authPageUrl: 'https://login.example.com/sign-in',
    ownerUid: 'owner_uid'
  }));

  try {
    await run(process.execPath, ['scripts/build.js'], {
      env: { ...process.env, XHS_FIREBASE_CONFIG_PATH: configPath }
    });
    const manifest = JSON.parse(await readFile('dist/extension/manifest.json', 'utf8'));
    assert.equal(manifest.host_permissions.includes('https://login.example.com/*'), true);
    assert.equal(manifest.host_permissions.some(value => value.includes('*.firebaseapp.com')), false);
    assert.equal(manifest.host_permissions.some(value => value.includes('*.web.app')), false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
