/**
 * context.js —— 运行期单例与启动期自检（数据目录 / Store / 会话密钥 / 日志）
 *
 * 功能：持有**整个进程唯一**的那几样东西，并按顺序完成启动期的一次性工作 ——
 *      解析数据目录、建目录、构造 `Store`（内部含迁移与备份）、读取或生成会话签名密钥，
 *      以及把数据层体检结果写进启动日志。对外导出 `dataDir` / `store` / `storeInfo` /
 *      `secretInfo` / `AUTH_SECRET` / `logLine` / `resolveDataDir`。
 *
 * ⚠️ **为什么单独一个文件**：拆分前这些都是 `server.js` 的模块级单例，所有 handler 直接闭包引用
 *    （`store` 被引用 100+ 处）。若把它们留在 `server.js`、handler 搬去 `routes/*`，`routes/*` 就必须
 *    反过来 require 入口 —— **成环**。所以单例下沉到这里，依赖方向变成单向：
 *    `context ← http-util ← routes ← server`。本文件**不许** require 上面任何一个。
 * ⚠️ **加载顺序即语义**：`process.env.HOME` 必须在 `Store` 构造**之前**改好（飞牛 package 用户没有真实 home，
 *    不改会写文件 EACCES）；`store` 构造必须先于任何 handler 被调用。所以 `server.js` 必须**第一个** require 本文件。
 *
 * ⭐ 0.8.1（记账 2 期）：数据层现在是**两个库**（主库 + 记账库），启动日志因此**两段各报一次** ——
 *    后端 / 文件 / WAL 探测 / 只读降级 / 迁移前备份 / 建索引失败，两套结果**分开写**。
 *    判据来自 `store._backendStatus()`（`{main, ledger}`，只含非敏感信息）而不是 `storeInfo`：
 *    `info()` 住在 `store/methods/admin.js`，本次改造刻意没有动它。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.1
 * 相关：docs/公共/架构文档/01-架构总览.md
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Store, dbStatusOf } = require('./storage.js');
const { hashPassword, hashUsable, loadOrCreateSecret } = require('./auth.js');

('use strict');

const DATA_DIR_ENV = process.env.DATA_DIR || '';

const PKGVAR = process.env.TRIM_PKGVAR || '';

const HOME_ENV = process.env.ZXDESK_HOME || process.env.TRIM_PKGHOME || process.env.TRIM_APPHOME || '';

// 修复飞牛 package 用户无真实 home → 写文件 EACCES
process.env.HOME = HOME_ENV || PKGVAR || path.join(__dirname, '..', '..', 'var', 'home');

/**
 * 功能：确定数据目录 —— 依次取 `DATA_DIR`（resource 声明）、`TRIM_PKGVAR`、包内 `var/`，第一个存在的即返回值。
 * @returns {string} 数据目录的绝对路径
 */
function resolveDataDir() {
  if (DATA_DIR_ENV) return DATA_DIR_ENV;
  if (PKGVAR) return PKGVAR;
  return path.join(__dirname, '..', '..', 'var');
}

// ---- 日志（本地时间）----
/**
 * 功能：按「本地时间 + 级别」格式把一行日志写到 stdout（由 `cmd/main` 重定向到 `$TRIM_PKGVAR/app.log`）。
 * @param {string} level - 日志级别，如 'info' / 'warn' / 'error'
 * @param {string} msg - 日志正文
 * @returns {void}
 */
function logLine(level, msg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const t = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  console.log(`[${t}] [${level}] ${msg}`);
}

// ---- 初始化数据层 ----
const dataDir = resolveDataDir();

fs.mkdirSync(dataDir, { recursive: true });

const store = new Store(dataDir);

const storeInfo = store.info();

// ⭐ 0.8.1：两个库的只读体检结果（主库那一半另有 `storeInfo`，见 store/methods/admin.js）——
//    读口统一在 `storage.js` 的 `dbStatusOf()` 上，本文件不直接去摸实例字段。
const dbStatus = dbStatusOf(store);

