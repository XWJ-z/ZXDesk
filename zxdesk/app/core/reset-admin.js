'use strict';
/**
 * core/reset-admin.js —— 离线重置账号密码（由 `cmd/reset-admin` 调用，也可直接 `node` 跑）
 *
 * 功能：一个顶层直接执行的离线运维脚本（不是模块），负责在 NAS 上以 root / 应用用户身份自救：
 *      `--list` 列出全部账号及各自的数据条数与口令可用性；`<用户名>` 重置指定账号的密码；
 *      `--make-admin <用户名>` 只提权、不改密码；不带参数则重置**唯一的管理员**。
 *      新密码一律从 stdin 读入；写入前先确认数据目录真实存在、数据层不是只读降级。
 *
 * 为什么必须有这个工具：
 *   本应用的管理员 = **出厂内置的 `admin` 账号**（见 server.js 的 `ensureBuiltinAdmin`）。
 *   ⚠️ 0.2.1 起**登录名可以改**（管理员的也能改），所以**不要靠「叫 `admin` 的账号」认人** ——
 *      用 `--list`，它按 `is_admin` 标记管理员；不带参数时重置的是**唯一的管理员**，与它叫什么名字无关。
 *   界面上**没有**、也不应该有一个「找回管理员密码」的入口 —— 那等于给所有人开后门。
 *   可管理员一旦忘了密码（或者库里的账号状态不对），整个应用就没人管得了（加不了成员、关不掉注册）。
 *   所以留一条**只能在 NAS 上、以 root/应用用户身份**执行的自救通道，就是这里。
 *   自定规矩（AGENTS.md §八）：凡涉及「第一次使用 / 找回入口」的功能，除了自动兜底，
 *   **必须再有一个人工命令能覆盖任意状态**，并在同一处把用法打出来 —— 就是本脚本。
 *
 * 用法：
 *   node reset-admin.js --list                  # 列出所有账号（忘了用户名时先看这个）
 *   node reset-admin.js <用户名>                # 重置指定账号
 *   node reset-admin.js                         # 不指定则重置**唯一的管理员**
 *   node reset-admin.js --make-admin <用户名>   # 只提权、不改密码（不需要输密码）
 *   新密码从 **stdin** 读入（shell 侧用 `read -s` 关掉回显再管道进来）。
 *
 * `--list` 会额外显示每个账号名下的**数据条数**与「没有可用口令」的账号：
 *   · 单用户时代的数据一律是 `user_id=1` ⇒ **数据不为零的那个账号就是能看到老数据的人**；
 *   · 散列为空/损坏的账号谁都登不进去（内置 admin 遇到这种情况会在启动时自动重写初始口令）。
 *   ⚠️ 这里显示条数是**故意**的，与需求 2 不冲突：那条红线管的是**界面**（管理员不该看到成员的任务数），
 *      而本脚本只能在 NAS 上以 root/应用用户身份跑 —— 有那个权限的人本来就能直接读库。
 *
 * ⚠️ 刻意**不用命令行参数**传密码：那会让明文出现在 `ps` 与 shell 历史里。
 * ⚠️ 走 `Store` 而不是直接写 SQL：SQLite 与 JSON 两种后端自动都支持，也不必在 bash 里解析库文件。
 * ⚠️ 本脚本**不做版本/环境判断之外的任何写入**，除了目标账号的 `password_hash` 与 `session_epoch`。
 *
 * ⭐ 0.8.1（记账 2 期）：数据层同时开着两个库（主库 + 记账库），所以本工具要认得**四个**数据
 *    文件名（`zxdesk.db` / `zxdesk.json` / `zxdesk-ledger.db` / `zxdesk-ledger.json`）。
 *    ⚠️ 记账库打不开**不拦**本脚本：它只写账号行（住在主库），把人挡在门外解决不了任何问题 ——
 *    但会**如实告警一行**，免得「记账功能整天 503」被当成另一件事去查。
 *
 * 环境变量：
 *   DATA_DIR     数据目录（**唯一**来源，由 `cmd/reset-admin` 算好传进来）
 *
 * ⚠️⚠️ 0.9.1 修：**不再拿 `TRIM_PKGVAR` 兜底**。它是「当前进程所属应用」的运行时目录
 *    （只放 `app.log` / `app.pid`）；在飞牛的 Web 终端（fntermx）里执行本脚本时，
 *    TRIM_PKGVAR 指向的是**那个终端应用** ⇒ 兜过去＝拿别人的目录当数据目录，报「这里没有
 *    zxdesk.db」，而且看起来像「库丢了」，最难查。⛔ 别加回兜底链。
 *
 * @author zx
 * @date   2026-09-10
 * @since 0.9.1
 * 相关：docs/公共/架构文档/04-多用户与账号.md
 */
const fs = require('node:fs');
const path = require('node:path');

const { Store, dbStatusOf } = require('./storage.js');
const { hashPassword, hashUsable, MIN_PASSWORD_LENGTH } = require('./auth.js');

