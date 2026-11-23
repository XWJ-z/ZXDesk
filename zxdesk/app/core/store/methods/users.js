'use strict';
/**
 * core/store/methods/users.js —— 账号 / 会话 / 全局设置
 * 功能：Store 的账号与会话业务方法。账号计数用 `countUsers` / `countAdmins` /
 * `countUserData`；账号查询与增删用 `createUser` / `findUserByName` / `listUsers` /
 * @author zx
 * @date   2026-09-11
 * @since 0.9.7
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
   * （全新安装，或历史上只注册过成员账号），启动时就会补出内置管理员
   * （见 `server.js` 的 `ensureBuiltinAdmin()`）。
   */
  countAdmins() {
    return this._bk.countAdmins();
  },

  /**
   * 功能：统计某个账号名下的业务数据条数（项目 / 项目任务 / 日常任务）。
   *
   * 说明：⭐ 只为**离线运维工具**（`cmd/reset-admin --list`）而存在，用来回答
   * 「我的老数据到底挂在哪个账号下」—— 单用户时代的数据一律是 `user_id=1`，
   * 所以 `countUserData(1)` 不为零的那个账号就是「能看到老数据的人」。
   */
  countUserData(uid) {
    const u = Number(uid);
    return this._bk.countUserData(u);
  },

  /**
   * 功能：设置或取消某个账号的管理员标记，并顺带刷新 `updated_at`。
   *
   * 说明：⚠️ 刻意**不碰 `session_epoch`**：改的是权限而不是口令，把正在用的人踢下线没有道理 ——
   * 被提升的人下一次请求就能看到「成员管理」入口，不需要重新登录。
   *
   */
  setAdminFlag(uid, isAdmin) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setAdminFlag(uid, isAdmin, stamp);
  },

  /**
   *
   * 说明：⭐ 为什么是「每账号一条」而不是全局设置：课表不是所有人用得上（不是学生就没有），
   */
  setHideTimetable(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideTimetable(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHideTimetable` 是**同一条决策的第二个实例**：
   */
  setHideBookmarks(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideBookmarks(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHideTimetable` / `setHideBookmarks` 是**同一条决策的第三个实例**：
   */
  setHideHardware(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideHardware(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 它就是 `setHideHardware` 的**继任者**：模块 `hardware` 改名 `digital`（界面叫「数码管理」），
   */
  setHideDigital(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideDigital(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHideTimetable` / `setHideBookmarks` / `setHideHardware` 是**同一条决策的第四个实例**
   */
  setHideVault(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideVault(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHideTimetable` / `setHideBookmarks` / `setHideHardware` / `setHideVault`
   */
  setHideTeamwork(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideTeamwork(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHideTeamwork` 等**同一条决策的第六个实例**：
   */
  setHideAi(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideAi(uid, !!hide, stamp);
  },

  /**
   * 功能：设置「这个账号不显示 zx 实验室」这条**个人偏好**，并返回是否真的更新到了一行。
   *
   * 说明：⭐ 与 `setHideIdea` 等**同一条决策的第十三个实例**：
   * 存在 `users` 行上（`schema/core.js` 的 `hide_lab`）、删账号随行消失、**不动 `session_epoch`**。
   * 关掉的是**入口**，不是数据：实验室库（`zxdesk-lab.db`）里的实验数据一条不动，
   */
  setHideLab(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideLab(uid, !!hide, stamp);
  },

  /**
   * 功能：记下「这个账号已同意 zx 实验室使用须知」，并返回是否真的更新到了一行。
   *
   * 说明：⭐ 首次进实验室要弹知情协议、勾选才能点同意，且**按账号记在服务端**
   * ⇒ 一个账号只问一次，换设备 / 换浏览器 / 重装都不再问。
   * 与 `setHideLab` 同一条规矩：只改 `users.lab_agreed` 这一列、不碰 `session_epoch`、
   */
  setLabAgreed(uid, agreed) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setLabAgreed(uid, !!agreed, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHideAi` 等**同一条决策的第七个实例**：
   */
  setHideIdea(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideIdea(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHideIdea` 等**同一条决策的第八个实例**：
   */
  setHidePomodoro(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHidePomodoro(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHidePomodoro` 等**同一条决策的第九个实例**：
   */
  setHideCalendar(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideCalendar(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHideCalendar` 等**同一条决策的第十个实例**：
   */
  setHideLedger(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideLedger(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与 `setHideLedger` 等**同一条决策的第十一个实例**：
   */
  setHideTrip(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideTrip(uid, !!hide, stamp);
  },

  /**
   * 功能：设置**记账里那颗眼睛的初值**（`true` = 进记账就把金额糊成圆点），并返回是否更新到了行。
   *
   * （「隐藏要具有记忆功能：我隐藏了，下次进入还是隐藏状态。并且手机端
   * 和电脑端同步」）：与上面那几个 `setHide*` **存在同一处**（`users` 行，`schema/core.js` 的
   * `hide_ledger_amount`）、删账号随行消失、**不动 `session_epoch`**（点一下眼睛不该把人踢下线）。
   */
  setHideLedgerAmount(uid, hide) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setHideLedgerAmount(uid, !!hide, stamp);
  },

  /**
   *
   * 说明：⭐ 与上面十个 `hide_*` 同属「每账号各管各的界面偏好」：删账号随行消失、
   */
  setNavOrder(uid, value) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setNavOrder(uid, value == null ? null : String(value), stamp);
  },

  /**
   *
   * 说明：⚠️ 与 `setNavOrder` 是同一条规矩的第二个实例，唯一区别是**它约束更紧**：
   */
  setNavTabs(uid, value) {
    this._assertWritable();
    const stamp = nowStamp();
    return this._bk.setNavTabs(uid, value == null ? null : String(value), stamp);
  },

  /**
   *
   * 说明：⭐ 为什么单开一个方法、而不是把 `username` 加进 `allowedCols`：`users` 表**刻意不走通用
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
   *
   * @param {{ username: string, passwordHash: string, displayName: string, isAdmin: boolean }} input - 新账号字段
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
   * （要对外一律用 `sanitizeUser`）。
   *
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
   * `reset-admin.js`）。⚠️ 不要把它的返回值直接返回给前端 —— 对外一律用 `getUser` / `listUsers`
   * （两者都过 `sanitizeUser`）。
   */
  findUserById(uid) {
    return this._bk.getUserRows(Number(uid)) || null;
  },

  /**
   * 功能：列出全部账号的**元信息**（无口令哈希、无任务数据、**无个人偏好**），供管理面板显示成员列表。
   *
   * 说明：⭐ 这里刻意把 `hide_timetable` / `hide_bookmarks` / `hide_hardware` / `hide_vault` / `hide_teamwork`
   * （账号本人的显示偏好）与 `vault_lock_minutes`（本人的自动锁定偏好）剔掉 ——
   * 管理账号用不到它们，而「管理员看不到成员的数据」是需求红线：用不到的字段就不给，
   */
  listUsers() {
    const rows = this._bk.listUsersRows();
    return rows.map((u) => {
      const v = sanitizeUser(u);
      delete v.hide_timetable;
      delete v.hide_bookmarks;
      delete v.hide_hardware;
      delete v.hide_digital; // 数码管理同款（模块改名后换的那一列）
      delete v.hide_vault;
      delete v.hide_teamwork;
      delete v.hide_ai; // 新偏好同款 —— 加了偏好就在这里加一行 delete（见方法头说明）
      delete v.hide_idea; // 灵感库同款
      delete v.hide_pomodoro; // 番茄钟同款
      delete v.hide_calendar; // 日历同款
      delete v.hide_ledger; // 记账同款
      delete v.hide_trip; // 行程同款
      delete v.hide_lab; // zx 实验室同款（同一条红线：用不到的偏好就不给）
      delete v.lab_agreed; // 第 3 轮：是否同意过实验室须知（同一条红线 —— 「这个人进过实验室」也是偏好）
      delete v.hide_ledger_amount; // 记账的眼睛初值同款（「这个人把金额藏起来了」也是偏好）
      // 导航排序两列同款：它们是**账号本人的界面偏好**，管理员用不到，
      // 而「管理员看不到成员的数据」是需求红线 —— 用不到的字段就不给
      // （「这个人把收藏夹拖到了第一位」同样是一条不该外泄的偏好）。
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
   *
   * @param {number} uid - 账号 id
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
   * （见 auth.js 的 `needsRehash`）。这与「改密码」是两回事 —— 后者必须踢掉旧会话
   * （`setPassword`），而这里明文没变，把用户其他设备一并踢下线属于无端副作用。
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