// ⭐ 0.8.9：启动日志**固定一行**「Node 版本 · 存储后端 · 库路径」。
//   换运行时这种改动，事后只能靠日志回答「这个包到底跑在哪个 Node 上」「数据写进了哪个文件」——
//   而这正是 0.8.9 唯一的主题，所以它必须**固定、完整、每次都有**，⛔ 不许散在别处拼。
logLine('info', `Node ${process.version} · 存储后端 ${storeInfo.backend} · ${storeInfo.dbFile}`);

if (storeInfo.initError) {
  logLine(
    'error',
    `数据层已回退到 JSON 备用存储：${storeInfo.initError} —— ` +
      (storeInfo.readOnly
        ? '【已停止写入】界面当前显示的不是数据库内容，为避免出现两套数据已拒绝所有修改；' +
          '请检查数据目录权限/归属（zxdesk:zxdesk）与磁盘空间，修好后重启应用。'
        : '本次没有可用的数据库，数据会写进 JSON 备用存储；' +
          '若数据目录里确实存在 zxdesk.db，请检查它的权限与完整性，修好后重启应用。'),
  );
}

if (storeInfo.backend === 'sqlite') {
  if (storeInfo.journalMode === 'wal') {
    logLine('info', 'SQLite 日志模式: WAL（读写不互斥，已启用 busy_timeout=5000 / synchronous=NORMAL）');
  } else {
    logLine(
      'warn',
      `SQLite 日志模式: ${storeInfo.journalMode}（未启用 WAL）—— ` +
        '常见原因是数据目录落在 NFS/SMB 等网络文件系统（WAL 需要共享内存）。' +
        '此时并发能力受限，建议把 data-share 放到本地存储卷。',
    );
  }
}

// ⭐ 0.8.1：**第二个库（记账）**—— 后端 / 文件 / WAL 探测 / 只读降级**各报一次**。
//   ⚠️ 两个库的探测结果必须能分开看：合成一行之后，就再也说不清「是哪个库没启用 WAL」，
//   而这条日志的用处正是「一眼看出数据目录是不是网络盘」。同理，只报「主库正常」会让
//   记账库打不开这件事**完全无声**（用户那边只看到记账功能整天 503）。
const ledgerStatus = dbStatus.ledger;
// ⚠️ `ledgerStatus` 理论上一定有（`_init` 的每条出口都会刷新状态快照），但启动日志**绝不能**
// 因为一段体检报告而把整个进程打挂 —— 拿不到就照实说「拿不到」，其余照常。
if (!ledgerStatus) {
  logLine('warn', '⚠️ 记账数据库的状态未取到（数据层初始化没有跑到状态快照那一步）—— 启动日志中缺少它的后两端信息');
} else {
  logLine('info', `记账数据库: ${ledgerStatus.file}（后端 ${ledgerStatus.backend}）`);
  if (!ledgerStatus.ok) {
    logLine(
      'error',
      `⚠️ 记账数据库不可用：${ledgerStatus.reason || '原因未知'}` +
        (ledgerStatus.readOnly
          ? ' —— 【已停止记账读写】为避免出现两套数据，记账相关的读写一律拒绝（503）；' +
            '其余功能不受影响，修好后重启应用即可恢复。'
          : ' —— 记账相关的读写一律拒绝（503）；其余功能不受影响。'),
    );
  } else if (ledgerStatus.backend === 'sqlite') {
    if (ledgerStatus.journalMode === 'wal') {
      logLine('info', '记账数据库日志模式: WAL（与主库各自探测、各自生效）');
    } else {
      logLine(
        'warn',
        `记账数据库日志模式: ${ledgerStatus.journalMode}（未启用 WAL）—— 与主库同一个成因：` +
          '数据目录若在网络盘（NFS/SMB），WAL 会因缺少共享内存而失败。',
      );
    }
  }
}

// 迁移前自动备份：本次启动若做过 schema 迁移，库旁边会多一份 .bak（出问题可回滚）
if (storeInfo.backupFile) {
  logLine('info', `迁移前已自动备份数据库: ${storeInfo.backupFile}（自动备份保留最近 5 份）`);
}

