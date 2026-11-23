'use strict';
/**
 * core/logs.js —— 日志文件的落点、追加与读取
 * 功能：日志文件就那么几个，**都住在数据目录里**：
 * `app.log`       —— 应用日志。⚠️ 它**不是本模块写的**：`cmd/main` 把进程 stdout
 * @author zx
 * @date   2026-09-28
 * @since 0.9.7
 * 相关：docs/公共/架构文档/01-架构总览.md、docs/公共/架构文档/18-ai辅助任务.md
 */

const fs = require('node:fs');
const path = require('node:path');

/** 应用日志的文件名（由 `cmd/main` 的 stdout 重定向产出，本模块只读） @type {string} */
const APP_LOG = 'app.log';

/** AI 使用记录的文件名前缀 @type {string} */
const AI_LOG_PREFIX = 'ai-';

/** 读尾部时一次最多抓多少字节（够放几百行；再往前翻不在本期范围内） @type {number} */
const TAIL_BYTES = 256 * 1024;

/** 一次最多回多少行（界面一次也看不完，给大只会让响应变慢） @type {number} */
const TAIL_LINES_MAX = 1000;

/** 读尾部时默认回多少行 @type {number} */
const TAIL_LINES_DEFAULT = 200;

/**
 * 功能：算出**日志目录** —— 就是数据目录（`app.log` 也住在那里，见文件头）。
 *
 * 说明：⭐ 判据取 `store.info().dbFile` 的所在目录 —— 这样**测试里会自动落到临时目录**
 * （每个用例 `new Store(tmpDir)`），绝不会写进真实数据目录去。
 * 拿不到时兜底 `TRIM_PKGVAR`（`cmd/main` 把 stdout 重定向成 `${TRIM_PKGVAR}/app.log`，
 */
function dirOfStore(store) {
  if (typeof store._logDir === 'string') return store._logDir;
  let dir = '';
  try {
    const f = store.info().dbFile || '';
    if (f) dir = path.dirname(f);
  } catch (_e) {
    dir = '';
  }
  if (!dir) dir = process.env.TRIM_PKGVAR || '';
  store._logDir = dir;
  return dir;
}

/**
 * 功能：算某个账号的 AI 记录文件名。
 * @param {(number|string)} uid - 账号 id
 * @returns {string} 形如 `ai-3.log`
 */
function aiLogName(uid) {
  return `${AI_LOG_PREFIX}${Number(uid)}.log`;
}

/**
 * 功能：这个文件名是不是我们认的日志文件（⭐ 读取接口的第一道闸门）。
 *
 * 说明：⚠️⭐ **白名单，不是黑名单** —— 只放行两种形状：`app.log` 与 `ai-<正整数>.log`。
 * 其余一律不认（`../zxdesk.db`、`ai-x.log`、`ai-1.log.bak` 都进不来）。
 *
 */
function isKnownLog(name) {
  const s = String(name == null ? '' : name);
  if (s === APP_LOG) return true;
  return /^ai-\d+\.log$/.test(s);
}

/**
 * 功能：把日志文件名解析成磁盘路径，并再夹一道目录边界。
 * @param {string} dir - 日志目录
 * @param {string} name - 文件名（须先过 `isKnownLog`）
 * @returns {?string} 绝对路径；名字不认或算出界时 null
 */
function logPath(dir, name) {
  if (!isKnownLog(name)) return null;
  const p = path.join(dir, String(name));
  // 第二道闸门：文件名里不可能有分隔符（上面白名单已挡），这里再核一次目录，
  if (path.dirname(p) !== path.normalize(dir)) return null;
  return p;
}

/**
 * 功能：往某个日志文件**追加一行**（文件不存在就建）。
 *
 * 说明：⚠️ 失败**静默**（吞掉异常）—— 写日志挂掉绝不能把用户的操作带崩
 * （磁盘满 / 权限不对时，该成功的那次请求仍然要成功）。
 * 行数算不准。
 */
