'use strict';

/**
 * modules/ledger/backend/sqlite.js —— 记账的**SQLite 版原语**
 *
 * 功能：本模块自己的存储原语（SQLite），与另一个后端**同名同参** ——
 *      「同名同参」由 `store/backend/index.js` 的 `assertOpsContract()` 在**加载时**比对，
 *      少一个 / 打错名 / 形参个数不一致 = 启动即抛。
 *
 * ⭐ **原子（算术 / 校验 / 排序）都不在这一层**：原语只回答「把这个账号的账户取回来 /
 *    把这一行改成什么样 / 今天那一行快照写上」。资产 / 负债 / 净值的算法在 `lib/money.js`、
 *    类型与侧在 `lib/kinds.js`、入参校验在 `routes.js` —— 两个后端因此**永远不会不一致**。
 *
 * ⚠️ ops 里的 `this` 是 **Store 实例**（门面用 `.apply(store, …)` 调用），所以照常访问
 *    `this.db` / `this._listSql()`。
 *    ⚠️ 原语之间**不许互相调用**：op 挂在 `ops` 表上、只能通过 `this._bk.xxx` 取到，
 *    直接写 `this.getLedgerAccount(...)` 是 `is not a function`（teamwork 模块踩过）。
 *
 * ⭐⭐ **0.8.1：本模块的表全部搬进了独立库**（`data/zxdesk-ledger.db`）——
 *    所以本文件里**一律不写 `this.db` / `this._listSql()`**，改用下面两个模块级函数：
 *    它们显式点名**记账库**那个连接。为什么不用 `this.db`：那个字段是「当前正在服务哪个库」
 *    的**临时值**（core 的门面在跑记账 op 时才会把它换成记账库），
 *    谁在门面之外读它就会打到主库上 —— 表现是「读不到数据 / 写进了另一个文件」，而且**不报错**。
 *    ⚠️ 写成**模块级函数**而不是 `ops` 上的 `_` 私有方法：`_` 开头的键**不进 `_bk` 门面的转发名单**
 *    （那份名单由 core 的 `assertOpsContract()` 给），写成方法会在真机上静默变成
 *    `... is not a function` —— 见 `docs/公共/架构文档/11-踩坑与说明.md` 第 42 条。
 *
 * ⚠️ 金额一律**整数分**（⛔ 原语层不做「元 ↔ 分」换算，那是 `lib/money.js` 的事）。
 *
 * @author zx
 * @date   2026-09-20
 * @since 0.9.5
 * 相关：docs/公共/架构文档/23-记账.md、docs/公共/架构文档/02-存储层与数据模型.md
 */

const { badRequest } = require('../../../core/store/helpers.js');
// ⭐ 0.8.1：预置的 22 行收支分类（唯一出处住 lib/，本文件只负责把它们灌进库）
//    ⚠️ `LEGACY_PRESET_NAMES` 只给「恢复内置分类」当识别旧名字的名单；`isOther` 是
//    「同侧『其它』」的唯一判据（⛔ 别在这里自己写 `name === '其它'` —— 双份判据必然漂移）。
const { CATEGORY_PRESETS, LEGACY_PRESET_NAMES, isOther } = require('../lib/categories.js');
// ⭐⭐ 0.8.2 三方导入：导入表的表名**只从注册表来**（⛔ 永不来自请求 / 文件名）。
//    ⚠️ 拿到表名还不够 —— 拼任何 SQL 之前一律再过一道 `assertIdent()`（第二道保险，见那个文件的说明）。
const { assertIdent } = require('../lib/import-sources.js');

/**
 * 功能：取**记账库的连接** —— 本模块所有原语只碰记账库的表（0.8.1 独立库）。
 *
 * 说明：⚠️ `store.ledgerDb` 为 `null`（记账库打不开 / 只读降级）时**回落 `store.db`**：
 *      这一层不负责报错，报错由 `_assertLedgerWritable()`（503，消息里说清哪个库、为什么）负责 ——
 *      门面在进任何记账 op 之前已经断言过一次，所以回落只服务于「门面之外的直接调用」（单测）。
 *
 * @param {Object} store - Store 实例
 * @returns {Object} `node:sqlite` 的库句柄（记账库那一个）
 */
function ldb(store) {
  return store.ledgerDb || store.db;
}

/**
 * 功能：在**记账库**上跑一条查询并返回行数组（core 的 `_listSql` 第三参可指定连接）。
 *
 * 说明：⭐ 与 `ldb()` 同一个理由：⛔ 不写 `this._listSql(sql, params)`（那会落到 `this.db` 上）。
 *
 * @param {Object} store - Store 实例
 * @param {string} sql - 查询语句
 * @param {Array.<*>} params - 绑定参数
 * @returns {Array.<Object>} 结果行数组
 */
function lsql(store, sql, params) {
  return store._listSql(sql, params, ldb(store));
}

/**
 * 改一个账户时**允许变的六列** —— ⚠️ `id` / `user_id` / `created_at` **一个都不许变**：
 * 前两者是身份与归属，第三个是审计。列名写死在这里（本表 `allowedCols` 刻意留空，见 `schema.js`）。
 * @type {Array.<string>}
 */
// ⚠️：分级与三个限额也在这份清单里（UPDATE 的 SET 子句是它拼的 ⇒ 少了哪列就写不进去，
//    而且**不报错**）；`tier` 与 `tail` / `note` 同属「空串落 null」那一类。
const ACCOUNT_COLS = ['kind', 'name', 'tail', 'note', 'opening_fen', 'sort_order', 'tier', 'limit_day_fen', 'limit_month_fen', 'limit_year_fen'];

/**
 * 功能：按给定顺序**整组重写** `sort_order`（0,1,2…）。
 *
 * 说明：⭐⭐ 三处排序（账户 / 分类胶囊 / 分组字段）共用这一个实现 —— 表名由**本文件的调用点写死**，
 *      ⛔ 不从接口层传（那等于把三张表的安全属性换成「任意表都能重排」，与 `allowedCols` 留空同源）。
 *      ⚠️ 只改「这个账号、且 id 在这个列表里」的行：列表外的行**保持原样**
 *      （前端漏传一个 id 时，那一行不该被静默归零、跑到最前面去）。
 *      ⚠️ 事务必须有：重排做到一半失败会留下一个**谁都没写过的**顺序，而且不报错。
 *      ⚠️⭐ 它是**模块级函数**而不是 `ops` 上的私有方法：`_` 开头的方法**不进 `_bk` 门面**的转发名单
 *      （那份名单由 core 的 `assertOpsContract()` 给），写成方法会在真机上静默变成
 *      `... is not a function`。
 *
 * @param {Object} db - `node:sqlite` 的库句柄（调用点传 `ldb(this)`）
 * @param {string} table - 表名（本文件内部调用点写死）
 * @param {number} uid - 用户 id
 * @param {Array.<number>} ids - 期望顺序（下标即新的 `sort_order`）
 * @param {number} stamp - 写入时间戳
 * @returns {number} 实际改到的行数
 */