/**
 * 功能：把错误信息打到 stderr 并以退出码 1 结束进程 —— 本脚本所有失败出口都走这里。
 * @param {string} msg - 面向使用者的错误说明（可含换行与缩进提示）
 * @returns {void}
 */
function die(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}

const dataDir = String(process.env.DATA_DIR || '').trim();
const wanted = String(process.argv[2] || '').trim();

if (!dataDir) {
  die(
    '没有拿到数据目录（DATA_DIR 为空）。\n' +
      '     飞牛应用中心启动时会注入它；手工执行请显式给一个：\n' +
      '     DATA_DIR=<你抄到的目录> node reset-admin.js <用户名>',
  );
}

if (!fs.existsSync(dataDir)) {
  die(`数据目录不存在：${dataDir}\n     请用 DATA_DIR=<数据目录> 指定（位置每台机器不同）。`);
}
// 先确认这里真的是数据目录 —— `new Store()` 会 mkdir，指错了地方就会**凭空造一个空库**，
// 然后告诉你「没有账号」，用户还以为数据丢了。宁可在这里停下。
// ⭐ 0.8.1：数据层现在是**两个库**（主库 + 记账库）⇒ 认得的数据文件有四个，不是两个。
//    ⚠️ 但判据不是「有任意一个就算」：只认到**记账库**那两个文件时必须停下 ——
//    那种情况下主库文件是真的不见了，而放行会让 `new Store()` 凭空建一个空的主库，
//    接着 `--list` 告诉你「还没有任何账号」，把一个「主库丢了」的事故说成「你还没注册」
//    （本脚本最容易骗人的一种失败）。所以这里把两件事分开说清楚。
const DATA_FILES = ['zxdesk.db', 'zxdesk.json', 'zxdesk-ledger.db', 'zxdesk-ledger.json'];
const foundFiles = DATA_FILES.filter((f) => fs.existsSync(path.join(dataDir, f)));
const hasMain = foundFiles.includes('zxdesk.db') || foundFiles.includes('zxdesk.json');
if (!foundFiles.length) {
  die(
    `在 ${dataDir} 里既没有 zxdesk.db 也没有 zxdesk.json（也没有记账库的 zxdesk-ledger.db / zxdesk-ledger.json），` +
      '这看起来不是 ZXDesk 的数据目录。\n' +
      '     请从 飞牛「应用中心 → ZXDesk → 应用设置」里抄出「数据目录」（每台机器的位置都不一样，\n' +
      '     所以这里不写死），然后带上它运行：\n' +
      '     DATA_DIR=<你抄到的目录> node reset-admin.js <用户名>',
  );
}
if (!hasMain) {
  die(
    `在 ${dataDir} 里只找到记账库（${foundFiles.join('、')}），主库的 zxdesk.db / zxdesk.json 都不在。\n` +
      '     这不是「还没注册账号」，而是主库文件不见了 —— 现在继续会凭空建一个空的主库，\n' +
      '     然后告诉你「没有账号」，很容易被当成数据全丢。\n' +
      '     请先从备份里把主库文件放回这个目录（整体备份压缩包里的 zxdesk.db / zxdesk.json），再重试。',
  );
}

const store = new Store(dataDir);
const info = store.info();
if (info.readOnly) {
  die(
    `数据层当前是只读的（${info.initError || '数据库打不开'}）—— 拒绝写入。\n` +
      '     请先修好数据目录的权限/归属（zxdesk:zxdesk）与磁盘空间。',
  );
}

// ⭐ 0.8.1：记账库（第二个库）不可用**不拦**本脚本 —— 它只写账号行（住在主库），
// 把人挡在门外解决不了任何问题。但必须**说出来**：否则用户会把「记账功能整天 503」
// 当成另一件事去查，而真正的原因（那个文件打不开）一个字都没人告诉他。
const ledgerStatus = dbStatusOf(store).ledger;
if (ledgerStatus && !ledgerStatus.ok) {
  console.warn(
    `⚠️ 记账数据库当前不可用（${ledgerStatus.reason || '原因未知'}）—— 本次只重设账号密码，不受影响；` +
      '但应用里的记账功能会一直返回 503，请一并联查那个文件。',
  );
}