// ⭐ 0.8.1：记账库的迁移前自动备份 —— 它用自己的前缀（`zxdesk-ledger.db.bak-v…`）与自己的版本号，
// 各转各的圈；⚠️ 它**失败时也走 `backupError`**（正文以「记账库：」开头），所以下面的告警一行就够。
if (dbStatus.ledgerBackupFile) {
  logLine('info', `记账数据库迁移前已自动备份: ${dbStatus.ledgerBackupFile}（保留最近 5 份）`);
}

if (storeInfo.backupError) {
  logLine('warn', `⚠️ 迁移前自动备份失败: ${storeInfo.backupError} —— 仍继续启动，但本次没有回滚点`);
}

// v5 结构升级（加外键 / 约束 / NOT NULL）：成功、跳过、两种结局都要说清楚
if (storeInfo.structuralUpgrade) {
  const up = storeInfo.structuralUpgrade;
  logLine('info', `数据库结构已升级: v${up.from} → v${up.to}（外键 ON DELETE CASCADE + 唯一/非空/取值范围约束）`);
  const norm = up.normalized || {};
  const cols = Object.keys(norm);
  if (cols.length) {
    logLine(
      'info',
      `结构升级时做了等价归一化（语义不变，仅为满足新约束）：${cols.map((c) => `${c} ${norm[c]} 条`).join('、')}`,
    );
  }
}

if (storeInfo.schemaUpgradeSkipped) {
  logLine(
    'warn',
    `⚠️ 数据库结构升级已跳过（本次仍是旧结构，**一行数据都没有动**）：${storeInfo.schemaUpgradeSkipped}` +
      '。造成这个结果的历史数据需要先处理掉，升级会在下次启动时重试；在此之前应用一切照常可用。',
  );
}

if (storeInfo.backend === 'sqlite' && storeInfo.foreignKeys === false) {
  logLine('warn', '⚠️ SQLite 外键未能启用（PRAGMA foreign_keys=ON 失败）—— 级联删除将退回应用层保证');
}

// 表改名迁移（0.1.2：课表 5 张加 `timetable_` 前缀；0.8.13：三块并版，16 张加 `time_` 前缀）
if (storeInfo.renamedTables && storeInfo.renamedTables.length) {
  logLine('info', `数据库表名已规范化（原地改名，数据未搬动）: ${storeInfo.renamedTables.join('、')}`);
}

if (storeInfo.tableAliasConflicts && storeInfo.tableAliasConflicts.length) {
  logLine(
    'error',
    `⚠️ 检测到表名冲突，已放弃改名（**一张表都没有动**）：${storeInfo.tableAliasConflicts.join('、')} —— ` +
      '典型成因是「装过新版 → 降级回旧版写了数据 → 再升上来」，于是新旧两套表同时存在。' +
      '应用不会替你在两批数据里二选一，请人工确认哪一批是要保留的（课表那 5 张的历史名字是 ' +
      'terms / period_blocks / periods / courses / course_sessions，随后带过 `timetable_` 前缀，' +
      '现名带 `time_timetable_` 前缀）。',
  );
}

// ⭐ 0.8.12 列改名迁移（users.hide_chat → hide_teamwork）：与表改名同性质，原地改名、数据未搬动
if (storeInfo.renamedColumns && storeInfo.renamedColumns.length) {
  logLine('info', `数据库列名已规范化（原地改名，数据未搬动）: ${storeInfo.renamedColumns.join('、')}`);
}

if (storeInfo.renamedJsonKeys && storeInfo.renamedJsonKeys.length) {
  logLine('info', `已按新表名读取旧的 zxdesk.json（键名迁移）: ${storeInfo.renamedJsonKeys.join('、')}`);
}

if (storeInfo.indexErrors && storeInfo.indexErrors.length) {
  logLine(
    'warn',
    `⚠️ ${storeInfo.indexErrors.length} 个索引未能建立（只是查询变慢，不影响数据与可用性）: ` +
      storeInfo.indexErrors.slice(0, 3).join('；'),
  );
}

