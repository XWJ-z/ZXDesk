/**
 * 更新服务：把「查最新版 → 下载 → 校验」串成一个带状态的对象。
 *
 * 只做三件事，别的一律不做（打开安装包、弹窗、写界面都在上层）：
 * 1. 调接口并判定「有没有新版」；
 * 2. 按接口给的地址下载、按接口给的 SHA256 校验；
 * 3. 把当前阶段告诉上层（`onState`）。
 *
 * 失败分两类，处理方式不同：
 * - 「没有发布记录 / 网络不通 / 接口 5xx」→ 安静收场（客户端不能因为更新服务挂了就打不开）；
 * - 「hash 对不上 / 大小不对」→ 明确报错并删包（下到的字节不可信，不能交给用户运行）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildApiUrl, fetchLatest } from './client.js';
import { downloadFile, probeUrls, safeFileName, sha256File } from './download.js';
import { expandDownloadUrls } from './mirrors.js';
import { readPackageVersion } from './verify.js';
import { isNewer, isValidVersion } from './version.js';

/** 进度推送最小间隔：下载 150 MB 会有上万次 data 事件，逐次推会把 IPC 打满。 */
const PROGRESS_INTERVAL_MS = 200;

/**
 * 一次「下载更新」最多下载几次。
 *
 * 为什么要有上限：镜像可能缓存了旧包（hash / 大小 / 包内版本都对不上），
 * 而候选地址有 4 个（1 个官方 + 3 个前缀），逐个试下来会把 150 MB 反复拖好几遍 ——
 * 用户看到的就是「一直在下载」。⛔ 内容不对的源会被标记为坏源，不再碰。
 *
 * 两次还不行就停手，交给网盘兜底（见 controller 的 update.pan）。
 */
const MAX_DOWNLOAD_ATTEMPTS = 2;

