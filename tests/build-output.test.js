/**
 * 验证构建产物不携带本机密钥，并保留现有 AI 配置入口和固定扩展 ID。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function isMissing(path) {
  return access(path).then(() => false, error => error.code === 'ENOENT');
}

test('未配置 Firebase 时构建安全且 AI 配置入口可用', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'xhs-comment-saver-build-'));
  try {
    await run(process.execPath, ['scripts/build.js'], {
      env: {
        ...process.env,
        XHS_FIREBASE_CONFIG_PATH: 'tests/fixtures/missing-firebase-config.json',
        XHS_BUILD_OUTPUT_DIR: outputDirectory
      }
    });

    const sourceManifest = JSON.parse(await readFile('manifest.json', 'utf8'));
    const builtManifest = JSON.parse(await readFile(`${outputDirectory}/extension/manifest.json`, 'utf8'));
    const expectedId = createHash('sha256')
      .update(Buffer.from(sourceManifest.key, 'base64'))
      .digest('hex')
      .slice(0, 32)
      .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + Number.parseInt(value, 16)));

    assert.equal((await readFile(`${outputDirectory}/extension-id.txt`, 'utf8')).trim(), expectedId);
    assert.equal(builtManifest.host_permissions.some(value => /firebaseapp\.com|web\.app/.test(value)), false);
    assert.equal(await isMissing(`${outputDirectory}/extension/.env`), true);
    assert.equal(await isMissing(`${outputDirectory}/extension/manager/apiconfig.json`), true);
    assert.equal(await isMissing(`${outputDirectory}/extension/manager/apiconfig.local.json`), true);

    const rules = await readFile(`${outputDirectory}/firestore.rules`, 'utf8');
    assert.match(rules, /allow read, write: if false/);

    const builtManager = await readFile(`${outputDirectory}/extension/manager/manager.js`, 'utf8');
    const builtApiConfig = await readFile(`${outputDirectory}/extension/manager/apiconfig.js`, 'utf8');
    const builtApiCore = await readFile(`${outputDirectory}/extension/manager/api-config-core.js`, 'utf8');
    const builtApiStore = await readFile(`${outputDirectory}/extension/manager/api-config-store.js`, 'utf8');
    const builtManagerHtml = await readFile(`${outputDirectory}/extension/manager/manager.html`, 'utf8');
    assert.match(builtManager, /configureApi/);
    assert.match(builtApiConfig, /API_PROVIDER_DEFAULTS/);
    assert.match(builtApiCore, /validateProviderUrl/);
    assert.match(builtApiStore, /xhs_api_config/);
    assert.match(builtApiStore, /readApiConfig/);
    assert.match(builtManagerHtml, /id="btn-api-config"/);
    assert.match(builtManagerHtml, /data-packaged-build="true"/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('已配置 Firebase 时只加入登录页的精确来源', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'xhs-comment-saver-build-'));
  const configPath = `${outputDirectory}/firebase.json`;
  try {
    await writeFile(configPath, JSON.stringify({
      apiKey: 'public-key',
      authDomain: 'xhs-test.firebaseapp.com',
      projectId: 'xhs-test',
      appId: 'test-app',
      authPageUrl: 'https://login.example.com/sign-in',
      ownerUid: 'owner_uid'
    }));
    await run(process.execPath, ['scripts/build.js'], {
      env: {
        ...process.env,
        XHS_FIREBASE_CONFIG_PATH: configPath,
        XHS_BUILD_OUTPUT_DIR: outputDirectory
      }
    });
    const manifest = JSON.parse(await readFile(`${outputDirectory}/extension/manifest.json`, 'utf8'));
    const expectedId = createHash('sha256')
      .update(Buffer.from(manifest.key, 'base64'))
      .digest('hex')
      .slice(0, 32)
      .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + Number.parseInt(value, 16)));
    assert.equal(manifest.host_permissions.includes('https://login.example.com/*'), true);
    assert.equal(manifest.host_permissions.some(value => value.includes('*.firebaseapp.com')), false);
    assert.equal(manifest.host_permissions.some(value => value.includes('*.web.app')), false);
    const rules = await readFile(`${outputDirectory}/firestore.rules`, 'utf8');
    const deployConfig = JSON.parse(await readFile(`${outputDirectory}/firebase.json`, 'utf8'));
    assert.match(rules, /uid == 'owner_uid'/);
    assert.doesNotMatch(rules, /__OWNER_UID__/);
    assert.deepEqual(deployConfig.firestore, { rules: 'firestore.rules' });
    assert.equal(deployConfig.hosting.public, 'hosting');
    const headers = deployConfig.hosting.headers[0].headers;
    assert.deepEqual(headers.find(item => item.key === 'Referrer-Policy'), {
      key: 'Referrer-Policy', value: 'no-referrer'
    });
    assert.deepEqual(headers.find(item => item.key === 'X-Content-Type-Options'), {
      key: 'X-Content-Type-Options', value: 'nosniff'
    });
    assert.deepEqual(headers.find(item => item.key === 'Cache-Control'), {
      key: 'Cache-Control', value: 'no-store'
    });
    assert.match(
      headers.find(item => item.key === 'Content-Security-Policy').value,
      new RegExp(`frame-ancestors chrome-extension://${expectedId}`)
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('危险输出路径在递归删除前被拒绝并保留哨兵', async () => {
  const projectSentinel = 'manifest.json';
  const temporarySentinel = await mkdtemp(join(tmpdir(), 'xhs-comment-saver-sentinel-'));
  const arbitraryAbsoluteDirectory = await mkdtemp(join(tmpdir(), 'other-build-output-'));
  const dangerousPaths = ['..', homedir(), tmpdir(), arbitraryAbsoluteDirectory];

  try {
    for (const outputDirectory of dangerousPaths) {
      await assert.rejects(
        run(process.execPath, ['scripts/build.js'], {
          env: { ...process.env, XHS_BUILD_OUTPUT_DIR: outputDirectory }
        })
      );
      assert.equal(await isMissing(projectSentinel), false);
      assert.equal(await isMissing(temporarySentinel), false);
    }
  } finally {
    await rm(temporarySentinel, { recursive: true, force: true });
    await rm(arbitraryAbsoluteDirectory, { recursive: true, force: true });
  }
});
