'use strict';
/**
 * modules/vault/store.js —— 密码库业务方法（0.3.2）
 *
 * 功能：密码库的全部业务逻辑，一处收齐 ——
 *      `vaultStatus()`（是否已初始化 / 是否已解锁 / 自动锁定秒数）、
 *      `vaultInit()` / `vaultUnlock()` / `vaultLock()` / `vaultLockAll()`（开库、解锁、上锁）、
 *      `vaultLockMinutes()` / `setVaultLockMinutes()`（每个账号自己的自动锁定偏好）、
 *      `listVaultEntries()` / `getVaultEntry()` / `createVaultEntry()` / `updateVaultEntry()` /
 *      `removeVaultEntry()`（条目的增删改查，加解密都在这里）、`generateVaultPassword()`、
 *      `vaultRenameTag()` / `vaultRemoveTag()`（0.4.4 起：标签的改名与删除）。
 *
 * ⭐ **标签（0.4.4 起）与标题睡在同一个密文里** —— 密文载荷从
 *    `{title,username,password,url,note}` 变成 `{…, tags:[…]}`。
 *    所以本模块**没有任何一行代码需要碰标签的存储**：加解密、备份、导出、导入
 *    （导入不搬密文列，见 `methods/backup.js`）全都自动跟上，库里也没有第二张表
 *    —— 这就是「分类名不落明文」这条承诺在结构上的实现。
 *    ⚠️ 因此**筛选与关键词搜索在前端做**（数据本来就已经整份解密在内存里）：
 *    服务端看不见标签，也就不可能替前端筛。别为了「服务端筛选方便」把标签挪到明文列。
 *    ⚠️ 老条目解出来的对象里**没有 `tags` 键**，`normTags()` 会兜成空数组 —— 零迁移。
 *
 * ⭐ **解锁状态是本模块最敏感的一处**（方案 §4.5），它有四条铁律：
 *   ① **DEK 只活在进程内存里** —— 一个模块级 `Map<uid, {dek, at, timer}>`，
 *      **绝不落盘、绝不进日志、绝不进任何响应体**；
 *   ② **不写 `this.data` / 不写库**：解锁是「这台服务进程记得你刚解锁过」，
 *      不是一条要被备份、被复制、被同步的数据；
 *   ③ **到期就删引用**（`setTimeout` + 每次访问滑动续期），进程退出自然消失；
 *   ④ **未解锁一律拒绝** —— 条目接口连「有几条」都不回答（403，且响应体里没有条目信息）。
 *   ⚠️ 诚实边界：JS **无法可靠清零**内存里的 Buffer（没有 `mlock`，GC 也不保证及时回收），
 *      所以本模块不做「用完 `fill(0)`」这种看着安全实则无效的表演。真实的防护是
 *      **10 分钟自动锁定 + 密钥不写盘**；「攻击者已拿到 root 且在你解锁期间读进程内存」不在
 *      本期的威胁模型内（产品说明里如实写着，见 `docs/公共/架构文档/16-密码库.md`）。
 *
 * ⭐ **加密只在这里发生一次**：`lib/crypto.js` 提供原语，本模块负责「什么时候调哪个原语」。
 *    两个后端（SQLite / JSON）只提供「存密文行 / 取密文行」这一组原语，**完全不懂密码学** ——
 *    这样「换个后端密码库就打不开」这种事在结构上不可能发生（与收藏夹 / 硬件同一条理由）。
 *
 * 🔑 **密钥架构（信封加密，方案）**：
 *    主密码 --scrypt(salt)--> KEK --AES-GCM--> DEK --AES-GCM(每条独立 IV)--> 条目密文
 *    · KEK 只用来解开 DEK（`dek_cipher`），**永远不直接加密条目**；
 *    · 所以「改主密码」只需用新 KEK 重新封装那 32 字节的 DEK，**不必重加密整库**；
 *    · `verifier_*` 是用 KEK 加密的固定明文 —— 解得开就说明主密码对（**不另存口令哈希**，
 *      方案）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `core/store/methods/vault.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。方法体一个字没动，
 *    只改了相对路径（`helpers.js` 多上跳一层、密码学原语改成模块自己的 `lib/crypto.js`）。
 *    ⚠️ **安全结论一个字都没改**：加密流程、解锁状态的四条铁律、响应体里不出现任何密钥材料
 *    —— 全都照旧。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.7
 * 相关：docs/公共/架构文档/16-密码库.md、docs/公共/开发方案/05-密码库-1期.md
 */
const crypto = require('node:crypto');
const { nowStamp, notFoundErr, badRequest, isBlankPassword } = require('../../core/store/helpers.js');
const vc = require('./lib/crypto.js');

/** 自动锁定的默认分钟数（方案 §十三-3 定案：10 分钟，可设置） @type {number} */
const DEFAULT_LOCK_MINUTES = 10;

/** 自动锁定分钟数的允许区间 —— 与 `validate.js` 的口径一致（**不允许 0**：自动锁定是安全特性） */
const LOCK_MINUTES_MIN = 1;
const LOCK_MINUTES_MAX = 120;

/** 钥匙编号的前缀 —— 与 `.zxkey` 文件格式里的 `app` 同源，改它 = 旧钥匙的 `kid` 全部对不上 */
const KID_PREFIX = 'zxdesk-key-v1';

/** 钥匙文件的大小上限：64 KB（方案 §8.1）—— 超过一定不是我们的文件 */
const KEY_FILE_MAX = 64 * 1024;

/** 导入钥匙时允许的 KDF 参数上限（方案 §8.3）—— 防止有人用「N=2^30」让服务端卡死 */
const IMPORT_KDF_MAX = { N: 1 << 17, r: 8, p: 4 };

/** 「已开钥匙」的空闲超时：10 分钟滑动（与密码库解锁态同一条体感） */
const READER_IDLE_MS = 10 * 60 * 1000;

/** 「已开钥匙」的数量上限（LRU 淘汰） */
const READER_MAX = 8;

/** 一个标签名的长度上限 —— 与 `validate.js` 的 `MAX_SHORT_TEXT` 同口径（收藏夹分类名也是 50） */
const MAX_TAG_LEN = 50;

/** 一条记录最多几个标签 —— 与 `validate.js` 的 `MAX_VAULT_TAGS` 同口径 */
const MAX_TAGS = 20;

/**
 * 功能：把「从密文里解出来的标签」或「请求里带上来的标签」归一化成 `string[]`。
 *
 * 说明：⭐ 它**同时**服务两个方向，这是刻意的：
 *      · 写入方向：请求里的 `tags` 已经过 `validate.js`，这里再兜一次（密文里存的东西
 *        不该依赖「上游一定校验过」）；
 *      · 读出方向：**密文是用户可以手工编辑的**（数据库文件就在他自己的 NAS 上），
 *        解出来的 `tags` 可能是字符串、可能是数字数组、可能根本没有这一键。
 *        读出方向若不做兜底，界面会在 `.map()` 上一头栽进去（表现是整屏白）。
 *      ⚠️ 上限**在这里是截断而不是报错**：读出方向的输入不可信，为了「一条坏记录」
 *        把整屏列表打崩是最差的选择；写入方向的报错已经在 `validate.js` 给过用户了。
 *
 * @param {*} raw - 原始值（数组 / 字符串 / null / 未定义）
 * @returns {Array.<string>} 去空白、丢空串、去重、截断后的标签名数组
 */