function appendLine(dir, name, line) {
  const p = logPath(dir, name);
  if (!p) return;
  try {
    fs.appendFileSync(p, String(line).replace(/[\r\n]+/g, ' ') + '\n', 'utf8');
  } catch (_e) {
    /* 见上：日志写不进去不是把主流程带崩的理由 */
  }
}

/**
 * 功能：读某个日志文件的**尾部若干行**。
 *
 * 说明：⭐ 实现是「定位到末尾 256KB 再往里读」而不是「读完整个文件」——
 * 日志文件的常态是越滚越大，整个读进来会卡住事件循环。
 * 从中间开始读时，**第一行可能是半行**（正好切在中间）⇒ 丢掉它，
 */
function readTail(dir, name, lines) {
  const p = logPath(dir, name);
  if (!p) return null;
  const n = Number.isInteger(lines) && lines > 0 ? Math.min(lines, TAIL_LINES_MAX) : TAIL_LINES_DEFAULT;

  let st;
  try {
    st = fs.statSync(p);
  } catch (_e) {
    // 文件还没生出来**不是错误**：应用刚装好、AI 一次都没用过时，`ai-*.log` 本来就不存在。
    return { name: String(name), text: '', lines: 0, truncated: false, missing: true };
  }

  const size = Number(st.size) || 0;
  const take = Math.min(size, TAIL_BYTES);
  const start = Math.max(0, size - TAIL_BYTES);
  let chunk = '';
  if (take > 0) {
    const buf = Buffer.alloc(take);
    const fd = fs.openSync(p, 'r');
    try {
      fs.readSync(fd, buf, 0, take, start);
    } finally {
      fs.closeSync(fd);
    }
    chunk = buf.toString('utf8');
    if (start > 0) {
      const i = chunk.indexOf('\n');
      chunk = i < 0 ? '' : chunk.slice(i + 1);
    }
  }

  const all = chunk.split('\n').filter((x) => x !== '');
  const tail = all.slice(-n);
  return {
    name: String(name),
    text: tail.join('\n'),
    lines: tail.length,
    truncated: all.length > tail.length || start > 0,
    missing: false,
  };
}

/**
 * 功能：列出目录里的日志文件（名字 / 大小 / 修改时间），**最新的在前**。
 * @param {string} dir - 日志目录
 * @returns {Array.<{name: string, size: number, mtime: number}>} 清单（读不到目录时返回空数组）
 */
function listLogs(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => isKnownLog(f))
      .map((f) => {
        let st = null;
        try {
          st = fs.statSync(path.join(dir, f));
        } catch (_e) {
          /* 刚还在、这会儿读不到：按 0 处理，别让整个清单挂掉 */
        }
        return { name: f, size: st ? Number(st.size) || 0 : 0, mtime: st ? Math.round(st.mtimeMs) : 0 };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (_e) {
    // 目录读不到（还没建 / 权限不对）⇒ 空清单，不是错误
    return [];
  }
}

/**
 * 功能：删掉某个账号的 AI 记录文件（**删账号时调它**）。
 *
 * 说明：⚠️⭐ 这一条是**隐私要求**，不是打扫卫生：`ai-<uid>.log` 里是「这个账号的 AI
 * 动过哪些工具」。账号都删了、这份痕迹却留在磁盘上，等于数据没删干净
 * （与 `userScopedTablesIn()` 那条「删账号跟着清哪些表」是同一条规矩的文件版）。
 */
function removeAiLog(dir, uid) {
  const p = logPath(dir, aiLogName(uid));
  if (!p) return;
  try {
    fs.rmSync(p, { force: true });
  } catch (_e) {
    /* 见上 */
  }
}

module.exports = {
  APP_LOG,
  AI_LOG_PREFIX,
  TAIL_BYTES,
  TAIL_LINES_MAX,
  TAIL_LINES_DEFAULT,
  aiLogName,
  dirOfStore,
  isKnownLog,
  logPath,
  appendLine,
  readTail,
  listLogs,
  removeAiLog,
};
