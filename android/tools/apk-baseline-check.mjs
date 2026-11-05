#!/usr/bin/env node
// android/tools/apk-baseline-check.mjs —— 「APK 身份对不对」的机械闸（零依赖）。
//
// 用法：node android/tools/apk-baseline-check.mjs [apk 路径]（默认 android/app/build/outputs/apk/debug/app-debug.apk）
//
// 断言三件事（任何一条不成立就退出非 0，别靠人眼看）：
//   1. 包名必须是 `dev.sopho.pi`（2026-10-23 业主拍板的正式包名；旧包 `dev.sopho.proto` 并存，
//      拿旧包跑这条闸**必须红** —— 那是安全检查，不是 bug）；
//   2. 签名证书 SHA-256 必须是**已交付包那把 key**（包名变了不换 key）；
//   3. versionCode 必须 ≥ 基线（默认 2）。**只要求不下降**：允许同 code 覆盖安装（业主 2026-10-22 更正）；
//      可用 --min-version N 抬高下限。规则与交付表在 docs/ops/android-client.md §14.3 / §17。
//
// 工具来自本机 Android SDK 的 build-tools（aapt / apksigner）。SDK 找不到 ⇒ 退出 2（**不静默通过**）。
// 这里不碰任何私钥内容：apksigner --print-certs 只读证书摘要。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const EXPECTED_PACKAGE = 'dev.sopho.pi';
/** v2（versionCode 2）那一包的签名证书，新包 `dev.sopho.pi` 仍用同一把（已交付 v1 也是同一把）。 */
const EXPECTED_CERT_SHA256 = 'faff248f15977835c25c25ec8c0b865fa6c4207bada8cfc8e5785ea8aa94e956';
/**
 * 最低可接受的 versionCode（v2 = 2）。闸只要求 **≥**，**不**要求比上一包大：
 * 业主 2026-10-22 更正为“只需不下降，允许同 code 覆盖安装”。
 */
const DEFAULT_MIN_VERSION_CODE = 2;

const minArgIndex = process.argv.indexOf('--min-version');
const MIN_VERSION_CODE = minArgIndex > 0 ? Number(process.argv[minArgIndex + 1]) : DEFAULT_MIN_VERSION_CODE;

const apkArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const apk = apkArg ?? path.join('android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

function sdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.env.HOME && path.join(process.env.HOME, 'AppData', 'Local', 'Android', 'Sdk'),
  ].filter(Boolean);
  return candidates.find((dir) => existsSync(path.join(dir, 'build-tools'))) ?? null;
}

function buildTools() {
  const root = sdkRoot();
  if (!root) return null;
  const dir = path.join(root, 'build-tools');
  const versions = readdirSync(dir)
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
  const newest = versions[0];
  if (!newest) return null;
  const exe = (name) => path.join(dir, newest, process.platform === 'win32' ? `${name}.exe` : name);
  const apksigner = path.join(dir, newest, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
  if (!existsSync(exe('aapt')) || !existsSync(apksigner)) return null;
  return { aapt: exe('aapt'), apksigner, version: newest };
}

function fail(message) {
  console.error(`✗ [apk-baseline] ${message}`);
  process.exit(1);
}

if (!existsSync(apk)) fail(`APK 不存在：${apk}（先 assembleDebug）`);
const tools = buildTools();
if (!tools) {
  console.error('✗ [apk-baseline] 找不到 Android SDK build-tools（aapt/apksigner）—— 不静默通过，退出 2');
  process.exit(2);
}

const badging = execFileSync(tools.aapt, ['dump', 'badging', apk], { encoding: 'utf8' });
const packageLine = badging.split('\n').find((line) => line.startsWith('package:')) ?? '';
const packageName = /name='([^']+)'/.exec(packageLine)?.[1];
const versionCode = Number(/versionCode='([^']+)'/.exec(packageLine)?.[1]);
const versionName = /versionName='([^']+)'/.exec(packageLine)?.[1];

// Windows 上 apksigner 是 .bat：execFileSync 直接起不了，得经过 cmd /c。
const certOut = process.platform === 'win32'
  ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/c', tools.apksigner, 'verify', '--print-certs', apk], { encoding: 'utf8' })
  : execFileSync(tools.apksigner, ['verify', '--print-certs', apk], { encoding: 'utf8' });
const certSha256 = /certificate SHA-256 digest:\s*([0-9a-f]{64})/i.exec(certOut)?.[1]?.toLowerCase();

console.log(`[apk-baseline] ${apk}`);
console.log(`[apk-baseline] build-tools ${tools.version}`);
console.log(`[apk-baseline] package=${packageName} versionCode=${versionCode} versionName=${versionName}`);
console.log(`[apk-baseline] certSHA256=${certSha256}`);

if (packageName !== EXPECTED_PACKAGE) fail(`包名 ${packageName} ≠ ${EXPECTED_PACKAGE}（旧包 dev.sopho.proto 与新包并存，不是同一个应用）`);
if (certSha256 !== EXPECTED_CERT_SHA256) {
  fail(`签名证书 ${certSha256} ≠ 基线 ${EXPECTED_CERT_SHA256}（换 key 会让已装包无法升级；不要生成替代 key）`);
}
if (!Number.isFinite(versionCode) || versionCode < MIN_VERSION_CODE) {
  fail(`versionCode=${versionCode} 小于基线 ${MIN_VERSION_CODE}（只要求不下降，允许同 code 覆盖安装）`);
}
console.log('✓ [apk-baseline] 包名 / 签名基线 / versionCode 三条都成立');
