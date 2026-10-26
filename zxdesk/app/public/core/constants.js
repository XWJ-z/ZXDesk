/**
 * core/constants.js —— 两端共用常量（象限 / 状态 / 项目配色）
 *
 * 功能：电脑版与手机版共用的三张常量表：新建项目时轮流取用的配色 `COLORS`、
 *      任务状态码到中文文案的映射 `STATUS`、四象限定义 `QUADS`。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.52
 * 相关：docs/公共/架构文档/07-前端-电脑版与手机版.md
 */

/** 新建项目时按顺序轮流取用的品牌配色（不够用时循环复用） */
export const COLORS = ['#3b82f6', '#8b5cf6', '#ef4444', '#f59e0b', '#10b981', '#ec4899', '#14b8a6', '#64748b'];

/**
 * 打卡（周期）任务的**专属配色** —— 甘特图里每个打卡任务按顺序分到其中一色，循环复用。
 *
 * 说明：⭐ 「每个打卡任务循环分配独有颜色，这些普通任务和窗口任务不能使用」。
 *      ⇒ 与 `COLORS` **刻意没有交集**（逐个 hex 比过）—— 普通任务 / 窗口任务只取 `COLORS`，
 *      所以永远不会画出打卡用的这几种颜色。
 *      ⚠️ 颜色只是「这是哪个打卡任务」的标识：**打过卡之后仍然是这一色，只变暗**（见
 *      `desktop/app.css` 的 `.tl-taskbar.tl-seg.ok`）—— ⛔ 别把已打卡改回绿色，那样同一个
 *      打卡任务的颜色会在一周之内变掉两次。
 * @type {Array.<string>}
 */
export const CYCLE_COLORS = ['#0ea5e9', '#22c55e', '#f43f5e', '#a855f7', '#eab308', '#f97316'];

/** 任务状态码 → 中文文案（`todo` 待办 / `doing` 进行中 / `done` 已完成 / `paused` 已搁置） */
export const STATUS = { todo: '待办', doing: '进行中', done: '已完成', paused: '已搁置' };

/**
 * 资产分组名字的**显示宽度**上限（格；一个汉字算 2）—— 与后端 `validate.js` 的
 * `ASSET_NAME_UNITS` **必须同一个数**（改了这里也要改那边）。
 *
 * 说明：⭐ 0.8.10：「新建分组的名称限制：字体最多 5 个汉字或 10 个字母」。
 *      ⚠️⭐ **一个汉字算 2 格** ⇒ 「5 个汉字」与「10 个字母」**一样宽 = 10 格**，
 *      所以这个常量是 **10**，⛔ 不是 20（首版写成 20 是把「5 个汉字」当成了 5 格，
 *      结果能打 10 个汉字 —— 装机后一眼看出来「还是太长」）。
 *      ⚠️ 前端这份只是**当场挡住白敲**（弹层 `oninput` 按 `widthOf()` 裁剪）；
 *      绕得过去，硬校验住服务端（`checkAssetGroup()`）。
 */
export const ASSET_NAME_UNITS = 10;

/**
 * 功能：四象限定义表 —— 电脑版与手机版共用同一份数据。
 *
 * ZXDesk 两端共用的常量 —— **唯一出处**（0.2.0，审查报告 A1）。
 *
 * ⚠️ 以前 `QUADS` / `COLORS` / `STATUS` 在 `desktop/app.js` 与 `mobile/app.js` 里各抄一份，
 *    「四象限的颜色/文案要一致」这件事只靠人记得改两处 —— 这正是 A1 要根除的东西。
 *
 * `QUADS` 是**两端的超集**：电脑版读 `key`/`label`/`sub`，手机版读 `k`/`label`/`short`。
 * 只增属性、不改值，所以两端既有行为逐字不变（`ttt/test/frontend-modules.test.js` 钉住这一点）。
 */
export const QUADS = [
  { key: 'Q1', k: 'q1', label: '重要且紧急', sub: '立即处理', short: '重要紧急', imp: 1, urg: 1, color: '#ef4444' },
  { key: 'Q2', k: 'q2', label: '重要不紧急', sub: '规划安排', short: '重要不急', imp: 1, urg: 0, color: '#3b82f6' },
  { key: 'Q3', k: 'q3', label: '紧急不重要', sub: '快速处理', short: '紧急不急', imp: 0, urg: 1, color: '#f59e0b' },
  { key: 'Q4', k: 'q4', label: '不重要不紧急', sub: '有空再做', short: '都不', imp: 0, urg: 0, color: '#10b981' },
];
