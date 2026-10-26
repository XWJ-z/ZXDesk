/**
 * Windows 打包入口（等价于 `electron-packager` CLI，多一层「本机沙箱兼容」）。
 *
 * 为什么不用 CLI：本机（NAS 容器）的内核沙箱**拦了两类系统调用** ——
 * ① `copy_file_range`（`fs.copyFileSync` 一律 `EPERM`）；② `utimes`（复制后用 `futime` 回填时间戳也 `EPERM`）。
 * packager 内部用 fs-extra 复制 app 目录，正好两样都用。
 * 这里在 import packager **之前**把这两类调用兜住（copyFile 改成「读进内存再写出去」、utimes 遇 EPERM 就跳过），
 * 语义等价（丢掉的只有 COW 加速与时间戳保留），**打包结果与在 Windows 上跑 CLI 一致**。
 *
 * ⚠️ 除这一层兼容处理，参数与任务单 §10.2 的 `pack:win` 逐项一致。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const IGNORE_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP']);

/**
 * Electron 官方安装包的 sha256（来源：v45.0.0 的官方 SHASUMS256.txt，2026-10-25 核对过一次）。
 *
 * 为什么要写死：`@electron/get` 在缓存命中 zip 之后，**还会去下一个 SHASUMS256.txt 来校验**；
 * 本机到 github releases 时通时不通（今天下午直接 socket hang up / 卡 4 分钟）。
 * 把校验和直接交给它 ⇒ 校验照做（不是关校验），但**完全不联网**。
 */
const ELECTRON_CHECKSUMS = {
  '45.0.0': { 'electron-v45.0.0-win32-x64.zip': 'ae53887a23bb640369c93dbd38c408a2af5c0deb86f2fa76c6c244cb444b7f47' },
};

/** 沙箱兼容：copyFile 用「读写」实现；utimes / chmod 失败直接跳过。 */
function patchFsForSandbox() {
  const originalCopySync = fs.copyFileSync;
  const originalCopy = fs.copyFile;

  fs.copyFileSync = (src, dest, mode) => {
    try {
      originalCopySync(src, dest, mode);
    } catch (e) {
      if (!IGNORE_CODES.has(e.code)) throw e;
      fs.writeFileSync(dest, fs.readFileSync(src));
    }
  };

  fs.copyFile = (src, dest, flags, callback) => {
    const cb = typeof flags === 'function' ? flags : callback;
    originalCopy(src, dest, flags, (err) => {
      if (!err || !IGNORE_CODES.has(err.code)) return cb(err);
      try {
        fs.writeFileSync(dest, fs.readFileSync(src));
        cb(null);
      } catch (inner) {
        cb(inner);
      }
    });
  };

  const originalPromiseCopy = fsp.copyFile;
  fsp.copyFile = async (src, dest, mode) => {
    try {
      return await originalPromiseCopy(src, dest, mode);
    } catch (e) {
      if (!IGNORE_CODES.has(e.code)) throw e;
      await fsp.writeFile(dest, await fsp.readFile(src));
    }
  };

  const swallow = (name) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      try {
        return original.apply(fs, cb ? args.slice(0, -1).concat([(err) => cb(IGNORE_CODES.has(err?.code) ? null : err)]) : args);
      } catch (e) {
        if (IGNORE_CODES.has(e.code)) return cb ? cb(null) : undefined;
        throw e;
      }
    };
  };
  const swallowSync = (name) => {
    const original = fs[name];
    if (typeof original !== 'function') return;
    fs[name] = (...args) => {
      try {
        return original.apply(fs, args);
      } catch (e) {
        if (IGNORE_CODES.has(e.code)) return undefined;
        throw e;
      }
    };
  };
  for (const name of ['utimes', 'futimes', 'chmod', 'chown', 'lchmod']) swallow(name);
  for (const name of ['utimesSync', 'futimesSync', 'chmodSync', 'chownSync', 'lchmodSync']) swallowSync(name);
  if (fsp.utimes) {
    const original = fsp.utimes;
    fsp.utimes = async (...args) => {
      try {
        return await original.apply(fsp, args);
      } catch (e) {
        if (IGNORE_CODES.has(e.code)) return undefined;
        throw e;
      }
    };
  }
}

async function main() {
  patchFsForSandbox();
  const mod = await import('@electron/packager');
  const packagerFn = mod.packager || mod.default;
  if (typeof packagerFn !== 'function') throw new Error('@electron/packager 里没找到 packager 函数');

  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  // 临时目录必须在**源码目录之外**（fs-extra 拒绝「复制到自己子目录」）。
  // 要指定就用环境变量 ZXDESK_PACK_TMP；默认走系统临时目录。
  const tempRoot = process.env.ZXDESK_PACK_TMP || path.join(os.tmpdir(), 'zxdesk-pack');
  fs.mkdirSync(tempRoot, { recursive: true });
  process.env.TMPDIR = tempRoot;

  // 上一次的输出先**挪走**再打包：本机内核沙箱会拒 `fs.rm` 大树（EPERM），
  // packager 的 overwrite 也走 rm ⇒ 第一次常常失败。rename 不受影响，且保留了上次的包便于对比。
  const outDir = path.join(root, 'build', 'out');
  const prevTarget = path.join(root, 'build', 'tmp', `prev-${Date.now()}`);
  if (fs.existsSync(path.join(outDir, 'ZXDesk-win32-x64'))) {
    try {
      fs.mkdirSync(path.dirname(prevTarget), { recursive: true });
      fs.renameSync(path.join(outDir, 'ZXDesk-win32-x64'), prevTarget);
      console.log(`上一次的输出已移到 ${path.relative(root, prevTarget)}`);
    } catch (e) {
      console.warn(`清理旧输出失败（继续，交给 overwrite）：${e.message}`);
    }
  }

  const electronVersion = String(pkg.devDependencies?.electron || '').replace(/^[^\d]*/, '');
  const checksums = ELECTRON_CHECKSUMS[electronVersion];

  const appPaths = await packagerFn({
    dir: root,
    name: 'ZXDesk',
    platform: 'win32',
    arch: 'x64',
    asar: true,
    out: path.join(root, 'build', 'out'),
    overwrite: true,
    appVersion: pkg.version,
    tempDirectory: tempRoot,
    // 有已知校验和就交给它（离线也能校验）；没有就退回默认（会联网取 SHASUMS256.txt）
    ...(checksums ? { download: { checksums } } : {}),
    ignore: [
      /^\/node_modules/, // ⛔ 壳零运行时依赖，devDeps 一个都不许进包
      /^\/tests/,
      /^\/build/,
      /^\/\.dev-data/,
      /^\/\.git/,
      /^\/README\.md$/,
      /^\/package-lock\.json$/,
    ],
  });

  for (const appPath of appPaths) console.log(`PACKAGED ${appPath}`);

  // ⚠️ 图标**必须**在打包之后写（0.1.6 丢图标的真因：图标写完了又跑了一次 pack，exe 被覆盖回默认图标）。
  // 这里把它接进同一条链，脚本自己会「写完再解析核对」，失败直接非零退出 —— 不许静默出无图标的包。
  const exe = path.join(appPaths[0], 'ZXDesk.exe');
  const iconScript = path.join(root, 'build', 'apply-icon.js');
  const child = spawnSync(process.execPath, [iconScript, exe], { stdio: 'inherit' });
  if (child.status !== 0) {
    throw new Error(`图标写入失败（exit ${child.status}）—— 包已打出但没有 ZXDesk 图标，⛔ 不要发这个包`);
  }
}

main().catch((e) => {
  console.error(`打包失败：${e.stack || e.message}`);
  process.exit(1);
});
