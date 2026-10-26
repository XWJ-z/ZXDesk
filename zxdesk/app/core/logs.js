'use strict';
/**
 * core/logs.js —— 日志文件的落点、追加与读取（0.8.5）
 *
 * 功能：日志文件就那么几个，**都住在数据目录里**：
 *        · `app.log`       —— 应用日志。⚠️ 它**不是本模块写的**：`cmd/main` 把进程 stdout
 *                             重定向成了它（`LOG_FILE="${TRIM_PKGVAR}/app.log"`），
 *                             而 `${TRIM_PKGVAR}` 正是数据目录 ⇒ 服务端这边只**读**它。
 *        · `ai-<uid>.log`  —— **AI 使用记录**，每账号一个文件，由本模块追加。
 *      本模块给出：文件名判据、路径解析、追加一行、读尾部若干行、列清单。
 *
 * ⚠️⭐ 为什么 AI 记录要落文件、而不是继续留在内存里：
 *      原来它住在 Store 实例上（每账号环形 `AUDIT_MAX` 条、**重启即清**）——
 *      用户想问「AI 上周拿我的数据干了什么」时，答案永远是「不知道，重启过了」。
 *      落成 `ai-<uid>.log` 之后：单文件可查、重启不怕、管理员也能拿去排查。
 *      ⚠️ 红线一个字没变：**只记动作，不记内容**。每行是一条 JSON，键只有
 *      `at` / `tool` / `args` / `ok` / `reason` 五个 —— 调用方多传的**在结构上进不来**
 *      （与 `modules/ai/store.js` 的 `aiAppendAudit` 同一条口径）。
 *
 * ⚠️ 读文件一律**只读尾部**：日志会长到几十 MB，整个 `readFileSync` 进来会把事件循环卡住
 *      （本项目对「同步 IO 阻塞首屏」有明确教训，见 `core/static.js` 里那段说明）。
 *
 * ⚠️ 边界：本模块**只认白名单文件名**（`isKnownLog`）。`file` 参数是从界面上来的字串，
 *      ⛔ 绝不允许它带 `/`、`\`、`..` —— 那就是目录穿越。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.5
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
 *      （每个用例 `new Store(tmpDir)`），绝不会写进真实数据目录去。
 *      ⚠️ 拿不到时兜底 `TRIM_PKGVAR`（`cmd/main` 把 stdout 重定向成 `${TRIM_PKGVAR}/app.log`，
 *      用的就是它）；两个都没有（本不该发生）⇒ 返回空串，调用方**不写**：
 *      宁可没有日志，也⛔ 不能落到进程 cwd 里去。
 *      ⚠️ 结果缓存在实例上：`info()` 每次都要 stat 库文件，而写记录是热路径。
 *
 * @param {Object} store - Store 实例
 * @returns {string} 目录绝对路径；判不出来时为空串
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
 *      其余一律不认（`../zxdesk.db`、`ai-x.log`、`ai-1.log.bak` 都进不来）。
 *
 * @param {string} name - 文件名（不含目录）
 * @returns {boolean} 认得为 true
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
  // ⚠️ 第二道闸门：文件名里不可能有分隔符（上面白名单已挡），这里再核一次目录，
  //    双保险的代价是一次字符串比较 —— 穿越这类事不值得省。
  if (path.dirname(p) !== path.normalize(dir)) return null;
  return p;
}

/**
 * 功能：往某个日志文件**追加一行**（文件不存在就建）。
 *
 * 说明：⚠️ 失败**静默**（吞掉异常）—— 写日志挂掉绝不能把用户的操作带崩
 *      （磁盘满 / 权限不对时，该成功的那次请求仍然要成功）。
 *      ⚠️ 行内的换行会被压成空格：一行就是一行，多出来的换行会让「尾部 N 行」的
 *      行数算不准。
 *
 * @param {string} dir - 日志目录
 * @param {string} name - 文件名（须先过 `isKnownLog`）
 * @param {string} line - 一行的内容
 * @returns {void}
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
 *      日志文件的常态是越滚越大，整个读进来会卡住事件循环。
 *      ⚠️ 从中间开始读时，**第一行可能是半行**（正好切在中间）⇒ 丢掉它，
 *      否则界面上会出现一条看起来像乱码的记录。
 *
 * @param {string} dir - 日志目录
 * @param {string} name - 文件名（须先过 `isKnownLog`）
 * @param {number} [lines] - 要回多少行（缺省 200，上限 1000）
 * @returns {?{name: string, text: string, lines: number, truncated: boolean, missing: boolean}} 结果；文件名不认时 null
 */
function readTail(dir, name, lines) {
  const p = logPath(dir, name);
  if (!p) return null;
  const n = Number.isInteger(lines) && lines > 0 ? Math.min(lines, TAIL_LINES_MAX) : TAIL_LINES_DEFAULT;

  let st;
  try {
    st = fs.statSync(p);
  } catch (_e) {
    // ⚠️ 文件还没生出来**不是错误**：应用刚装好、AI 一次都没用过时，`ai-*.log` 本来就不存在。
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
 *      动过哪些工具」。账号都删了、这份痕迹却留在磁盘上，等于数据没删干净
 *      （与 `userScopedTablesIn()` 那条「删账号跟着清哪些表」是同一条规矩的文件版）。
 *      ⚠️ 失败同样静默：删不掉一个日志文件不该让「删账号」整个失败。
 *
 * @param {string} dir - 日志目录
 * @param {(number|string)} uid - 账号 id
 * @returns {void}
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