// ⭐ 0.8.1：记账库的建索引失败 —— 与主库同一条口径（逐条 try/catch、只报告不上抛），
// 单独一行是为了让人一眼看出「慢的是哪一个库」。
if (dbStatus.ledgerIndexErrors.length) {
  logLine(
    'warn',
    `⚠️ 记账数据库有 ${dbStatus.ledgerIndexErrors.length} 个索引未能建立（只是查询变慢，不影响数据与可用性）: ` +
      dbStatus.ledgerIndexErrors.slice(0, 3).join('；'),
  );
}

if (storeInfo.importedFromJson > 0) {
  logLine(
    'info',
    `已从 zxdesk.json 导入 ${storeInfo.importedFromJson} 条历史数据到 SQLite` +
      (storeInfo.importedJsonFile ? `，原文件已归档为 ${storeInfo.importedJsonFile}` : ''),
  );
}

if (storeInfo.importError) {
  logLine('error', `zxdesk.json 导入失败（已回滚，数据未受影响）: ${storeInfo.importError}`);
}

// 历史任务缺少开始日期：**只报告，绝不改写**（前端按截止日期推断显示，与旧版界面一致）
if (storeInfo.legacyNullStartDates > 0) {
  logLine(
    'info',
    `检测到 ${storeInfo.legacyNullStartDates} 条历史任务没有开始日期 —— ` +
      '按截止日期推断显示，不会修改数据库里的原始值。',
  );
}

logLine('info', `数据目录: ${dataDir}`);

// ⭐⭐ 0.8.12：协作附件**孤儿巡检** —— 「库里有记录、磁盘没文件」与
//   「磁盘有文件、库里没记录」各报一次。⚠️⭐ **只报告、绝不自动删**（绝不改写用户数据）。
//   附件子系统住在任务板模块里（可整目录删掉）⇒ 方法不在时静默跳过；巡检本身出错也不阻断启动。
if (typeof store.collabFileOrphans === 'function') {
  try {
    const orph = store.collabFileOrphans();
    if (orph && (orph.diskOnly || orph.rowsOnly)) {
      logLine(
        'warn',
        `⚠️ 协作附件巡检：磁盘上有 ${orph.diskOnly} 个文件在库里没有记录、库里有 ${orph.rowsOnly} 条记录` +
          '在磁盘上找不到文件 —— **一律不动**（决策 18：绝不改写用户数据），仅在此报告。',
      );
    }
  } catch (e) {
    logLine('warn', `⚠️ 协作附件巡检未能完成（不影响启动）: ${(e && e.message) || e}`);
  }
}

// username 唯一索引没建起来：登录名查重会退化为「应用层兜底」，必须让人知道（静默降级是不可接受的）
if (storeInfo.usersIndexError) {
  logLine(
    'warn',
    `⚠️ users.username 唯一索引创建失败: ${storeInfo.usersIndexError} —— ` +
      '已降级为应用层查重（新建账号时显式比对），功能可用但缺少数据库级约束；' +
      '常见原因是历史库中存在重复或空用户名。',
  );
}

/**
 * 会话签名密钥。
 * ⚠️ 必须落盘：不落盘则每次重启换密钥 → 所有人被登出。
 * ⚠️ 落盘失败**不阻断启动**，但要显著告警 —— 静默降级是不可接受的。
 */
const secretInfo = loadOrCreateSecret(dataDir);

const AUTH_SECRET = secretInfo.secret;

if (secretInfo.error) {
  logLine(
    'warn',
    `⚠️ 会话密钥无法落盘（${secretInfo.file}）: ${secretInfo.error} —— ` +
      '本次运行登录仍可用，但**应用重启后所有人需要重新登录**。请检查数据目录的权限与归属（zxdesk:zxdesk）。',
  );
}