function reorderRows(db, table, uid, ids, stamp) {
  const u = Number(uid);
  const list = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!list.length) return 0;
  let hit = 0;
  db.exec('BEGIN');
  try {
    const st = db.prepare(`UPDATE ${table} SET sort_order=?, updated_at=? WHERE id=? AND user_id=?`);
    list.forEach((id, i) => {
      hit += st.run(i, stamp, id, u).changes;
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return hit;
}

const ops = {
  // ---- 记账（0.8.0）----
  /**
   * 功能：取该账号的全部账户，按「组内 `sort_order` → id」升序。
   *
   * 说明：⚠️ 这里排的是**组内**顺序；**组与组之间的顺序**由 `lib/kinds.js` 的 `KINDS` 决定，
   *      在业务层（`store.js` 的 `ledgerAccounts`）拼装 —— 原语层不认识「九类的顺序」这件事。
   *      ⚠️ `sort_order` 兜 `COALESCE(…, 0)`：老 JSON 数据里可能是 NULL，
   *      而 SQLite 默认让 NULL 排最前 ⇒ 不兜一下两后端的顺序会不一致。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 账户行数组
   */
  listLedgerAccounts(uid) {
    return lsql(this,
      `SELECT * FROM ledger_accounts
        WHERE user_id=?
        ORDER BY COALESCE(sort_order, 0) ASC, id ASC`,
      [Number(uid)],
    );
  },

  /**
   * 功能：按 id + 归属取一个账户；不存在或不属于该账号都返回 null。
   *
   * 说明：⭐ 上层就靠这个 null 把「越权」与「不存在」合并成同一个 404——
   *      两种情况**必须逐字一致**，否则状态码本身就成了探测「别人有哪些 id」的通道。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 账户 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getLedgerAccount(uid, id) {
    return ldb(this).prepare('SELECT * FROM ledger_accounts WHERE id=? AND user_id=?').get(id, Number(uid)) || null;
  },

  /**
   * 功能：插入一个账户，返回新建的整行。
   *
   * 说明：⚠️ `id` 由库发号（调用方不给）；`user_id` 由本层强制写成入参那个账号 ——
   *      请求体里带来的任何 `user_id` 都流不进来。
   *      ⚠️ 空值统一写成 NULL（`tail` / `note` 都是可空的），别留空串 ——
   *      `''` 与 `NULL` 在库里是同一件事，让它们分家会在读侧造出两条不同的分支。
   *
   * @param {number} uid - 用户 id
   * @param {Object} values - `{kind, name, tail, note, opening_fen, sort_order, created_at, updated_at}`
   * @returns {Object} 新建的整行（含 `id`）
   */
  insertLedgerAccount(uid, values) {
    // ⚠️⭐⭐ INSERT 的列**手写**（不像 UPDATE 那样用 `ACCOUNT_COLS` 拼）⇒ 加列时**这里也要加**，
    //    否则「建账户时带的分级/限额」**静默丢掉**（测试当场抓过：传了 tier 读回是 ''）。
    const r = ldb(this)
      .prepare(
        `INSERT INTO ledger_accounts
           (user_id, kind, name, tail, note, opening_fen, sort_order,
            tier, limit_day_fen, limit_month_fen, limit_year_fen, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Number(uid),
        values.kind,
        values.name,
        values.tail || null,
        values.note || null,
        Number(values.opening_fen) || 0,
        Number(values.sort_order) || 0,
        values.tier || null,
        values.limit_day_fen == null ? null : Number(values.limit_day_fen),
        values.limit_month_fen == null ? null : Number(values.limit_month_fen),
        values.limit_year_fen == null ? null : Number(values.limit_year_fen),
        values.created_at,
        values.updated_at,
      );
    return ldb(this).prepare('SELECT * FROM ledger_accounts WHERE id=?').get(Number(r.lastInsertRowid)) || null;
  },

  /**
   * 功能：把一个账户的**六个可写列整行写一遍**（`updated_at` 一并刷新）。
   *
   * 说明：⚠️ **整行写、不是逐列 patch**：业务层先读现状、把 patch 合上去、再整行交到这里
   *      （`store.js` 的 `ledgerUpdateAccount`）—— 于是两个后端都不必各自拼一段 SET。
   *      `id` / `user_id` / `created_at` **一个都不进 SET**：它们是身份与审计。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 账户 id
   * @param {Object} values - 恰好六个键：`kind` / `name` / `tail` / `note` / `opening_fen` / `sort_order`
   * @param {number} stamp - 更新时间戳（epoch 毫秒）
   * @returns {boolean} 是否真的改到了一行（不属于本人 / 不存在时为 false）
   */
  updateLedgerAccount(uid, id, values, stamp) {
    const r = ldb(this)
      .prepare(
        `UPDATE ledger_accounts SET ${ACCOUNT_COLS.map((c) => `${c}=?`).join(', ')}, updated_at=?
          WHERE id=? AND user_id=?`,
      )
      .run(
        ...ACCOUNT_COLS.map((c) => (c === 'tail' || c === 'note' ? values[c] || null : values[c])),
        stamp,
        id,
        Number(uid),
      );
    return r.changes > 0;
  },

  /**
   * 功能：删掉一个账户（**硬删**）。
   *
   * 说明：⚠️ 上层**先取一次再删**（`deleteLedgerAccount`），所以这里不用管「不存在」的区分 ——
   *      但 `user_id=?` 这个条件照样要带：它是防止「拿别人的 id 来删」的最后一道。
   *      ⭐ **快照一张都不动**（方案 §三）：历史是「我当时有多少钱」，删账户不改写它。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 账户 id
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteLedgerAccount(uid, id) {
    const r = ldb(this).prepare('DELETE FROM ledger_accounts WHERE id=? AND user_id=?').run(id, Number(uid));
    return r.changes > 0;
  },

  /**
   * 功能：取该账号在**某一年**里的快照行，按日期升序。
   *
   * 说明：⭐ 年份用**字符串区间**取（`date >= 'YYYY-01-01' AND date <= 'YYYY-12-31'`）——
   *      `date` 是 `YYYY-MM-DD` 定长串，字典序即时间序，不必引日期库。
   *
   * @param {number} uid - 用户 id
   * @param {number|string} year - 四位年份
   * @returns {Array.<Object>} 该年的快照行数组
   */
  listLedgerSnapshots(uid, year) {
    const y = String(year);
    return lsql(this,
      'SELECT * FROM ledger_snapshots WHERE user_id=? AND date>=? AND date<=? ORDER BY date ASC, id ASC',
      [Number(uid), `${y}-01-01`, `${y}-12-31`],
    );
  },

  /**
   * 功能：该账号**有过快照的年份**，降序 —— 给走势图那颗年度下拉当选项。
   *
   * 说明：⭐ 选项**必须来自真实数据**：写死「今年 ± N 年」会让用户选到一整年空白的走势图，
   *      而他没法知道那不是 bug。没有快照时回空数组，由业务层补上「今年」。
   *      ⚠️ `date` 是 `YYYY-MM-DD` 定长串 ⇒ `substr(date,1,4)` 直接就是年（⛔ 不引日期库）。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<number>} 年份数组，降序
   */
  snapshotYears(uid) {
    return lsql(this,
      'SELECT DISTINCT CAST(substr(date, 1, 4) AS INTEGER) AS y FROM ledger_snapshots WHERE user_id=? ORDER BY y DESC',
      [Number(uid)],
    ).map((r) => Number(r.y));
  },

  /**
   * 功能：把「某一天」的那一行快照**写上或改掉**（一人一天最多一行），返回写入后的行。
   *
   * 说明：⭐ `ON CONFLICT(user_id, date) DO UPDATE` 保证**一天一行** ——
   *      少了它，一天改几次余额就会攒出几行，而「一天最多一行」正是走势图（第 4 期）的前提。
   *      ⚠️ 三个数是**那一刻的事实**：调用方（业务层）必须拿**同一次** `summarize()` 的结果
   *      喂进来，⛔ 不许一处算一处存。
   *
   * @param {number} uid - 用户 id
   * @param {string} date - `YYYY-MM-DD`（调用方给**服务端今天**）
   * @param {{asset_fen: number, debt_fen: number, net_fen: number}} totals - 那一刻的三个数
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行
   */
  upsertLedgerSnapshot(uid, date, totals, stamp) {
    const u = Number(uid);
    const d = String(date);
    ldb(this)
      .prepare(
        `INSERT INTO ledger_snapshots (user_id, date, asset_fen, debt_fen, net_fen, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, date) DO UPDATE SET
           asset_fen=excluded.asset_fen, debt_fen=excluded.debt_fen, net_fen=excluded.net_fen`,
      )
      .run(
        u,
        d,
        Number(totals.asset_fen) || 0,
        Number(totals.debt_fen) || 0,
        Number(totals.net_fen) || 0,
        stamp,
      );
    return ldb(this).prepare('SELECT * FROM ledger_snapshots WHERE user_id=? AND date=?').get(u, d) || null;
  },

  // ---- 自定义分类（视图）与其用途归属 ----
  /**
   * 功能：取该账号的全部自定义分类，按 `sort_order` → id 升序。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 分类行数组
   */
  listLedgerViews(uid) {
    return lsql(this,
      `SELECT * FROM ledger_views
        WHERE user_id=?
        ORDER BY COALESCE(sort_order, 0) ASC, id ASC`,
      [Number(uid)],
    );
  },

  /**
   * 功能：按 id + 归属取一套分类；不存在或不属于该账号都返回 null（越权与不存在统一 404）。
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getLedgerView(uid, id) {
    return ldb(this).prepare('SELECT * FROM ledger_views WHERE id=? AND user_id=?').get(id, Number(uid)) || null;
  },

  /**
   * 功能：插一套分类，返回落地后的那一行。
   * @param {number} uid - 用户 id
   * @param {{name: string, sort_order: number, created_at: number, updated_at: number}} values - 要写的列
   * @returns {Object} 写入后的行
   */
  insertLedgerView(uid, values) {
    const v = values || {};
    // ⭐ 0.8.0：`builtin` 在这里只被 **seed 用**（写 1/2）；用户新建分类时业务层不传 ⇒ 落 0。
    //    ⚠️ 它**不在** `updateLedgerView` 的可改列里 —— 一条分类的「是不是内置」不该会变。
    const info = ldb(this)
      .prepare(
        'INSERT INTO ledger_views (user_id, name, sort_order, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        Number(uid),
        String(v.name),
        Number(v.sort_order) || 0,
        Number(v.builtin) || 0,
        v.created_at,
        v.updated_at,
      );
    return ldb(this).prepare('SELECT * FROM ledger_views WHERE id=?').get(Number(info.lastInsertRowid)) || null;
  },

  /**
   * 功能：改一套分类（只允许改 `name` 与 `sort_order`）。
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @param {{name: string, sort_order: number}} values - 要写的列
   * @param {number} stamp - 写入时间戳
   * @returns {boolean} 有行被改到为 true
   */
  updateLedgerView(uid, id, values, stamp) {
    const v = values || {};
    const r = ldb(this)
      .prepare('UPDATE ledger_views SET name=?, sort_order=?, updated_at=? WHERE id=? AND user_id=?')
      .run(String(v.name), Number(v.sort_order) || 0, stamp, Number(id), Number(uid));
    return r.changes > 0;
  },

  /**
   * 功能：删一套分类 —— ⭐ **连同它的用途归属一起删**（一个事务里两条语句）。
   *
   * 说明：⚠️ 不删归属行会留下「指向不存在分类」的孤儿：界面上再也看不到它们，
   *      但个人备份会把它们带出去、导入时又变成跳过的行（用户看到「跳过 N 条」却找不到原因）。
   *      ⚠️ 与「删账户」不同：删分类**不动任何账户**、不改金额（它本来就只是看账的一种方式）。
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @returns {boolean} 删除前这套分类存在为 true
   */
  deleteLedgerView(uid, id) {
    const u = Number(uid);
    const v = Number(id);
    // ⚠️ `node:sqlite` **没有** `db.transaction()` 那个 API（那是 better-sqlite3 的）——
    //    多语句原子性照本项目的既有写法：`BEGIN` / `COMMIT` / 出错 `ROLLBACK`（见本文件上方几处）。
    let hit;
    ldb(this).exec('BEGIN');
    try {
      ldb(this).prepare('DELETE FROM ledger_view_tags WHERE user_id=? AND view_id=?').run(u, v);
      hit = ldb(this).prepare('DELETE FROM ledger_views WHERE id=? AND user_id=?').run(v, u).changes;
      ldb(this).exec('COMMIT');
    } catch (e) {
      ldb(this).exec('ROLLBACK');
      throw e;
    }
    return hit > 0;
  },

  /**
   * 功能：取一套分类里的**全部用途归属行**（组小计与「这个账户算哪一组」都靠它）。
   * @param {number} uid - 用户 id
   * @param {number} viewId - 分类 id
   * @returns {Array.<Object>} 归属行数组
   */
  listLedgerViewTags(uid, viewId) {
    return lsql(this,'SELECT * FROM ledger_view_tags WHERE user_id=? AND view_id=? ORDER BY id ASC', [
      Number(uid),
      Number(viewId),
    ]);
  },

  /**
   * 功能：给「某个账户在某套分类里」写上 / 改掉用途（一个账户一套分类最多一行）。
   * @param {number} uid - 用户 id
   * @param {number} viewId - 分类 id
   * @param {number} accountId - 账户 id
   * @param {string} tag - 用途名（非空；「不分类」由 delete 表达）
   * @param {number} stamp - 写入时间戳
   * @returns {Object} 写入后的行
   */
  upsertLedgerViewTag(uid, viewId, accountId, tag, stamp) {
    const u = Number(uid);
    const v = Number(viewId);
    const a = Number(accountId);
    ldb(this)
      .prepare(
        `INSERT INTO ledger_view_tags (user_id, view_id, account_id, tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, view_id, account_id) DO UPDATE SET tag=excluded.tag, updated_at=excluded.updated_at`,
      )
      .run(u, v, a, String(tag), stamp, stamp);
    return (
      ldb(this).prepare('SELECT * FROM ledger_view_tags WHERE user_id=? AND view_id=? AND account_id=?').get(u, v, a) ||
      null
    );
  },
  /**
   * 功能：写一套分类里**组内的先后** —— 按提交上来的账户顺序，把 sort_order 依次写成 0,1,2…
   *
   * 说明：⭐⭐ 顺序住 ledger_view_tags.sort_order（**不是**账户表的 sort_order）：
   *      账户表那一列只在同一个 kind 内部起作用，而「按账户用途」的一组里混着现金 / 储蓄卡 /
   *      虚拟账户 —— 靠它永远排不出用户要的顺序（报的「支付宝拖不到第一个」
   *      就是这个形状：拖完只有同为虚拟账户的微信跟它换了位，看着像生效了）。
   *      ⚠️ 按 (user_id, view_id, account_id) 更新，**不是按主键 id**：前端手上只有账户 id
   *      （tag 行的 id 从不下发），而且这样天然只动这一套分类、动不到别的分类。
   *      ⚠️ 没归属行的账户（真没分的）更新命中 0 行 —— 那是对的行为：它在这套分类里没有位置。
   *      ⚠️ 多语句原子性照项目既有写法（node:sqlite 没有 db.transaction()）。
   *
   * @param {number} uid - 用户 id
   * @param {number} viewId - 哪一套分类
   * @param {Array.<number>} accountIds - 组内新顺序（账户 id）
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {number} 实际改动的行数
   */
  reorderLedgerTags(uid, viewId, accountIds, stamp) {
    const u = Number(uid);
    const v = Number(viewId);
    const list = Array.isArray(accountIds)
      ? accountIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (!list.length) return 0;
    let hit = 0;
    ldb(this).exec('BEGIN');
    try {
      const st = ldb(this).prepare(
        'UPDATE ledger_view_tags SET sort_order=?, updated_at=? WHERE user_id=? AND view_id=? AND account_id=?',
      );
      list.forEach((aid, i) => {
        hit += st.run(i, stamp, u, v, aid).changes;
      });
      ldb(this).exec('COMMIT');
    } catch (e) {
      ldb(this).exec('ROLLBACK');
      throw e;
    }
    return hit;
  },

  /**
   * 功能：把「某个账户在某套分类里」的用途**拿掉**（＝ 回到「其它」）。
   * @param {number} uid - 用户 id
   * @param {number} viewId - 分类 id
   * @param {number} accountId - 账户 id
   * @returns {boolean} 有行被删为 true
   */
  deleteLedgerViewTag(uid, viewId, accountId) {
    const r = ldb(this)
      .prepare('DELETE FROM ledger_view_tags WHERE user_id=? AND view_id=? AND account_id=?')
      .run(Number(uid), Number(viewId), Number(accountId));
    return r.changes > 0;
  },

  /**
   * 功能：删掉某个账户在**所有分类**里的用途行（删账户时调）。
   *
   * 说明：⚠️ 不删就会留下「指向已删账户」的归属行：组小计按账户算，所以它不影响钱，
   *      但它会被个人备份带出去（导入时变成跳过计数）—— 属于该清干净的东西。
   * @param {number} uid - 用户 id
   * @param {number} accountId - 账户 id
   * @returns {number} 删掉的行数
   */
  deleteLedgerTagsOfAccount(uid, accountId) {
    return ldb(this)
      .prepare('DELETE FROM ledger_view_tags WHERE user_id=? AND account_id=?')
      .run(Number(uid), Number(accountId)).changes;
  },

  // ---- 分组字段（九类顺序 ＋ 内置用途）与三处排序（0.8.0）----

  /**
   * 功能：取分组字段，按 `sort_order` → id 升序；给了 `scope` 就只取那一套。
   *
   * 说明：⭐ 两套共用一张表（`scope = 'kind' | 'usage'`，见 `schema.js`）：`kind` 那 9 行管
   *      **九类的显示顺序**，`usage` 那几行是**内置「按账户用途」的字段**。
   *      ⚠️ 排序末尾带 `id` 兜底：`sort_order` 万一撞了（重排中途失败），顺序仍然**确定** ——
   *      否则同一份数据在两次请求里可能画出两种顺序，而两边**都不报错**。
   *
   * @param {number} uid - 用户 id
   * @param {?string} scope - `'kind'` / `'usage'`；给假值时两套都给
   * @returns {Array.<Object>} 字段行数组
   */
  listLedgerGroups(uid, scope) {
    const u = Number(uid);
    if (scope) {
      return lsql(this,
        `SELECT * FROM ledger_groups
          WHERE user_id=? AND scope=?
          ORDER BY COALESCE(sort_order, 0) ASC, id ASC`,
        [u, String(scope)],
      );
    }
    return lsql(this,
      `SELECT * FROM ledger_groups
        WHERE user_id=?
        ORDER BY scope ASC, COALESCE(sort_order, 0) ASC, id ASC`,
      [u],
    );
  },

  /**
   * 功能：按 id + 归属取一个分组字段；不存在或不属于该账号都返回 null。
   * @param {number} uid - 用户 id
   * @param {number} id - 字段行 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getLedgerGroup(uid, id) {
    return (
      ldb(this).prepare('SELECT * FROM ledger_groups WHERE id=? AND user_id=?').get(Number(id), Number(uid)) || null
    );
  },

  /**
   * 功能：插一个分组字段，返回落地后的那一行。
   *
   * 说明：⚠️ `gkey` 是**稳定键**（新增用途时由业务层生成，见 `lib/usages.js`）；
   *      它的 `UNIQUE(user_id, scope, gkey)` 同时是 seed 的**幂等落点** ⇒
   *      重复插同一个键会**当场抛错** —— 这正是想要的（⛔ 不是「静默插两行」：
   *      那会让同一个用途在界面上出现两次、两组的账户还各算一遍）。
   *
   * @param {number} uid - 用户 id
   * @param {{scope: string, gkey: string, name: string, sort_order: number, locked: number, created_at: number, updated_at: number}} values - 要写的列
   * @returns {Object} 写入后的行
   */
  insertLedgerGroup(uid, values) {
    const v = values || {};
    const info = ldb(this)
      .prepare(
        `INSERT INTO ledger_groups (user_id, scope, gkey, name, sort_order, locked, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Number(uid),
        String(v.scope),
        String(v.gkey),
        String(v.name),
        Number(v.sort_order) || 0,
        v.locked ? 1 : 0,
        v.created_at,
        v.updated_at,
      );
    return ldb(this).prepare('SELECT * FROM ledger_groups WHERE id=?').get(Number(info.lastInsertRowid)) || null;
  },

  /**
   * 功能：改一个分组字段（只允许改 `name` 与 `sort_order`）。
   *
   * 说明：⭐⭐ **改名不影响任何账户归属** —— 归属那一列存的是 `gkey`（见 `schema.js` 里
   *      `ledger_view_tags.tag` 的说明）。这就是「用途可以重命名」能成立的全部原因，
   *      ⛔ 别顺手把 `gkey` 一起放开（放开 = 改一次名，所有归类的账户静默掉到「其它」）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 字段行 id
   * @param {{name: string, sort_order: number}} values - 要写的列
   * @param {number} stamp - 写入时间戳
   * @returns {boolean} 有行被改到为 true
   */
  updateLedgerGroup(uid, id, values, stamp) {
    const v = values || {};
    const r = ldb(this)
      .prepare('UPDATE ledger_groups SET name=?, sort_order=?, updated_at=? WHERE id=? AND user_id=?')
      .run(String(v.name), Number(v.sort_order) || 0, stamp, Number(id), Number(uid));
    return r.changes > 0;
  },

  /**
   * 功能：删一个分组字段（只管这一行）。
   *
   * 说明：⚠️ 「原本归在它下面的账户去哪」**不在这里** —— 那是业务口径
   *      （挪到「其它」，走 `reassignLedgerViewTags`）。两件事必须分开：这一层只认行，
   *      「哪些账户归它」要读内置分类的 id，那是业务的量。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 字段行 id
   * @returns {boolean} 删除前这一行存在为 true
   */
  deleteLedgerGroup(uid, id) {
    return (
      ldb(this).prepare('DELETE FROM ledger_groups WHERE id=? AND user_id=?').run(Number(id), Number(uid)).changes > 0
    );
  },

  /**
   * 功能：把某个分类下、归属为 `fromKey` 的那些行**整批改成 `toKey`**（删用途时的兜底动作）。
   *
   * 说明：⚠️ 它只动 `tag` 一列，⛔ 不动账户、⛔ 不动别的分类 —— 「删掉一个用途」不该牵连
   *      用户在**自建分类**里的归类（那些存的是用途名文本，是另一套语义，见 schema.js）。
   *
   * @param {number} uid - 用户 id
   * @param {number} viewId - 分类 id
   * @param {string} fromKey - 原归属键
   * @param {string} toKey - 新归属键（「其它」）
   * @param {number} stamp - 写入时间戳
   * @returns {number} 改到的行数
   */
  reassignLedgerViewTags(uid, viewId, fromKey, toKey, stamp) {
    return ldb(this)
      .prepare('UPDATE ledger_view_tags SET tag=?, updated_at=? WHERE user_id=? AND view_id=? AND tag=?')
      .run(String(toKey), stamp, Number(uid), Number(viewId), String(fromKey)).changes;
  },

  /**
   * 功能：按给定顺序重排**账户**（列表里的先后；两端都能拖，手机端长按）。
   * @param {number} uid - 用户 id
   * @param {Array.<number>} ids - 期望顺序
   * @param {number} stamp - 写入时间戳
   * @returns {number} 实际改到的行数
   */
  reorderLedgerAccounts(uid, ids, stamp) {
    return reorderRows(ldb(this), 'ledger_accounts', uid, ids, stamp);
  },

  /**
   * 功能：按给定顺序重排**分类胶囊**（⭐ 含内置那两颗，所以顺序才需要入库）。
   * @param {number} uid - 用户 id
   * @param {Array.<number>} ids - 期望顺序
   * @param {number} stamp - 写入时间戳
   * @returns {number} 实际改到的行数
   */
  reorderLedgerViews(uid, ids, stamp) {
    return reorderRows(ldb(this), 'ledger_views', uid, ids, stamp);
  },

  /**
   * 功能：按给定顺序重排**分组字段**（九类的显示顺序 / 用途的先后）。
   * @param {number} uid - 用户 id
   * @param {Array.<number>} ids - 期望顺序
   * @param {number} stamp - 写入时间戳
   * @returns {number} 实际改到的行数
   */
  reorderLedgerGroups(uid, ids, stamp) {
    return reorderRows(ldb(this), 'ledger_groups', uid, ids, stamp);
  },

  /**
   * 功能：取「与某个账户有关」的全部转账（转出 + 转入），按 `date` 倒序、同日按 id 倒序。
   *
   * 说明：⭐ 账户详情页那份「收支明细」就是它 —— 由业务层先确认这个账户存在且属于本人，
   *      所以这里只管取数（`user_id` 条件照旧带着，它是最后一道）。
   *      ⚠️ **`OR` 条件刻意不拆成两次查询再合并**：两条路的顺序与去重都得自己保证，
   *      而合起来一条 SQL 的语义最直白；规模是「一个人自己的几十笔」，多余索引也一并省了
   *      （见 `schema.js` 的索引说明）。
   *
   * @param {number} uid - 用户 id
   * @param {number} accountId - 账户 id
   * @returns {Array.<Object>} 转账行数组（新的在前）
   */
  listLedgerTransfers(uid, accountId) {
    const a = Number(accountId);
    return lsql(this,
      `SELECT * FROM ledger_transfers
        WHERE user_id=? AND (from_id=? OR to_id=?)
        ORDER BY date DESC, id DESC`,
      [Number(uid), a, a],
    );
  },

  /**
   * 功能：**原子地**记下一笔转账（一个事务：确认两个账户都在 ＋ 插一行 `ledger_transfers`）。
   *
   * 说明：⭐⭐ 0.8.1 起**余额是实时派生出来的**⇒ 本原语**不再碰
   *      `ledger_accounts`**：转账只是「两个账户之间挪过钱」这条**事实**，
   *      它对余额的影响由 `lib/balance.js` 在需要时算出来。
   *      ⚠️⭐ 1 期那句「转出账户加增量、转入账户加增量」**整块删掉**了 ——
   *      留着它就是把同一笔钱算两遍（`opening_fen` 一份、派生时再来一份），
   *      表现是「转一次账，余额掉两倍 / 涨两倍」，而且**不报错**。
   *      ⚠️ 两个账户的归属照旧在这里确认（`user_id` 条件）：不是 1 条命中 ⇒ 回 `null`，
   *      由业务层转成 404（⛔ 不许留下一条指向别人账户的转账明细）。
   *      ⚠️ `node:sqlite` 没有 `db.transaction()`（那是 better-sqlite3 的），
   *      多语句原子性照本项目的既有写法：`BEGIN` / `COMMIT` / 出错 `ROLLBACK`。
   *
 * @param {number} uid - 用户 id
 * @param {{date: string, from_id: number, to_id: number, amount_fen: number, note: string}} values - 要写的内容
 *      ⚠️ 列名是 `date`（`ledger_transfers` 是 1 期表、**结构一字不改**，见 `schema.js`）——
 *      它在派生时按「那一天的开头」参与排序（`lib/balance.js` 的 `momentOf()`）。
 * @param {number} stamp - 写入时间戳（epoch 毫秒）
 * @returns {?Object} 新建的那一行转账；两个账户有一侧没命中时为 null（已回滚）
 */
  transferLedger(uid, values, stamp) {
    const u = Number(uid);
    const from = Number(values.from_id);
    const to = Number(values.to_id);
    const amt = Math.trunc(Number(values.amount_fen)) || 0;
    const db = ldb(this);
    db.exec('BEGIN');
    try {
      const out = db.prepare('SELECT id FROM ledger_accounts WHERE id=? AND user_id=?').get(from, u);
      const into = db.prepare('SELECT id FROM ledger_accounts WHERE id=? AND user_id=?').get(to, u);
      if (!out || !into) {
        db.exec('ROLLBACK');
        return null;
      }
      const info = db
        .prepare(
          `INSERT INTO ledger_transfers (user_id, date, from_id, to_id, amount_fen, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(u, String(values.date), from, to, amt, values.note || null, stamp);
      const row = db.prepare('SELECT * FROM ledger_transfers WHERE id=?').get(Number(info.lastInsertRowid)) || null;
      db.exec('COMMIT');
      return row;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },

  /**
   * 功能：删掉**与某个账户有关**的全部转账（删账户时调）。
   *
   * 说明：⚠️⭐ **0.8.1 起不再被任何路径调用**（保留函数本身，⛔ 不要删）：
   *      ·  第 6 条把「删账户」改成了「写一行删除记录 ＋ 硬删账户行」，
   *        转账 / 流水 / 手动调整**一条都不删** —— 它们保留原 id，显示名字时去删除记录表取原名；
   *      · 之所以**留着**：两后端的 op 集合必须逐字一致（`assertOpsContract()` 在加载时比对），
   *        删掉一个键会让两个后端对不上而**启动即抛**；而且既有测试仍在直接调它。
   *      ⇒ 它现在只是一段「按 id 清明细」的能力，⛔ 别在删账户那条路上把它加回来。
   *
   * @param {number} uid - 用户 id
   * @param {number} accountId - 账户 id
   * @returns {number} 删掉的行数
   */
  deleteLedgerTransfersOfAccount(uid, accountId) {
    const a = Number(accountId);
    return ldb(this)
      .prepare('DELETE FROM ledger_transfers WHERE user_id=? AND (from_id=? OR to_id=?)')
      .run(Number(uid), a, a).changes;
  },

  /**
   * 功能：取本账号在**与某个账户有关**的全部转账里、按日期升序的那一批（派生余额要用全量）。
   *
   * 说明：⭐⭐ 它是「余额实时派生」这条口径的**取数口**：派生一个账户的余额时
   *      必须能拿到**它参与过的每一笔转账**，而 1 期只有「按账户查」那一个原语
   *      ⇒ 拿它去查每一个账户就是一串 N+1。
   *      ⚠️ 排序按 `date`（`YYYY-MM-DD` 定长串，字典序即时间序）—— 顺序只为**结果可复现**，
   *      `lib/balance.js` 是纯函数、自己按时刻判先后（⛔ 不假设入参有序）。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 该账号的全部转账行（按 `date` 升序）
   */
  listLedgerTransfersByUser(uid) {
    return lsql(this,
      'SELECT * FROM ledger_transfers WHERE user_id=? ORDER BY date ASC, id ASC',
      [Number(uid)],
    );
  },

  // ---- 记账条目（2 期）----
  /**
   * 功能：取本账号的记账条目 —— 「按月区间 ＋ 游标 ＋ 条数上限」，按 `(at, id)` 倒序。
   *
   * 说明：⭐⭐ 三条形状上的取舍（都是「写错了不报错、只是静默不对」的那一类）：
   *      · **区间是字典序**（`at >= from AND at < to`）：`at` 是 `YYYY-MM-DD HH:MM:SS` 定长串
   *        ⇒ 字典序即时间序，按月取数传 `'2026-09-01'` / `'2026-10-01'` 即可；
   *      · **游标而不是 offset**：条件是
   *        `at < 游标时刻 OR (at = 游标时刻 AND id < 游标 id)` —— 同一秒里两笔按 `id` 兜底
   *        ，于是「翻页不重不漏」与「中途有人插数据」两件事同时成立；
   *      · `limit` **本层只负责「给了就用」**，上限 30 那条判据住接口层（⛔ 不在这里兜底截断 ——
   *        静默截断会让用户以为「就这么多」）。
   *
   * @param {number} uid - 用户 id
   * @param {{from?: ?string, to?: ?string, before?: ?{at: string, id: number}, limit?: ?number}} [opts] - 取数条件
   * @returns {Array.<Object>} 条目行数组（新的在前）
   */
  listLedgerEntries(uid, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const where = ['user_id=?'];
    const params = [Number(uid)];
    if (o.from) {
      where.push('at>=?');
      params.push(String(o.from));
    }
    if (o.to) {
      where.push('at<?');
      params.push(String(o.to));
    }
    const before = o.before && typeof o.before === 'object' ? o.before : null;
    if (before && before.at != null) {
      where.push('(at<? OR (at=? AND id<?))');
      params.push(String(before.at), String(before.at), Number(before.id) || 0);
    }
    let sql = `SELECT * FROM ledger_entries WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC`;
    const lim = Math.trunc(Number(o.limit));
    if (Number.isFinite(lim) && lim > 0) {
      sql += ' LIMIT ?';
      params.push(lim);
    }
    return lsql(this, sql, params);
  },

  /**
   * 功能：按 id + 归属取一条记账条目；不存在或不属于该账号都返回 null（越权与不存在统一 404）。
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getLedgerEntry(uid, id) {
    return (
      ldb(this).prepare('SELECT * FROM ledger_entries WHERE id=? AND user_id=?').get(Number(id), Number(uid)) || null
    );
  },

  /**
   * 功能：插一条记账条目，返回落地后的那一行。
   *
   * 说明：⚠️ `user_id` 由本层强制写成入参那个账号（请求体里带来的任何 `user_id` 都流不进来）；
   *      `note` 空串统一落 `NULL`（与账户那张表同一条口径：`''` 与 `NULL` 是同一件事）。
   *      ⚠️ `category_id` 为 `null` = **未分类**，它是一个**合法值**，
   *      ⛔ 不许兜成 0（0 会变成一条「指向不存在分类」的悬空外键）。
   *      ⚠️ `account_id` **非空**：没选账户时由业务层先落到**空账户**的 id。
   *
   * @param {number} uid - 用户 id
   * @param {{at: string, ie: string, amount_fen: number, category_id?: ?number, account_id: number,
   *      refund_of?: ?number, note?: string}} values - 要写的列
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行
   */
  insertLedgerEntry(uid, values, stamp) {
    const v = values || {};
    const info = ldb(this)
      .prepare(
        `INSERT INTO ledger_entries
           (user_id, at, ie, amount_fen, category_id, account_id, refund_of, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Number(uid),
        String(v.at),
        String(v.ie),
        Math.trunc(Number(v.amount_fen)) || 0,
        v.category_id == null ? null : Number(v.category_id),
        Number(v.account_id),
        v.refund_of == null ? null : Number(v.refund_of),
        v.note ? String(v.note) : null,
        stamp,
        stamp,
      );
    return ldb(this).prepare('SELECT * FROM ledger_entries WHERE id=?').get(Number(info.lastInsertRowid)) || null;
  },

  // ---- 三方导入（0.8.2）----
  // ⚠️⭐ 这五个原语一律收 `table`（表名走参数），且**拼任何 SQL 之前**先过 `assertIdent()`：
  //    表名只可能来自 `lib/import-sources.js` 的注册表（⛔ 永不来自请求 / 文件名），
  //    这一道是「哪天有人把来源键接到请求参数上」时的当场保险（第二道）。

  /**
   * 功能：数该账号在**这张导入表**里有多少行（给界面上的「已导入 N 笔」）。
   *
   * 说明：⚠️ 表名走参数而不是写死 `shayu`：一来源一张表，加来源只改注册表。
   *      ⚠️ 按 `user_id` 过滤 —— 别人的行一米都不许算进来。
   *
   * @param {number} uid - 用户 id
   * @param {string} table - 导入表名（来自注册表）
   * @returns {number} 该账号在这张表里的行数（0 = 还没导入过，⛔ 不是错误）
   */
  countImportedRows(uid, table) {
    const t = assertIdent(table);
    const row = ldb(this).prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id=?`).get(Number(uid));
    return Number(row && row.n) || 0;
  },

  /**
   * 功能：算该账号**下一个批次号**（`COALESCE(MAX(batch_id), 0) + 1`，账号范围内）。
   *
   * 说明：⭐ 批次号是「这一次导入」的身份，也是整批清除时「这一批」的落点 ——
   *      它**只增不减**（删了数据也不会把号退回去，⛔ 免得旧批次被新数据撞上）。
   *      ⚠️ 空表 ⇒ `MAX` 是 `NULL` ⇒ 用 `COALESCE` 兜成 0 再加 1，于是第一次就是 `1`。
   *      ⚠️ 只在这个账号范围内取最大值（别人的批次号不影响我）。
   *
   * @param {number} uid - 用户 id
   * @param {string} table - 导入表名（来自注册表）
   * @returns {number} 下一个批次号（至少为 1）
   */
  nextImportBatchId(uid, table) {
    const t = assertIdent(table);
    const row = ldb(this)
      .prepare(`SELECT COALESCE(MAX(batch_id), 0) + 1 AS n FROM ${t} WHERE user_id=?`)
      .get(Number(uid));
    const n = Math.trunc(Number(row && row.n));
    return Number.isFinite(n) && n > 0 ? n : 1;
  },

  /**
   * 功能：**批量插导入行 —— 一个事务**（要么全写、要么一行都不写）。
   *
   * 说明：⭐⭐ 为什么必须是事务：导入动辄几百条，中途失败（磁盘满 / 库被降级成只读）时
   *      **不许留下「导了一半」** —— 半截数据比整份失败难查得多：用户看到列表里有一半，
   *      再导一次又会因为「去重」把那一半当成已经导过而跳过 ⇒ 剩下那一半**永远补不上**。
   *      ⚠️ `rows` 是**有序数组**，里面那个 `row_no` 由**下标 + 1** 现算（⭐ 不让调用方传）：
   *      唯一键是 `(user_id, batch_id, row_no)`，调用方传就可能出现重复行号 ⇒ 当场抛错。
   *      ⚠️⭐ `at` / `fen` 允许 `NULL`（日期 / 金额认不出的行）⇒ **照实写 `NULL`**，
   *      ⛔ 绝不用 `Number(x) || 0` 把 `null` 兜成 `0` —— 那会让认不出的行**混进统计**。
   *      ⚠️ 空数组直接返回（⛔ 不抛错、⛔ 不空跑一个事务）。
   *      ⚠️ **回滚失败忽略**（`catch` 里只 `ROLLBACK`）：原错误更重要（照
   *      `deleteLedgerBudgetsForPeriod` 的先例）。
   *
   * @param {number} uid - 用户 id
   * @param {string} table - 导入表名（来自注册表）
   * @param {Array.<Object>} rows - 有序数组，元素形如
   *      `{ dateRaw, ieRaw, category, account, amountRaw, note, at, fen }`
   *      （⭐ 原样六列 ＋ 两个派生列；`at` / `fen` 可为 `null`）
   * @param {number} batchId - 这一批的批次号（由 `nextImportBatchId()` 给）
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {{inserted: number}} 写进去的条数（空数组时为 0）
   */
  insertImportedRows(uid, table, rows, batchId, stamp) {
    const t = assertIdent(table);
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return { inserted: 0 };
    const u = Number(uid);
    const b = Number(batchId);
    const db = ldb(this);
    const stmt = db.prepare(
      `INSERT INTO ${t}
         (user_id, batch_id, row_no, date_raw, ie_raw, category, account, amount_raw, note, at, fen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      list.forEach((v, i) => {
        const r = v || {};
        stmt.run(
          u,
          b,
          i + 1,
          r.dateRaw == null ? null : String(r.dateRaw),
          r.ieRaw == null ? null : String(r.ieRaw),
          r.category == null ? null : String(r.category),
          r.account == null ? null : String(r.account),
          r.amountRaw == null ? null : String(r.amountRaw),
          r.note == null ? null : String(r.note),
          r.at == null ? null : String(r.at),
          r.fen == null ? null : Math.trunc(Number(r.fen)),
          stamp,
        );
      });
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
    return { inserted: list.length };
  },

  /**
   * 功能：取**区间原料**（导入行）—— ⭐ 明细 / 账单 / 预算的「合并取数」里导入那一半的唯一取数口。
   *
   * 说明：⭐⭐ **区间语义与 `selectLedgerEntriesBetween` 逐字相同**：左闭右开
   *      （`at>=from AND at<?`）；`from` / `to` 给空串 ⇒ 那一端不设限。
   *      ⚠️⭐ **排除 `at` 为 `NULL` 的行**（它们不属于任何区间 —— 日期认不出，统计里没有它们的位置）。
   *      ⚠️ 回**十列**（`id / date_raw / ie_raw / category / account / amount_raw / note / at /
   *      fen / batch_id`）：原样六列 ＋ 两个派生列 ＋ 身份两列，界面与统计要的都在这；
   *      ⛔ 不回 `user_id` / `row_no` / `created_at`（那条路上没有消费者）。
   *      ⚠️ 排序 `(at, id)` **升序**：顺序只为结果可复现，且两个后端必须给出同一个顺序。
   *
   * @param {number} uid - 用户 id
   * @param {string} table - 导入表名（来自注册表）
   * @param {string} from - 区间起点（**含**）`YYYY-MM-DD`；空串 = 不限
   * @param {string} to - 区间终点（**不含**）`YYYY-MM-DD`；空串 = 不限
   * @returns {Array.<Object>} 导入行数组（十列，按 `(at, id)` 升序）
   */
  selectImportedBetween(uid, table, from, to) {
    const t = assertIdent(table);
    const where = ['user_id=?', 'at IS NOT NULL'];
    const params = [Number(uid)];
    if (from) {
      where.push('at>=?');
      params.push(String(from));
    }
    if (to) {
      where.push('at<?');
      params.push(String(to));
    }
    return lsql(this,
      `SELECT id, date_raw, ie_raw, category, account, amount_raw, note, at, fen, batch_id
         FROM ${t}
        WHERE ${where.join(' AND ')}
        ORDER BY at ASC, id ASC`,
      params,
    );
  },

  /**
   * 功能：删该账号在**这张导入表**里的全部行（整批清除），回删掉的条数。
   *
   * 说明：⭐⭐ 导入的数据是**只读**的（⛔ 不能单条改 / 单条删）⇒ 撤走只有这条路：
   *      「一次清空这个账号的全部导入行」，⛔ 不按 `batch_id` 挑批 —— 用户要的是「把导进来的清掉」。
   *      ⚠️ 一条 `DELETE` 本身不可分割，⛔ 不额外套事务（照 `deleteLedgerTransfersOfAccount` 的先例）。
   *      ⚠️ `user_id` 一起在 `WHERE` 里 ⇒ 删不到别人的行（越权面归零）。
   *
   * @param {number} uid - 用户 id
   * @param {string} table - 导入表名（来自注册表）
   * @returns {number} 实际删掉的行数（0 = 本来就没导过）
   */
  deleteImportedByUser(uid, table) {
    const t = assertIdent(table);
    return ldb(this).prepare(`DELETE FROM ${t} WHERE user_id=?`).run(Number(uid)).changes;
  },

  /**
   * 功能：改一条记账条目（**整行写**，`updated_at` 一并刷新）。
   *
   * 说明：⚠️ **`refund_of` 不在可改列里**，而且这不是漏写：它表达的是「这一条**是**退款」这个身份，
   *      放开它等于一次 PUT 就能把一笔普通记账**变成**退款（或反过来）—— 那会让「累计退款 ≤ 原额」
   *      这条校验被整个绕过。退款要改只能改它自己的金额 / 时刻 / 备注。
   *      ⚠️ `id` / `user_id` / `created_at` 照旧不进 SET（身份与审计）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @param {{at: string, ie: string, amount_fen: number, category_id?: ?number, account_id: number, note?: string}} values - 要写的列
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {boolean} 是否真的改到了一行（不属于本人 / 不存在时为 false）
   */
  updateLedgerEntry(uid, id, values, stamp) {
    const v = values || {};
    const r = ldb(this)
      .prepare(
        `UPDATE ledger_entries
            SET at=?, ie=?, amount_fen=?, category_id=?, account_id=?, note=?, updated_at=?
          WHERE id=? AND user_id=?`,
      )
      .run(
        String(v.at),
        String(v.ie),
        Math.trunc(Number(v.amount_fen)) || 0,
        v.category_id == null ? null : Number(v.category_id),
        Number(v.account_id),
        v.note ? String(v.note) : null,
        stamp,
        Number(id),
        Number(uid),
      );
    return r.changes > 0;
  },

  /**
   * 功能：删一条记账条目 —— ⭐ **连带删掉「退的是它」的那些退款条目**（一个事务）。
   *
   * 说明：⭐⭐ 为什么必须连带（C-14）：退款与它的原交易是**同一件事的两半**，
   *      原交易一删，那些退款行就指向一个不存在的 id ⇒ 界面上显示不出「退的是哪一笔」，
   *      而它的金额**还在余额里**（静默的钱对不上）。两端的删除确认文案要说清这一点。
   *      ⚠️ 反方向**不删**：这一条自己如果是退款，删它就只是删它 —— 原交易一行不动。
   *      ⚠️ 多语句原子性照本项目的既有写法（`node:sqlite` 没有 `db.transaction()`）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 条目 id
   * @returns {boolean} 删除前这一条存在为 true
   */
  deleteLedgerEntry(uid, id) {
    const u = Number(uid);
    const e = Number(id);
    const db = ldb(this);
    let hit;
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM ledger_entries WHERE user_id=? AND refund_of=?').run(u, e);
      hit = db.prepare('DELETE FROM ledger_entries WHERE id=? AND user_id=?').run(e, u).changes;
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw err;
    }
    return hit > 0;
  },

  /**
   * 功能：一次取回**一批原条目**的退款条目（⛔ 不做 N+1）。
   *
   * 说明：⭐ 调用点的两种用法都在这一份结果上：①「原交易那一行显示已退多少」＝把它们按
   *      `refund_of` 求和；②「这笔还能退多少」＝拿原额减这个和。
   *      ⚠️ 返回的是**整行**（不是求和结果）：求和是业务层的口径，而排序与分桶在那边一次做完
   *      ——原语层只回答「这些原条目各自有哪些退款行」。
   *      ⚠️ `entryIds` 为空时**一次库都不查**（回空数组）：空 `IN ()` 在 SQLite 里是语法错。
   *
   * @param {number} uid - 用户 id
   * @param {Array.<number>} entryIds - 原条目 id 数组
   * @returns {Array.<Object>} 退款条目行数组（按时刻升序）
   */
  listLedgerRefunds(uid, entryIds) {
    const u = Number(uid);
    const ids = (Array.isArray(entryIds) ? entryIds : [])
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return [];
    return lsql(this,
      `SELECT * FROM ledger_entries
        WHERE user_id=? AND refund_of IN (${ids.map(() => '?').join(',')})
        ORDER BY at ASC, id ASC`,
      [u, ...ids],
    );
  },

  /**
   * 功能：**原子地**记一笔退款 —— 一个事务里「算原条目累计退款 ＋ 校验 ≤ 原额 ＋ 插入」。
   *
   * 说明：⭐⭐ 这是本模块**唯一**能改「已退多少」的入口：
   *      校验与插入必须在同一个事务里，否则「两次同时提交」可以各自看到旧的和、双双通过
   *      ⇒ 累计退款超过原额，而两边的响应都是 201（静默的错账）。
   *      超限 ⇒ `ROLLBACK` ＋ 抛 **400**。
   *      ⚠️ 原条目不存在 / 不是本人的 ⇒ 回 `null`（由业务层转成 404，越权与不存在逐字一致）。
   *      ⚠️ **不许给退款再退款**：原条目自己带 `refund_of` ⇒ 400（否则"退款链"能无限套下去，
   *      而每一层都动余额）。这一条**住在这里**而不是业务层：它要读原条目，读了就该当场判掉。
   *
   * @param {number} uid - 用户 id
   * @param {{at: string, amount_fen: number, category_id?: ?number, account_id: number, refund_of: number, note?: string}} values - 要写的内容
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {?Object} 新建的退款条目；原条目不存在 / 不属于本人时为 null（已回滚）
   * @throws {Error} 累计退款超过原额、或给退款再退款时抛 400
   */
  insertLedgerRefund(uid, values, stamp) {
    const u = Number(uid);
    const v = values || {};
    const db = ldb(this);
    db.exec('BEGIN');
    try {
      const orig = db
        .prepare('SELECT * FROM ledger_entries WHERE id=? AND user_id=?')
        .get(Number(v.refund_of), u);
      if (!orig) {
        db.exec('ROLLBACK');
        return null;
      }
      if (orig.refund_of != null) {
        db.exec('ROLLBACK');
        throw badRequest('这一笔本身就是退款，不能再给它退款');
      }
      const amt = Math.trunc(Number(v.amount_fen)) || 0;
      const sum = db
        .prepare('SELECT COALESCE(SUM(amount_fen), 0) AS s FROM ledger_entries WHERE user_id=? AND refund_of=?')
        .get(u, Number(orig.id));
      // ⚠️ 原额也压成整数再比：老库 / 手改过的行里可能是字符串，`'1000' + 30 > 1000` 是**字符串比较**
      if ((Number(sum && sum.s) || 0) + amt > Math.trunc(Number(orig.amount_fen)) || 0) {
        db.exec('ROLLBACK');
        throw badRequest('退款总额不能超过这一笔的金额');
      }
      const info = db
        .prepare(
          `INSERT INTO ledger_entries
             (user_id, at, ie, amount_fen, category_id, account_id, refund_of, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          u,
          String(v.at),
          '收入',
          amt,
          v.category_id == null ? null : Number(v.category_id),
          Number(v.account_id),
          Number(orig.id),
          v.note ? String(v.note) : null,
          stamp,
          stamp,
        );
      const row = db.prepare('SELECT * FROM ledger_entries WHERE id=?').get(Number(info.lastInsertRowid)) || null;
      db.exec('COMMIT');
      return row;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 校验失败那几条路自己已经回滚过，这里再滚一次会抛「没有活动事务」—— 忽略它 */
      }
      throw e;
    }
  },

  /**
   * 功能：取**备注历史候选** —— 该账号（可限某一类别）用过的不重复备注，最近用过的在前。
   *
   * 说明：⭐⭐ 备注候选**不新开表**：直接来自已有的流水备注，
   *      由**服务端一处**给（⛔ 不让两端各自 `distinct` —— 各自实现必然漂移）。
   *      ⚠️ 排序用 `MAX(at)`（这个词**最后一次用**是什么时候）而不是 `MIN`：
   *      「最近用过的先给」才符合「接着上次写」的用法。
   *      ⚠️ 空串与 `NULL` 都不算候选（它们不是「用户写过的备注」）。
   *      ⚠️ `limit` 的上限（20）由业务层定，本层只负责「给了就用」。
   *
   * @param {number} uid - 用户 id
   * @param {?number} categoryId - 只取这个类别的候选；给 `null` 时取全部类别的
   * @param {number} limit - 最多给几条
   * @returns {Array.<string>} 备注候选（最近的在前）
   */
  listLedgerNoteCandidates(uid, categoryId, limit) {
    const where = ["user_id=? AND note IS NOT NULL AND note<>''"];
    const params = [Number(uid)];
    if (categoryId != null && Number(categoryId) > 0) {
      where.push('category_id=?');
      params.push(Number(categoryId));
    }
    params.push(Math.trunc(Number(limit)) || 20);
    return lsql(this,
      `SELECT note, MAX(at) AS last_at, MAX(id) AS last_id
         FROM ledger_entries
        WHERE ${where.join(' AND ')}
        GROUP BY note
        ORDER BY last_at DESC, last_id DESC
        LIMIT ?`,
      params,
    ).map((r) => String(r.note));
  },

  // ---- 收支分类（2 期）----
  /**
   * 功能：取本账号的全部收支分类（**含已归档的**），一级在前、各自按 `sort_order`。
   *
   * 说明：⭐ 已归档的**也要取回来**：历史流水的 `category_id` 还指着它们，
   *      界面上要显示原名；「不出现在选择器里」是**前端按 `archived_at` 过滤**的事。
   *      ⚠️ 排序 `COALESCE(parent_id, 0)` 把一级（`parent_id` 为 NULL）归成 0、排在二级前面
   *      —— 与 SQLite 里 NULL 排最前的默认行为**刻意对齐**（两个后端的顺序必须逐字一致）。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 分类行数组
   */
  listLedgerCategories(uid) {
    return lsql(this,
      `SELECT * FROM ledger_categories
        WHERE user_id=?
        ORDER BY COALESCE(parent_id, 0) ASC, COALESCE(sort_order, 0) ASC, id ASC`,
      [Number(uid)],
    );
  },

  /**
   * 功能：按 id + 归属取一个收支分类；不存在或不属于该账号都返回 null（越权与不存在统一 404）。
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @returns {?Object} 命中的行；未命中为 null
   */
  getLedgerCategory(uid, id) {
    return (
      ldb(this).prepare('SELECT * FROM ledger_categories WHERE id=? AND user_id=?').get(Number(id), Number(uid)) ||
      null
    );
  },

  /**
   * 功能：插一个收支分类，返回落地后的那一行。
   *
   * 说明：⚠️ `ie` **只有一级填**（二级写 `null`、继承父 —— / §4.3 ②）：
   *      冗余存一遍必然与父漂移，而「这一笔算哪一侧」全靠它。
   *      ⚠️ `name` **允许重名**（与账户名同一条纪律），故这里没有唯一约束可撞。
   *      ⚠️⭐ `builtin` 也在这条 INSERT 里（**手写的列清单**）：漏了它 = **建分类时带的标记静默丢掉**
   *      （seed / 恢复内置分类都会写 1，用户新建则落 0）。
   *
   * @param {number} uid - 用户 id
   * @param {{parent_id?: ?number, name: string, ie?: ?string, sort_order?: number, builtin?: number}} values - 要写的列
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行
   */
  insertLedgerCategory(uid, values, stamp) {
    const v = values || {};
    const info = ldb(this)
      .prepare(
        `INSERT INTO ledger_categories (user_id, parent_id, name, ie, sort_order, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Number(uid),
        v.parent_id == null ? null : Number(v.parent_id),
        String(v.name),
        v.ie == null ? null : String(v.ie),
        Number(v.sort_order) || 0,
        Number(v.builtin) === 1 ? 1 : 0,
        stamp,
        stamp,
      );
    return ldb(this).prepare('SELECT * FROM ledger_categories WHERE id=?').get(Number(info.lastInsertRowid)) || null;
  },

  /**
   * 功能：改一个收支分类（**只允许改 `name` 与 `sort_order`**）。
   *
   * 说明：⭐⭐ `ie` 与 `parent_id` **一个都不进 SET**，这是刻意的（§6.3 第 1 条）：
   *      · 改 `ie` ⇒ 历史流水整批跨到另一侧（「支出」变「收入」），而流水那条记录上**什么都没变**；
   *      · 改 `parent_id` ⇒ 那是「搬家」，是另一件事。
   *      ⇒ 想改这两样只有一条路：归档重建（可见、可解释）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @param {{name: string, sort_order?: number}} values - 要写的列
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {boolean} 是否真的改到了一行
   */
  updateLedgerCategory(uid, id, values, stamp) {
    const v = values || {};
    const r = ldb(this)
      .prepare('UPDATE ledger_categories SET name=?, sort_order=?, updated_at=? WHERE id=? AND user_id=?')
      .run(String(v.name), Number(v.sort_order) || 0, stamp, Number(id), Number(uid));
    return r.changes > 0;
  },

  /**
   * 功能：**归档**一个收支分类（`archived_at` 落一个时刻，行留着）。
   *
   * 说明：⭐⭐ 删除＝归档：⛔ 不做物理删、⛔ 不把历史流水挪到「其它」——
   *      流水照旧指着这个 id、名字照显，只是**不再出现在选择器里**。
   *      ⚠️ **幂等**：已经归档过的再归档一次不算失败（`COALESCE` 保住第一次的时刻）——
   *      把「重复点一下」判成 404 会让人以为「这条已经没了」，而它明明还在历史流水上。
   *      ⚠️ 返回 `false` 只表示「不是这个账号的 / 压根不存在」。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @param {number} stamp - 归档时刻（epoch 毫秒）
   * @returns {boolean} 这一行存在且属于本人为 true
   */
  archiveLedgerCategory(uid, id, stamp) {
    const u = Number(uid);
    const c = Number(id);
    const row = ldb(this).prepare('SELECT id FROM ledger_categories WHERE id=? AND user_id=?').get(c, u);
    if (!row) return false;
    ldb(this)
      .prepare(
        'UPDATE ledger_categories SET archived_at=COALESCE(archived_at, ?), updated_at=? WHERE id=? AND user_id=?',
      )
      .run(stamp, stamp, c, u);
    return true;
  },

  /**
   * 功能：把 `fromId` 下面的**全部二级分类**整批改挂到 `toId` 名下（「移动到其它」，C-29）。
   *
   * 说明：⚠️ 只动 `parent_id` 一列：**名字不变**（「名字不变」）、`ie` 不变
   *      （二级的 `ie` 本来就是 NULL、继承父）⇒ 于是「挪一下」这件事在历史流水上**看不出痕迹**。
   *      ⚠️ 它**不负责**「`toId` 是不是同一侧的『其它』」—— 那是业务层的口径
   *      （要把子分类挪到**同侧**那个「其它」下面；挪到另一侧等于把支出静默变成收入）。
   *
   * @param {number} uid - 用户 id
   * @param {number} fromId - 原父分类 id
   * @param {number} toId - 新父分类 id（同侧的「其它」）
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {number} 改到的行数
   */
  reassignLedgerCategoryChildren(uid, fromId, toId, stamp) {
    return ldb(this)
      .prepare('UPDATE ledger_categories SET parent_id=?, updated_at=? WHERE user_id=? AND parent_id=?')
      .run(Number(toId), stamp, Number(uid), Number(fromId)).changes;
  },

  /**
   * 功能：把**直接挂在** `fromId` 上的记账条目整批改挂到 `toId` 名下（真删除那个分类时用）。
   *
   * 说明：⚠️ ⭐ **只改「直接挂在这个分类上」的那些**（`category_id = fromId`）：挂在它
   *      **子分类**名下的流水⛔ 不动 —— 子分类是被**改挂**（`reassignLedgerCategoryChildren`），
   *      它们名下的账跟着子分类走。只动 `category_id` 一列：金额 / 时刻 / 账户一个字不改
   *      （所以**余额与快照都不受影响**，⛔ 不用重算快照）。
   *      ⚠️ 它**不负责**「`toId` 是不是同一侧的『其它』」—— 那是业务层的口径（挪到另一侧
   *      等于把一笔支出静默变成收入）。
   *
   * @param {number} uid - 用户 id
   * @param {number} fromId - 原分类 id
   * @param {number} toId - 新分类 id（同侧的「其它」）
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {number} 改到的行数
   */
  reassignLedgerCategoryEntries(uid, fromId, toId, stamp) {
    return ldb(this)
      .prepare('UPDATE ledger_entries SET category_id=?, updated_at=? WHERE user_id=? AND category_id=?')
      .run(Number(toId), stamp, Number(uid), Number(fromId)).changes;
  },

  /**
   * 功能：**取消归档**一个收支分类（把 `archived_at` 清成 `NULL`，其余一个字不动）。
   *
   * 说明：⭐ 它就是「删除＝归档」那条口径的**回程**：归档是行留着、只在
   *      选择器里消失；恢复就是让那一行**重新可选**。⚠️ **不判重**：它的全称本来就还占着
   *      （判重不排除已归档的，见 `lib/categories.js` 的 `nameTaken()`）。
   *      ⚠️ 返回 `false` 只表示「不是这个账号的 / 压根不存在」——「本来就没归档」那条判据
   *      住业务层（要回一句可读的 400，而不是静默成功）。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {boolean} 这一行存在且属于本人为 true
   */
  restoreLedgerCategory(uid, id, stamp) {
    return (
      ldb(this)
        .prepare('UPDATE ledger_categories SET archived_at=NULL, updated_at=? WHERE id=? AND user_id=?')
        .run(stamp, Number(id), Number(uid)).changes > 0
    );
  },

  /**
   * 功能：**硬删**一个收支分类行（⛔ 与「归档」是两件事：这个删完那一行就没了）。
   *
   * 说明：⭐⭐ 它**只管删这一行**（⛔ 不碰流水、不碰子分类、不碰默认账户）：那三件事的
   *      顺序与落点**全住业务层**（`ledgerDeleteCategory`）——「一个原语一件事」，
   *      两个后端才不用各写一遍同样的分支。
   *      ⚠️ 越权与不存在在这一层是同一件事（回 `false`）：`user_id` 一起在 `WHERE` 里。
   *      ⚠️ 删完之后历史流水的 `category_id` 会指向**不存在的行** ⇒ 前端显示「未分类」——
   *      本动作不会走到那一步（业务层先把那些流水改挂到「其它」），但原语层不替它兜。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 分类 id
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteLedgerCategory(uid, id) {
    return (
      ldb(this).prepare('DELETE FROM ledger_categories WHERE id=? AND user_id=?').run(Number(id), Number(uid)).changes > 0
    );
  },

  /**
   * 功能：**幂等地**把预置的 22 行收支分类灌进这个账号（⭐ 全部标 `builtin = 1`）。
   *
   * 说明：⭐⭐ 判据是「**这个账号一个分类都没有**」而不是「缺哪行补哪行」（第 4 条 /
   *      §4.4 ③）：按后者的话，用户删掉的预置分类**下次进这一屏又冒出来**——
   *      而用户删它正是因为不想再看到它。
   *      ⚠️ `sort_order` 直接取**数组下标**（0 起，跨两侧全局编号）：`lib/categories.js` 的
   *      注释写着「顺序即 sort_order」，前端按 `ie` 过滤后再排，两侧各自从 0 开始显示等价。
   *      ⭐ 起这批预置就是**内置分类**（既定的 22 行）⇒ `builtin` 写 `1`，
   *      用户既删不掉也改不了名（判据在业务层，看的就是这一列）。
   *      ⚠️ 它是**种子**、不是业务写：只在这个账号还没有任何分类时落库。
   *
   * @param {number} uid - 用户 id
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {number} 实际插入的行数（已有分类时为 0）
   */
  seedLedgerCategories(uid, stamp) {
    const u = Number(uid);
    const cnt = ldb(this).prepare('SELECT COUNT(*) AS n FROM ledger_categories WHERE user_id=?').get(u);
    if (Number(cnt && cnt.n) > 0) return 0;
    const st = ldb(this).prepare(
      `INSERT INTO ledger_categories (user_id, parent_id, name, ie, sort_order, builtin, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, 1, ?, ?)`,
    );
    let n = 0;
    CATEGORY_PRESETS.forEach((c, i) => {
      st.run(u, c.name, c.ie, i, stamp, stamp);
      n += 1;
    });
    return n;
  },

  /**
   * 功能：把本账号的收支分类**对齐到内置清单** —— 补全内置 ＋（硬）删掉旧预置。
   *
   * 说明：⭐⭐ 顺序**不能颠倒**（① 必须在 ② 之前）：② 要把旧预置的二级分类挪到「其它」下面，
   *      而「其它」得先由 ① 保证存在 —— 反过来写的话，一个连「其它」都没有的老库上，
   *      那些二级分类会**没地方去**（要么被一起删掉、要么变成指向不存在父的孤儿）。
   *      ① **补全内置**：按「同 `ie` 且同名且 `parent_id` 为空」认那一行 ——
   *        · 找到 ⇒ 标 `builtin = 1`（`marked`）。⚠️⭐ **已归档的也算「找到」**：把它标成内置，
   *          但**不动它的 `archived_at`** —— 这个动作不负责取消归档，那是另一件事（用户自己选）。
   *          只在「本来不是 1」时才 UPDATE（于是**再跑一次 `marked` 也是 0**，幂等）。
   *        · 没找到 ⇒ INSERT 一行（`parent_id = NULL`、`builtin = 1`、`sort_order` = 预置下标）（`added`）。
   *      ② **清旧预置**：要删的 ＝ 一级（`parent_id` 为空）且 `builtin = 0` 且名字在
   *        `LEGACY_PRESET_NAMES` 里且**不在**新清单的名字集里。
   *        · 它的**未归档**二级分类 ⇒ `parent_id` 改成**同一侧**的「其它」那一行（`moved`）；
   *          ⚠️ 「同侧」的判据走 `isOther(cat, row.ie)`：把支出的子分类挪到收入侧的「其它」下面，
   *          就是**静默把一笔支出变成收入**（金额照旧，界面上却换了一侧）。
   *          ⚠️ **已归档的子分类不动**（它本来就该在归档区里）。
   *        · 然后 `DELETE` 那一行（`removed`）。
   *      ③ 只删**一级**：旧预置全是一级，二级是用户自己建的，⛔ 一条都不删。
   *
   *      ⚠️⭐ **硬删的后果（知情并接受）**：历史流水的 `category_id` 会指向一个不存在的行 ⇒
   *      前端 `catName()` 找不到就显示「未分类」（
   *      **他显式点的这个动作**，不是自动跑的）。
   *      ⚠️ 名字撞车的代价：用户若自己建了个叫「零食」的分类，会被一起删掉 ——
   *      数据层分不出「旧预置」与「同名的自建行」（`LEGACY_PRESET_NAMES` 的说明里写着）。
   *
   * @param {number} uid - 用户 id
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {{removed: number, added: number, marked: number, moved: number}} 四个计数
   */
  restoreBuiltinCategories(uid, stamp) {
    const u = Number(uid);
    const db = ldb(this);
    const newNames = new Set(CATEGORY_PRESETS.map((p) => String(p.name)));
    const legacyNames = new Set(LEGACY_PRESET_NAMES.map((n) => String(n)));
    let removed = 0;
    let added = 0;
    let marked = 0;
    let moved = 0;
    db.exec('BEGIN');
    try {
      // ① 补全内置（⛔ 必须在 ② 之前 —— ② 需要「其它」已经存在当落点）
      CATEGORY_PRESETS.forEach((p, i) => {
        const row = db
          .prepare(
            `SELECT * FROM ledger_categories
              WHERE user_id=? AND parent_id IS NULL AND ie=? AND name=?
              ORDER BY id ASC LIMIT 1`,
          )
          .get(u, String(p.ie), String(p.name));
        if (row) {
          // ⚠️ 已归档的也算「找到」——只标 `builtin`，**不动** `archived_at`（本动作不负责取消归档）；
          //    只在「本来不是 1」时才改，于是第二次跑 `marked` 也是 0（幂等）
          marked += db
            .prepare('UPDATE ledger_categories SET builtin=1, updated_at=? WHERE id=? AND user_id=? AND builtin<>1')
            .run(stamp, Number(row.id), u).changes;
          return;
        }
        db.prepare(
          `INSERT INTO ledger_categories (user_id, parent_id, name, ie, sort_order, builtin, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?, 1, ?, ?)`,
        ).run(u, String(p.name), String(p.ie), i, stamp, stamp);
        added += 1;
      });

      // ② 清旧预置（只认一级、且名字在旧名单里又不在新清单里）
      const doomed = ldb(this)
        // ⚠️ 用 `builtin<>1` 而**不是** `builtin=0`：与 json 后端那一头（`Number(r.builtin) !== 1`）
        //    保持**同一条判据**—— 两处各写一个"今天等价"的写法，迟早会漂移。
        .prepare('SELECT * FROM ledger_categories WHERE user_id=? AND parent_id IS NULL AND builtin<>1 ORDER BY id ASC')
        .all(u)
        .filter((r) => legacyNames.has(String(r.name)) && !newNames.has(String(r.name)));
      for (const row of doomed) {
        // ⭐ 落点必须是**同一侧**的「其它」（`row.ie`）——挪到另一侧就是把支出静默变成收入
        const other = ldb(this)
          .prepare('SELECT * FROM ledger_categories WHERE user_id=? AND parent_id IS NULL ORDER BY id ASC')
          .all(u)
          .find((c) => isOther(c, row.ie));
        if (other) {
          // ⚠️ 只挪**未归档**的二级分类（已归档的本来就该留在归档区里，跟着一行走没意义）
          moved += db
            .prepare(
              `UPDATE ledger_categories SET parent_id=?, updated_at=?
                WHERE user_id=? AND parent_id=? AND archived_at IS NULL`,
            )
            .run(Number(other.id), stamp, u, Number(row.id)).changes;
        }
        removed += db.prepare('DELETE FROM ledger_categories WHERE id=? AND user_id=?').run(Number(row.id), u).changes;
      }

      // ③ 顺手清掉这些分类身上的「每种类别的默认账户」行 —— 分类已经没了，那一行就是**指向不存在分类的孤行**。
      //    ⚠️ 它不会串到新分类上（`ledger_categories.id` 是 AUTOINCREMENT、id 不复用 ⇒ 新建的分类拿到的是新号），
      //    界面也看不见（两端都拿 `state.lgCats` 回查，查不到就不画）—— 但留着它就是一条**永远读不到的垃圾**，
      //    而且与全项目「删主体要连附属一起删」的口径不一致（先例：删原交易连带删它的退款，C-14）。
      //    ⚠️ 只删 `kind='category'` 那一层：全局两层（`income` / `expense`，`category_id=0` 哨兵）一个字不动。
      if (doomed.length) {
        const ph = doomed.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM ledger_default_accounts WHERE user_id=? AND kind='category' AND category_id IN (${ph})`,
        ).run(u, ...doomed.map((r) => Number(r.id)));
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
    return { removed, added, marked, moved };
  },

  // ---- 默认账户（2 期， 第 19 条）----
  /**
   * 功能：取本账号的全部默认账户行（全局两层 ＋ 每类别一层，一张表装两层）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 默认账户行数组
   */
  listLedgerDefaults(uid) {
    return lsql(this,
      'SELECT * FROM ledger_default_accounts WHERE user_id=? ORDER BY kind ASC, category_id ASC, id ASC',
      [Number(uid)],
    );
  },

  /**
   * 功能：写一行默认账户（**upsert**：`(user_id, kind, category_id)` 是唯一落点）。
   *
   * 说明：⭐⭐ 为什么用 upsert 而不是「有则改、无则插」分两步：唯一约束是落点，
   *      `ON CONFLICT DO UPDATE` 一句话就把「重复设同一个类别」收敛成一行
   *      —— 分两步写会造出一个**中间窗口**（查到没有、插之前别人插了）⇒ 两行同键。
   *      ⚠️ 全局两层传 `categoryId = 0`（**哨兵，不是 NULL**）：SQLite 的 `UNIQUE` 把 NULL 当互不相等，
   *      用 NULL 表示「全局」会让那两行**可以重复插**（唯一约束形同虚设，且不报错）。
   *
   * @param {number} uid - 用户 id
   * @param {string} kind - `'income'` / `'expense'` / `'category'`
   * @param {number} categoryId - 分类 id；全局两层传 `0`
   * @param {number} accountId - 默认账户 id（可以指向空账户）
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行
   */
  upsertLedgerDefault(uid, kind, categoryId, accountId, stamp) {
    const u = Number(uid);
    const k = String(kind);
    const c = Number(categoryId) || 0;
    ldb(this)
      .prepare(
        `INSERT INTO ledger_default_accounts (user_id, kind, category_id, account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind, category_id) DO UPDATE SET
           account_id=excluded.account_id, updated_at=excluded.updated_at`,
      )
      .run(u, k, c, Number(accountId), stamp, stamp);
    return (
      ldb(this)
        .prepare('SELECT * FROM ledger_default_accounts WHERE user_id=? AND kind=? AND category_id=?')
        .get(u, k, c) || null
    );
  },

  /**
   * 功能：删一行默认账户（**只该用于「每类别」那一层**）。
   *
   * 说明：⚠️ 全局两层（`kind` 为 `income` / `expense`）**不可以删** —— 那条判据住业务层
   *      （全局默认是固定两层、只能改）：删掉它，界面上那两个格子就再也没有
   *      「怎么回到默认」这条路了。本层不管这件事，只是把行删掉。
   *
   * @param {number} uid - 用户 id
   * @param {string} kind - `'income'` / `'expense'` / `'category'`
   * @param {number} categoryId - 分类 id；全局两层传 `0`
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteLedgerDefault(uid, kind, categoryId) {
    return (
      ldb(this)
        .prepare('DELETE FROM ledger_default_accounts WHERE user_id=? AND kind=? AND category_id=?')
        .run(Number(uid), String(kind), Number(categoryId) || 0).changes > 0
    );
  },

  // ---- 删除记录（2 期）----
  /**
   * 功能：往「删除记录」表里记一行（`UNIQUE(user_id, account_id)` 让重复写收敛成一行）。
   *
   * 说明：⭐ 这张表存在的**唯一理由**是 `name`（`schema.js` 里写着）：账户被硬删之后，
   *      转账 / 流水 / 手动调整还指着那个**原 id**，要显示「原账户名」全靠它。
   *      ⚠️ `AUTOINCREMENT` 不复用 id ⇒ 「同一个 id 又被新建的账户顶掉」不会发生。
   *
   * @param {number} uid - 用户 id
   * @param {number} accountId - 被删掉的账户 id（原 id）
   * @param {string} name - 原名字
   * @param {number} stamp - 删除时刻（epoch 毫秒）
   * @returns {Object} 写入后的行
   */
  insertLedgerAccountDeletion(uid, accountId, name, stamp) {
    const u = Number(uid);
    const a = Number(accountId);
    ldb(this)
      .prepare(
        `INSERT INTO ledger_account_deletions (user_id, account_id, name, deleted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, account_id) DO UPDATE SET name=excluded.name, deleted_at=excluded.deleted_at`,
      )
      .run(u, a, String(name), stamp);
    return (
      ldb(this).prepare('SELECT * FROM ledger_account_deletions WHERE user_id=? AND account_id=?').get(u, a) || null
    );
  },

  /**
   * 功能：取本账号的全部删除记录（老的在前）。
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 删除记录行数组
   */
  listLedgerAccountDeletions(uid) {
    return lsql(this, 'SELECT * FROM ledger_account_deletions WHERE user_id=? ORDER BY id ASC', [Number(uid)]);
  },

  /**
   * 功能：**原子地**删一个账户 —— 一个事务里「写一行删除记录 ＋ 硬删账户行」。
   *
   * 说明：⭐⭐⭐ 这是 2 期改掉 1 期行为的那一处：1 期是「硬删账户 ＋ 连带删掉
   *      所有与它有关的转账明细」，现在是「**写删除记录 ＋ 硬删账户行**」——
   *      转账 / 流水 / 手动调整**一条都不动**（它们的 id 照旧指着那个已经没有行的账户）。
   *      ⚠️ 为什么必须在**一个事务**里：只做一半的两个方向都是静默事故 ——
   *      · 只写记录不删行 ⇒ 账户还在列表里，用户以为没删掉；
   *      · 只删行不写记录 ⇒ 那条转账从此**显示不出账户名**（界面上是一个空名字），而且再也补不回来。
   *      ⚠️ 顺序是「先写记录、后删行」：中途失败也不会出现「行没了、名字也没了」那种不可恢复态。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 账户 id
   * @param {string} name - 这个账户**当前的名字**（调用方先取一次现状，拿它直接写记录）
   * @param {number} stamp - 删除时刻（epoch 毫秒）
   * @returns {boolean} 是否真的删掉了一行（不属于本人 / 不存在时为 false）
   */
  deleteLedgerAccountWithRecord(uid, id, name, stamp) {
    const u = Number(uid);
    const a = Number(id);
    const db = ldb(this);
    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT INTO ledger_account_deletions (user_id, account_id, name, deleted_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, account_id) DO UPDATE SET name=excluded.name, deleted_at=excluded.deleted_at`,
      ).run(u, a, String(name), stamp);
      const hit = db.prepare('DELETE FROM ledger_accounts WHERE id=? AND user_id=?').run(a, u).changes;
      db.exec('COMMIT');
      return hit > 0;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
  },

  /**
   * 功能：取「账户 id → 名字」的**合并视图** —— 账户表 ∪ 删除记录表（C-8 的唯一判据）。
   *
   * 说明：⭐⭐ 为什么必须合成一处：转账明细、流水列表、账户筛选**都要**
   *      显示账户名，而「先查账户表、查不到再查删除记录表」这条判据写两遍**必然漂移**
   *      —— 漂移的表现是「同一个账户，在流水里显示得出名字、在转账明细里显示不出来」。
   *      ⚠️ `deleted: true` 让调用方能**区分**「还在的账户」与「已删的账户」：
   *      已删账户**不该出现在任何筛选 / 统计里**（C-28），但**名字仍然要能查得到**。
   *      ⚠️ `special: 1` 那一行也在这里（它就是「不关联」那一项要用的 id）—— 它是一行真账户。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<{id: number, name: string, deleted: boolean, special: number}>} 合并后的名字表
   */
  ledgerAccountNames(uid) {
    const u = Number(uid);
    const out = lsql(this, 'SELECT id, name, special FROM ledger_accounts WHERE user_id=? ORDER BY id ASC', [u]).map(
      (r) => ({
        id: Number(r.id),
        name: String(r.name == null ? '' : r.name),
        deleted: false,
        special: Number(r.special) === 1 ? 1 : 0,
      }),
    );
    const seen = new Set(out.map((r) => r.id));
    lsql(this, 'SELECT account_id, name FROM ledger_account_deletions WHERE user_id=? ORDER BY id ASC', [u]).forEach(
      (d) => {
        const id = Number(d.account_id);
        if (seen.has(id)) return; // 账户行还在（正常不该发生）⇒ 以账户表为准
        out.push({ id, name: String(d.name == null ? '' : d.name), deleted: true, special: 0 });
      },
    );
    return out;
  },

  // ---- 手动调整余额（2 期， 第 4 / 5 条）----
  /**
   * 功能：取本账号**全部**手动调整记录（按时刻升序）。
   *
   * 说明：⭐ 取数形态选的是**按账号**（而不是按账户）那一种（二选一里的一支），理由有二：
   *      ① 余额派生要的正是**这个账号的全部调整**（`lib/balance.js` 按账户分桶），
   *      按账户取就变成 N+1；② 账户详情那一屏要的三类混排也只是 JS 里一次 `filter`
   *      —— 于是「按账户取」这一支**没有任何消费者**，加了就是白维护一份。
   *      ⚠️ 这张表**只增不改不删**⇒ 没有 update / delete 原语。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 调整记录行数组（按时刻升序）
   */
  listLedgerAdjustmentsByUser(uid) {
    return lsql(this,
      'SELECT * FROM ledger_adjustments WHERE user_id=? ORDER BY at ASC, id ASC',
      [Number(uid)],
    );
  },

  /**
   * 功能：写一行手动调整记录（**只记数、不改账户**）。
   *
   * 说明：⚠️ 与 `applyLedgerAdjustment` 的分工：这一个只写留痕那一行，
   *      适合「账户的基准已经在别处改好了」或补一条历史记录的场景；
   *      「用户改余额」那条正常路径走 `applyLedgerAdjustment`（它才是一个事务）。
   *      ⚠️ `from_fen` / `to_fen` 都是**绝对值**（不是增量）—— 界面要显示「从 X 调整为 Y」。
   *
   * @param {number} uid - 用户 id
   * @param {{account_id: number, at: string, from_fen: number, to_fen: number}} values - 要写的列
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行
   */
  insertLedgerAdjustment(uid, values, stamp) {
    const v = values || {};
    const info = ldb(this)
      .prepare(
        `INSERT INTO ledger_adjustments (user_id, account_id, at, from_fen, to_fen, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Number(uid),
        Number(v.account_id),
        String(v.at),
        Math.trunc(Number(v.from_fen)) || 0,
        Math.trunc(Number(v.to_fen)) || 0,
        stamp,
      );
    return ldb(this).prepare('SELECT * FROM ledger_adjustments WHERE id=?').get(Number(info.lastInsertRowid)) || null;
  },

  /**
   * 功能：**原子地**把余额钉成一个新值 —— 一个事务里「写一行调整记录 ＋ 把 `opening_fen` 改成新值」。
   *
   * 说明：⭐⭐ 为什么必须是**一个原语、一个事务**：这两件事分开写会出现
   *      「留痕说从 2000 调到 5000、而账户的基准其实还是 3000」这种**账实不符**
   *      —— 界面上一条漂亮的「从 X 调整为 Y」，余额却对不上它，而且两边都不报错。
   *      ⚠️ 顺序是「先写调整记录、后改账户」：先用同一个值写进两处，中途失败就整体回滚。
   *      ⚠️ `fromFen` 由调用方算好传进来（它是**当前派生余额**，要读库里的三类变动 ——
   *      那是业务层的活），本层只负责「把这一个数原样落进两处」。
   *
   * @param {number} uid - 用户 id
   * @param {number} id - 账户 id
   * @param {number} fromFen - 调整**前**的余额绝对值（派生出来的那个数）
   * @param {number} toFen - 调整**后**的余额绝对值（＝新的基准）
   * @param {string} at - 调整时刻 `YYYY-MM-DD HH:MM:SS`（服务端当前时刻）
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {?Object} 新建的调整记录；账户不存在 / 不属于本人时为 null（已回滚）
   */
  applyLedgerAdjustment(uid, id, fromFen, toFen, at, stamp) {
    const u = Number(uid);
    const a = Number(id);
    const to = Math.trunc(Number(toFen)) || 0;
    const db = ldb(this);
    db.exec('BEGIN');
    try {
      const info = db
        .prepare(
          `INSERT INTO ledger_adjustments (user_id, account_id, at, from_fen, to_fen, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(u, a, String(at), Math.trunc(Number(fromFen)) || 0, to, stamp);
      const hit = db
        .prepare('UPDATE ledger_accounts SET opening_fen=?, updated_at=? WHERE id=? AND user_id=?')
        .run(to, stamp, a, u).changes;
      if (!hit) {
        db.exec('ROLLBACK');
        return null;
      }
      const row = db.prepare('SELECT * FROM ledger_adjustments WHERE id=?').get(Number(info.lastInsertRowid)) || null;
      db.exec('COMMIT');
      return row;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
  },

  // ---- 空账户（2 期）----
  /**
   * 功能：取这个账号的**空账户**那一行；还没有时回 `null`（⛔ 不在这里顺手建）。
   *
   * 说明：⚠️ 取与建分成两个原语，为的是**读路径不写库**：`ledgerAccountNames()` / 派生余额
   *      这类只读路径要用它的 id，但它们**不该**因为「被读了一次」就造出一行来
   *      （GET 一律无副作用）。
   *
   * @param {number} uid - 用户 id
   * @returns {?Object} 空账户那一行；不存在时为 null
   */
  getLedgerSpecialAccount(uid) {
    return ldb(this).prepare('SELECT * FROM ledger_accounts WHERE user_id=? AND special=1 ORDER BY id ASC').get(Number(uid)) || null;
  },

  /**
   * 功能：**幂等地**保证这个账号有一行空账户，返回它（已经有了就原样返回）。
   *
   * 说明：⭐⭐ 空账户是一行**真账户**：
   *      它有稳定 id、能被流水指着，只是**不显示、不可删、不参与净值**。
   *      ⚠️ 它的属性全部写死在这里（`kind='custom'` / `name='空账户'` / `opening_fen=0` /
   *      `sort_order=0` / `special=1`）：它是**系统行**，用户改不了它的名字（界面上压根不出现）。
   *      ⚠️ 每个账号**恰好一行**这条约束由**部分唯一索引**（`idx_ledger_accounts_special`）守着，
   *      本函数只负责「先查、没有才插」——两者都要有：只靠索引的话并发插入会当场抛错。
   *
   * @param {number} uid - 用户 id
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {?Object} 空账户那一行（新建或原有的）
   */
  ensureLedgerSpecialAccount(uid, stamp) {
    const u = Number(uid);
    const cur = ldb(this)
      .prepare('SELECT * FROM ledger_accounts WHERE user_id=? AND special=1 ORDER BY id ASC')
      .get(u);
    if (cur) return cur;
    const info = ldb(this)
      .prepare(
        `INSERT INTO ledger_accounts
           (user_id, kind, name, tail, note, opening_fen, sort_order, special, created_at, updated_at)
         VALUES (?, 'custom', '空账户', NULL, NULL, 0, 0, 1, ?, ?)`,
      )
      .run(u, stamp, stamp);
    return ldb(this).prepare('SELECT * FROM ledger_accounts WHERE id=?').get(Number(info.lastInsertRowid)) || null;
  },

  // ---- 预算（3 期）----
  /**
   * 功能：取**某一期**的全部预算行（总预算 ＋ 分类预算一次给全）。
   *
   * 说明：⭐⭐ 本期的两种取数都由它兜住（方案 §4.3 说明 4）：
   *      「取某一期的全部行」（含总预算）与「取某一期的总预算那一行」（调用方自己 `.find(category_id === 0)`）
   *      —— ⛔ **不另建一个 `selectLedgerBudgetOne`**：多一个原语 = 两后端各多一份实现、
   *      契约多一条要对的账，而它的消费者只是把返回的数组过滤一下。
   *      ⚠️⭐ **排序键只有 `category_id`**（`0` 总预算在最前、分类升序）：唯一约束
   *      `(user_id, period_type, period_key, category_id)` 已经保证「同一期同一个 `category_id`
   *      只有一行」⇒ 这个排序键是**全序**（⛔ 不必再拿 `id` 兜底，那不是判据是运气）。
   *      ⚠️ **本层不算「已用」**（那是 `lib/budget.js` 的活）：它只按 `period_type` / `period_key`
   *      把行取回来，⛔ 不过滤未来条目（`now` 的权威在业务层，方案 §5.2 的两条「不要做的事」）。
   *
   * @param {number} uid - 用户 id
   * @param {string} periodType - `'week'` / `'month'` / `'year'`
   * @param {string} periodKey - 该期的起始日 `YYYY-MM-DD`
   * @returns {Array.<Object>} 该期的全部预算行
   */
  selectLedgerBudgets(uid, periodType, periodKey) {
    return lsql(this,
      `SELECT * FROM ledger_budgets
        WHERE user_id=? AND period_type=? AND period_key=?
        ORDER BY category_id ASC`,
      [Number(uid), String(periodType), String(periodKey)],
    );
  },

  /**
   * 功能：设 / 改**一行**额度（**upsert**：`(user_id, period_type, period_key, category_id)` 是唯一落点）。
   *
   * 说明：⭐⭐ 为什么用 upsert 而不是「有则改、无则插」分两步：唯一约束是落点，
   *      `ON CONFLICT DO UPDATE` 一句话就把「同一期同一维度设两次」收敛成一行
   *      —— 分两步写会造出一个**中间窗口**（查到没有、插之前别人插了）⇒ 两行同键，
   *      而界面上会同时出现两份同一期的预算（谁生效取决于查出来的先后，静默且难查）。
   *      ⚠️⭐ **命中唯一约束时是「更新」不是 400**（方案 §5.5）：用户改一个额度是**正常操作**。
   *      ⚠️ 总预算传 `categoryId = 0`（**哨兵，不是 NULL**）：SQLite 的 `UNIQUE` 把 NULL 当互不相等，
   *      用 NULL 表示「总预算」会让它**可以重复插**（唯一约束形同虚设，且不报错）。
   *      ⚠️ `amount_fen = 0` 是一个**合法值**（明确设成 0元）；「没设」＝这一行不存在 ⇒ ⛔ 不许
   *      把 0 当成「删除」（删除是 `deleteLedgerBudget` 那条路）。
   *
   * @param {number} uid - 用户 id
   * @param {string} periodType - `'week'` / `'month'` / `'year'`
   * @param {string} periodKey - 该期的起始日 `YYYY-MM-DD`
   * @param {number} categoryId - 分类 id；**总预算传 `0`**
   * @param {number} amountFen - 额度（整数分；允许 0）
   * @param {number} stamp - 写入时间戳（epoch 毫秒）
   * @returns {Object} 写入后的行
   */
  upsertLedgerBudget(uid, periodType, periodKey, categoryId, amountFen, stamp) {
    const u = Number(uid);
    const t = String(periodType);
    const k = String(periodKey);
    const c = Number(categoryId) || 0;
    ldb(this)
      .prepare(
        `INSERT INTO ledger_budgets (user_id, period_type, period_key, category_id, amount_fen, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, period_type, period_key, category_id) DO UPDATE SET
           amount_fen=excluded.amount_fen, updated_at=excluded.updated_at`,
      )
      .run(u, t, k, c, Math.trunc(Number(amountFen)) || 0, stamp, stamp);
    return (
      ldb(this)
        .prepare('SELECT * FROM ledger_budgets WHERE user_id=? AND period_type=? AND period_key=? AND category_id=?')
        .get(u, t, k, c) || null
    );
  },

  /**
   * 功能：删**一行**额度（清某一份预算）—— 没删到任何行时回 `false`。
   *
   * 说明：⚠️ 越权与不存在**在这一层是同一件事**（回 `false`）：`user_id` 一起在 `WHERE` 里，
   *      「别人的那一行」与「压根没有那一行」都删不到 ⇒ 上层据此回 404（
   *      越权与不存在统一 404，⛔ 不写 403 —— 403 是探测通道）。
   *      ⚠️⭐ 「清总预算要连带清掉该期全部分类预算」那条口径**不住这里**（那是
   *      `deleteLedgerBudgetsForPeriod` 的活）：本函数只删它点名的那一行，
   *      ⛔ 不自己判 `categoryId === 0`（把两件事混进一个原语，两后端就得各写一遍那条分支）。
   *
   * @param {number} uid - 用户 id
   * @param {string} periodType - `'week'` / `'month'` / `'year'`
   * @param {string} periodKey - 该期的起始日 `YYYY-MM-DD`
   * @param {number} categoryId - 分类 id；**总预算传 `0`**
   * @returns {boolean} 是否真的删掉了一行
   */
  deleteLedgerBudget(uid, periodType, periodKey, categoryId) {
    return (
      ldb(this)
        .prepare(`DELETE FROM ledger_budgets WHERE user_id=? AND period_type=? AND period_key=? AND category_id=?`)
        .run(Number(uid), String(periodType), String(periodKey), Number(categoryId) || 0).changes > 0
    );
  },

  /**
   * 功能：⭐ **清掉这一期的全部行**（总预算 ＋ 它名下的所有分类预算）—— 回删掉的行数。
   *
   * 说明：⭐⭐ 它是「清除总预算」的落点：**一个事务**里把
   *      `(user_id, period_type, period_key)` 这一期的行全删掉，**要么都成、要么都不成**
   *      —— 失败方向是**保持原样**（⛔ 不许出现「总预算没了、分类预算还在」的半截状态，
   *      那会让界面显示一堆没有总额的分类预算栏，而用户以为自己什么都清掉了）。
   *      ⚠️ **一条 `DELETE` 本身就不可分割**，这里仍然显式 `BEGIN` / `COMMIT`：
   *      一是把「这是一次全清」写在代码里（照 `reorderRows()` 的先例），
   *      二是它与「先删分类、再删总预算」那句描述**等价**（一条语句覆盖两种行），
   *      ⛔ 别拆成两条 —— 拆了才真的需要事务来兜。
   *      ⚠️ **回滚失败忽略**（`catch` 里只 `ROLLBACK`）：原错误更重要（照 `restoreBuiltinCategories`）。
   *
   * @param {number} uid - 用户 id
   * @param {string} periodType - `'week'` / `'month'` / `'year'`
   * @param {string} periodKey - 该期的起始日 `YYYY-MM-DD`
   * @returns {number} 实际删掉的行数（0 = 这一期本来就没有预算）
   */
  deleteLedgerBudgetsForPeriod(uid, periodType, periodKey) {
    const db = ldb(this);
    let hit;
    db.exec('BEGIN');
    try {
      hit = db
        .prepare('DELETE FROM ledger_budgets WHERE user_id=? AND period_type=? AND period_key=?')
        .run(Number(uid), String(periodType), String(periodKey)).changes;
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_e) {
        /* 回滚失败忽略：原错误更重要 */
      }
      throw e;
    }
    return hit;
  },

  /**
   * 功能：取**区间原料**（记账条目里统计要的那六列）—— ⭐ 区间统计**唯一**的取数口。
   *
   * 说明：⭐⭐ 为什么必须有它（方案 §5.2 / §5.3）：账单屏要「近 6 个月」、月详情页要
   *      「对比上月」，这些全靠**多个区间**的切片 —— 而 2 期只有「按月 ＋ 游标分页」那一个原语
   *      （它收 `limit`、只回一页）⇒ 拿它去取 6 个区间就是一串 N+1，而且**页数一满就静默漏数据**。
   *      ⚠️ **只回六列**（`id` / `at` / `ie` / `amount_fen` / `category_id` / `refund_of`）：
   *      账单只要这些；⛔ 不 `SELECT *`（那会把备注 / 账户 id 也搬过边界，
   *      而它们在这条路上没有任何消费者 —— 与「没有消费者的列不进表」同一条纪律）。
   *      ⚠️ **区间是左闭右开的字典序**（`at>=from AND at<?`）；两个端点都给空串 = 不限。
   *      ⚠️ **本层不过滤未来条目**（`now` 的权威在业务层）：未来条目**照样取回来**，
   *      由 `lib/budget.js` 判「进不进合计」（见它文件头的口径 3）。
   *      ⚠️ 排序 `(at, id)` **升序**：顺序只为**结果可复现**（纯函数不假设有序，
   *      但两个后端必须给出同一个顺序，否则「同一份数据两种后端算出不同结果」）。
   *
   * @param {number} uid - 用户 id
   * @param {string} from - 区间起点（**含**）`YYYY-MM-DD`；空串 = 不限
   * @param {string} to - 区间终点（**不含**）`YYYY-MM-DD`；空串 = 不限
   * @returns {Array.<Object>} 条目行数组（六列，按 `(at, id)` 升序）
   */
  selectLedgerEntriesBetween(uid, from, to) {
    const where = ['user_id=?'];
    const params = [Number(uid)];
    if (from) {
      where.push('at>=?');
      params.push(String(from));
    }
    if (to) {
      where.push('at<?');
      params.push(String(to));
    }
    return lsql(this,
      `SELECT id, at, ie, amount_fen, category_id, refund_of
         FROM ledger_entries
        WHERE ${where.join(' AND ')}
        ORDER BY at ASC, id ASC`,
      params,
    );
  },

  /**
   * 功能：取本账号**全部**预算行（按 期类型 → 期起始日 → 维度 升序）。
   *
   * 说明：⭐⭐ 它的**唯一消费者是个人备份的导入侧**（`store/methods/backup.js` 的 `_planImport`）：
   *      导入时要拿「库里已有的这一期的行」做**去重集**，才能把「同一个维度的两份额度」
   *      收敛成一份（⛔ 不去重 = 导入两次就多出一份，而备份文件看上去完全正常）。
   *      ⚠️ 它**不是**给界面用的（界面按「一期」取数，走 `selectLedgerBudgets`）——
   *      两个原语的分工在这里，⛔ 别互相替代（`_planImport` 要的是**全部期**，
   *      而 `selectLedgerBudgets` 只认一期）。
   *      ⚠️ 排序是**全序**（三个键 + `id` 兜底）：恢复时按这份顺序逐行插，
   *      顺序确定才能让「同一期的多行」在换机后仍然按同一个先后排。
   *
   * @param {number} uid - 用户 id
   * @returns {Array.<Object>} 该账号的全部预算行
   */
  listLedgerBudgetsByUser(uid) {
    return lsql(this,
      `SELECT * FROM ledger_budgets
        WHERE user_id=?
        ORDER BY period_type ASC, period_key ASC, category_id ASC, id ASC`,
      [Number(uid)],
    );
  },

  /**
   * 功能：取本模块进**个人备份**的那一份数据。
   *
   * 说明：⭐ 账户 / 快照 / 分类 / 转账都是用户亲手攒下来的东西（换机 / 恢复之后不能丢）
   *      ⇒ **必须进个人备份**（方案 §五）。走的是**本模块自己的原语**，所以删掉本模块目录时
   *      这一份自然消失，备份里不会剩下一个「指向不存在模块」的键。
   *      ⚠️ 键名 = **表名**，必须与 `store/methods/backup.js` 的 `PERSONAL_SOURCES` 逐字一致。
   *      ⚠️ **五张表都进**：只搬账户会让净值历史在换机后静默变成一条空线；
   *      不搬转账则会让「余额是怎么变的」在换机后无从查起（明细全没了）。
   *      ⭐ 0.8.1：2 期那**四张新表**（记账条目 / 收支分类 / 默认账户 / 删除记录）也一并进 ——
   *      它们是用户亲手记下的账（记一笔 / 建分类 / 设默认 / 删账户留下的原名），
   *      漏掉任何一张的表现都是「备份看着成功、恢复后那部分账没了」，而且**不报错**。
   *      ⭐ 0.8.2：3 期那**一张**（`ledger_budgets`）同样进 —— 理由一模一样。
   *
   * @param {number} uid - 用户 id
   * @returns {{ledger_accounts: Array.<Object>, ledger_snapshots: Array.<Object>,
   *      ledger_views: Array.<Object>, ledger_view_tags: Array.<Object>,
   *      ledger_groups: Array.<Object>, ledger_transfers: Array.<Object>,
   *      ledger_entries: Array.<Object>, ledger_categories: Array.<Object>,
   *      ledger_default_accounts: Array.<Object>, ledger_account_deletions: Array.<Object>,
   *      ledger_budgets: Array.<Object>}} 备份里那些键
   */
  exportLedger(uid) {
    const u = Number(uid);
    const ledger_accounts = lsql(this,
      `SELECT * FROM ledger_accounts
        WHERE user_id=?
        ORDER BY COALESCE(sort_order, 0) ASC, id ASC`,
      [u],
    );
    const ledger_snapshots = lsql(this,
      'SELECT * FROM ledger_snapshots WHERE user_id=? ORDER BY date ASC, id ASC',
      [u],
    );
    const ledger_views = lsql(this,
      'SELECT * FROM ledger_views WHERE user_id=? ORDER BY COALESCE(sort_order, 0) ASC, id ASC',
      [u],
    );
    const ledger_view_tags = lsql(this,
      'SELECT * FROM ledger_view_tags WHERE user_id=? ORDER BY id ASC',
      [u],
    );
    // ⭐ 0.8.0：转账明细也进个人备份 —— 它是用户亲手记下的「钱怎么挪的」，
    //    换机 / 恢复之后不能只剩两个对不上的余额（方案 §5 的备份口径）
    const ledger_transfers = lsql(this,
      'SELECT * FROM ledger_transfers WHERE user_id=? ORDER BY date ASC, id ASC',
      [u],
    );
    // ⭐ 0.8.0：分组字段（九类的显示顺序 ＋ 内置用途的**名字与顺序**）也进备份 ——
    //    用途名是用户改过的、顺序是他拖出来的，换机后不能悄悄退回默认那七个；
    //    「其它」那一行的 `locked` 也一并带走（否则恢复后它变成可删的）
    const ledger_groups = lsql(this,
      'SELECT * FROM ledger_groups WHERE user_id=? ORDER BY scope ASC, COALESCE(sort_order, 0) ASC, id ASC',
      [u],
    );
    // ⭐ 0.8.1：2 期那四张表。⚠️ 排序都带 `id` 兜底 —— 恢复时按这份顺序逐行插，
    //    顺序确定才能让「同一时刻的两笔」在换机后仍然按同一个先后排。
    const ledger_entries = lsql(this,
      'SELECT * FROM ledger_entries WHERE user_id=? ORDER BY at ASC, id ASC',
      [u],
    );
    const ledger_categories = lsql(this,
      'SELECT * FROM ledger_categories WHERE user_id=? ORDER BY COALESCE(parent_id, 0) ASC, COALESCE(sort_order, 0) ASC, id ASC',
      [u],
    );
    const ledger_default_accounts = lsql(this,
      'SELECT * FROM ledger_default_accounts WHERE user_id=? ORDER BY id ASC',
      [u],
    );
    const ledger_account_deletions = lsql(this,
      'SELECT * FROM ledger_account_deletions WHERE user_id=? ORDER BY id ASC',
      [u],
    );
    // ⭐ 0.8.2（3 期）：预算额度也进个人备份 —— 它是用户亲手设的额度，
    //    漏了它的表现是「备份看着成功、换机后预算全没了」，而且**不报错**。
    //    ⚠️ 排序与 `listLedgerBudgetsByUser()` 逐字一致（期 → 起始日 → 维度 → id）：恢复按这份顺序逐行插。
    const ledger_budgets = lsql(this,
      'SELECT * FROM ledger_budgets WHERE user_id=? ORDER BY period_type ASC, period_key ASC, category_id ASC, id ASC',
      [u],
    );
    return {
      ledger_accounts,
      ledger_snapshots,
      ledger_views,
      ledger_view_tags,
      ledger_groups,
      ledger_transfers,
      ledger_entries,
      ledger_categories,
      ledger_default_accounts,
      ledger_account_deletions,
      ledger_budgets,
    };
  },
};

module.exports = { ops };
