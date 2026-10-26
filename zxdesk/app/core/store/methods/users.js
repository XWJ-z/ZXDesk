'use strict';
/**
 * core/store/methods/users.js —— 账号 / 会话 / 全局设置（0.2.0，审查报告 B2）
 *
 * 功能：Store 的账号与会话业务方法。账号计数用 `countUsers` / `countAdmins` /
 *      `countUserData`；账号查询与增删用 `createUser` / `findUserByName` / `listUsers` /
 *      `getUser` / `deleteUser`；权限、口令与名字维护用 `setAdminFlag` / `setPassword` /
 *      `setPasswordHash` / `setUsername` / `touchLastLogin`；`setHideTimetable` / `setHideBookmarks` /
 *      `setHideHardware` 写「不显示课表 / 收藏夹 / 硬件管理」这三条个人偏好；
 *      `setHideDigital`（0.8.10）是它的继任者 —— 硬件改名「数码管理」后的开关列；
 *      `sessionEpoch` 读会话世代，`getSetting` / `setSetting` 读写全局键值设置。
 *
 * ⭐ 这里的方法**一律不出现 `this.backend`**：凡是要分后端的地方都走
 *    `this._bk.<op>(...)`（存储原语层门面，见 store/backend/index.js）。
 *
 * ⚠️ 方法体是从改造前的 `db.js` 按字节切出来的（分岔那段搬去了 backend/*.js）。
 *
 * @author zx
 * @date   2026-09-11
 * @since 0.8.21
 * 相关：docs/公共/架构文档/02-存储层与数据模型.md
 */
const { nowStamp, sanitizeUser } = require('../helpers.js');

