'use strict';
/**
 * core/store/helpers.js —— 与后端无关的小工具（0.2.0，审查报告 B2 从 db.js 原样搬来）
 *
 * 功能：store 层唯一的纯函数工具箱，两个后端、业务方法与 `server.js` 都从这里取。
 *      `today()` / `nowStamp()` / `compactStamp()` 产出本地时间字符串，`addDays()` 做日期偏移；
 *      `clampRange()` 兜底任务日与截止日；`numOr()` 做不吃 `0` 的数值兜底；
 *      `uidOf()` 取行的归属用户（兼容缺字段的老 JSON 数据）；`sanitizeUser()` 输出不含口令的账号视图；
 *      `sessionSig()` 生成课次去重签名。
 *      ⭐ 0.5.1 起还收了三类**跨模块各抄一份**的小工具：`notFoundErr()` / `badRequest()`（store 层的
 *      「越权与不存在统一 404」「说人话的 400」错误构造器）与 `splitTerms()`（多词 AND 检索的切词）——
 *      它们此前在 4~2 个模块的 `store.js` 里逐字重复。
 *
 * 这里只有**纯函数**：没有 `this`、不碰 `this.db` / `this.data`。
 * 所以两个后端、业务方法、乃至 `server.js` 都能放心 require 它们。
 *
 * ⚠️ 函数体是从改造前的 `db.js` 按字节切出来的。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.21
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */

/**
 * 功能：取本地时区的今天，格式化为 `YYYY-MM-DD`。
 * 说明：与 FN 系统一致，避免 UTC 差 8 小时。
 * @returns {string} 本地日期字符串 `YYYY-MM-DD`
 */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 功能：取本地当前时刻，格式化为 `YYYY-MM-DD HH:mm:ss`（秒级）。
 * @returns {string} 本地时间字符串
 */
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 功能：取本地当前时刻，格式化为文件名友好的紧凑时间戳 `YYYYMMDD-HHmmss`。
 * 说明：给备份文件用，避免空格与冒号。
 * @returns {string} 紧凑时间戳字符串
 */
function compactStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 功能：把 `YYYY-MM-DD` 日期字符串加减 n 天，返回同格式的新字符串。
 * @param {string} dateStr - 起始日期，`YYYY-MM-DD`
 * @param {number} n - 天数偏移，可为负数
 * @returns {string} 偏移后的日期字符串 `YYYY-MM-DD`
 */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * 功能：日期区间兜底 —— 若「任务日 > 截止日期」，就把截止日期抬到任务日，保证任务日 ≤ 截止日期。
 * 说明：**就地修改传入的 row 并把它返回**，不是返回副本。
 * @param {Object} row - 含 `start_date` / `due_date` 的行对象
 * @returns {Object} 同一个行对象（已就地修正）
 */
function clampRange(row) {
  if (row.start_date && row.due_date && row.start_date > row.due_date) {
    row.due_date = row.start_date;
  }
  return row;
}

/**
 * 功能：把入参转成数值，仅在值缺失（undefined / null / 空串）或不是有限数时返回默认值。
 *
 * 说明：数值兜底中**`0` 是合法值**，不能被 `|| 默认值` 吃掉。课表里的「课间 0 分钟」（连着上、不休息）
 *      是真实存在的作息，用 `Number(v) || 5` 会把它静默改成 5 —— 而界面上完全看不出来。
 *
 * @param {*} v - 待转换的值
 * @param {number} dflt - 缺失或非法时返回的默认值
 * @returns {number} 转换结果或默认值
 */