// --list：只读，忘了用户名时先看它
if (wanted === '--list' || wanted === '-l') {
  const users = store.listUsers();
  console.log(`数据目录: ${dataDir}（后端 ${info.backend}）`);
  if (!users.length) {
    console.log('这个库里还没有任何账号 —— 打开应用首页，用内置管理员 admin / admin123 登录即可（登录后可改名）。');
    process.exit(0);
  }
  console.log(`共 ${users.length} 个账号：`);
  const noPassword = [];
  users.forEach((u) => {
    const c = store.countUserData(u.id);
    const total = c.projects + c.projectTasks + c.dailyTasks;
    const data = total
      ? ` · 数据: 项目 ${c.projects} / 项目任务 ${c.projectTasks} / 日常 ${c.dailyTasks}`
      : ' · 数据: 无';
    // ⭐ 单用户时代的老数据一律 user_id=1 —— 直接标出来，省得用户猜「我原来的任务去哪了」
    const legacy = u.id === 1 && total ? ' ← 单用户时代的老数据（user_id=1）挂在它名下' : '';
    // `listUsers()` 走的是 sanitizeUser（不含口令哈希），这里按名字再取一次原始行来判断口令可用性
    const raw = store.findUserByName(u.username);
    const usable = raw ? hashUsable(raw.password_hash) : false;
    if (!usable) noPassword.push(u.username);
    console.log(
      `  [${u.id}] ${u.username}${u.is_admin ? '（管理员）' : ''}` +
        `${u.display_name ? ' · ' + u.display_name : ''} · 上次登录 ${u.last_login_at || '从未'}` +
        `${data}${usable ? '' : ' · ⚠️ 没有可用口令（谁都登不进去）'}${legacy}`,
    );
  });
  if (noPassword.length) {
    console.log('');
    console.log(
      `⚠️ 有 ${noPassword.length} 个账号**没有可用口令**（散列为空或已损坏），任何密码都登不进去：` +
        ` ${noPassword.join(' / ')}`,
    );
    console.log('   重设其中某个账号的密码：cmd/reset-admin <上面那个用户名>');
  }
  if (!users.some((u) => u.is_admin)) {
    console.log('');
    console.log('⚠️ 这个库里**一个管理员都没有** —— 用下面这条命令把你常用的那个账号提成管理员：');
    console.log('   cmd/reset-admin --make-admin <上面某个用户名>');
  }
  process.exit(0);
}

// ---- --make-admin <用户名>：把某个账号提升为管理员（**不需要密码**） ----
//
// ⭐ 这是「不管库里是什么状态，你都能拿回管理员」的最后一道保险：
//    忘了管理员密码、或者压根不知道哪个账号是管理员时，用你**知道密码**的那个账号执行它，
//    重启应用后它就有「成员管理」了。启动时的 `ensureBuiltinAdmin()` 覆盖不了「admin 这个名字被占、
//    而占它的账号你也不想用」这类情况。
if (wanted === '--make-admin' || wanted === '-a') {
  const name = String(process.argv[3] || '').trim();
  if (!name) {
    die(
      '--make-admin 需要指定用户名：\n' +
        '     node reset-admin.js --make-admin <用户名>\n' +
        '     先跑 --list 看看都有哪些账号。',
    );
  }
  const u = store.findUserByName(name);
  if (!u) die(`没有叫「${name}」的账号。用 --list 看看都有哪些账号。`);
  if (Number(u.is_admin) === 1) {
    console.log(`账号「${name}」本来就是管理员，无需改动。`);
    process.exit(0);
  }
  if (!store.setAdminFlag(u.id, true)) die('写入失败：账号可能刚被删除，请重试。');
  console.log(`已把账号「${name}」提升为管理员（**密码保持原样**，用你原来的密码登录即可）。`);
  console.log('请重新启动应用后使用：登录后侧栏会出现「⚙ 成员」。');
  process.exit(0);
}

// 选目标账号
let target;
if (wanted) {
  target = store.findUserByName(wanted);
  if (!target) die(`没有叫「${wanted}」的账号。用 --list 看看都有哪些账号。`);
} else {
  const admins = store.listUsers().filter((u) => u.is_admin);
  if (!admins.length) {
    die(
      '这个库里没有管理员账号（不正常，可能是数据被改过）。\n' +
        '     请用 --list 查看账号，再指定用户名重置；或删掉数据目录重新开始。',
    );
  }
  if (admins.length > 1) {
    die(`存在多个管理员，请指定要重置哪一个：${admins.map((a) => a.username).join(' / ')}`);
  }
  target = store.findUserByName(admins[0].username);
  if (!target) die('读取管理员账号失败');
}

// 新密码从 stdin 读（shell 已经用 read -s 关掉回显）
let password;
try {
  password = fs.readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
} catch (e) {
  die(`读取新密码失败：${(e && e.message) || e}`);
}
if (!password) die('新密码为空（密码需要用管道从 stdin 传进来，见 cmd/reset-admin）');
if (password.length < MIN_PASSWORD_LENGTH) die(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
if (password.length > 200) die('新密码过长（最多 200 位）');

// setPassword 会同时把 session_epoch +1 → 该账号**所有**已登录设备立刻失效。
// 这正是我们要的：密码换了，旧会话不能还留着。
if (!store.setPassword(target.id, hashPassword(password))) {
  die('写入失败：账号可能刚被删除，请重试。');
}

console.log(`已重置账号「${target.username}」的密码${target.is_admin ? '（管理员）' : ''}。`);
console.log('该账号所有已登录的设备都已失效，需要用新密码重新登录。');
console.log('请重新启动应用后使用。');
