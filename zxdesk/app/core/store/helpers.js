'use strict';
/**
 * core/store/helpers.js —— 与后端无关的小工具
 * 功能：store 层唯一的纯函数工具箱，两个后端、业务方法与 `server.js` 都从这里取。
 * `today()` / `nowStamp()` / `compactStamp()` 产出本地时间字符串，`addDays()` 做日期偏移；
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
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
 * 是真实存在的作息，用 `Number(v) || 5` 会把它静默改成 5 —— 而界面上完全看不出来。
 *
 */
function numOr(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 功能：取一行数据的归属用户 id —— 缺失 `user_id` 时按 1（首个账号）处理。
 *
 * **可能根本没有 `user_id` 字段**，直接比较会判为「不属于任何人」→
 * （见 AGENTS.md §六「启动与迁移绝不改写用户数据」的同源教训：宁可兼容，不可表现为丢数据）。
 * 故缺失一律按 1（首个账号）处理。
 */
function uidOf(row) {
  const v = row && row.user_id;
  return v === undefined || v === null ? 1 : Number(v);
}

/**
 * 功能：输出账号的对外安全视图（⭐ **剔除 `password_hash`**），只保留账号元信息字段。
 *
 * 说明：管理面板、导出、`/api/auth/me` **一律**走这里 —— 避免某个接口「顺手把整行返回」而泄露口令哈希。
 * 返回的就是需求 2 允许管理员看到的全部内容：**账号元信息，不含任何任务数据与统计**。
 *
 */
function sanitizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    is_admin: u.is_admin ? 1 : 0,
    // 关掉 NAS硬件管理、关掉密码库、关掉对话。
    // JSON 回退后端与老库里可能没这几列，一律按「不关闭」处理 ——
    // 缺列的表现必须是「照常显示入口」，不能是「整块功能凭空消失」。
    hide_timetable: u.hide_timetable ? 1 : 0,
    hide_bookmarks: u.hide_bookmarks ? 1 : 0,
    hide_hardware: u.hide_hardware ? 1 : 0,
    // 开关列换成 `hide_digital`；⚠️ 老列 `hide_hardware` 在上面**保留、语义退役**
    // （照 `hide_calendar` 的先例）—— 老库那一列还在、还是 1/0，只是没有界面再写它。
    hide_digital: u.hide_digital ? 1 : 0,
    hide_vault: u.hide_vault ? 1 : 0,
    hide_teamwork: u.hide_teamwork ? 1 : 0,
    // 它是设置页开关与插槽显隐的共同判据，缺列绝不能让功能凭空消失。
    hide_ai: u.hide_ai ? 1 : 0,
    hide_idea: u.hide_idea ? 1 : 0,
    hide_pomodoro: u.hide_pomodoro ? 1 : 0,
    // 它是设置页开关与侧边栏显隐的共同判据，缺列绝不能让功能凭空消失。
    hide_calendar: u.hide_calendar ? 1 : 0,
    // 它是设置页开关与侧边栏显隐的共同判据，缺列绝不能让功能凭空消失。
    hide_ledger: u.hide_ledger ? 1 : 0,
    // 它是设置页开关与侧边栏 / 更多页显隐的共同判据，缺列绝不能让功能凭空消失。
    hide_trip: u.hide_trip ? 1 : 0,
    // zx 实验室的显示开关：同上，缺列按「显示入口」处理 ——
    // 它是设置页开关与侧栏 / 更多页显隐的共同判据，缺列绝不能让这一屏凭空消失。
    // 与其它 `hide_*` 的一处不同：它关掉的是**整个沙箱的入口**（里面的实验功能没有各自的开关）。
    hide_lab: u.hide_lab ? 1 : 0,
    // 记账里那颗眼睛的**初值**（1 = 进来就把金额糊成圆点）。
    // 它不是「关掉某个功能」那十一个开关之一 —— 缺列按 0（不隐藏）处理，
    // 表现必须是「照常显示金额」，⛔ 绝不能是「金额全糊着、用户不知道为什么」。
    hide_ledger_amount: u.hide_ledger_amount ? 1 : 0,
    // 这个账号**是否已同意「zx 实验室使用须知」**（首次进入要弹知情协议、勾选过才能点同意）。
    // 与上面那批 `hide_*` 不同：那不是开关，而是「读过并同意了」这件事本身 ——
    // 缺失 / 旧库补列一律按 **0（还没同意）** 处理：宁可多问一次，也不能默认替用户答应。
    lab_agreed: u.lab_agreed ? 1 : 0,
    // 写在 `schema/core.js` 的建表语句里。⚠️ 这里**原样透出、一个字都不解析**：
    // `null` = 从没排过（老库补列 / 新账号） ⇒ 前端按清单 `order` 走默认；
    // `''`  = 用户明确清空了（只可能出现在 `nav_tabs` 上）。
    nav_order: u.nav_order == null ? null : String(u.nav_order),
    nav_tabs: u.nav_tabs == null ? null : String(u.nav_tabs),
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
 * 以 `\u0001` 连接成一个可直接比较的字符串。
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
 * 真正插入的那一刻再取出父项刚回填的 `id`（父项先插、`id` 当场回填）。
 *
 * 说明：⭐ 让「重新编号 + 重指外键」**在一个事务里**完成：若改成「先插父项、拿到 id 再插子项」，
 * 就成了两次独立的写，中间失败会留下一堆没有子项的孤儿项目。
 */
function deref(v) {
  if (v && typeof v === 'object' && v.__ref && typeof v.__ref === 'object') return v.__ref.id;
  return v;
}

/**
 * 功能：构造一个「资源不存在」的 404 错误（越权与不存在**统一走它**，互相看不出区别）。
 *
 * 四份实现此前逐字相同。 是「不存在」的唯一出口，403 才是「知道但不给」。
 *
 * @param {string} what - 中文资源名（进错误文案，便于日志排查）
 */
function notFoundErr(what) {
  const e = new Error(`${what}不存在`);
  e.status = 404;
  return e;
}

/**
 * 功能：构造一个「入参 / 状态不合法」的 400 错误（文案会直接展示给用户，必须说人话）。
 *
 * 它们的本地名有 `badRequest` 与 `bad` 两种，实现逐字相同，现统一叫 `badRequest`。
 *
 * @param {string} message - 中文说明
 */
function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/**
 * 功能：把搜索串按空白切词 —— **多词 AND** 检索的第一步。
 *
 * 「整个查询串当成一个子串」是本项目修过的一条语义缺陷（搜「嵌入式 sqlite」会去找连在一起的
 * 9 个字符，基本必然 0 命中，而界面毫无提示）；切成词之后，每个词都必须在某一处出现才算命中。
 * 全部小写化 —— 检索大小写不敏感；中文两字词天然可用（子串匹配，不做分词）。
 */
function splitTerms(q) {
  return String(q == null ? '' : q)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 功能：判断一个值是不是**「去空白后为空」** —— 密码库 / 加密信息的「空判据」唯一实现。
 *
 * ⇒ 「只敲一个空格」能一路存进密码库，列表里看着是一条正常记录、用的时候复制出一个空串
 * （实测：`{"password":" "}` → 201）。
 * **命中范围刻意包含三种「看不见的字符」**：全角空格（`\u3000`，中文输入法最容易带进来）、
 * `storage.js → store/index.js → modules/*` 的加载链上；`validate.js` 反过来 require
 */
function isBlankPassword(v) {
  return /^[\s\u200B\uFEFF]*$/.test(String(v == null ? '' : v));
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
  // 密码库 / 加密信息的「空判据」（`validate.js` 转出同一个函数）
  isBlankPassword,
};