/**
 * 功能：出厂内置管理员的凭据常量（用户名 / 初始口令 / 显示名），供 `ensureBuiltinAdmin()` 建号与日志提示使用。
 *
 * 说明：⭐ 内置管理员：`admin` / `admin123`（替换掉「首个注册者即管理员」）。
 *
 * **为什么必须有内置账号**：「谁先注册谁就是管理员」把部署者自己关在了门外 ——
 * 他装好应用后先注册了自己的成员账号，从此系统里**一个管理员都没有**，谁也开不了「成员管理」。
 * 一个「可能把自己锁死」的账号模型是不可接受的，所以改成**出厂就带一个管理员**：
 * 凭据是公开的（文档与启动日志里都写着），登录后第一件事就是去「设置 → 账号设置」改掉它。
 *
 * 规则（`ensureBuiltinAdmin()`，每次启动跑一遍，**以「内置管理员这个账号」为准，
 * **不以「库里有没有管理员」为准**）。⚠️ 0.2.1 起**先按身份、再按名字**两道判据（见 `BUILTIN_ADMIN_KEY`）：
 *
 * | 库里状态                                    | 动作                                                       |
 * | ------------------------------------------- | ---------------------------------------------------------- |
 * | `admin` 已是管理员，且**口令可用**           | **什么都不做**（绝不重置它的密码 —— 大多数启动走这条），并把它的 id 记进 `builtin_admin_id` |
 * | `admin` 存在但**没有可用口令**（空/损坏）    | **重写为初始口令**（否则这个账号谁都进不去，见下）           |
 * | `admin` 存在但是普通成员，且口令可用         | **提升为管理员，绝不改它的密码**（谁设的密码谁是主人）       |
 * | `admin` 不存在（无论库里有没有别的管理员）   | 建 `admin` / `admin123`                                    |
 * | `builtin_admin_id` 指向的账号已不存在        | 清掉这个失效标记，再按上面四条按名字兜底                     |
 *
 * ⚠️ 一旦 `builtin_admin_id` 认领成功，**上面四条就只处理那一个身份，与名字无关** ——
 *    这正是「登录名可以改成维护者的名字、而重启不会重造一个 `admin`」的机制所在。
 *
 * ⚠️ **第三行是 改的**：最初的判据是「库里一个管理员都没有才补」，
 *    结果早期库在单用户时代就有数据、又用旧版注册过账号（那个账号就是管理员），
 *    于是这条规则**永远不为他创建 admin** —— 他按文档敲 `admin` / `admin123` 只会得到「密码不正确」。
 *    现在的判据改成「`admin` 这个入口在不在」：**只要名字还空着就补上**，
 *    这样「忘记管理员密码」也永远有救；代价见下面那条安全说明。
 *
 * ⚠️ **第二行是同一天第三次踩坑后补的**（配合 `auth.js` 的 `hashUsable`）：
 *    单用户时代**就已经有一张 `users` 表**（只有 id / username / display_name / created_at，
 *    没有密码列 —— 见 `storage.js` 的 `_ensureColumn('users', 'password_hash', ...)`），
 *    老库升级上来时那个补出来的列是 **NULL**。而旧规则是「名字被占 → 提升它、绝不改密码」，
 *    于是提升出了一个**没有密码的管理员**：账号在、权限在、显示名还叫「管理员」，
 *    但 `verifyPassword(任何口令, NULL)` 恒为 false —— 敲什么都是「密码不正确」，
 *    而「绝不改密码」又让它永远修不回来。**判据必须是「能不能用它登录」，不是「这一行在不在」。**
 *    散列为空/损坏时重写口令**不违反「绝不重置密码」**：那种状态下没有任何人的密码被夺走。
 *
 * ⚠️ 这个默认口令是**公开**的 —— 谁能在改密码之前访问到这个应用，谁就是管理员。
 *    因此：启动日志每次都会 `[warn]` 催改；**已经另有管理员的库里补出它时会额外告警**
 *    （那等于给一个本来安全的库加了一个公开口令的入口，必须让人看见）。
 *    应用只跑在 NAS 的局域网端口上，所以实际风险窗口很短。
 */
const BUILTIN_ADMIN = { username: 'admin', password: 'admin123', displayName: '管理员' };