module.exports = {
  /**
   * 功能：统计账号总数 —— 判断「库里是否已有账号」，用于决定登录页显示「登录」还是「首次注册」。
   * @returns {number} 账号总数
   */
  countUsers() {
    return this._bk.countUsers();
  },

  /**
   * 功能：统计管理员账号数 —— 启动时用来判断「要不要补一个内置管理员」。
   *
   * 说明：这是「**永不把人锁在门外**」的最后一道保障：只要库里一个管理员都没有
   *      （全新安装，或历史上只注册过成员账号），启动时就会补出内置管理员
   *      （见 `server.js` 的 `ensureBuiltinAdmin()`）。
   *
   * @returns {number} `is_admin=1` 的账号数
   */
  countAdmins() {
    return this._bk.countAdmins();
  },

  /**
   * 功能：统计某个账号名下的业务数据条数（项目 / 项目任务 / 日常任务）。
   *
   * 说明：⭐ 只为**离线运维工具**（`cmd/reset-admin --list`）而存在，用来回答
   *      「我的老数据到底挂在哪个账号下」—— 单用户时代的数据一律是 `user_id=1`，
   *      所以 `countUserData(1)` 不为零的那个账号就是「能看到老数据的人」。
   *      ⚠️ **绝不可**把它接进管理接口（`/api/admin/users`）：需求 2 的红线是
   *      「管理员也看不到成员的数据」，「有几条任务」已经是统计泄露（见 AGENTS.md §六 决策表）。
   *      这里能用是因为调用方是**只能在 NAS 上以 root/应用用户身份执行**的命令行 ——
   *      有那个权限的人本来就能直接读库。
   *
   * @param {number} uid - 账号 id
   * @returns {{ projects: number, projectTasks: number, dailyTasks: number }} 三类数据的条数
   */
  countUserData(uid) {
    const u = Number(uid);
    return this._bk.countUserData(u);
  },

  /**
   * 功能：设置或取消某个账号的管理员标记，并顺带刷新 `updated_at`。
   *
   * 说明：⚠️ 刻意**不碰 `session_epoch`**：改的是权限而不是口令，把正在用的人踢下线没有道理 ——
   *      被提升的人下一次请求就能看到「成员管理」入口，不需要重新登录。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} isAdmin - true 设为管理员，false 取消管理员
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setAdminFlag(uid, isAdmin) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setAdminFlag(uid, isAdmin, stamp);
  },

  /**
   * 功能：设置「这个账号不显示课表」这条**个人偏好**（0.2.1），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 为什么是「每账号一条」而不是全局设置：课表不是所有人用得上（不是学生就没有），
   *      而本应用的数据是**每个账号完全独立**的 —— 管理员一刀切会把用得上的人一起关掉。
   *      偏好存在 `users` 行上（见 `schema/core.js` 的 `hide_timetable`），删账号时随之消失。
   *      ⚠️ 与 `setPassword` 不同，这里**不动 `session_epoch`**：改个显示开关不该把人踢下线。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现课表入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideTimetable(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideTimetable(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示网址收藏夹」这条**个人偏好**（0.3.0），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideTimetable` 是**同一条决策的第二个实例**：
   *      收藏夹也不是所有人用得上（不收藏网址的人嫌它占侧栏一位），而本应用的数据本来就是
   *      每账号完全独立的 —— 所以它同样存在 `users` 行上（见 `schema/core.js` 的 `hide_bookmarks`）、
   *      删账号时随行消失、且**不动 `session_epoch`**（显示开关不该把人踢下线）。
   *      ⚠️ 两个偏好**各改各的列**：关课表不会顺手关掉收藏夹（有测试钉着）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现收藏夹入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideBookmarks(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideBookmarks(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示 NAS硬件管理」这条**个人偏好**（0.3.1），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideTimetable` / `setHideBookmarks` 是**同一条决策的第三个实例**：
   *      台账不是所有人用得上（没有 NAS 的人、只用别人的机器的人），而本应用的数据本来就是
   *      每账号完全独立的 —— 所以它同样存在 `users` 行上（见 `schema/core.js` 的 `hide_hardware`）、
   *      删账号时随行消失、且**不动 `session_epoch`**（显示开关不该把人踢下线）。
   *      ⭐ 「也要像课表一样可以在设置中关闭这个功能」。
   *      ⚠️ 三个偏好**各改各的列**：关课表不会顺手关掉收藏夹或硬件管理（有测试钉着）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现硬件管理入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideHardware(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideHardware(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示数码管理」这条**个人偏好**（0.8.10），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 它就是 `setHideHardware` 的**继任者**：模块 `hardware` 改名 `digital`（界面叫「数码管理」），
   *      开关列随之换成 `hide_digital`。⚠️ 老列 `hide_hardware` **保留、语义退役**
   *      （照 `hide_calendar` 的先例）：删列会碰用户数据，而它留着完全无害。
   *      ⚠️ **不自动迁移老偏好**：改写用户数据要单独拍板，
   *      而一个界面开关重勾一次的成本远小于「悄悄替他改了什么」。
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现数码管理入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideDigital(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideDigital(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示密码库」这条**个人偏好**（0.3.2），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideTimetable` / `setHideBookmarks` / `setHideHardware` 是**同一条决策的第四个实例**
   *      ：密码库不是所有人用得上（不把密码交给任何软件的人、只用浏览器自带
   *      密码管理器的人），而本应用的数据本来就是每账号完全独立的 —— 所以它同样存在 `users` 行上
   *      （见 `schema/core.js` 的 `hide_vault`）、删账号时随行消失、且**不动 `session_epoch`**。
   *      ⭐ 「也要像课表一样可以在设置中关闭这个功能」。
   *      ⚠️ 关掉的是**入口**，不是密码库：`vault_meta` / `vault_items` 一行都不动，
   *      重新打开立刻回来 —— 这一点对密码库尤其要紧（用户会怕「关一下把密码删了」）。
   *      ⚠️ 四个偏好**各改各的列**：关课表不会顺手关掉收藏夹 / 硬件 / 密码库（有测试钉着）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现密码库入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideVault(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideVault(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示对话」这条**个人偏好**（0.3.5），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideTimetable` / `setHideBookmarks` / `setHideHardware` / `setHideVault`
   *      是**同一条决策的第五个实例**：不是每个人都需要在工作台上聊天，
   *      而本应用的数据本来就是每账号完全独立的 —— 所以它同样存在 `users` 行上
   *      （见 `schema/core.js` 的 `hide_teamwork`）、删账号时随行消失、且**不动 `session_epoch`**。
   *      ⭐ 「也要像课表一样可以在设置中关闭这个功能」。
   *      ⚠️ 关掉的是**入口**，不是对话：好友关系、会话与消息一行都不动，重新打开立刻回来。
   *      这一点对对话尤其要紧 —— **对面的人不知道你关掉了它**，消息照收、照存在你的 NAS 上，
   *      所以「关掉」绝不能变成「拒收」。
   *      ⚠️ 五个偏好**各改各的列**：关课表不会顺手关掉收藏夹 / 硬件 / 密码库 / 对话（有测试钉着）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现对话入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideTeamwork(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideTeamwork(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示 AI 辅助任务」这条**个人偏好**（0.6.0），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideTeamwork` 等**同一条决策的第六个实例**：
   *      存在 `users` 行上（`schema/core.js` 的 `hide_ai`）、删账号随行消失、**不动 `session_epoch`**。
   *      ⚠️ 关掉的是**入口与插槽**，不是数据：`ai_*` 三张表一行不动，重新打开立刻回来。
   *      ⚠️ 六个偏好**各改各的列**：关 AI 不会顺手关掉对话 / 密码库等（有测试钉着）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现 AI 辅助任务的入口与插槽
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideAi(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideAi(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示灵感库」这条**个人偏好**（0.7.1），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideAi` 等**同一条决策的第七个实例**：
   *      存在 `users` 行上（`schema/core.js` 的 `hide_idea`）、删账号随行消失、**不动 `session_epoch`**。
   *      ⚠️ 关掉的是**入口**，不是数据：`idea_items` 一行不动，重新打开立刻回来。
   *      ⚠️ 七个偏好**各改各的列**：关灵感库不会顺手关掉别的（有测试钉着）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现灵感库入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideIdea(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideIdea(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示番茄钟」这条**个人偏好**（0.7.5），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideIdea` 等**同一条决策的第八个实例**：
   *      存在 `users` 行上（`schema/core.js` 的 `hide_pomodoro`）、删账号随行消失、**不动 `session_epoch`**。
   *      ⚠️ 关掉的是**入口**，不是数据：`time_pomodoro_sessions` 一行不动，重新打开立刻回来
   *      （正在计时的那个番茄也不会因为关掉入口就被丢弃）。
   *      ⚠️ 别把它与番茄钟**自己的时长偏好**混起来：四个时长住 `time_pomodoro_prefs`
   *      —— 这一列只管「要不要在界面上看见它」。
   *      ⚠️ 八个偏好**各改各的列**：关番茄钟不会顺手关掉别的（有测试钉着）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现番茄钟入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHidePomodoro(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHidePomodoro(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示日历」这条**个人偏好**（0.7.5），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHidePomodoro` 等**同一条决策的第九个实例**：
   *      存在 `users` 行上（`schema/core.js` 的 `hide_calendar`）、删账号随行消失、**不动 `session_epoch`**。
   *      ⚠️ 关掉的是**入口**，不是数据：`calendar_events` 一行不动，重新打开立刻回来。
   *      ⚠️ 别把它与日历**自己的图层开关**混起来：那三个（课表 / 任务 / 假期）住 `calendar_prefs`
   *      —— 这一列只管「要不要在界面上看见日历」。
   *      ⚠️ 九个偏好**各改各的列**：关日历不会顺手关掉别的（有测试钉着）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现日历入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideCalendar(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideCalendar(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示记账」这条**个人偏好**（0.8.0），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideCalendar` 等**同一条决策的第十个实例**：
   *      存在 `users` 行上（`schema/core.js` 的 `hide_ledger`）、删账号随行消失、**不动 `session_epoch`**。
   *      ⚠️ 关掉的是**入口**，不是数据：`ledger_accounts` / `ledger_snapshots` 一行不动，
   *      重新打开立刻回来 —— 钱数一条都不会变。
   *      ⚠️ 十个偏好**各改各的列**：关记账不会顺手关掉别的（有测试钉着）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现记账入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideLedger(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideLedger(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示行程」这条**个人偏好**（0.8.6），并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideLedger` 等**同一条决策的第十一个实例**：
   *      存在 `users` 行上（`schema/core.js` 的 `hide_trip`）、删账号随行消失、**不动 `session_epoch`**。
   *      ⚠️ 关掉的是**入口**，不是数据：`time_trips` / `time_trip_tickets` / `time_trip_points` 一行不动，
   *      重新打开立刻回来 —— 车票与轨迹是**已经发生过的事实凭证**。
   *      ⚠️ 十一个偏好**各改各的列**：关行程不会顺手关掉别的（有测试钉着）。
   *      ⚠️ 它**不是**行程的「三档提醒开关」：那三档住模块自己的表 `time_trip_prefs`（同一条 铁律 11）。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示该账号界面不再出现行程入口
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setHideTrip(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideTrip(uid, !!hide, stamp);
  },

  /**
   * 功能：设置**记账里那颗眼睛的初值**（`true` = 进记账就把金额糊成圆点），并返回是否更新到了行。
   *
   * ⭐ 0.8.21（「隐藏要具有记忆功能：我隐藏了，下次进入还是隐藏状态。并且手机端
   *      和电脑端同步」）：与上面那几个 `setHide*` **存在同一处**（`users` 行，`schema/core.js` 的
   *      `hide_ledger_amount`）、删账号随行消失、**不动 `session_epoch`**（点一下眼睛不该把人踢下线）。
   *
   * 说明：⚠️⭐ 它与那十一项**语义不同**（虽然共用 `PUT /api/auth/prefs` 这条通道）：
   *      那十一项是「关掉某个功能」，这一项是「金额默认糊不糊」—— 用户当场仍能点眼睛看回来
   *      （那一次只改内存 `state.lgHide`，不落库）。⚠️ 各改各的列，它不许连累上面那十一列。
   *      ⚠️ 为什么必须落库而不是 localStorage：「手机端和电脑端同步」——
   *      localStorage 只活在这一台设备的一个浏览器里，换端 / 换浏览器就丢了。
   *
   * @param {number} uid - 账号 id
   * @param {boolean} hide - true 表示进记账时先把金额糊成圆点
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   * @since 0.8.21
   */
  setHideLedgerAmount(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideLedgerAmount(uid, !!hide, stamp);
  },

  /**
   * 功能：写入**电脑端侧栏**里模块入口的顺序（0.8.5 导航排序），返回是否真的更新到了一行。
   *
   * 说明：⭐ 与上面十个 `hide_*` 同属「每账号各管各的界面偏好」：删账号随行消失、
   *      **不动 `session_epoch`**（拖个顺序把人踢下线毫无道理）。
   *      ⚠️ 存的是**模块名**（逗号分隔，如 `teamwork,timetable`），不是下标 —— 理由见
   *      `schema/core.js` 建表语句里那一段（删模块目录时存名字最坏只丢一项）。
   *      ⚠️ `null` 与空串**语义不同**，这里**原样落库、不解释**：
   *      `null` = 「恢复默认顺序」（前端按清单 `order` 排），空串 = 「用户排了个空的」。
   *      校验（是不是数组、项多长）在 HTTP 层做，这里只管写。
   *
   * @param {number} uid - 账号 id
   * @param {?string} value - 逗号分隔的模块名；`null` 表示恢复默认的顺序
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setNavOrder(uid, value) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setNavOrder(uid, value == null ? null : String(value), stamp);
  },

  /**
   * 功能：写入**手机端底部标签栏**放哪几个模块（0.8.5 导航排序），返回是否真的更新到了一行。
   *
   * 说明：⚠️ 与 `setNavOrder` 是同一条规矩的第二个实例，唯一区别是**它约束更紧**：
   *      只有「有底部标签能力」的模块能进来，而且**最多两个**（底栏固定 6 颗 ——
   *      今天 / 任务板 / 两个模块 / 更多 / 设置）。
   *      ⚠️ 数量与白名单的判据**不在这里**、也不在 HTTP 层，而是在前端（`core/modules.js`）：
   *      那是「界面长什么样」的事，服务端只需要保证「存进去的是合理长度的字符串」。
   *
   * @param {number} uid - 账号 id
   * @param {?string} value - 逗号分隔的模块名（顺序即标签顺序）；`null` 表示恢复默认
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setNavTabs(uid, value) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setNavTabs(uid, value == null ? null : String(value), stamp);
  },

  /**
   * 功能：改写某个账号的**登录名**（0.2.1）—— 「本人改自己」与「管理员改成员」都走这一个方法。
   *
   * 说明：⭐ 为什么单开一个方法、而不是把 `username` 加进 `allowedCols`：`users` 表**刻意不走通用
   *      `_update()`**（见 `schema/core.js` 的 `allowedCols`）—— 账号的每一列都有自己的语义，
   *      交给通用更新等于绕过它们。改名与改口令相反：**不递增 `session_epoch`**，
   *      不踢任何人下线（登录名不参与会话校验，Cookie 里是 `uid` + `session_epoch`）；
   *      但改完**旧名字立刻登不上**，这正是「改登录名」的意义所在。
   *
   * ⚠️ 唯一性在这里显式比对（不依赖 SQLite 的唯一索引）：JSON 后端没有约束，两边行为必须一致 ——
   *    与 `createUser` 同一个理由。⚠️ 改成自己原来的名字**不算冲突**（幂等成功），
   *    否则「什么都没改就点保存」会莫名其妙报「用户名已存在」。
   * ⚠️ 新名的长度与字符集**由调用方先校验**（`validateUsername`），这里只管唯一性 ——
   *    放这里会让 HTTP 层拿不到那句可以直接展示的文案，也会让离线工具复用时缺少统一的校验口。
   *
   * @param {number} uid - 账号 id
   * @param {string} username - 新的登录名
   * @returns {?Object} 更新后的脱敏账号元信息（`sanitizeUser` 的结果）；账号不存在时为 null
   * @throws {Error} 新名已被**别的**账号占用时抛 409；新名为空抛 400；数据层只读时抛 503
   */
  setUsername(uid, username) {
    this._assertWritable();
    const u = Number(uid);
    const name = String(username == null ? '' : username).trim();
    if (!name) {
      const err = new Error('用户名不能为空');
      err.status = 400;
      throw err;
    }
    const exist = this.findUserByName(name);
    if (exist && Number(exist.id) !== u) {
      const err = new Error('用户名已存在');
      err.status = 409;
      throw err;
    }
    const stamp = nowStamp();
    if (!this._bk.setUsername(u, name, stamp)) return null;
    return this.getUser(u);
  },

  /**
   * 功能：新建账号，并把脱敏后的账号元信息返回给调用方。
   *
   * 说明：用户名唯一 —— 这里**显式查重**（不依赖 SQLite 的唯一索引）：
   *      JSON 后端没有约束，两边行为必须一致，否则「同一个用户名在两种后端下的表现不同」。
   *
   * @param {{ username: string, passwordHash: string, displayName: string, isAdmin: boolean }} input - 新账号字段
   * @returns {Object} 脱敏后的账号元信息（`sanitizeUser` 的结果，不含口令散列）
   * @throws {Error} 用户名为空抛 400、用户名已存在抛 409；数据层只读时抛 503
   */
  createUser(input) {
    this._assertWritable();
    const username = String(input.username || '').trim();
    if (!username) {
      const err = new Error('用户名不能为空');
      err.status = 400;
      throw err;
    }
    if (this.findUserByName(username)) {
      const err = new Error('用户名已存在');
      err.status = 409;
      throw err;
    }
    const stamp = nowStamp();
    const created = this._insert('users', {
      username,
      display_name: input.displayName || '',
      password_hash: input.passwordHash,
      is_admin: input.isAdmin ? 1 : 0,
      session_epoch: 0,
      hide_timetable: 0,
      hide_bookmarks: 0,
      hide_hardware: 0,
      hide_vault: 0,
      hide_teamwork: 0,
      vault_lock_minutes: 10,
      last_login_at: null,
      created_at: stamp,
      updated_at: stamp,
    });
    return sanitizeUser(created);
  },

  /**
   * 功能：按登录名取账号记录 —— **含 `password_hash`**。
   *
   * 说明：仅供 `auth.js` 校验口令用。⚠️ 不要把它的返回值直接返回给前端
   *      （要对外一律用 `sanitizeUser`）。
   *
   * @param {string} username - 登录名，比较前会去掉首尾空白
   * @returns {?Object} 账号原始行；名字为空或查不到时为 null
   */
  findUserByName(username) {
    const name = String(username == null ? '' : username).trim();
    if (!name) return null;
    return this._bk.findUserByName(username, name);
  },

  /**
   * 功能：按 id 取账号的**原始行**（⭐ **含 `password_hash`**）—— 与 `findUserByName` 同一个性质。
   *
   * 说明：供「离线运维」与启动期兜底判断口令可用性使用（`context.js` 的 `ensureBuiltinAdmin()`、
   *      `reset-admin.js`）。⚠️ 不要把它的返回值直接返回给前端 —— 对外一律用 `getUser` / `listUsers`
   *      （两者都过 `sanitizeUser`）。
   *
   * @param {number} uid - 账号 id
   * @returns {?Object} 账号原始行；账号不存在时为 null
   */
  findUserById(uid) {
    return this._bk.getUserRows(Number(uid)) || null;
  },

  /**
   * 功能：列出全部账号的**元信息**（无口令哈希、无任务数据、**无个人偏好**），供管理面板显示成员列表。
   *
   * 说明：⭐ 这里刻意把 `hide_timetable` / `hide_bookmarks` / `hide_hardware` / `hide_vault` / `hide_teamwork`
   *      （账号本人的显示偏好）与 `vault_lock_minutes`（本人的自动锁定偏好）剔掉 ——
   *      管理账号用不到它们，而「管理员看不到成员的数据」是需求红线：用不到的字段就不给，
   *      免得哪天它变成一条身份标签（「这个人开了密码库」本身就是一条隐私）。
   *      `ttt/test/admin.test.js` 与 `ttt/test/isolation.test.js`
   *      的成员列表断言正是钉这件事，**别为了让新字段过去而放宽那条测试**
   *      （加了新偏好就**在这几行里加一行 delete**，而不是把断言改宽）。
   *
   * @returns {Array.<Object>} 脱敏后的账号元信息数组，按 id 升序
   */
  listUsers() {
    const rows = this._bk.listUsersRows();
    return rows.map((u) => {
      const v = sanitizeUser(u);
      delete v.hide_timetable;
      delete v.hide_bookmarks;
      delete v.hide_hardware;
      delete v.hide_digital; // ⭐ 0.8.10：数码管理同款（模块改名后换的那一列）
      delete v.hide_vault;
      delete v.hide_teamwork;
      delete v.hide_ai; // ⭐ 0.6.0：新偏好同款 —— 加了偏好就在这里加一行 delete（见方法头说明）
      delete v.hide_idea; // ⭐ 0.7.1：灵感库同款
      delete v.hide_pomodoro; // ⭐ 0.7.5：番茄钟同款
      delete v.hide_calendar; // ⭐ 0.7.5：日历同款
      delete v.hide_ledger; // ⭐ 0.8.0：记账同款
      delete v.hide_trip; // ⭐ 0.8.6：行程同款
      delete v.hide_ledger_amount; // ⭐ 0.8.21：记账的眼睛初值同款（「这个人把金额藏起来了」也是偏好）
      // ⭐ 0.8.5 导航排序两列同款：它们是**账号本人的界面偏好**，管理员用不到，
      //    而「管理员看不到成员的数据」是需求红线 —— 用不到的字段就不给
      //    （「这个人把收藏夹拖到了第一位」同样是一条不该外泄的偏好）。
      delete v.nav_order;
      delete v.nav_tabs;
      delete v.vault_lock_minutes;
      return v;
    });
  },

  /**
   * 功能：按 id 取账号的**元信息**（无口令哈希）。
   *
   * 说明：会话校验用 —— 令牌里的 `session_epoch` 与库里的对得上才认。
   *
   * @param {number} uid - 账号 id
   * @returns {?Object} 脱敏后的账号元信息；账号不存在时为 null
   */
  getUser(uid) {
    const u = this._bk.getUserRows(uid);
    return u ? sanitizeUser(u) : null;
  },

  /**
   * 功能：读某账号的会话世代（`session_epoch`），Cookie 校验时用来判断令牌是否已作废。
   * @param {number} uid - 账号 id
   * @returns {?number} 会话世代；账号不存在时为 null
   */
  sessionEpoch(uid) {
    const u = this._bk.sessionEpochRows(uid);
    if (!u) return null;
    return Number(u.session_epoch || 0);
  },

  /**
   * 功能：改密码（「重置成员密码」与「改我自己的密码」都走这里），并把 `session_epoch + 1`。
   *
   * 说明：⭐ 换代是必须的：Cookie 是无状态签名，**不换代就踢不掉人** ——
   *      否则「重置了密码，对方的旧会话照样能用」，重置形同虚设。
   *
   * @param {number} uid - 账号 id
   * @param {string} passwordHash - 新的 scrypt 口令散列
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setPassword(uid, passwordHash) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setPassword(uid, passwordHash, stamp);
  },

  /**
   * 功能：**只**换口令散列，不动 `session_epoch`。
   *
   * 说明：用途是登录成功时发现散列用的是过时的成本参数，就地重算升级
   *      （见 auth.js 的 `needsRehash`）。这与「改密码」是两回事 —— 后者必须踢掉旧会话
   *      （`setPassword`），而这里明文没变，把用户其他设备一并踢下线属于无端副作用。
   *
   * @param {number} uid - 账号 id
   * @param {string} passwordHash - 重算后的口令散列
   * @returns {boolean} 是否真的更新到了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setPasswordHash(uid, passwordHash) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setPasswordHash(uid, passwordHash, stamp);
  },

  /**
   * 功能：记一次登录时间（只写 `last_login_at`，顺带刷新 `updated_at`）。
   *
   * 说明：只是个时间戳，**只读降级时直接跳过** —— 不值得为此让登录失败。
   *
   * @param {number} uid - 账号 id
   * @returns {void}
   */
  touchLastLogin(uid) {
    if (this.readOnly) return;
    const stamp = nowStamp();
    return this._bk.touchLastLogin(uid, stamp);
  },

  /**
   * 功能：删除账号**并连同其全部数据**（已批准的策略：账号走人，数据一起走）。
   *
   * 说明：⚠️ 调用方必须已确认「不是管理员自己」—— 本层不做这个判断。
   *
   * @param {number} uid - 账号 id
   * @returns {boolean} 是否真的删掉了一行（账号不存在时为 false）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  deleteUser(uid) {
    this._assertWritable();
    const u = Number(uid);
    return this._bk.deleteUser(u);
  },

  /**
   * 功能：读一个全局设置的值（原始字符串）。
   * @param {string} key - 设置键名，例如 `allow_self_register`
   * @returns {?string} 设置值；键不存在时为 null
   */
  getSetting(key) {
    return this._bk.getSetting(key);
  },

  /**
   * 功能：写入或覆盖一个全局设置，值一律按字符串保存。
   * @param {string} key - 设置键名
   * @param {(string|number|boolean)} value - 设置值，落库前会被转成字符串
   * @returns {boolean} 恒为 true（表示已写入）
   * @throws {Error} 数据层只读时抛出（由 HTTP 层收口成 503）
   */
  setSetting(key, value) {
    this._assertWritable();
    return this._bk.setSetting(key, value);
  },
};