export class UpdateService {
  /**
   * @param {object} input
   * @param {string} input.currentVersion
   * @param {string} input.apiUrl
   * @param {string} [input.channel]
   * @param {string} input.dir - 安装包落盘目录（数据目录下的 updates/）
   * @param {Function} input.fetchImpl
   * @param {Function} input.transport
   * @param {(level:'info'|'warn', message:string)=>void} [input.log]
   * @param {()=>void} [input.onState]
   * @param {number} [input.timeoutMs]
   * @param {number} [input.probeTimeoutMs]
   */
  constructor(input) {
    this.currentVersion = String(input.currentVersion || '');
    this.apiUrl = String(input.apiUrl || '');
    this.channel = input.channel === 'beta' ? 'beta' : 'stable';
    this.dir = input.dir;
    this.fetchImpl = input.fetchImpl;
    this.transport = input.transport;
    this.log = input.log || (() => {});
    this.onState = input.onState || (() => {});
    this.timeoutMs = Number(input.timeoutMs || 8000);
    /** 单个下载源的探测超时：太短会把慢但可用的源误判为不可用。 */
    this.probeTimeoutMs = Number(input.probeTimeoutMs || 4000);

    this.pendingCheck = null;
    this.pendingDownload = null;
    this.info = null;
    this.lastProgressAt = 0;

    this.state = {
      phase: 'idle',
      current: this.currentVersion,
      latest: null,
      available: false,
      mustUpdate: false,
      notes: '',
      force: false,
      minVersion: '',
      fileName: '',
      fileSize: 0,
      hash: '',
      progress: null,
      filePath: '',
      packageType: '',
      /** 网盘兜底地址（清单里带的），连续失败后界面用它给「手动更新」出口。 */
      fallbackUrl: '',
      /** 这次「下载更新」已经试了几次（0 = 还没开始）。 */
      attempts: 0,
      error: null,
      checkedAt: null,
    };
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  emit() {
    try {
      this.onState(this.snapshot());
    } catch (error) {
      this.log('warn', `状态推送失败：${error.message}`);
    }
  }

  /**
   * 查询最新版本。
   * @param {{silent?:boolean}} [options] - silent：启动后的自动检查，失败不打扰界面
   */
  async check(options = {}) {
    const silent = options.silent === true;
    if (this.pendingCheck) return this.pendingCheck;

    const target = buildApiUrl(this.apiUrl, this.channel);
    if (!target.ok) {
      this.state = { ...this.state, phase: 'error', error: { kind: 'config', message: target.reason } };
      this.emit();
      return this.snapshot();
    }

    // 静默检查失败时要退回「检查之前」的阶段，不能把已有结论（有新版本 / 已下载）冲掉
    const previousPhase = this.state.phase;
    this.state = { ...this.state, phase: 'checking', error: null };
    this.emit();
    this.pendingCheck = this.doCheck(target.url, silent, previousPhase).finally(() => {
      this.pendingCheck = null;
    });
    return this.pendingCheck;
  }

  async doCheck(url, silent, previousPhase = 'idle') {
    const result = await fetchLatest({ url, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });

    if (!result.ok) {
      // 404 = 该端还没发布记录，与「已是最新」同一个结论
      if (result.kind === 'not-published') {
        this.info = null;
        this.state = {
          ...this.state,
          phase: 'latest',
          latest: null,
          available: false,
          mustUpdate: false,
          error: null,
          checkedAt: Date.now(),
        };
        this.emit();
        return this.snapshot();
      }

      this.log('warn', `版本检查失败（${result.kind}）：${result.message}`);
      const keepPhase = silent && previousPhase !== 'idle' && previousPhase !== 'checking';
      this.state = {
        ...this.state,
        phase: keepPhase ? previousPhase : 'error',
        error: { kind: result.kind, message: result.message },
        checkedAt: Date.now(),
      };
      this.emit();
      return this.snapshot();
    }

    const info = result.info;
    this.info = info;
    const available = isNewer(info.version, this.currentVersion);
    // 强制更新：服务端点名 force，或当前版本低于它给的最低支持版本
    const belowMinimum = info.minVersion && isValidVersion(info.minVersion) ? isNewer(info.minVersion, this.currentVersion) : false;

    this.state = {
      ...this.state,
      phase: available ? 'available' : 'latest',
      latest: info.version,
      available,
      mustUpdate: available && (info.force || belowMinimum),
      notes: info.notes,
      force: info.force,
      minVersion: info.minVersion,
      fileName: info.fileName,
      fileSize: info.fileSize,
      hash: info.hash,
      packageType: packageTypeOf(info.fileName),
      fallbackUrl: info.fallbackUrl || '',
      attempts: 0,
      error: null,
      progress: null,
      filePath: '',
      checkedAt: Date.now(),
    };
    this.log('info', `版本检查：当前 ${this.currentVersion}，最新 ${info.version}（${available ? '有更新' : '已是最新'}）`);
    this.emit();
    return this.snapshot();
  }

  /** 下载并校验。已在下则复用同一个 Promise（两个入口点会重复触发）。 */
  async download() {
    if (this.pendingDownload) return this.pendingDownload;
    const info = this.info;
    if (!info || !this.state.available) return this.snapshot();

    this.state = {
      ...this.state,
      phase: 'downloading',
      error: null,
      progress: { received: 0, total: info.fileSize, percent: 0 },
    };
    this.emit();

    this.pendingDownload = this.doDownload(info).finally(() => {
      this.pendingDownload = null;
    });
    return this.pendingDownload;
  }

  async doDownload(info) {
    const fileName = safeFileName(info.fileName);
    const dest = path.join(this.dir, fileName);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      this.failDownload('disk', `建不了下载目录：${error.message}`);
      return this.snapshot();
    }

    // 只留当前版本这一份包，避免反复升级把数据目录撑大
    pruneOldPackages(this.dir, fileName);

    // ① 探测：官方地址 ＋ 镜像一起测，按响应快慢排序。
    //    先探测再下载的理由：连不上的源逐个等超时会让用户干等好几分钟。
    const candidates = expandDownloadUrls(info.downloadUrls);
    this.state = { ...this.state, phase: 'downloading', progress: null, error: null };
    this.emit();
    const reachable = await probeUrls(candidates, this.transport, { timeoutMs: this.probeTimeoutMs });
    if (reachable.length === 0) {
      this.log('warn', `下载源全部不可达（${candidates.length} 个）`);
      fs.rmSync(dest, { force: true });
      fs.rmSync(`${dest}.part`, { force: true });
      this.giveUp('所有下载源都连不上（GitHub 与镜像均超时）', 0);
      return this.snapshot();
    }
    this.log(
      'info',
      `可用下载源 ${reachable.length}/${candidates.length}：${reachable.map((r) => `${hostOf(r.url)} ${r.ms}ms`).join('，')}`,
    );

    const urls = reachable.map((r) => r.url);
    /** 内容不对的源（旧包 / 被改过）：标记后不再尝试，免得反复拖同一个坏包。 */
    const poisoned = new Set();
    let attempts = 0;
    let usedUrl = '';
    let lastError = null;

    while (attempts < MAX_DOWNLOAD_ATTEMPTS) {
      // 优先换一个没用过的源；都试过且没有坏源时才回到上一个（网络抖动值得再试一次）
      const url = urls.find((u) => !poisoned.has(u) && u !== usedUrl) || urls.find((u) => !poisoned.has(u));
      if (!url) break;
      attempts += 1;
      usedUrl = url;
      this.state = { ...this.state, attempts };
      try {
        // 换源 = 换字节，.part 不能续（拼起来的包 hash 必然不对）
        fs.rmSync(`${dest}.part`, { force: true });
        this.log('info', `开始下载 ${info.version}（第 ${attempts}/${MAX_DOWNLOAD_ATTEMPTS} 次）：${url}`);
        await downloadFile({
          url,
          dest,
          transport: this.transport,
          expectedSize: info.fileSize,
          onProgress: (progress) => this.reportProgress(progress, info.fileSize),
        });

        // ① 字节数：下载层已经用响应头挡过一次，这里核对落盘结果
        const size = fs.statSync(dest).size;
        if (info.fileSize > 0 && size !== info.fileSize) {
          fs.rmSync(dest, { force: true });
          poisoned.add(url);
          throw new Error(`包大小不符（期望 ${info.fileSize}，实际 ${size}）`);
        }

        // ② SHA256：证明「下到的字节就是发布的那份」
        const actual = await sha256File(dest);
        if (actual !== info.hash) {
          fs.rmSync(dest, { force: true });
          poisoned.add(url);
          throw new Error(`SHA256 校验失败（期望 ${short(info.hash)}，实际 ${short(actual)}）——这个源上的不是这一版`);
        }

        // ③ 包内版本：证明「这份字节属于这个版本」（hash 只能证明没被换，不能证明记录写对了）
        const packaged = readPackageVersion(dest);
        if (packaged && packaged !== info.version) {
          fs.rmSync(dest, { force: true });
          poisoned.add(url);
          throw new Error(`包内版本是 ${packaged}，不是清单说的 ${info.version}`);
        }
        if (!packaged && this.log) {
          this.log('info', `包内版本读不出来（${path.basename(dest)}）：按 SHA256 判定`);
        }

        this.state = {
          ...this.state,
          phase: 'ready',
          filePath: dest,
          attempts,
          progress: { received: info.fileSize, total: info.fileSize, percent: 100 },
          error: null,
        };
        this.emit();
        this.log('info', `下载完成并通过三重校验（大小 / SHA256 / 包内版本）：${dest}`);
        return this.snapshot();
      } catch (error) {
        lastError = error;
        this.log('warn', `下载失败（第 ${attempts} 次，${url}）：${error.message}`);
      }
    }

    // 停手就把半截文件清掉：.part 可能有 150MB，用户不会再续（下次是新的两次尝试）
    fs.rmSync(dest, { force: true });
    fs.rmSync(`${dest}.part`, { force: true });
    this.giveUp(lastError?.message || '下载失败', attempts);
    return this.snapshot();
  }