/**
 * ⭐ **内置管理员身份标记**（0.2.1，随「登录名可改」一起加的）：
 * 在 `settings` 里记下「哪个账号是内置管理员」。
 *
 * **为什么非有不可**：原来这条兜底是靠**名字**认人的 —— 「名字 `admin` 还在不在」。
 * 可 0.2.1 起**登录名可以改了**（所有账号、含管理员），于是「把 `admin` 改成人名」的下一刻，
 * 名字就空了出来，下次启动这条兜底会**老老实实再建一个 `admin` / `admin123` 的管理员**——
 * 也就是说：改个名就凭空多出一个**口令公开、且按现有接口删不掉**的入口，而且只有第一次的日志
 * 看起来像提醒。那是把「兜底」变成了「后门」。
 *
 * 所以判据从**名字**改成**落库的身份**：只要这一条记录还在，就永远认得出它是内置管理员，
 * 改多少次名都不影响兜底；`settings` 是全局键值表，随整库备份走，天然自洽
 * （⚠️ 不放 `users` 上加列：那要动结构，而这件事**只需要记住一个 id**）。
 *
 * ⚠️ 与 的关系：那条结论**一个字没改** —— 「判据必须是『这账号在不在』**且**『它的口令能不能用』」。
 *    变的只是「怎么定位那个账号」：从「名字叫 `admin`」换成「id 存在这个键里」。
 *    认不到时（键缺失 / 指向的账号被删 / 指向的账号已经不是管理员且口令也坏了）一律**退回按名字兜底**，
 *    「永不把人锁在门外」保持完整。
 */
const BUILTIN_ADMIN_KEY = 'builtin_admin_id';

/**
 * 功能：读「内置管理员是哪个账号」—— 返回键里记的 id，没记过或不是正整数时返回 null。
 * @returns {?number} 内置管理员的账号 id；未认领时为 null
 */