function numOr(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 功能：取一行数据的归属用户 id —— 缺失 `user_id` 时按 1（首个账号）处理。
 *
 * 说明：⚠️ 不能直接写 `r.user_id === uid`：JSON 后端的历史数据（0.0.8 之前写的 zxdesk.json）
 *      **可能根本没有 `user_id` 字段**，直接比较会判为「不属于任何人」→
 *      用户升级后打开界面发现「任务全没了」—— 这正是本项目最忌讳的数据事故
 *      （见 AGENTS.md §六「启动与迁移绝不改写用户数据」的同源教训：宁可兼容，不可表现为丢数据）。
 *      故缺失一律按 1（首个账号）处理。
 *
 * @param {?Object} row - 数据行，可为 null / undefined
 * @returns {number} 归属用户 id；缺失时回退 1
 */
function uidOf(row) {
  const v = row && row.user_id;
  return v === undefined || v === null ? 1 : Number(v);
}

/**
 * 功能：输出账号的对外安全视图（⭐ **剔除 `password_hash`**），只保留账号元信息字段。
 *
 * 说明：管理面板、导出、`/api/auth/me` **一律**走这里 —— 避免某个接口「顺手把整行返回」而泄露口令哈希。
 *      返回的就是需求 2 允许管理员看到的全部内容：**账号元信息，不含任何任务数据与统计**。
 *
 * @param {?Object} u - 账号原始行
 * @returns {?Object} 仅含元信息的新对象；入参为空时返回 null
 */
function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    is_admin: u.is_admin ? 1 : 0,
    // ⭐ 个人偏好（0.2.1 / 0.3.0 / 0.3.1 / 0.3.2 / 0.3.5）：关掉课表、关掉网址收藏夹、
    //    关掉 NAS硬件管理、关掉密码库、关掉对话。
    //    JSON 回退后端与老库里可能没这几列，一律按「不关闭」处理 ——
    //    缺列的表现必须是「照常显示入口」，不能是「整块功能凭空消失」。
    hide_timetable: u.hide_timetable ? 1 : 0,
    hide_bookmarks: u.hide_bookmarks ? 1 : 0,
    hide_hardware: u.hide_hardware ? 1 : 0,
    // ⭐ 数码管理的显示开关（0.8.10）：模块 `hardware` 改名 `digital` 之后，
    //    开关列换成 `hide_digital`；⚠️ 老列 `hide_hardware` 在上面**保留、语义退役**
    //    （照 `hide_calendar` 的先例）—— 老库那一列还在、还是 1/0，只是没有界面再写它。
    hide_digital: u.hide_digital ? 1 : 0,
    hide_vault: u.hide_vault ? 1 : 0,
    hide_teamwork: u.hide_teamwork ? 1 : 0,
    // ⭐ AI 辅助任务的显示开关（0.6.0）：同上，缺列按「显示入口」处理 ——
    //    它是设置页开关与插槽显隐的共同判据，缺列绝不能让功能凭空消失。
    hide_ai: u.hide_ai ? 1 : 0,
    // ⭐ 灵感库的显示开关（0.7.1）：同上，缺列按「显示入口」处理。
    hide_idea: u.hide_idea ? 1 : 0,
    // ⭐ 番茄钟的显示开关（0.7.5）：同上，缺列按「显示入口」处理。
    hide_pomodoro: u.hide_pomodoro ? 1 : 0,
    // ⭐ 日历的显示开关（0.7.5）：同上，缺列按「显示入口」处理 ——
    //    它是设置页开关与侧边栏显隐的共同判据，缺列绝不能让功能凭空消失。
    hide_calendar: u.hide_calendar ? 1 : 0,
    // ⭐ 记账的显示开关（0.8.0）：同上，缺列按「显示入口」处理 ——
    //    它是设置页开关与侧边栏显隐的共同判据，缺列绝不能让功能凭空消失。
    hide_ledger: u.hide_ledger ? 1 : 0,
    // ⭐ 行程的显示开关（0.8.6， 第 5 处）：同上，缺列按「显示入口」处理 ——
    //    它是设置页开关与侧边栏 / 更多页显隐的共同判据，缺列绝不能让功能凭空消失。
    hide_trip: u.hide_trip ? 1 : 0,
    // ⭐ 0.8.21：记账里那颗眼睛的**初值**（1 = 进来就把金额糊成圆点）。
    //    ⚠️ 它不是「关掉某个功能」那十一个开关之一 —— 缺列按 0（不隐藏）处理，
    //    表现必须是「照常显示金额」，⛔ 绝不能是「金额全糊着、用户不知道为什么」。
    hide_ledger_amount: u.hide_ledger_amount ? 1 : 0,
    // ⭐ 0.8.5 导航排序（0.8.5）：两列的**语义与「NULL 与空串必须能区分」那条口径**
    //    写在 `schema/core.js` 的建表语句里。⚠️ 这里**原样透出、一个字都不解析**：
    //    · `null` = 从没排过（老库补列 / 新账号） ⇒ 前端按清单 `order` 走默认；
    //    · `''`  = 用户明确清空了（只可能出现在 `nav_tabs` 上）。
    //    解析成数组由前端 `core/modules.js` **一处**做（两端共用，⛔ 别在两端各写一份）。
    nav_order: u.nav_order == null ? null : String(u.nav_order),
    nav_tabs: u.nav_tabs == null ? null : String(u.nav_tabs),
    // ⭐ 密码库自动锁定分钟数（0.3.2）：缺列时兜 **10 分钟**（默认值），
    //    ⚠️ 绝不兜成 0/undefined —— 那会让「自动锁定」这个安全特性静默失效。
    vault_lock_minutes:
      Number.isInteger(Number(u.vault_lock_minutes)) && Number(u.vault_lock_minutes) >= 1
        ? Number(u.vault_lock_minutes)
        : 10,
    created_at: u.created_at,
    updated_at: u.updated_at,
    last_login_at: u.last_login_at,
  };
}