  /**
   * 停手：不再重试，交给用户手动更新。
   * 文案与「网盘兜底」由界面负责，这里只保证 **phase=error + kind=give-up + 失败次数** 是准的。
   */
  giveUp(message, attempts) {
    this.state = {
      ...this.state,
      phase: 'error',
      attempts,
      error: { kind: 'give-up', message, attempts },
      progress: null,
    };
    this.emit();
    this.log('warn', `下载已放弃（共 ${attempts} 次）：${message}`);
  }

  failDownload(kind, message) {
    this.state = {
      ...this.state,
      phase: 'error',
      error: { kind, message },
      progress: null,
    };
    this.emit();
  }

  reportProgress(progress, totalBytes) {
    const total = progress.total || totalBytes || 0;
    const percent = total > 0 ? Math.min(100, Math.floor((progress.received / total) * 100)) : 0;
    const now = Date.now();
    const done = total > 0 && progress.received >= total;
    if (!done && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    this.state = {
      ...this.state,
      progress: { received: progress.received, total, percent },
    };
    this.emit();
  }

  /** 已下载完成的文件路径（没有返回空串）。 */
  downloadedFile() {
    const file = this.state.filePath;
    if (!file) return '';
    try {
      return fs.statSync(file).isFile() ? file : '';
    } catch {
      return '';
    }
  }
}

/** 按扩展名判断包形态：安装版给 exe，绿色版给 zip。 */
export function packageTypeOf(fileName) {
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.exe')) return 'installer';
  if (name.endsWith('.zip')) return 'portable';
  return 'unknown';
}

function pruneOldPackages(dir, keepName) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === keepName || entry === `${keepName}.part`) continue;
      if (/\.(exe|zip|msi|bin)$/i.test(entry)) fs.rmSync(path.join(dir, entry), { force: true });
    }
  } catch {
    /* 清理失败不影响下载 */
  }
}

function short(hash) {
  return `${String(hash).slice(0, 12)}…`;
}

/** 日志里只留主机名：完整地址太长，也不好在一行里看。 */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url);
  }
}