function normTags(raw) {
  const list = Array.isArray(raw) ? raw : [];
  /** @type {Array.<string>} */
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const name = String(item).trim();
    if (!name || name.length > MAX_TAG_LEN) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * 进程内解锁表：`uid → { dek, at, minutes, timer }`。
 *
 * ⚠️ 它是**模块级的**（不是 `this.` 上的）：解锁状态压根不属于「存储层的数据」，
 *    它跟 Store 实例的生命周期无关（同一进程重新构造 Store 也不该把密钥丢了）。
 *    `ttt/test/vault.test.js` 用 `vaultLockAll()` 在用例之间清场。
 *
 * @type {Map.<number, {dek: Buffer, at: number, minutes: number, timer: ?Object}>}
 */
const unlocked = new Map();

/**
 * 进程内「已开钥匙」表：`"<会话账号>:<kid>" → {dek, ownerUid, at, timer}`。
 *
 * 说明：⭐⭐ 0.9.8 第 6 轮（阅读器）：这里的 DEK **不是**某个账号的解锁态，
 *      而是「这一把钥匙刚刚被输对过密码」—— 它来自 `.zxkey` 导入的材料，
 *      **不进 `unlocked`、不参与 `_vaultDek()`**，所以拿它打开别人的文件
 *      ⛔ 不会把别人的密码库解锁（方案 §10.3 第 ③ 条）。
 *      ⚠️ 键里带**会话账号**：同一把钥匙被两个人分别导入时，各自输各自的密码、各自计时。
 *      ⚠️ 绝不落盘、绝不进响应、绝不进日志（与 `unlocked` 同一条纪律）。
 * @type {Map.<string, {dek: Buffer, ownerUid: ?number, at: number, timer: ?Object}>}
 */
const readerKeys = new Map();

/**
 * 功能：校验一份 `.zxkey` 的**格式**（⛔ 不验密码、不解密、不碰数据库、不回任何密钥材料）。
 *
 * 说明：⭐⭐ 0.9.8 第 7 轮（方案 §14.6.1.3）：`keyInspect()` 与 `keyImport()` 共用这一处。
 *      抽出来的理由是**失效方式**——两处各写一遍，早晚一边放宽一边没放宽，
 *      症状是「识别说这是好钥匙，导入却说不是钥匙文件」，用户在两步之间被绕死。
 *      ⚠️ 这里**不校验 `kid` 与材料是否对得上**：那要解密后才能算（`kidOf()`），
 *      而 inspect 明确「不验密码」。⇒ `kid` 只当**文件里写的那一个**用（显示与查重）。
 * @param {Object} obj - 解析后的 JSON
 * @returns {{obj: Object, params: Object, salt: Buffer, kid: string, owner_uid: ?number, owner_name: string, created_at: string}}
 *      校验通过的材料；⛔ 调用方别把 `salt` / `obj` 里的字段往外吐
 * @throws {Error} 400（格式不合法 / 被截断 / 参数越界）
 */
function parseKeyFile(obj) {
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  if (!o || o.app !== 'zxdesk' || Number(o.v) !== 1 || o.kind !== 'vault-key') {
    throw badRequest('这不是一个有效的钥匙文件');
  }
  // ⚠️ 大小上限在**解析后**再兜一次：路由层已经按 `KEY_FILE_MAX` 限制读取长度，
  //    但那个口头约定不该是唯一防线（少一处就是「一个 50 MB 的 JSON 进内存」）。
  if (Buffer.byteLength(JSON.stringify(o), 'utf8') > KEY_FILE_MAX) {
    throw badRequest('这不是一个有效的钥匙文件');
  }
  const str = (v) => String(v == null ? '' : v);
  const need = ['kid', 'salt', 'dek_iv', 'dek_cipher', 'dek_tag', 'verifier_iv', 'verifier_cipher', 'verifier_tag'];
  if (need.some((f) => !str(o[f]))) throw badRequest('钥匙文件不完整（可能被截断）');
  if (String(o.kdf || 'scrypt') !== 'scrypt') throw badRequest('钥匙文件的参数不合法（可能被改过）');
  let params;
  try {
    params = vc.normalizeKdfParams(o.kdf_params);
  } catch (_e) {
    throw badRequest('钥匙文件的参数不合法（可能被改过）');
  }
  if (params.N > IMPORT_KDF_MAX.N || params.r > IMPORT_KDF_MAX.r || params.p > IMPORT_KDF_MAX.p) {
    throw badRequest('钥匙文件的参数不合法（可能被改过）');
  }
  const salt = Buffer.from(str(o.salt), 'base64');
  if (salt.length < 8) throw badRequest('钥匙文件不完整（可能被截断）');
  return {
    obj: o,
    params,
    salt,
    kid: str(o.kid),
    owner_uid: Number.isInteger(Number(o.owner_uid)) ? Number(o.owner_uid) : null,
    owner_name: str(o.owner_name).slice(0, 100),
    created_at: str(o.created_at),
  };
}

/**
 * 功能：算一把钥匙的编号（DEK 指纹前 16 位十六进制）。
 *
 * 说明：⭐ `kid` **不是密钥**，只是「这两把钥匙是不是同一把」的指纹 ——
 *      它进 `.zxkey` 文件、进数据库、进接口响应（方案 §8.1 / §8.4），所以绝不能由它反推 DEK。
 *      ⚠️ 前缀 `zxdesk-key-v1` 刻意写死：换它就等于让所有已导出的钥匙「对不上号」。
 * @param {Buffer} dek - 32 字节数据密钥
 * @returns {string} 16 位小写十六进制
 */
function kidOf(dek) {
  return crypto.createHash('sha256').update(KID_PREFIX).update(dek).digest('hex').slice(0, 16);
}

/**
 * 功能：生成带本地时区偏移的 ISO 时间（`2026-11-08T22:40:00+08:00`）。
 *
 * 说明：⚠️ 刻意不用 `toISOString()`：它是 UTC（`…T14:40:00.000Z`），而钥匙文件是**给人看**的，
 *      「这把钥匙是什么时候导出的」应当按用户所在时区写。差值用 `getTimezoneOffset()` 算，
 *      不引入任何时区库（铁律 5）。
 * @param {Date} [d] - 时间（缺省现在）
 * @returns {string} 带偏移的 ISO 串
 */
function isoLocal(d) {
  const t = d instanceof Date ? d : new Date();
  const off = -t.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const body =
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` +
    `T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  return `${body}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

/**
 * 功能：算「已开钥匙」在内存表里的键（会话账号 ＋ 钥匙编号）。
 * @param {number} uid - 当前会话账号 id
 * @param {string} kid - 钥匙编号
 * @returns {string} 内存键
 */
function readerSlot(uid, kid) {
  return `${Number(uid)}:${String(kid)}`;
}

/**
 * 功能：把「已开钥匙」的内存键拆回 `[账号 id, 钥匙编号]`。
 * @param {string} slot - `readerSlot()` 生成的键
 * @returns {Array} `[uid, kid]`
 */
function splitSlot(slot) {
  const s = String(slot);
  const i = s.indexOf(':');
  if (i < 0) return [NaN, s];
  return [Number(s.slice(0, i)), s.slice(i + 1)];
}

/**
 * 功能：给一把「已开钥匙」挂一个「到期就从内存表删掉」的定时器。
 *
 * 说明：⚠️ 必须 `unref()`（与 `scheduleDrop()` 同一理由）。正确性由 `readerDek()` /
 *      `readerHas()` 里的时间比对兜底 —— 定时器只负责「尽早释放引用」，它可能晚触发。
 * @param {string} slot - 内存键
 * @returns {Object} Node 的 Timeout 句柄（已 unref）
 */
function scheduleReaderDrop(slot) {
  const t = setTimeout(() => {
    const e = readerKeys.get(slot);
    if (e && e.timer) clearTimeout(e.timer);
    readerKeys.delete(slot);
  }, READER_IDLE_MS);
  if (typeof t.unref === 'function') t.unref();
  return t;
}

/**
 * 功能：把这个账号在阅读器里**已经打开的**钥匙全部清掉（锁库时调）。
 *
 * 说明：⭐⭐ 0.9.8 第 7 轮（方案 §11.3 第 5 条）：老大要求「锁定过后自动回到这个界面」，
 *      而阅读器是另一个页面 —— 它自己那把钥匙（`readerKeys`，10 分钟滑动）如果留着，
 *      锁库之后那个窗口还能继续解密。⇒ 锁库这一下要**连它一起失效**，
 *      让它下一次请求拿 403，前端据此回到「需要主密码」。
 *      ⚠️ 只清**这个会话账号**导入的钥匙（键前缀 `uid:`）：同一把钥匙被别人导入是另一行记录，
 *      锁 A 的库不该打断 B 正在看的文件。
 *      ⚠️ 只删内存引用，⛔ 不碰库里已导入的钥匙记录（那是「下次还能用」，与「这次已经开着」是两件事）。
 * @param {number} uid - 会话账号 id
 * @returns {number} 清掉的把数
 */
function purgeReaderKeys(uid) {
  const prefix = `${Number(uid)}:`;
  let n = 0;
  for (const k of [...readerKeys.keys()]) {
    if (!k.startsWith(prefix)) continue;
    const e = readerKeys.get(k);
    if (e && e.timer) clearTimeout(e.timer);
    readerKeys.delete(k);
    n += 1;
  }
  return n;
}

/**
 * 功能：构造一个「需要解锁 / 主密码不对」的 403 错误。
 *
 * 说明：⭐ **刻意不用 401**：前端的规则是「遇到 401 一律跳登录页」，
 *      而「主密码输错了」把人踢回登录页是彻底的误伤（他账号明明好好的）。
 *      403 属于「授权结果」这一桶，响应体逐字固定、不掺 `readOnly` 之类字段。
 *
 * @param {string} message - 中文说明（会直接展示给用户）
 * @returns {Error} 带 `status = 403` 的错误
 */
function denied(message) {
  const e = new Error(message);
  e.status = 403;
  return e;
}

/**
 * 功能：把某个账号的解锁记录（连同它的定时器）从进程内存里彻底拿掉。
 * @param {number} uid - 账号 id
 * @returns {void}
 */
function dropUnlocked(uid) {
  const e = unlocked.get(Number(uid));
  if (e && e.timer) clearTimeout(e.timer);
  unlocked.delete(Number(uid));
}

/**
 * 功能：**只读**判断某个账号此刻在不在解锁态 —— 与 `vaultIsUnlocked()` 的唯一区别是**不续期**。
 *
 * 说明：⭐ 009 报告 S9：`GET /api/vault/status` 以前直接走 `vaultIsUnlocked()`，而那个方法每次访问
 *      都会把到期时间往后推 —— 于是**一个拿着 Cookie 的脚本低频轮询 status 就能让密码库永不自动锁定**
 *      （前端倒计时是纯本地的，不是前端缺陷）。「继续操作就续期」是给**真正在用密码库**的动作
 *      （查看 / 复制 / 增删改）准备的；「问一句现在锁没锁」不该享受这个待遇。
 *      ⚠️ 过期记录照样**当场清掉**（连同定时器）—— 只是不往后推而已。
 *
 * @param {number} uid - 账号 id
 * @returns {boolean} 处于解锁态返回 true（且**不改**到期时间）
 */
function peekUnlocked(uid) {
  const key = Number(uid);
  const e = unlocked.get(key);
  if (!e) return false;
  if (Date.now() - e.at > e.minutes * 60000) {
    dropUnlocked(key);
    // ⭐ 0.9.8 第 7 轮：定时器可能晚触发（进程忙）⇒ 这里发现过期也把阅读器的钥匙一并清掉，
    //    否则「已经超时」和「阅读器还能解密」会同时成立（方案 §11.3 第 5 条）
    purgeReaderKeys(key);
    return false;
  }
  return true;
}

/**
 * 功能：读某个账号的自动锁定分钟数（账号行上的 `vault_lock_minutes`，兜底默认 10 分钟）。
 *
 * 说明：⚠️ 兜底是**双向夹取**（既兜「老库没这一列 → undefined」，也兜「库里被写了个荒唐值」）：
 *      老 JSON 数据、以及结构升级前建出来的账号行都可能没有这一列 ——
 *      缺列的表现必须是「用默认的 10 分钟」，**不能是「永不锁定」**（那是一个安全特性的静默失效）。
 *
 * @param {Object} self - Store 实例（业务方法都挂在它的原型上）
 * @param {number} uid - 账号 id
 * @returns {number} 分钟数（1~120）
 */
function lockMinutesOf(self, uid) {
  const u = self.getUser(uid);
  const raw = u ? Number(u.vault_lock_minutes) : NaN;
  if (!Number.isInteger(raw) || raw < LOCK_MINUTES_MIN) return DEFAULT_LOCK_MINUTES;
  return Math.min(raw, LOCK_MINUTES_MAX);
}

module.exports = {
  DEFAULT_LOCK_MINUTES,
  LOCK_MINUTES_MIN,
  LOCK_MINUTES_MAX,

  /**
   * 功能：读某个账号的自动锁定分钟数（给路由层与前端用）。
   * @param {number} uid - 账号 id
   * @returns {number} 分钟数（1~120）
   */
  vaultLockMinutes(uid) {
    return lockMinutesOf(this, uid);
  },

  /**
   * 功能：改某个账号的自动锁定分钟数（**每个账号各管各的**，存在 `users` 行上）。
   *
   * 说明：⭐ 与四个显示开关同一条规矩：不进全局 `settings`、删账号随行消失、
   *      **不动 `session_epoch`**（改「多久自动锁」不该把人踢下线）。
   *      ⚠️ 改小之后**立刻生效**：已经在解锁态的那些会话，其到期时间按新值重算 ——
   *      否则「我刚改成 1 分钟，它却还按 10 分钟给我留着」，用户会以为设置没生效。
   *
   * @param {number} uid - 账号 id
   * @param {number} minutes - 分钟数（区间由 `validate.js` 保证）
   * @returns {number} 落库后的分钟数
   * @throws {Error} 数据层只读时抛 503
   */
  setVaultLockMinutes(uid, minutes) {
    this._assertWritable();
    const n = Number(minutes);
    if (!Number.isInteger(n) || n < LOCK_MINUTES_MIN || n > LOCK_MINUTES_MAX) {
      throw badRequest(`自动锁定时间应是 ${LOCK_MINUTES_MIN} 到 ${LOCK_MINUTES_MAX} 分钟之间的整数`);
    }
    if (!this._bk.setVaultLockMinutes(Number(uid), n, nowStamp())) {
      throw notFoundErr('这个账号');
    }
    const e = unlocked.get(Number(uid));
    if (e) {
      e.minutes = n;
      // 重设定时器：新值可以比原来更短，也可以更长，两种情况都得按新的来
      if (e.timer) clearTimeout(e.timer);
      e.timer = scheduleDrop(uid, n);
    }
    return n;
  },

  /**
   * 功能：密码库状态 —— **未解锁时也只回这三样**（`initialized` / `unlocked` / 锁定秒数），
   *      不含任何条目信息（连条数都不给）。
   *
   * 说明：⚠️ `initialized` 只说明「这个账号设过主密码」，它**不是**敏感信息 ——
   *      用户自己当然知道；而界面必须靠它决定「显示设置主密码页」还是「显示解锁页」。
   *      条目数量**刻意不给**：那是「你存了几个账号」的侧信道，未解锁时没有理由回答。
   *
   * @param {number} uid - 账号 id
   * @returns {{initialized: boolean, unlocked: boolean, lockAfterSeconds: number, lockMinutes: number}} 状态
   */
  vaultStatus(uid) {
    const minutes = lockMinutesOf(this, uid);
    const e = unlocked.get(Number(uid));
    const isOn = peekUnlocked(uid);
    // ⭐⭐ 0.9.8 第 7 轮（方案 §11.3 第 1 条）：多回一个「还剩多少秒」。
    //    ⚠️ 原来是靠前端各自算倒计时（只有密码库那一屏在跑），加密信息屏根本没有计时器 ⇒
    //    到点也不会回到锁屏。现在由 `core/vault-watch.js` 统一按这个值排到期定时器。
    //    ⚠️ 仍然走 `peekUnlocked()`（只读、**不续期**）—— 009 报告 S9 踩过
    //    「轮询 status 让自动锁定永不触发」，⛔ 不能改成 `vaultIsUnlocked()`。
    const left = isOn && e ? Math.max(0, Math.round((e.at + e.minutes * 60000 - Date.now()) / 1000)) : 0;
    return {
      initialized: !!this._bk.getVaultMeta(Number(uid)),
      // ⚠️ 只读判断（`peekUnlocked`）：这个接口是给界面问「现在锁没锁」的，
      //    **不算一次操作**、不续期 —— 否则脚本轮询就能让自动锁定永不触发（009 报告 S9）
      unlocked: isOn,
      lockAfterSeconds: minutes * 60,
      lockMinutes: minutes,
      remainingSeconds: left,
    };
  },

  /**
   * 功能：判断某个账号此刻是否处于解锁态 —— 顺带**滑动续期**（把到期时间往后推）。
   *
   * 说明：⭐ 超时口径是**空闲超时**（每次访问都续期），不是「从解锁那刻起 10 分钟一到就锁」：
   *      后者会在用户正对着详情页抄密码的时候把他锁掉，而方案 §七 明确要求
   *      「避免用户写到一半被锁掉」（界面还有锁前 30 秒提示）。
   *      ⚠️ 过期记录**当场删除**（连同定时器）—— 「过期了但还留着引用」等于把超时做成了摆设。
   *
   * @param {number} uid - 账号 id
   * @returns {boolean} 处于解锁态返回 true
   */
  vaultIsUnlocked(uid) {
    const key = Number(uid);
    if (!peekUnlocked(key)) return false;
    // ⭐ 只有走到这里才续期 —— 「问状态」走 `peekUnlocked()`，不推到期时间（009 报告 S9）
    const e = unlocked.get(key);
    e.at = Date.now();
    if (e.timer) clearTimeout(e.timer);
    e.timer = scheduleDrop(key, e.minutes);
    return true;
  },

  /**
   * 功能：初始化密码库 —— 第一次设置主密码（**每个账号一次**）。
   *
   * 说明：⭐ 一次性做三件事：生成随机盐 → 派生 KEK → 生成随机 DEK 并用 KEK 封装 →
   *      写一行 `vault_meta`（含用 KEK 加密的验证块）。**条目此时还是空的**。
   *      ⚠️ 重复初始化**明确报 400**（不是静默覆盖）：覆盖会让原密码库**永久打不开**
   *      （DEK 被换成新的，旧条目全部解不开），而用户以为只是「重新设了个密码」。
   *      ⚠️ 「已初始化」的判据是**库里有 `vault_meta` 行**，不是内存里的解锁表 ——
   *      所以服务重启之后 `initialized` 依然是 true。
   *
   * @param {number} uid - 账号 id
   * @param {string} masterPassword - 主密码明文（长度由 `validate.js` 保证）
   * @returns {{ok: true}} 固定返回体（**不回 DEK、不回任何库内材料**）
   * @throws {Error} 已初始化（400）、数据层只读（503）
   */
  vaultInit(uid, masterPassword) {
    this._assertWritable();
    const key = Number(uid);
    if (this._bk.getVaultMeta(key)) {
      throw badRequest('这个账号已经设置过主密码了，不能重复初始化（重新初始化会让原来的条目全部打不开）');
    }
    const params = vc.KDF_DEFAULT;
    const salt = vc.newSalt();
    const kek = vc.deriveKek(masterPassword, salt, params);
    const dek = vc.newDek();
    const sealed = vc.sealDek(kek, dek);
    const verifier = vc.makeVerifier(kek);
    const stamp = nowStamp();
    this._bk.insertVaultMeta(key, {
      kdf: 'scrypt',
      kdf_params: JSON.stringify({ N: params.N, r: params.r, p: params.p, keylen: params.keylen }),
      salt: salt.toString('base64'),
      dek_iv: sealed.iv,
      dek_cipher: sealed.cipher,
      dek_tag: sealed.tag,
      verifier_iv: verifier.iv,
      verifier_cipher: verifier.cipher,
      verifier_tag: verifier.tag,
      created_at: stamp,
      updated_at: stamp,
    });
    // ⭐ 初始化成功即视为已解锁：用户刚刚亲口设了主密码，再让他立刻输一遍是纯粹的添堵
    this._vaultHold(key, dek);
    return { ok: true };
  },

  /**
   * 功能：用主密码解锁密码库 —— 校验通过则把 DEK 放进**进程内**解锁表。
   *
   * 说明：⭐ 校验分两步、缺一不可：① 用主密码 + 库里那个盐派生 KEK；
   *      ② 用它解开 `verifier_*` 并比对固定明文。**不需要**先解 DEK ——
   *      验证块对不上的时候连 DEK 密文都不碰（少一次可能出错的解密）。
   *      ⚠️ 失败信息**只有一句「主密码不正确」**：不区分「密码错」与「密文被改过」，
   *      也不透露盐或参数。这两种情况的处置对用户来说是一样的（重试或放弃）。
   *      ⚠️ `kdf_params` 读不出来（手改坏了）时抛出的是**另一句话**（参数损坏）——
   *      因为那不是「密码错」，用户重试一百次也没用，必须让他知道该走备份恢复。
   *
   * @param {number} uid - 账号 id
   * @param {string} masterPassword - 主密码明文
   * @returns {{ok: true, lockAfterSeconds: number}} 成功结果
   * @throws {Error} 未初始化（400）、主密码不对（403）
   */
  vaultUnlock(uid, masterPassword) {
    const key = Number(uid);
    const meta = this._bk.getVaultMeta(key);
    if (!meta) throw badRequest('这个账号还没有设置主密码，请先设置');
    if (String(meta.kdf) !== 'scrypt') throw badRequest('这个密码库用了本版本不认识的算法，请升级应用后再试');

    const params = vc.parseKdfParams(meta.kdf_params); // 参数损坏 → 抛「参数已损坏」，不是「密码错」
    const salt = Buffer.from(String(meta.salt || ''), 'base64');
    if (salt.length < 8) throw badRequest('这个密码库的盐已损坏，无法解锁（请从备份恢复）');
    const kek = vc.deriveKek(masterPassword, salt, params);
    const ok = vc.checkVerifier(kek, {
      iv: meta.verifier_iv,
      cipher: meta.verifier_cipher,
      tag: meta.verifier_tag,
    });
    if (!ok) throw denied('主密码不正确');

    const dek = vc.openDek(kek, { iv: meta.dek_iv, cipher: meta.dek_cipher, tag: meta.dek_tag });
    const minutes = lockMinutesOf(this, key);
    this._vaultHold(key, dek, minutes);
    return { ok: true, lockAfterSeconds: minutes * 60 };
  },

  /**
   * 功能：把一个 DEK 放进进程内解锁表，并挂上到期自动清除的定时器。
   *
   * 说明：⭐ 定时器必须 `unref()` —— 否则它会**拖住事件循环**，
   *      表现为「关掉应用之后进程迟迟不退出」（真机上是停不下来的服务）。
   *      真正的到期判定在 `vaultIsUnlocked()` 里也做了一遍（定时器只是让引用尽早释放，
   *      不是正确性的唯一来源 —— 定时器可能因为进程忙碌而晚触发）。
   *
   * @param {number} uid - 账号 id
   * @param {Buffer} dek - 32 字节数据密钥
   * @param {number} [minutes] - 锁定分钟数；省略时读该账号的偏好
   * @returns {void}
   */
  _vaultHold(uid, dek, minutes) {
    const key = Number(uid);
    const m = Number.isInteger(minutes) ? minutes : lockMinutesOf(this, key);
    dropUnlocked(key);
    unlocked.set(key, { dek, at: Date.now(), minutes: m, timer: scheduleDrop(key, m) });
  },

  /**
   * 功能：取当前账号的 DEK（**本模块唯一的取密钥出口**）；未解锁或已超时一律抛 403。
   *
   * 说明：⚠️ 所有条目方法都必须先过这里 —— 它是「未解锁不返回任何条目信息」这条规矩的
   *      单一执行点。**不要**在任何地方绕过它去读 `unlocked`。
   *
   * @param {number} uid - 账号 id
   * @returns {Buffer} 32 字节 DEK
   * @throws {Error} 未解锁（403）
   */
  _vaultDek(uid) {
    if (!this.vaultIsUnlocked(uid)) throw denied('密码库已锁定，请先输入主密码解锁');
    return unlocked.get(Number(uid)).dek;
  },

  /**
   * 功能：手动锁定密码库（界面上的「🔒 锁定」按钮）。
   * @param {number} uid - 账号 id
   * @returns {{ok: true}} 固定返回体（**不回「锁没锁上」之外的任何东西**）
   */
  vaultLock(uid) {
    // ⭐ 0.9.8 第 7 轮：手动锁定也要把阅读器已开的钥匙清掉（`lockAndPurge()`）
    this.lockAndPurge(uid);
    return { ok: true };
  },

  /**
   * 功能：锁定一个账号并**连带清掉它在阅读器里已开的钥匙**（锁库的唯一推荐入口）。
   *
   * 说明：⭐⭐ 0.9.8 第 7 轮（方案 §11.3 第 5 条）：老大要求锁库后「不留一个还在解密的窗口」。
   *      三处调用：手动锁定（`vaultLock()`）、自动到期（`scheduleDrop()` 的定时器）、
   *      `peekUnlocked()` 发现已过期。⛔ 别把清理塞进 `dropUnlocked()` ——
   *      `_vaultHold()`（重新解锁）也调它，那样每次解锁都会误伤。
   * @param {number} uid - 账号 id
   * @returns {{ok: true, purged: number}} 清掉的阅读器钥匙把数（排查用，界面不看）
   */
  lockAndPurge(uid) {
    const key = Number(uid);
    dropUnlocked(key);
    return { ok: true, purged: purgeReaderKeys(key) };
  },

  /**
   * 功能：清空**全部**账号的解锁状态（测试与运维用；也可作为「全局上锁」的入口）。
   * @returns {number} 被清掉的解锁记录条数
   */
  vaultLockAll() {
    const n = unlocked.size;
    [...unlocked.keys()].forEach(dropUnlocked);
    // ⭐ 0.9.8 第 7 轮：全局上锁同样要清阅读器钥匙（测试清场靠它，
    //    运维「一键上锁」也不该留下还能解密的窗口）
    readerKeys.forEach((e) => {
      if (e && e.timer) clearTimeout(e.timer);
    });
    readerKeys.clear();
    return n;
  },

  /**
   * 功能：**仅供测试** —— 看某个账号当前的解锁记录（**只回时间信息，绝不回密钥**）。
   *
   * 说明：⚠️ 这是给 `ttt/test/vault.test.js` 的**测试缝**（方案 §九 要求「超时自动锁定用
   *      可注入的时钟 / 短超时验证」）。它刻意**只返回 `{at, minutes}`、不返回 DEK** ——
   *      一个会吐密钥的测试钩子迟早会被用到请求路径上去。
   *      ⚠️ 生产代码里**不许调用它**（它存在的唯一理由是让超时可以被验证，而不必真等 10 分钟）。
   *
   * @param {number} uid - 账号 id
   * @returns {?{at: number, minutes: number}} 解锁记录的时间信息；未解锁时为 null
   */
  _vaultDebugLockState(uid) {
    const e = unlocked.get(Number(uid));
    return e ? { at: e.at, minutes: e.minutes } : null;
  },

  /**
   * 功能：**仅供测试** —— 把某个账号的解锁记录**标记为已过期**（把 `at` 往回拨到期限之外）。
   *
   * 说明：⚠️ 与 `_vaultDebugLockState` 同一性质：测试缝，生产代码不许调。
   *      它**不删记录**（那是 `vaultIsUnlocked()` 的职责）—— 这样测试才能验到
   *      「过期记录会被当场删掉」这一条（否则就变成了「测试自己把它删了」）。
   *
   * @param {number} uid - 账号 id
   * @returns {boolean} 确实有一条记录被拨过期返回 true
   */
  _vaultDebugExpire(uid) {
    const e = unlocked.get(Number(uid));
    if (!e) return false;
    e.at = Date.now() - (e.minutes + 1) * 60000;
    return true;
  },

  /**
   * 功能：列出该账号的全部条目 —— **只回摘要，不回密码**（列表页用）。
   *
   * 说明：⭐ 为什么列表里也不给密码：界面上「列表 → 点进去 → 复制」是两步，
   *      把全部密码一次性吐给列表页，等于每打开一次密码库就把它整本摊在内存与网络里，
   *      而用户此刻可能只是在找「那个 GitHub 的账号叫什么」。
   *      ⚠️ 单条解密失败（密文被改过 / 手工编辑坏了）**不静默跳过**：
   *      跳过会让用户以为「这条记录不见了」，而实际情况是「这条被损坏了」。
   *      这里把它标成 `broken: true` 一并返回，标题留空，由界面明确显示一条告警。
   *      ⭐ 每条都带上 `tags`（0.4.4 起）：**筛选与搜索都在前端做**，所以标签必须跟着
   *      摘要一起回来 —— 但这**不是**「服务端也开始按标签筛了」，服务端只是把密文里的
   *      那几个字符串原样交给已经在内存里持有明文的那个界面（见文件头）。
   *      损坏的那条同样给 `tags: []`（**不是不给这一键**）：界面统一按数组用，
   *      「某一条没有这个字段」会变成一个只在损坏时才出现的分支。
   *      ⭐ 0.8.18：另回一份 `tagPool`（建过、但还没有任何记录用到的标签名，见 `vaultTagPool()`）
   *      —— 左栏与计数要把它并进去，否则「刚建的空标签」下一次取数就凭空消失。
   *
   * @param {number} uid - 账号 id
   * @returns {{items: Array.<Object>, broken: number, tagPool: Array.<string>}} 摘要列表、损坏条数与标签池
   * @throws {Error} 未解锁（403）
   */
  listVaultEntries(uid) {
    const dek = this._vaultDek(uid);
    /** @type {Array.<Object>} */
    const items = [];
    let broken = 0;
    for (const row of this._bk.listVaultItems(Number(uid))) {
      let obj;
      try {
        obj = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
      } catch (_e) {
        broken += 1;
        items.push({
          id: row.id,
          title: '',
          username: '',
          url: '',
          tags: [],
          // ⭐ 0.9.8：解不开的那条**算不出**它有没有密码 ⇒ 一律 false。
          //    ⚠️ 别给它 true：那会让界面在一条「已经坏了」的记录上再叠一句「这条没设密码」，
          //    两句话指的其实是不同的毛病，混在一起用户只会更糊涂。
          blank_password: false,
          broken: true,
          updated_at: row.updated_at,
        });
        continue;
      }
      items.push({
        id: row.id,
        title: String(obj.title || ''),
        username: String(obj.username || ''),
        url: String(obj.url || ''),
        tags: normTags(obj.tags),
        has_note: !!obj.note,
        // ⭐⭐ 0.9.8（方案 42 §一·4）：**算出来的**标记 —— 老库里已经存进去的空白密码条目
        //    不自动删、不自动改（R-002），只在列表里标一句「这条没设密码」，由用户自己补或删。
        //    ⚠️ 它**不进表、不加列**：库里多一列就多一份要维护的真相，
        //    而「空不空」完全由密文里的 `password` 当场算得出来。
        blank_password: isBlankPassword(obj.password),
        broken: false,
        updated_at: row.updated_at,
      });
    }
    return { items, broken, tagPool: this.vaultTagPool(uid) };
  },

  /**
   * 功能：判断某条密码条目是否属于该账号（路由层在「详情 / 编辑 / 删除」前统一用它回 404）。
   *
   * 说明：⭐ 它**不需要解锁**：只比对 `id` 与 `user_id`，不碰任何密文列 ——
   *      所以「未解锁时探某个 id 存不存在」也只会得到 404，不泄露任何条目内容。
   *      路由层把这一步放在「取 DEK」之前，是为了让**越权与不存在**在任何状态下都回同一个 404。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsVaultEntry(uid, id) {
    return this._bk.ownsVaultItem(Number(uid), id);
  },

  /**
   * 功能：要求当前账号处于解锁态（不满足直接抛 403），顺带把解锁态**滑动续期**一次。
   *
   * 说明：给「不需要读条目、但仍要求在解锁态」的接口用（例如密码生成器，方案 §六 把它归在
   *      「登录 + 已解锁」那一档）—— 它本身不产生任何数据，但把它挂在解锁之后，
   *      「谁能调生成器」就和「谁能看密码」是同一个门槛，不会多出一条独立的判定路径。
   *
   * @param {number} uid - 账号 id
   * @returns {boolean} 恒为 true（不满足时抛错）
   * @throws {Error} 未解锁时抛 403
   */
  vaultAssertUnlocked(uid) {
    this._vaultDek(uid);
    return true;
  },

  /**
   * 功能：取一条条目的**完整内容**（含密码），供详情页查看 / 复制。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {Object} `{ id, title, username, password, url, note, tags, updated_at }`
   * @throws {Error} 未解锁（403）、条目不存在或不属于本人（404）、密文损坏（500 之外另说，见下）
   */
  getVaultEntry(uid, id) {
    const dek = this._vaultDek(uid);
    const row = this._bk.getVaultItem(Number(uid), id);
    if (!row) throw notFoundErr('这条密码记录');
    let obj;
    try {
      obj = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
    } catch (_e) {
      // ⚠️ 这里**不冒充 404**：记录确实存在，只是解不开。回 404 会让用户以为记录被删了，
      //    而真相是「这条记录被改坏了，请从备份恢复」——两者的处置完全不同。
      throw badRequest('这条记录已损坏，解不出内容（可能是数据库被手工改动过，请从备份恢复）');
    }
    return {
      id: row.id,
      title: String(obj.title || ''),
      username: String(obj.username || ''),
      password: String(obj.password || ''),
      url: String(obj.url || ''),
      note: String(obj.note || ''),
      tags: normTags(obj.tags),
      updated_at: row.updated_at,
    };
  },

  /**
   * 功能：新建一条密码条目（整条加密后落库）。
   *
   * 说明：⚠️ 必填的 `password` 由路由层查（`validate.checkVaultItem` 只管「带了就校验」，
   *      与收藏夹的 `url`、硬件的 `name` 同一手法），这样编辑时「只改标题」不会被要求重发密码。
   *      ⚠️ IV 由 `vc.encryptJson()` 内部 `randomBytes(12)` 生成，**本层无从指定**（GCM 的 IV 绝不复用）。
   *      ⚠️ 标签**跟着这一条一起加密**（0.4.4 起）：库里因此没有明文分类名，
   *      代价是服务端没法按标签检索 —— 筛选在前端做（见文件头）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} item - 明文条目 `{ title, username, password, url, note, tags }`
   * @returns {{id: number}} 新条目 id
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  createVaultEntry(uid, item) {
    this._assertWritable();
    const dek = this._vaultDek(uid);
    const sealed = vc.encryptJson(dek, {
      title: String((item && item.title) || ''),
      username: String((item && item.username) || ''),
      password: String((item && item.password) || ''),
      url: String((item && item.url) || ''),
      note: String((item && item.note) || ''),
      tags: normTags(item && item.tags),
    });
    const stamp = nowStamp();
    const row = this._bk.insertVaultItem(Number(uid), {
      iv: sealed.iv,
      cipher: sealed.cipher,
      tag: sealed.tag,
      sort_order: Number((item && item.sort_order) || 0) || 0,
      created_at: stamp,
      updated_at: stamp,
    });
    return { id: row.id };
  },

  /**
   * 功能：编辑一条条目 —— 只改请求里真的带了的字段，改完**整条重新加密**。
   *
   * 说明：⭐ 「整条重新加密」是刻意的（而不是只改密文里的某一段）：密文是**一整块**，
   *      字段级加密会让「一条记录里几个字段的 IV 一样不一样」变成需要推理的事。
   *      代价是要先把原明文解出来，收益是没有第二种密文形态。
   *      ⚠️ **每次写入都换新 IV**（`vc.encryptJson` 自己生成）—— 复用旧 IV 是 GCM 的致命错误
   *      （方案 §5.3 硬要求 2）。`ttt/test/vault.test.js` 断言了「改完之后 IV 与改之前不同」。
   *      ⚠️ 一条记录都没改到（不属于本人）→ 返回 false，由路由层收口成 404。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @param {Object} patch - 只含要改的字段（`title` / `username` / `password` / `url` / `note` / `tags`）
   * @returns {boolean} 是否真的改到了（不归本人时为 false）
   * @throws {Error} 未解锁（403）、条目不存在（404）、密文损坏（400）、数据层只读（503）
   */
  updateVaultEntry(uid, id, patch) {
    this._assertWritable();
    const dek = this._vaultDek(uid);
    const key = Number(uid);
    const row = this._bk.getVaultItem(key, id);
    if (!row) throw notFoundErr('这条密码记录');
    let cur;
    try {
      cur = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
    } catch (_e) {
      throw badRequest('这条记录已损坏，解不出内容，无法修改（请从备份恢复）');
    }
    const next = {
      title: String(cur.title || ''),
      username: String(cur.username || ''),
      password: String(cur.password || ''),
      url: String(cur.url || ''),
      note: String(cur.note || ''),
      tags: normTags(cur.tags),
    };
    const src = patch && typeof patch === 'object' ? patch : {};
    ['title', 'username', 'password', 'url', 'note'].forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) next[k] = String(src[k] || '');
    });
    // ⚠️ 标签单独处理（它是数组）：**不带 `tags` 键 = 原样保留**，这一条是「改备注别把标签弄丢」的
    //    唯一保障 —— 界面上「只改标题」的那次 PUT 不会带上 tags，落到这里就必须是旧值。
    if (Object.prototype.hasOwnProperty.call(src, 'tags') && src.tags !== undefined) next.tags = normTags(src.tags);
    const sealed = vc.encryptJson(dek, next);
    return this._bk.updateVaultItem(
      key,
      id,
      ['iv', 'cipher', 'tag', 'updated_at'],
      [sealed.iv, sealed.cipher, sealed.tag, nowStamp()],
    );
  },

  /**
   * 功能：删除一条条目（密文行整行删掉）。
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  removeVaultEntry(uid, id) {
    this._assertWritable();
    this._vaultDek(uid); // 未解锁不许删（删也是写操作，但它同时需要「证明你在场」）
    return this._bk.deleteVaultItem(Number(uid), id);
  },

  /**
   * 功能：把**所有**条目里叫 `from` 的标签改名为 `to`（0.4.4 起）—— 界面上的「标签改名」。
   *
   * 说明：⭐ 标签没有自己的表（它睡在每条记录的密文里），所以「改名」在物理上就是
   *      「把所有带着它的记录读出来、改一个字符串、再写回去」。这正是本模块为
   *      「分类名不落明文」付出的代价，也是它换来的东西：库里找不到「工作 / 银行 / 公司 VPN」
   *      这些字眼。
   *      ⚠️ 新名与**已有的另一个标签重名时是「合并」**（两条都带上新名，靠归一化去重）——
   *      这是用户心里最自然的语义，也是最省事的：不需要问「要不要合并」。
   *      ⚠️ 一条都没改到（没人用这个标签 / 界面拿的是旧数据）→ `changed: 0`，
   *      **不是 404**：标签在服务端不是一个「资源」，它只是密文里的一个字符串。
   *
   * @param {number} uid - 账号 id
   * @param {string} from - 原标签名（由 `validate.checkVaultTagRename` 归一化）
   * @param {string} to - 新标签名
   * @returns {{changed: number}} 实际被改写的记录条数
   * @throws {Error} 未解锁（403）、有记录解不开（400）、数据层只读（503）
   */
  vaultRenameTag(uid, from, to) {
    const r = this._vaultRewriteTags(uid, (tags) => tags.map((t) => (t === from ? to : t)));
    // ⭐ 0.8.18：标签池跟着改名（池里那个名字若还在，不改就会出现「刚建的空标签改完名还在」）——
    //    重名由 `normTags` 去重，正好等于「合并」。
    this._vaultSyncPool(uid, (pool) => pool.map((t) => (t === from ? to : t)));
    return r;
  },

  /**
   * 功能：把**所有**条目里叫 `name` 的标签拿掉（0.4.4 起）—— 界面上的「删除这个标签」。
   *
   * 说明：⚠️ 删标签**不删记录**（与收藏夹「删分类不删书签」同一条语义），
   *      只是把那个字符串从每条记录的标签数组里摘掉；记录本身一个字段都没变。
   *
   * @param {number} uid - 账号 id
   * @param {string} name - 要摘掉的标签名（由 `validate.checkVaultTagRemove` 归一化）
   * @returns {{changed: number}} 实际被改写的记录条数
   * @throws {Error} 未解锁（403）、有记录解不开（400）、数据层只读（503）
   */
  vaultRemoveTag(uid, name) {
    const r = this._vaultRewriteTags(uid, (tags) => tags.filter((t) => t !== name));
    // ⭐ 0.8.18：标签池也要摘掉它 —— 否则「删了的标签」会从池里原样冒回来（计数 0、筛出空列表）。
    this._vaultSyncPool(uid, (pool) => pool.filter((t) => t !== name));
    return r;
  },

  /**
   * 功能：读该账号的**标签池** —— 建过、但可能还没有任何记录用到的标签名（0.8.18）。
   *
   * 说明：⭐⭐ 池子**也是一份密文**（`vault_meta.tags_*`，用同一把 DEK 加解密），
   *      所以它**不是** `vault_tags` 明文表 —— 服务端照旧看不见任何标签名。
   *      ⚠️ 读它**必须已解锁**（`_vaultDek()` 是唯一门槛，与 `listVaultEntries` 同一处），
   *      未解锁一律 403 —— 「你有哪些分类」同样属于「你有哪些账号」那类信息。
   *      ⚠️ 密文解不开（手改坏了）时**返回空池而不是抛错**：条目里的标签一条都没丢，
   *      为一份辅助清单把整个列表页打崩是最差的选择（与 `normTags` 那条「读出方向兜底」同一取向）。
   *
   * @param {number} uid - 账号 id
   * @returns {Array.<string>} 标签池（归一化后的名字数组；没有时为空数组）
   * @throws {Error} 未解锁（403）
   */
  vaultTagPool(uid) {
    const dek = this._vaultDek(uid);
    const meta = this._bk.getVaultMeta(Number(uid));
    if (!meta || !meta.tags_cipher) return [];
    try {
      const obj = vc.decryptJson(dek, { iv: meta.tags_iv, cipher: meta.tags_cipher, tag: meta.tags_tag });
      return normTags(obj && obj.tags);
    } catch (_e) {
      return [];
    }
  },

  /**
   * 功能：往标签池里**新建一个空标签**（0.8.18，界面上的「写一个新标签 ＋ 新建」）。
   *
   * 说明：⭐ 这是密码库唯一一处「建出来时还没有任何记录用到它」的标签 —— 与随手记 / 收藏夹
   *      的空标签同形（它们靠明文标签表实现；密码库靠这份加密清单，见 `schema.js` 文件头）。
   *      ⚠️ 同名**不报错、直接回 `added: false`**：用户在输入框里连点两下不该看到红字，
   *      而这与「服务端已存在同名标签」是同一件事（筛选、计数都按名字走）。
   *      ⚠️ 上限与「一条记录的标签数」同一个 `MAX_TAGS`：池子只是让名字提前存在，
   *      没有理由比真正能挂上去的还多。
   *
   * @param {number} uid - 账号 id
   * @param {string} name - 标签名（已由 `validate.checkVaultTagCreate` 归一化）
   * @returns {{ok: true, name: string, added: boolean}} `added=false` 表示本来就有
   * @throws {Error} 未初始化（400）、未解锁（403）、池满（400）、数据层只读（503）
   */
  vaultAddTag(uid, name) {
    this._assertWritable();
    const key = Number(uid);
    if (!this._bk.getVaultMeta(key)) throw badRequest('这个账号还没有设置主密码，请先设置');
    const before = this.vaultTagPool(uid);
    if (before.includes(name)) return { ok: true, name, added: false };
    if (before.length >= MAX_TAGS) throw badRequest(`标签最多 ${MAX_TAGS} 个`);
    this._vaultSyncPool(uid, (pool) => pool.concat([name]));
    return { ok: true, name, added: true };
  },

  /**
   * 功能：把标签池整体改一遍并写回 —— 改名 / 删除 / 新建三条路径的**唯一写入点**。
   *
   * 说明：⚠️ 三列**一起写**（`iv` / `cipher` / `tag`）：单独换一个 `iv` 而不同时换密文
   *      会把这份清单直接毁掉（与 `vault_items` 那三列同一条纪律）。
   *      ⚠️ 没变化就不写（省一次磁盘写，也少一次无谓的密文重排）。
   *      ⚠️ **刻意不动 `updated_at`**：那一列在 `vault_meta` 上的语义是「开库材料最后一次重写」
   *      （改主密码 / 改自动锁定），标签池不属于开库材料 —— 动它会让「主密码什么时候改的」失真。
   *
   * @param {number} uid - 账号 id
   * @param {Function} mutate - `(pool: string[]) => string[]`
   * @returns {void}
   * @throws {Error} 未解锁（403）
   */
  _vaultSyncPool(uid, mutate) {
    const key = Number(uid);
    const meta = this._bk.getVaultMeta(key);
    if (!meta) return;
    const dek = this._vaultDek(uid);
    const before = this.vaultTagPool(uid);
    const after = normTags(mutate(before));
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const sealed = vc.encryptJson(dek, { tags: after });
    this._bk.updateVaultMeta(key, ['tags_iv', 'tags_cipher', 'tags_tag'], [sealed.iv, sealed.cipher, sealed.tag]);
  },

  /**
   * 功能：标签批量改写的**唯一实现** —— 「先全部解密成内存里的新值，全部成功之后再逐条写回」。
   *
   * 说明：⭐⭐ 这个两段式结构是刻意的，别把它改成「一边解密一边写」：
   *      · 第一段只读、只算，**任何一条解不开就整块抛 400**，一行都不写 ——
   *        否则会出现「前几条的标签改了、后面那条坏了没改」，而用户看到的是一句失败提示，
   *        他会以为「什么都没发生」；
   *      · 第二段才写，此时所有新密文都已经在内存里算好（`encryptJson` 也在这里调，
   *        每条各自一个新的随机 IV），写的动作再失败也只可能是数据层只读 —— 那种情况
   *        在第一步 `_assertWritable()` 就拦掉了，走不到这里。
   *      ⚠️ 每次写入都会**换新 IV + 整条重新加密**（GCM 的硬要求，见方案 §5.3）；
   *      所以「改一个标签」在磁盘上表现为「这些记录整条的密文都变了」，这是正常的。
   *      ⚠️ 没变化的记录**不写**（`before/after` 相同就跳过）：少一次写入、更新时间也不会白跳。
   *      ⚠️ **标签名不进日志**：本函数不做任何 `logLine`，路由层那里也只记条数（方案硬要求 4）。
   *
   * @param {number} uid - 账号 id
   * @param {Function} mutate - `(tags: string[]) => string[]`，返回该条记录的新标签数组
   * @returns {{changed: number}} 实际被改写的记录条数
   * @throws {Error} 未解锁（403）、有记录解不开（400）、数据层只读（503）
   */
  _vaultRewriteTags(uid, mutate) {
    this._assertWritable();
    const dek = this._vaultDek(uid);
    const key = Number(uid);

    // ---- 第一段：只读只算，全部成功才算数 ----
    /** @type {Array.<{id: number, payload: Object}>} */
    const plans = [];
    for (const row of this._bk.listVaultItems(key)) {
      let obj;
      try {
        obj = vc.decryptJson(dek, { iv: row.iv, cipher: row.cipher, tag: row.tag });
      } catch (_e) {
        // ⚠️ 明确说「一行都没改」：用户接下来该做的是恢复那条记录，而不是再点一次
        throw badRequest('有一条记录已损坏（内容解不开），标签暂时改不了 —— 请先从备份恢复那条记录，一行都没有改动');
      }
      const before = normTags(obj.tags);
      const after = normTags(mutate(before));
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      plans.push({
        id: row.id,
        payload: {
          title: String(obj.title || ''),
          username: String(obj.username || ''),
          password: String(obj.password || ''),
          url: String(obj.url || ''),
          note: String(obj.note || ''),
          tags: after,
        },
      });
    }

    // ---- 第二段：逐条写回（新密文已算好，每条一个新 IV）----
    let changed = 0;
    for (const p of plans) {
      const sealed = vc.encryptJson(dek, p.payload);
      const ok = this._bk.updateVaultItem(
        key,
        p.id,
        ['iv', 'cipher', 'tag', 'updated_at'],
        [sealed.iv, sealed.cipher, sealed.tag, nowStamp()],
      );
      if (ok) changed += 1;
    }
    return { changed };
  },

  /**
   * 功能：用一个账号的 DEK 把一份**明文对象**封装成密文三列 —— 给 `secrets` 模块（加密信息）用。
   *
   * 说明：⭐⭐ 0.9.8（方案 42 §二·2）：加密信息**复用密码库的主密码与解锁态**（同一个 DEK），
   *      而不是另起一套主密码。理由是产品性的：两者在界面上是同一屏的两格
   *      （网址 ｜ 密码 ｜ 加密信息），用户心里就是「一个保险箱」；再让他记一个主密码是纯负担，
   *      而且**必然有人忘**（忘了就是一个永久打不开的库）。
   *      ⚠️⭐ 所以这两个方法是 `secrets` 模块碰密钥的**唯一通道**：
   *      `secrets` **不做任何加解密**、也不许 `require('../vault/lib/crypto.js')`
   *      （铁律 7 / 决策 76：跨模块只走业务方法）。它拿到的是三列字符串，原样落库。
   *      ⚠️ **闸门不绕**：`_vaultDek()` 是「未解锁一律 403」的唯一执行点，
   *      密码库锁着的时候这里照样抛 403 —— 于是「锁密码库 = 加密信息一起锁」是结构性的，
   *      不是靠调用方记得多调一道检查。
   *      ⚠️ IV 由 `encryptJson()` 内部随机生成（每条独立），本方法无从指定（GCM 的 IV 绝不复用）。
   *
   * @param {number} uid - 账号 id
   * @param {Object} obj - 要加密的明文对象（`{title, body}` 之类）
   * @returns {{iv: string, cipher: string, tag: string}} 三列密文（可直接落库）
   * @throws {Error} 未解锁（403）
   */
  sealForUser(uid, obj) {
    const dek = this._vaultDek(uid);
    return vc.encryptJson(dek, obj && typeof obj === 'object' ? obj : {});
  },

  /**
   * 功能：用一个账号的 DEK 把**一行密文**解回明文对象 —— 给 `secrets` 模块（加密信息）用。
   *
   * 说明：与 `sealForUser()` 是同一对（理由见上）。⚠️ 解不开时**不冒充 404**：
   *      由调用方决定怎么说（`secrets` 那边照 `getVaultEntry()` 的口径回 400「已损坏，请从备份恢复」），
   *      这里只把原语层的错误原样抛出去 —— 本方法不替调用方编用户话术。
   *
   * @param {number} uid - 账号 id
   * @param {{iv: string, cipher: string, tag: string}} row - 密文三列
   * @returns {Object} 解出来的对象（形状由 `sealForUser()` 写入时决定）
   * @throws {Error} 未解锁（403）、密文损坏（原语层抛错）
   */
  openForUser(uid, row) {
    const dek = this._vaultDek(uid);
    const src = row && typeof row === 'object' ? row : {};
    return vc.decryptJson(dek, { iv: src.iv, cipher: src.cipher, tag: src.tag });
  },

  /**
   * 功能：用该账号的 DEK 加密**一段字节**（带 AAD）—— 给 `secrets` 的附件分块加密用。
   *
   * 说明：⭐⭐ 0.9.8（方案 42 §2.7·2）：附件是**密文文件**，每 1 MiB 封一帧，每帧独立 IV ＋
   *      AAD（头 ‖ 块序号 ‖ 总块数）。这一层只做「`_vaultDek(uid)` ＋ 转手」，**DEK 不出 vault** ——
   *      `secrets` 拿到的永远只是三件字节。
   *      ⚠️ 与 `sealForUser()` 是同一道闸门（`_vaultDek` 未解锁抛 403），所以「锁上密码库 =
   *      附件也读不出、也传不进」，不是靠调用方记得多调一次检查。
   *      ⚠️ **入参/出参都是 Buffer**，不是 base64：附件块多且大，编码开销与拷贝都不该出现在这条路上。
   *
   * @param {number} uid - 账号 id
   * @param {Buffer} buf - 明文块
   * @param {Buffer} aad - 附加认证数据（没有也要显式传 `Buffer.alloc(0)`）
   * @returns {{iv: Buffer, tag: Buffer, cipher: Buffer}} 三件（可直接写进 blob 帧）
   * @throws {Error} 未解锁（403）、参数类型不对时抛出
   */
  sealBytes(uid, buf, aad) {
    const dek = this._vaultDek(uid);
    return vc.encryptBytes(dek, buf, aad);
  },

  /**
   * 功能：用该账号的 DEK 解密**一段字节**（AAD 必须与加密时逐字节相同）—— `sealBytes()` 的逆运算。
   *
   * 说明：⚠️ **只解调用方点名的那一块** —— 视频拖进度时不需要从头解下来，
   *      这也是「内存恒定」这条承诺的全部来源（方案 42 §2.7·2 的 O(1) 定位）。
   *      ⚠️ 解不开就抛：⛔ 绝不返回空 Buffer（那会让用户拿到一个 0 字节文件却以为下载成功了）。
   *
   * @param {number} uid - 账号 id
   * @param {{iv: Buffer, tag: Buffer, cipher: Buffer}} parts - 三件
   * @param {Buffer} aad - 与加密时逐字节相同的 AAD
   * @returns {Buffer} 明文块
   * @throws {Error} 未解锁（403）、参数不合法、密文被篡改时抛出
   */
  openBytes(uid, parts, aad) {
    const dek = this._vaultDek(uid);
    const src = parts && typeof parts === 'object' ? parts : {};
    return vc.decryptBytes(dek, src.iv, src.tag, src.cipher, aad);
  },

  // ==========================================================================================
  // 钥匙文件（.zxkey）与阅读器的「已开钥匙」—— 0.9.8 第 6 轮（方案 2026-11-08-0.9.8-第6轮修改）
  //
  // ⭐⭐ 这一组方法解决的是「换机器 / 账号被删之后还能打开 .zxdesk」：
  //    文件格式一个字不改（`.zxdesk` 里仍然没有任何钥匙材料），
  //    钥匙改成一份**单独导出**的文件 `.zxkey`（`vault_meta` 的全部材料 ＋ `kid` 指纹），
  //    导入后存进本机数据库（`vault_imported_keys`），用的时候仍要输那把锁的主密码。
  //    ⇒ 偷到一个 `.zxdesk` 仍然猜不出密码（它连盐和验证块都没有）；这正是「数据与秘钥分开」。
  // ==========================================================================================

  /**
   * 功能：导出钥匙文件的内容（**不落盘**，由路由层包成下载）。
   *
   * 说明：⭐ 门槛是「已解锁 ＋ 再输一次主密码」（方案 §8.2）：防止有人趁你开着页面把整库的钥匙导走。
   *      ⚠️ 返回的 JSON 里**没有明文密钥**：`dek_*` / `verifier_*` 都是用 KEK 封装过的材料，
   *      `kid` 只是指纹。它等于「全套数据的总钥匙」—— 文案必须写清这一点（§8.6）。
   *      ⚠️ `created_at` 用本地时区偏移（给人看），不是 `toISOString()` 的 UTC。
   *
   * @param {number} uid - 账号 id
   * @param {string} masterPassword - 主密码（用于确认身份）
   * @returns {Object} `.zxkey` 的 JSON 对象（路由层 `JSON.stringify` 后下载）
   * @throws {Error} 未解锁（403）、未初始化（400）、主密码不对（403）
   */
  keyExport(uid, masterPassword) {
    this.vaultAssertUnlocked(uid);
    const key = Number(uid);
    const meta = this._bk.getVaultMeta(key);
    if (!meta) throw badRequest('这个账号还没有设置主密码，没有钥匙可以导出');
    const params = vc.parseKdfParams(meta.kdf_params);
    const salt = Buffer.from(String(meta.salt || ''), 'base64');
    if (salt.length < 8) throw badRequest('这个密码库的盐已损坏，无法导出钥匙（请从备份恢复）');
    const kek = vc.deriveKek(masterPassword, salt, params);
    if (!vc.checkVerifier(kek, { iv: meta.verifier_iv, cipher: meta.verifier_cipher, tag: meta.verifier_tag })) {
      throw denied('主密码不正确');
    }
    const dek = vc.openDek(kek, { iv: meta.dek_iv, cipher: meta.dek_cipher, tag: meta.dek_tag });
    const u = this.getUser(key) || {};
    return {
      app: 'zxdesk',
      v: 1,
      kind: 'vault-key',
      kid: kidOf(dek),
      owner_uid: key,
      owner_name: String(u.username || ''),
      kdf: 'scrypt',
      kdf_params: { N: params.N, r: params.r, p: params.p, keylen: params.keylen },
      salt: String(meta.salt),
      dek_iv: String(meta.dek_iv),
      dek_cipher: String(meta.dek_cipher),
      dek_tag: String(meta.dek_tag),
      verifier_iv: String(meta.verifier_iv),
      verifier_cipher: String(meta.verifier_cipher),
      verifier_tag: String(meta.verifier_tag),
      created_at: isoLocal(),
    };
  },

  /**
   * 功能：**看一眼**一份钥匙文件属于谁（⛔ 不验密码、不落库、不回任何密钥材料）。
   *
   * 说明：⭐⭐ 0.9.8 第 7 轮（方案 §14.6.1.3）：阅读器把「换一把钥匙」改成
   *      「选文件 → 识别 → 输密码解锁」三步，第 2 步要能告诉用户
   *      「已识别：来自账号「xwj」的钥匙 · 编号 … · 2026-11-08 导出」，
   *      并在「钥匙属于 A、文件属于 B」时先提醒一句「可能打不开」。
   *      ⚠️ 正因为它**不验密码**，所以只回四个非敏感字段：编号只是指纹、账号名本来就显示在界面上。
   *      ⛔ 不许回 `salt` / `dek_*` / `verifier_*` 任何一项 —— 那等于把钥匙材料抄给前端。
   * @param {number} uid - 当前会话账号 id（只用于判「本机是否已有这把」）
   * @param {Object} obj - 解析后的 `.zxkey` JSON
   * @returns {{kid: string, owner_uid: ?number, owner_name: string, created_at: string, already: boolean}}
   * @throws {Error} 400（格式不合法 / 被截断 / 参数越界）
   */
  keyInspect(uid, obj) {
    const p = parseKeyFile(obj);
    return {
      kid: p.kid,
      owner_uid: p.owner_uid,
      owner_name: p.owner_name,
      created_at: p.created_at,
      already: !!this._bk.getImportedKey(Number(uid), p.kid),
    };
  },

  /**
   * 功能：导入一份钥匙文件（校验 6 条，通过后落库并**当场把这把钥匙打开**）。
   *
   * 说明：⭐⭐ 校验是「逐条给不同话术」（方案 §8.3）：
   *      格式不对 → 「不是一个有效的钥匙文件」；字段缺 → 「不完整」；参数越界 →
   *      「参数不合法」；验证块解不开 → 「主密码不对」；DEK 解不开 → 「已损坏」。
   *      分成五句不是为了好看：它们的处置完全不同（换文件 / 找回原文件 / 找对方重导 / 重输密码）。
   *      ⚠️ **KDF 参数有上限**（`N ≤ 2^17` / `r ≤ 8` / `p ≤ 4`）：钥匙文件是外部输入，
   *      放任一个 `N=2^30` 进来就等于给了一个「让服务端算到死」的入口。
   *      ⚠️ **幂等**：同一把钥匙（同一 `user_id` ＋ `kid`）重复导入不报错、不重复插行（方案 §8.3）；
   *      JSON 后端没有唯一索引，所以「先查后写」是**唯一**的正确做法（不能靠数据库兜）。
   *      ⚠️ 导入成功后把这把钥匙放进 `readerKeys`（10 分钟）：用户刚敲完密码，
   *      再让他为同一个文件敲一遍是纯粹的添堵（与 `vaultInit()` 后直接算已解锁同一体感）。
   *
   * @param {number} uid - 导入者账号 id
   * @param {Object} obj - 解析后的 `.zxkey` JSON
   * @param {string} masterPassword - 那把钥匙的主密码
   * @returns {{kid: string, owner_uid: ?number, owner_name: string, already: boolean}} 导入结果
   * @throws {Error} 格式 / 参数 / 主密码 / 损坏（400 或 403，话术见 §8.3）
   */
  keyImport(uid, obj, masterPassword) {
    this._assertWritable();
    const key = Number(uid);
    // ⭐ 0.9.8 第 7 轮：格式校验抽成 `parseKeyFile()`，与 `keyInspect()` 共用一处实现
    //    （两处各写一遍的失效方式：一边放宽了一边没放宽 ⇒ 「识别通过但导入说不是钥匙文件」）
    const p = parseKeyFile(obj);
    const str = (v) => String(v == null ? '' : v);
    const o = p.obj;
    const salt = p.salt;
    const params = p.params;
    const kek = vc.deriveKek(masterPassword, salt, params);
    if (!vc.checkVerifier(kek, { iv: str(o.verifier_iv), cipher: str(o.verifier_cipher), tag: str(o.verifier_tag) })) {
      throw denied('这个钥匙文件的主密码不对');
    }
    let dek;
    try {
      dek = vc.openDek(kek, { iv: str(o.dek_iv), cipher: str(o.dek_cipher), tag: str(o.dek_tag) });
    } catch (_e) {
      throw badRequest('钥匙文件已损坏，无法使用');
    }
    const kid = kidOf(dek);
    // ⚠️ 文件里带的 `kid` 与现算不一致 ⇒ 有人在改这个文件（或拼错了另一把钥匙的材料）
    if (str(o.kid) !== kid) throw badRequest('钥匙文件已损坏，无法使用');

    const ownerUid = p.owner_uid;
    const ownerName = p.owner_name;
    const existed = !!this._bk.getImportedKey(key, kid);
    if (!existed) {
      const stamp = nowStamp();
      this._bk.insertImportedKey(key, {
        kid,
        owner_uid: ownerUid,
        owner_name: ownerName,
        kdf: 'scrypt',
        kdf_params: JSON.stringify({ N: params.N, r: params.r, p: params.p, keylen: params.keylen }),
        salt: str(o.salt),
        dek_iv: str(o.dek_iv),
        dek_cipher: str(o.dek_cipher),
        dek_tag: str(o.dek_tag),
        verifier_iv: str(o.verifier_iv),
        verifier_cipher: str(o.verifier_cipher),
        verifier_tag: str(o.verifier_tag),
        created_at: stamp,
        last_used_at: stamp,
      });
    }
    this.readerHold(key, kid, dek, ownerUid);
    return { kid, owner_uid: ownerUid, owner_name: ownerName, already: existed };
  },

  /**
   * 功能：列出本账号导入过的钥匙（⛔ 不含任何密钥材料，方案 §8.4）。
   * @param {number} uid - 账号 id
   * @returns {Array.<{kid: string, owner_uid: ?number, owner_name: string, created_at: ?string, last_used_at: ?string}>}
   *      钥匙列表（新的在前）
   */
  listImportedKeys(uid) {
    return this._bk.listImportedKeys(Number(uid)).map((r) => ({
      kid: String(r.kid),
      owner_uid: r.owner_uid == null ? null : Number(r.owner_uid),
      owner_name: String(r.owner_name || ''),
      created_at: r.created_at || null,
      last_used_at: r.last_used_at || null,
    }));
  },

  /**
   * 功能：删掉一条导入记录（只删数据库那一行，⛔ 不碰任何文件、不影响别人）。
   * @param {number} uid - 账号 id
   * @param {string} kid - 钥匙编号
   * @returns {{ok: true, removed: boolean}} 结果
   * @throws {Error} 数据层只读（503）
   */
  removeImportedKey(uid, kid) {
    this._assertWritable();
    const key = Number(uid);
    const removed = this._bk.deleteImportedKey(key, String(kid));
    this.readerDrop(key, String(kid));
    return { ok: true, removed };
  },

  /**
   * 功能：列出「打开这个文件可以试哪些钥匙」（**只报编号与来源，不报材料**）。
   *
   * 说明：⭐⭐ 顺序就是建议顺序（方案 §10.3）：
   *      ① 文件属于本账号且密码库已解锁 ⇒ 用**会话 DEK**（不弹密码）；
   *      ② 本账号亲手导入过的钥匙（`owner_uid` 与文件对得上的排前面）。
   *      ⚠️ 这里**不判断「能不能开」**：`.zxdesk` 头里没有 `kid`（格式一个字不改），
   *      所以「这把钥匙能不能开这个文件」只能由路由层**真解一帧**来验 —— 那是唯一诚实的证据。
   *      ⚠️ `kind: 'session'` 的那一条**只在文件属于本账号时**出现：拿自己的 DEK 去开别人的文件
   *      一定失败，把它列出来只会让人多点一次。
   *
   * @param {number} uid - 当前登录账号 id
   * @param {number} fileUid - 文件头里记的账号 id
   * @returns {{sessionKid: string, sessionHeld: boolean, keys: Array.<Object>}} 候选
   */
  readerCandidates(uid, fileUid) {
    const key = Number(uid);
    const own = Number(fileUid) === key;
    const unlockedNow = peekUnlocked(key);
    const sessionKid = own && unlockedNow ? kidOf(unlocked.get(key).dek) : '';
    /** @type {Array.<Object>} */
    const keys = [];
    for (const r of this.listImportedKeys(key)) {
      keys.push(
        Object.assign({}, r, {
          held: readerKeys.has(readerSlot(key, r.kid)),
          matches: r.owner_uid != null && Number(r.owner_uid) === Number(fileUid),
        }),
      );
    }
    // 「来源对得上」的排前面（只是建议，不是判断）；同组内保持「新的在前」
    keys.sort((a, b) => Number(b.matches) - Number(a.matches));
    return { sessionKid, sessionHeld: !!sessionKid, keys };
  },

  /**
   * 功能：用一把**导入的钥匙**的主密码打开它，把 DEK 放进 `readerKeys`（10 分钟滑动）。
   *
   * 说明：⭐⭐ 这是方案 §10.3 第 ③ 条的唯一实现：**只把 DEK 放进阅读器的内存表**，
   *      ⛔ 不解锁任何账号的会话（不碰 `unlocked`）—— 于是「看了别人的文件」不等于
   *      「拿到了别人的密码库」。
   *      ⚠️ 失败只有一句「主密码不正确」（不区分密码错与密文损坏）：那种区分等于白送一个探测口。
   *      ⚠️ 节流不在这里做（`scryptSync` 会阻塞事件循环）：路由层按 `reader:<账号>:<kid>` 计。
   *
   * @param {number} uid - 当前登录账号 id
   * @param {string} kid - 钥匙编号
   * @param {string} masterPassword - 那把钥匙的主密码
   * @returns {{kid: string, owner_uid: ?number, owner_name: string}} 打开的那把钥匙
   * @throws {Error} 没有这把钥匙（400）、参数损坏（400）、主密码不对（403）
   */
  readerDerive(uid, kid, masterPassword) {
    const key = Number(uid);
    const row = this._bk.getImportedKey(key, String(kid));
    if (!row) throw badRequest('本机没有这把钥匙 —— 请先导入它的钥匙文件');
    let params;
    try {
      params = vc.parseKdfParams(row.kdf_params);
    } catch (_e) {
      throw badRequest('这把钥匙的参数已损坏，请重新导入钥匙文件');
    }
    const salt = Buffer.from(String(row.salt || ''), 'base64');
    if (salt.length < 8) throw badRequest('这把钥匙的盐已损坏，请重新导入钥匙文件');
    const kek = vc.deriveKek(masterPassword, salt, params);
    if (!vc.checkVerifier(kek, { iv: row.verifier_iv, cipher: row.verifier_cipher, tag: row.verifier_tag })) {
      throw denied('主密码不正确');
    }
    const dek = vc.openDek(kek, { iv: row.dek_iv, cipher: row.dek_cipher, tag: row.dek_tag });
    this.readerHold(key, String(kid), dek, row.owner_uid == null ? null : Number(row.owner_uid));
    return {
      kid: String(kid),
      owner_uid: row.owner_uid == null ? null : Number(row.owner_uid),
      owner_name: String(row.owner_name || ''),
    };
  },

  /**
   * 功能：把一把已开的钥匙放进内存表并挂到期定时器（`keyImport()` / `readerDerive()` 共用）。
   *
   * 说明：⚠️ 定时器必须 `unref()`（与 `_vaultHold()` 同一条理由：不 unref 会拖住事件循环，
   *      真机上表现为「点了停止应用，进程却一直不退出」）。
   *      ⚠️ 上限 8 把、超了淘汰**最久没动**的那把：内存里同时躺着十几把 DEK 没有任何好处。
   * @param {number} uid - 会话账号 id
   * @param {string} kid - 钥匙编号
   * @param {Buffer} dek - 32 字节 DEK
   * @param {?number} ownerUid - 原件所属账号
   * @returns {void}
   */
  readerHold(uid, kid, dek, ownerUid) {
    const key = readerSlot(uid, kid);
    const old = readerKeys.get(key);
    if (old && old.timer) clearTimeout(old.timer);
    readerKeys.set(key, {
      dek,
      ownerUid: ownerUid == null ? null : Number(ownerUid),
      at: Date.now(),
      timer: scheduleReaderDrop(key),
    });
    while (readerKeys.size > READER_MAX) {
      let oldest = null;
      let oldestAt = Infinity;
      for (const [k, v] of readerKeys) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldest = k;
        }
      }
      if (!oldest) break;
      this.readerDrop(...splitSlot(oldest));
    }
  },

  /**
   * 功能：取一把已开钥匙的 DEK（**顺带滑动续期**）；没开或已超时一律 403。
   * @param {number} uid - 会话账号 id
   * @param {string} kid - 钥匙编号
   * @returns {Buffer} 32 字节 DEK
   * @throws {Error} 这把钥匙还没打开 / 已超时（403）
   */
  readerDek(uid, kid) {
    const key = readerSlot(uid, kid);
    const e = readerKeys.get(key);
    if (!e) throw denied('这把钥匙还没打开 —— 请输入它的主密码');
    if (Date.now() - e.at > READER_IDLE_MS) {
      this.readerDrop(Number(uid), String(kid));
      throw denied('这把钥匙已经自动锁上了 —— 请重新输入主密码');
    }
    e.at = Date.now();
    if (e.timer) clearTimeout(e.timer);
    e.timer = scheduleReaderDrop(key);
    return e.dek;
  },

  /**
   * 功能：判断某个会话账号手上**有没有**这把已开的钥匙（只判断，不续期）。
   * @param {number} uid - 会话账号 id
   * @param {string} kid - 钥匙编号
   * @returns {boolean} 在内存表里且没超时则为 true
   */
  readerHas(uid, kid) {
    const e = readerKeys.get(readerSlot(uid, kid));
    if (!e) return false;
    if (Date.now() - e.at > READER_IDLE_MS) {
      this.readerDrop(Number(uid), String(kid));
      return false;
    }
    return true;
  },

  /**
   * 功能：用**指定的那把钥匙**解一段附件字节 —— 阅读器的流式解密出口。
   *
   * 说明：⭐ 与 `openBytes()` 的唯一差别是「密钥从哪来」：那个用**会话 DEK**（本账号已解锁），
   *      这个用 `readerKeys` 里那把导入钥匙的 DEK。⛔ 两者都不把 DEK 交出去。
   *      ⚠️ 解不开就抛（GCM tag 校验失败）—— 绝不返回空 Buffer（那会让用户拿到 0 字节文件却以为成功）。
   * @param {number} uid - 会话账号 id
   * @param {string} kid - 钥匙编号
   * @param {{iv: Buffer, tag: Buffer, cipher: Buffer}} parts - 三件
   * @param {Buffer} aad - 与加密时逐字节相同的 AAD
   * @returns {Buffer} 明文块
   * @throws {Error} 钥匙没开 / 已超时（403）、密文被篡改（原语层抛错）
   */
  openBytesAs(uid, kid, parts, aad) {
    const dek = this.readerDek(uid, kid);
    const src = parts && typeof parts === 'object' ? parts : {};
    return vc.decryptBytes(dek, src.iv, src.tag, src.cipher, aad);
  },

  /**
   * 功能：把一把（或某账号的全部）已开钥匙从内存里拿掉。
   * @param {number} uid - 会话账号 id
   * @param {?string} kid - 钥匙编号；不传 = 该账号全部
   * @returns {void}
   */
  readerDrop(uid, kid) {
    if (kid === undefined || kid === null) {
      for (const k of [...readerKeys.keys()]) {
        const [u] = splitSlot(k);
        if (u === Number(uid)) {
          const e = readerKeys.get(k);
          if (e && e.timer) clearTimeout(e.timer);
          readerKeys.delete(k);
        }
      }
      return;
    }
    const k = readerSlot(uid, kid);
    const e = readerKeys.get(k);
    if (e && e.timer) clearTimeout(e.timer);
    readerKeys.delete(k);
  },

  /**
   * 功能：清空**全部**已开钥匙（退出登录 / 测试清场用）。
   * @returns {number} 清掉的把数
   */
  readerPurgeAll() {
    const n = readerKeys.size;
    for (const k of [...readerKeys.keys()]) {
      const e = readerKeys.get(k);
      if (e && e.timer) clearTimeout(e.timer);
    }
    readerKeys.clear();
    return n;
  },

  /**
   * 功能：**仅供测试** —— 看当前有几把已开钥匙（⛔ 不返回任何密钥）。
   * @returns {number} 把数
   */
  readerDebugCount() {
    return readerKeys.size;
  },

  /**
   * 功能：生成一个强随机密码（密码生成器）。
   *
   * 说明：⚠️ 参数校验在 `validate.js` 做过一遍（给得出人话的 400），这里再兜一次
   *      ——因为原语层抛的是**英文/技术向**的错误，直接透给用户就成了一句看不懂的话。
   *
   * @param {Object} opts - `{ length?, charset?, noAmbiguous? }`
   * @returns {{password: string}} 生成的密码
   * @throws {Error} 参数不合法（400）
   */
  generateVaultPassword(opts) {
    try {
      return { password: vc.generatePassword(opts || {}) };
    } catch (e) {
      throw badRequest((e && e.message) || '生成参数不合法');
    }
  },
};

/**
 * 功能：给某个账号挂一个「到期就把解锁记录删掉」的定时器。
 *
 * 说明：⭐ 必须 `unref()`：不 unref 的定时器会拖住事件循环，真机上表现为
 *      「点了停止应用，进程却一直不退出」。⚠️ 它只是**尽早释放引用**的优化，
 *      正确性由 `vaultIsUnlocked()` 里的时间比对兜底（定时器可能晚触发）。
 *
 * @param {number} uid - 账号 id
 * @param {number} minutes - 锁定分钟数
 * @returns {Object} Node 的 Timeout 句柄（已 unref）
 */
function scheduleDrop(uid, minutes) {
  // ⭐⭐ 0.9.8 第 7 轮：到期时**顺手清掉这个账号在阅读器里已开的钥匙**（方案 §11.3 第 5 条）。
  //    ⚠️ 为什么不在 `dropUnlocked()` 里做：`_vaultHold()`（重新解锁）也调它 ——
  //    那样每次解锁都会把阅读器已开的钥匙一起清掉，用户会看到「刚输过密码又失效」。
  const t = setTimeout(() => {
    dropUnlocked(uid);
    purgeReaderKeys(uid);
  }, Math.max(1, minutes) * 60000);
  if (typeof t.unref === 'function') t.unref();
  return t;
}