/**
 * 功能：生成课次的去重签名（导入「追加」策略用）—— 课程名 + 星期 + 起止节 + 周次 + 教室，
 *      以 `\u0001` 连接成一个可直接比较的字符串。
 * @param {string} courseName - 课程名
 * @param {Object} s - 课次对象，读取 `weekday` / `period_start` / `period_end` / `weeks` / `room`
 * @returns {string} 去重签名串
 */
function sessionSig(courseName, s) {
  return [courseName, s.weekday, s.period_start, s.period_end, s.weeks || '', s.room || ''].join('\u0001');
}

/**
 * 功能：取本地当前时刻，格式化为**给用户看的**备份文件名时间戳 `YYYY-MM-DD-HHmm`。
 *
 * 说明：与 `compactStamp()` 的差别只在可读性 —— 那个是内部快照用的紧凑格式（`20260912-153045`），
 *      这个是下载给用户的文件名（`2026-09-12-1530`）。别为了「统一」把两者合并：
 *      内部快照名跟着改，会让数据目录里的历史快照与人眼对不上。
 *
 * @returns {string} 文件名时间戳字符串
 */
function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 功能：把「延迟引用」解成真实值 —— 备份导入时，子项的外键先写成 `{ __ref: 父项行对象 }`，
 *      真正插入的那一刻再取出父项刚回填的 `id`（父项先插、`id` 当场回填）。
 *
 * 说明：⭐ 让「重新编号 + 重指外键」**在一个事务里**完成：若改成「先插父项、拿到 id 再插子项」，
 *      就成了两次独立的写，中间失败会留下一堆没有子项的孤儿项目。
 *
 * @param {*} v - 待解析的值
 * @returns {*} 延迟引用则返回父项的新 id，其余原样返回
 */
function deref(v) {
  if (v && typeof v === 'object' && v.__ref && typeof v.__ref === 'object') return v.__ref.id;
  return v;
}

/**
 * 功能：构造一个「资源不存在」的 404 错误（越权与不存在**统一走它**，互相看不出区别）。
 *
 * 说明：⭐ 0.5.1 起从 4 个模块的 `store.js`（bookmarks / teamwork / vault / hardware）收敛到这里 ——
 *      四份实现此前逐字相同。 是「不存在」的唯一出口，403 才是「知道但不给」。
 *
 * @param {string} what - 中文资源名（进错误文案，便于日志排查）
 * @returns {Error} 带 `status = 404` 的错误对象
 */
function notFoundErr(what) {
  const e = new Error(`${what}不存在`);
  e.status = 404;
  return e;
}

/**
 * 功能：构造一个「入参 / 状态不合法」的 400 错误（文案会直接展示给用户，必须说人话）。
 *
 * 说明：⭐ 0.5.1 起从各模块的 `store.js`（bookmarks / teamwork / vault / backup）收敛到这里 ——
 *      它们的本地名有 `badRequest` 与 `bad` 两种，实现逐字相同，现统一叫 `badRequest`。
 *
 * @param {string} message - 中文说明
 * @returns {Error} 带 `status = 400` 的错误对象
 */
function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/**
 * 功能：把搜索串按空白切词 —— **多词 AND** 检索的第一步。
 *
 * 说明：⭐ 0.5.1 起从 bookmarks / hardware 两个 `store.js` 收敛到这里（两份逐字相同）。
 *      「整个查询串当成一个子串」是本项目修过的一条语义缺陷（搜「嵌入式 sqlite」会去找连在一起的
 *      9 个字符，基本必然 0 命中，而界面毫无提示）；切成词之后，每个词都必须在某一处出现才算命中。
 *      ⚠️ 全部小写化 —— 检索大小写不敏感；中文两字词天然可用（子串匹配，不做分词）。
 *
 * @param {string} q - 原始查询串（可为 null / undefined）
 * @returns {Array.<string>} 小写化后的非空词数组；空查询返回空数组（= 不过滤）
 */
function splitTerms(q) {
  return String(q == null ? '' : q)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

module.exports = {
  today,
  nowStamp,
  compactStamp,
  fileStamp,
  addDays,
  clampRange,
  numOr,
  uidOf,
  sanitizeUser,
  sessionSig,
  deref,
  notFoundErr,
  badRequest,
  splitTerms,
};
