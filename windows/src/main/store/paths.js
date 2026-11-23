/**
 * ZXDesk工作台 Windows 客户端
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 数据目录「像被用过」的判据。
 *
 */
export function hasExistingData(dir, fsImpl = fs) {
  const marks = ['prefs.json', 'session.bin', 'credential.bin', 'tofu.json', 'notices-cache.json'];
  const subMarks = [path.join('logs', 'boot.log'), 'profile'];
  for (const name of [...marks, ...subMarks]) {
    try {
      if (fsImpl.existsSync(path.join(dir, name))) return true;
    } catch {
      // 单个判定失败不影响其它标记
    }
  }
  return false;
}

/**
 * 兜底位置：`%LOCALAPPDATA%\ZXDesk\data`。
 *
 */
function localFallback(localAppData, hasData, warning) {
  const root = path.join(localAppData, 'ZXDesk');
  const data = path.join(root, 'data');
  if (hasData) {
    try {
      if (hasData(data)) return { dir: data, mode: 'fallback', warning };
      if (hasData(root)) return { dir: root, mode: 'fallback', warning };
    } catch {
    }
  }
  return { dir: data, mode: 'fallback', warning };
}

/**
 * 纯决策（可单测）：给定环境与「可写判定」，返回数据目录与模式。
 * @param {object} input
 */
export function decideDataDir(input) {
  const { isPackaged, exeDir, devDir, localAppData, canWrite, hasData } = input;
  const installDataDir = typeof input.installDataDir === 'string' && input.installDataDir ? input.installDataDir : '';
  const envDataDir = typeof input.envDataDir === 'string' && input.envDataDir ? input.envDataDir : '';

  if (!isPackaged) {
    if (canWrite(devDir)) return { dir: devDir, mode: 'dev', warning: null };
    return localFallback(localAppData, hasData, '开发目录不可写，已改用 LOCALAPPDATA');
  }

  // ① 环境变量：调试 / 便携，最高优先（不可写就说明白，不静默改道）
  if (envDataDir) {
    if (canWrite(envDataDir)) return { dir: envDataDir, mode: 'override', warning: null };
    return localFallback(
      localAppData,
      hasData,
      `ZXDESK_DATA_DIR 指向的目录不可写（${envDataDir}），已改用 LOCALAPPDATA`,
    );
  }

  // ② 安装版：安装程序选的数据路径
  if (installDataDir) {
    if (canWrite(installDataDir)) return { dir: installDataDir, mode: 'installed', warning: null };
    return localFallback(
      localAppData,
      hasData,
      `安装时选的数据目录不可写（${installDataDir}），已改用 LOCALAPPDATA`,
    );
  }

  // ③ 绿色 / 测试版：程序目录下的 data/
  const portable = path.join(exeDir, 'data');
  if (canWrite(portable)) return { dir: portable, mode: 'portable', warning: null };

  return localFallback(
    localAppData,
    hasData,
    '程序目录不可写，已改用 LOCALAPPDATA（请把程序解压到可写目录，别放 Program Files）',
  );
}

/**
 * 读安装程序写的 `install.ini`（在 exe 旁边）。
 *
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
    hasData: hasExistingData,
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
    /** 账号清单（明文，不存密码）：撑起「文件 → 切换账号」那个菜单。 */
    accounts: path.join(dir, 'accounts.json'),
    /**
     * 网关凭据（加密）：访问码 Cookie 的跨启动副本。
     * 独立于 `session.bin` —— 「退出登录」不该让这台设备连访问码都要重输。
     */
    gateway: path.join(dir, 'gateway.bin'),
    tofu: path.join(dir, 'tofu.json'),
    prefs: path.join(dir, 'prefs.json'),
    notices: path.join(dir, 'notices-cache.json'),
    bootLog: path.join(dir, 'logs', 'boot.log'),
  };
}
