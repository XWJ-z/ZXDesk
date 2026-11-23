'use strict';
/**
 * modules/ledger/lib/import-sources.js —— **三方导入来源注册表**（本期唯一出处）
 * 功能：声明「有哪些三方来源、每个来源住哪张表、表里该有哪些列」，并给出建表语句与索引语句。
 * 它是「**一来源一张表**」这条口径的**唯一落脚点** —— `schema.js`、两个后端、`store.js`
 * @author zx
 * @date   2026-09-24
 * @since 0.9.7
 * 相关：docs/公共/开发方案/23-记账-三方导入（鲨鱼记账）.md、docs/公共/架构文档/23-记账.md
 */

/**
 * 合法表名的形状 —— ⭐ **拼 SQL 之前的第二道保险**。
 *
 */
const IDENT_RE = /^[a-z][a-z0-9_]{0,30}$/;

/**
 * 三方来源清单 —— **顺序即界面上从上到下的顺序**（以后加别家往下加）。
 *
 */
const SOURCES = [
  {
    key: 'shark',
    label: '鲨鱼记账',
    table: 'shayu',
    required: ['日期', '收支类型', '类别', '金额'],
    optional: ['账户', '备注'],
  },
];

/**
 * 功能：校验一个表名是不是合法标识符，不合法**当场抛错**（⛔ 不静默回一个默认表名）。
 *
 * @param {string} name - 待校验的表名
 * @returns {string} 原样返回（便于串联）
 * @throws {Error} 形状不合法时抛 500（这是**代码写错**，不是用户输入错 —— 用户输入永远到不了这里）
 */
function assertIdent(name) {
  const s = String(name == null ? '' : name);
  if (!IDENT_RE.test(s)) {
    const err = new Error(`三方导入的表名不合法（只允许小写字母开头的小写字母 / 数字 / 下划线）：${JSON.stringify(s)}`);
    err.status = 500;
    throw err;
  }
  return s;
}

/**
 * 功能：按来源键取来源定义。
 *
 * 说明：⚠️ 认不出**返回 `null`**（⛔ 不抛错）—— 调用它的是「把 `?source=` 转成来源」的接口层，
 * 那里要把「不认识的来源」翻成 **400**（入参非法），而不是 500。
 * @param {string} key - 来源键（如 `'shark'`）
 */
function getSource(key) {
  const k = String(key == null ? '' : key);
  return SOURCES.find((s) => s.key === k) || null;
}

/**
 * 功能：列出全部来源（浅拷贝 —— 调用方改不动这份清单）。
 * @returns {Array.<Object>} 来源定义数组
 */
function listSources() {
  return SOURCES.slice();
}

/**
 * 功能：列出全部导入表名（`schema.js` 与模块契约自检用）。
 * @returns {Array.<string>} 表名数组
 */
function listTables() {
  return SOURCES.map((s) => assertIdent(s.table));
}

/**
 * 功能：生成某个来源那张表的建表语句。
 *
 * 说明：⭐⭐ **列的分工**（方案 `23` §2.3）：
 * `date_raw` / `ie_raw` / `category` / `account` / `amount_raw` / `note` ——
 * **原样 6 列**（要的「数据原样保存，结构也一样」）；
 */
function tableDdl(src, n, ine) {
  const t = assertIdent(n);
  return `
      CREATE TABLE ${ine ? 'IF NOT EXISTS ' : ''}${t} (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,      -- 无默认值：漏传 uid 直接报错，不静默落到 1 号账号
        batch_id   INTEGER NOT NULL,      -- 这一行是哪一次导入来的（整批清除的落点）
        row_no     INTEGER NOT NULL,      -- 这一批里的第几行（1 起；与 batch_id 一起构成行身份）
        date_raw   TEXT,                  -- 原样：日期（${src.label} 自己的写法，一个字不改）
        ie_raw     TEXT,                  -- 原样：收支类型
        category   TEXT,                  -- 原样：类别（不映射到 ledger_categories）
        account    TEXT,                  -- 原样：账户名（不关联 ledger_accounts）
        amount_raw TEXT,                  -- 原样：金额原文
        note       TEXT,                  -- 原样：备注
        at         TEXT,                  -- 派生：YYYY-MM-DD（排序与按月取数唯一的钥匙）
        fen        INTEGER,               -- 派生：整数分（统计唯一的钥匙）
        created_at INTEGER,               -- 审计用，不参与判定
        UNIQUE(user_id, batch_id, row_no) -- 同一批的同一行只可能有一份
      );`;
}

/**
 * 功能：生成某个来源那张表的表名 -> 建表语句映射（供 `schema.js` 展开进 `tables`）。
 * @returns {Object.<string, Function>} `{ shayu: (n, ine) => sql }`
 */
function tablesFor() {
  const out = {};
  for (const s of SOURCES) out[assertIdent(s.table)] = (n, ine) => tableDdl(s, n, ine);
  return out;
}

/**
 * 功能：生成导入表的**列白名单**映射 —— ⭐ **一律留空数组**（`allowedCols` 的语义是「允许通用
 * `_update()` 写哪些列」；导入的数据是**只读**的，没有「改一行」这个业务）。
 * @returns {Object.<string, Array>} `{ shayu: [] }`
 */
function blankColsFor() {
  const out = {};
  for (const s of SOURCES) out[assertIdent(s.table)] = [];
  return out;
}

/**
 * 功能：生成「删账号要清空哪些表」里属于导入表的那一份。
 * @returns {Array.<string>} 表名数组
 */
function scopedFor() {
  return listTables();
}

/**
 * 功能：生成导入表的索引语句。
 *
 * 说明：⭐ 取数永远是「这个账号的、按 `at` 落在某一段里的行」⇒ 左列管过滤、右列正好是那个排序键。
 * @returns {Array.<string>} `CREATE INDEX ...` 语句数组
 */
function indexesFor() {
  return SOURCES.map(
    (s) => `CREATE INDEX IF NOT EXISTS idx_${assertIdent(s.table)}_user_at ON ${assertIdent(s.table)}(user_id, at)`,
  );
}

module.exports = {
  SOURCES,
  assertIdent,
  getSource,
  listSources,
  listTables,
  tableDdl,
  tablesFor,
  blankColsFor,
  scopedFor,
  indexesFor,
};
