/**
 * 数据目录解析（安装版 + 绿色版 + 开发态三合一）。
 *
 * 优先级（`isPackaged` 时）：
 * 1. `ZXDESK_DATA_DIR` 环境变量（调试 / 便携，最高优先）；
 * 2. 安装程序写的 `<exe 目录>/install.json` 的 `dataDir`（**0.2.1 正式版走这条**）；
 * 3. `<exe 目录>/data/`（绿色版 / 测试版，能写就用）；
 * 4. `%LOCALAPPDATA%\ZXDesk\`（兜底，并提示）。
 *
 * 开发态（`npm start`）写 `Project/windows/.dev-data/`（⛔ 不写进 `node_modules/electron`）。
 *
 * ⚠️ `app.setPath` 必须在 `ready` **之前**调用，否则 Chromium 会先往 `%APPDATA%` 写一份。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 纯决策（可单测）：给定环境与「可写判定」，返回数据目录与模式。
 *
 * @param {object} input
 * @param {boolean} input.isPackaged
 * @param {string} input.exeDir - 打包态：exe 所在目录
 * @param {string} input.devDir - 开发态：`Project/windows/.dev-data`
 * @param {string} input.localAppData - `%LOCALAPPDATA%`
 * @param {(dir:string)=>boolean} input.canWrite
 * @returns {{dir:string, mode:'portable'|'dev'|'fallback', warning:string|null}}
 */
export function decideDataDir(input) {
  const { isPackaged, exeDir, devDir, localAppData, canWrite } = input;
  const installDataDir = typeof input.installDataDir === 'string' && input.installDataDir ? input.installDataDir : '';
  const envDataDir = typeof input.envDataDir === 'string' && input.envDataDir ? input.envDataDir : '';

  if (!isPackaged) {
    if (canWrite(devDir)) return { dir: devDir, mode: 'dev', warning: null };
    return {
      dir: path.join(localAppData, 'ZXDesk'),
      mode: 'fallback',
      warning: '开发目录不可写，已改用 LOCALAPPDATA',
    };
  }

  // ① 环境变量：调试 / 便携，最高优先（不可写就说明白，不静默改道）
  if (envDataDir) {
    if (canWrite(envDataDir)) return { dir: envDataDir, mode: 'override', warning: null };
    return {
      dir: path.join(localAppData, 'ZXDesk'),
      mode: 'fallback',
      warning: `ZXDESK_DATA_DIR 指向的目录不可写（${envDataDir}），已改用 LOCALAPPDATA`,
    };
  }

  // ② 安装版：安装程序选的数据路径（0.2.1 正式版）
  if (installDataDir) {
    if (canWrite(installDataDir)) return { dir: installDataDir, mode: 'installed', warning: null };
    return {
      dir: path.join(localAppData, 'ZXDesk'),
      mode: 'fallback',
      warning: `安装时选的数据目录不可写（${installDataDir}），已改用 LOCALAPPDATA`,
    };
  }

  // ③ 绿色 / 测试版：程序目录下的 data/
  const portable = path.join(exeDir, 'data');
  if (canWrite(portable)) return { dir: portable, mode: 'portable', warning: null };

  return {
    dir: path.join(localAppData, 'ZXDesk'),
    mode: 'fallback',
    warning: '程序目录不可写，已改用 LOCALAPPDATA（请把程序解压到可写目录，别放 Program Files）',
  };
}

/**
 * 读安装程序写的 `install.ini`（在 exe 旁边）。
 *
 * 为什么是 INI 不是 JSON：Windows 路径里的反斜杠在 JSON 字符串里必须转义，
 * 而 NSIS 没有现成的字符串替换 ⇒ 写出来就是坏 JSON。INI 不需要转义。
 *
 * 格式（安装程序写）：
 *   [install]
 *   dir=C:\Program Files\ZXDesk
 *   data=D:\ZXDeskData
 *   version=0.2.1
 *
 * 读不到 / 坏了就当没有 —— ⛔ 不影响启动，只是退回绿色口径。
 */
export function readInstallConfig(exeDir, fsImpl = fs) {
  try {
    const text = fsImpl.readFileSync(path.join(exeDir, 'install.ini'), 'utf8');
    const values = parseIni(text);
    // 一个键都没有 = 不是我们写的配置（或文件被清空）⇒ 当没有
    if (!values.data && !values.dir && !values.version) return null;
    const dataDir = (values.data || '').trim();
    return {
      dataDir: dataDir || null,
      installDir: (values.dir || '').trim() || exeDir,
      version: (values.version || '').trim() || null,
    };
  } catch {
    return null;
  }
}

/** 极简 INI 解析：只认 `[install]` 段里的 `key=value`，其余忽略（可单测）。 */
export function parseIni(text) {
  const out = {};
  let inSection = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inSection = section[1].trim().toLowerCase() === 'install';
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** 真判定：能建目录、能写一个探针文件。 */
export function canWriteDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 运行时入口：算好目录并把子目录建出来。 */
export function resolveDataDir({ isPackaged, exeDir, devDir, localAppData, env }) {
  const install = isPackaged ? readInstallConfig(exeDir) : null;
  const decided = decideDataDir({
    isPackaged,
    exeDir,
    devDir,
    localAppData,
    installDataDir: install?.dataDir || '',
    envDataDir: (env || process.env)?.ZXDESK_DATA_DIR || '',
    canWrite: canWriteDir,
  });
  decided.install = install;
  for (const name of ['profile', 'crashes', 'logs']) {
    try {
      fs.mkdirSync(path.join(decided.dir, name), { recursive: true });
    } catch {
      // 单层失败不致命：日志会记 warning
    }
  }
  return decided;
}

/** 数据目录下的固定文件名（集中一处，⛔ 别散着拼字符串）。 */
export function dataFiles(dir) {
  return {
    session: path.join(dir, 'session.bin'),
    credential: path.join(dir, 'credential.bin'),
    tofu: path.join(dir, 'tofu.json'),
    prefs: path.join(dir, 'prefs.json'),
    bootLog: path.join(dir, 'logs', 'boot.log'),
  };
}