function builtinAdminId() {
  const id = Number(store.getSetting(BUILTIN_ADMIN_KEY));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * 功能：把某个账号认领为「内置管理员」（写 `settings` 的 `builtin_admin_id`），失败只告警不抛。
 *
 * 说明：⚠️ 刻意**不阻断启动**：只读降级时写入必然失败，而那种情况下应用本来就该照常起得来
 *      （进去还能导出备份自救），不能因为记不下一个 id 就起不来。但**必须响** ——
 *      写不进去意味着下次启动还会按名字兜底，改名后的后门就又有了，得让人看见。
 *
 * @param {number} id - 要认领的账号 id
 * @returns {void}
 */
function claimBuiltinAdmin(id) {
  try {
    store.setSetting(BUILTIN_ADMIN_KEY, String(id));
  } catch (e) {
    logLine(
      'warn',
      `⚠️ 内置管理员标记（settings.${BUILTIN_ADMIN_KEY}）写入失败: ${(e && e.message) || e} —— ` +
        `本次仍按名字「${BUILTIN_ADMIN.username}」兜底，下次启动会重试。`,
    );
  }
}

/**
 * 功能：每次启动跑一遍的内置管理员兜底 —— **先按「落库的身份」（`builtin_admin_id`）认领，
 *      认不到再按名字 `admin`**，决定「什么都不做 / 重写初始口令 / 提升为管理员 / 新建账号」，
 *      并把实际动作写进日志。
 * @returns {void}
 */
/**
 * 功能：生成一次性初始口令（内置管理员散列为空/损坏、必须重写时用）。
 *
 * 说明：⚠️ 刻意**不复用** `BUILTIN_ADMIN.password` —— 那个口令是公开的，用它重置等于把一个
 *      「账号不可用」的故障自动转换成「公开口令可登录」。这里给 12 位随机串，只打印到启动日志一次。
 *      `base64url` 不会产生需要转义的字符，复制粘贴进登录框即可。
 *
 * @returns {string} 12 位一次性口令
 */
function oneTimePassword() {
  return crypto.randomBytes(9).toString('base64url');
}

function ensureBuiltinAdmin() {
  try {
    // ⭐ 自助注册的出厂值：**首次启动显式写一次 '0'**（关闭）。
    //    ⚠️ 不靠「缺键即关闭」推断 —— 管理员在界面上要能看见「已关闭」这个状态，而不是一片空白。
    //    ⚠️ 只写一次：老库若已显式开过（'1'），这里不动它。
    if (store.getSetting('allow_self_register') == null) store.setSetting('allow_self_register', '0');
    // ---- ⭐ 第一判据：按**身份**认领（0.2.1 起登录名可改，不能再看名字了）----
    //      分支与下面的按名字兜底**逐条对应**，只是不依赖名字。
    const claimedId = builtinAdminId();
    if (claimedId !== null) {
      const claimed = store.findUserById(claimedId);
      if (claimed) {
        const claimedIsAdmin = Number(claimed.is_admin) === 1;
        // 口令坏掉：重写初始口令（用 setPassword，顺带作废可能残留的旧会话）
        if (!hashUsable(claimed.password_hash)) {
          if (!claimedIsAdmin) store.setAdminFlag(claimed.id, true);
          const tmp = oneTimePassword();
          store.setPassword(claimed.id, hashPassword(tmp));
          logLine(
            'warn',
            `⚠️ 内置管理员账号「${claimed.username}」（uid=${claimed.id}）**没有可用口令**（散列为空或已损坏）` +
              `—— 谁都登不进去。已为它重置**一次性口令** ${tmp}（只打印这一次，请立刻抄下）` +
              (claimedIsAdmin ? '' : '，并提升为管理员') +
              '；登录后请在「设置 → 账号设置」里改掉。',
          );
          return;
        }
        // 被人从库里改掉了管理员标志：补回来，但绝不碰它的密码
        if (!claimedIsAdmin) {
          store.setAdminFlag(claimed.id, true);
          logLine(
            'warn',
            `已把内置管理员账号「${claimed.username}」（uid=${claimed.id}）重新提为管理员（密码保持原样）—— ` +
              '请确认这个账号还是你自己的。',
          );
          return;
        }
        logLine('info', `内置管理员账号「${claimed.username}」（uid=${claimed.id}）已存在且口令可用，未做任何改动`);
        return;
      }
      // 认不到：键指向的账号已经不存在了 —— 清掉这个失效标记，退回按名字兜底
      logLine(
        'warn',
        `⚠️ 内置管理员标记（settings.${BUILTIN_ADMIN_KEY}=${claimedId}）指向的账号已不存在 —— ` +
          `本次按名字「${BUILTIN_ADMIN.username}」重新兜底。`,
      );
      store.setSetting(BUILTIN_ADMIN_KEY, '');
    }

    // ---- 第二判据：按名字 admin（老库首次启动 / 从未认领 / 标记失效时走这里）----
    const existing = store.findUserByName(BUILTIN_ADMIN.username);
    // ⭐ 认人成功就立刻记下来：这样**下次启动认的是 id**，之后随便改名都不会再重建一个 admin
    if (existing) claimBuiltinAdmin(existing.id);

    // ---- 名字还空着：建出来（**哪怕库里已经有别的管理员** —— 见上面第三行的踩坑）----
    if (!existing) {
      const otherAdmins = store.countAdmins();
      const created = store.createUser({
        username: BUILTIN_ADMIN.username,
        passwordHash: hashPassword(BUILTIN_ADMIN.password),
        displayName: BUILTIN_ADMIN.displayName,
        isAdmin: true,
      });
      if (created && created.id) claimBuiltinAdmin(created.id);
      logLine(
        'warn',
        `已创建内置管理员账号「${BUILTIN_ADMIN.username}」（初始密码 ${BUILTIN_ADMIN.password}）—— ` +
          '⚠️ 这是公开的初始密码，请立刻登录并在「设置 → 账号设置」里修改；改完之前，能访问本应用的人都能当管理员。',
      );
      if (otherAdmins > 0) {
        logLine(
          'warn',
          `⚠️ 注意：本库原本已有 ${otherAdmins} 个管理员账号，这次是**额外**补了一个公开初始密码的内置入口` +
            '（为的是「谁忘了密码都还有救」）。如果不需要它，登录后把它的密码改成只有你知道的即可。',
        );
      }
      return;
    }

    const isAdmin = Number(existing.is_admin) === 1;

    // ---- ⭐ 名字在，但这条记录**没有可用口令**：谁都登不进去，只能重写初始口令 ----
    //      （散列为 NULL / 空串 / 写坏；单用户时代老库升级上来的 `users` 行必属此类）
    if (!hashUsable(existing.password_hash)) {
      if (!isAdmin) store.setAdminFlag(existing.id, true);
      // 用 setPassword 而**不是** setPasswordHash：它会递增 session_epoch，
      // 把这条记录上可能残留的旧会话一并作废 —— 重写口令不该留下旧会话。
      // ⚠️ 用**一次性随机口令**而不是那个公开的初始口令：后者等于把一个故障（散列坏了）
      //    自动转换成「公开口令可登录」。口令写在启动日志里，照样能做到「永不把人锁在门外」。
      const tmp = oneTimePassword();
      store.setPassword(existing.id, hashPassword(tmp));
      logLine(
        'warn',
        `⚠️ 账号「${BUILTIN_ADMIN.username}」在库里存在，但**没有可用口令**（散列为空或已损坏）—— ` +
          `谁都登不进去。已为它重置**一次性口令** ${tmp}（只打印这一次，请立刻抄下）` +
          (isAdmin ? '' : '，并提升为管理员') +
          '；登录后请在「设置 → 账号设置」里改掉。',
      );
      return;
    }

    // ---- 已是管理员且口令可用：**一个字节都不动**（尤其不能重置密码，否则等于每次重启开后门）----
    if (isAdmin) {
      logLine('info', `内置管理员账号「${BUILTIN_ADMIN.username}」已存在且口令可用，未做任何改动`);
      return;
    }

    // ---- 名字被注册成了普通成员：提升它，但**不碰密码**（谁知道密码谁是主人；改别人的口令是数据事故）----
    store.setAdminFlag(existing.id, true);
    logLine(
      'warn',
      `已把账号「${BUILTIN_ADMIN.username}」提升为管理员（密码保持原样）—— ` +
        '请用它登录后在「设置 → 账号设置」里确认密码只有你自己知道。',
    );
  } catch (e) {
    // 只读降级等情况：**不阻断启动**，但必须响（静默失败＝用户永远进不去还不明原因）
    logLine('error', `⚠️ 内置管理员账号创建失败（你可能会没人是管理员）: ${(e && e.message) || e}`);
  }
}

ensureBuiltinAdmin();

// ---- 异常兜底（不退出，记录） ----
process.on('uncaughtException', (e) => logLine('error', 'uncaught: ' + ((e && e.stack) || e)));

process.on('unhandledRejection', (e) => logLine('error', 'unhandledRejection: ' + ((e && e.message) || e)));

// ---- 优雅退出（cmd stop 发送 SIGTERM） ----
process.on('SIGTERM', () => {
  logLine('info', '收到 SIGTERM，退出');
  process.exit(0);
});

process.on('SIGINT', () => {
  logLine('info', '收到 SIGINT，退出');
  process.exit(0);
});

/**
 * 功能：对外可读的**运行期量**容器，目前只有「实际监听到的端口」一个字段。
 *
 * ⚠️ 为什么需要它：`healthPayload()` 要上报**真实端口**（`service_port` 8990 被占用时会顺延 +1…+20），
 *    而持有该端口的是入口 `server.js` 里的 `server` 对象。让 `routes/system.js` 反过来 require 入口
 *    就成了**循环依赖**，所以只把这**一个值**下发到这里。
 * ⚠️ 语义等价：监听成功前 `port` 为 `null` —— 与原来 `server.address()` 在未监听时返回 `null`
 *    （于是整个表达式为 `null`）**完全一致**；监听成功后由 `listen()` 回填成实际端口。
 */
const runtime = { port: null };

module.exports = {
  DATA_DIR_ENV,
  PKGVAR,
  HOME_ENV,
  resolveDataDir,
  logLine,
  dataDir,
  store,
  storeInfo,
  secretInfo,
  AUTH_SECRET,
  BUILTIN_ADMIN,
  BUILTIN_ADMIN_KEY,
  ensureBuiltinAdmin,
  runtime,
};
