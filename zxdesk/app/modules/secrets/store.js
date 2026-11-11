'use strict';
/**
 * modules/secrets/store.js —— **加密信息**业务方法（0.9.8 · 实验室第一格 / 方案 42）
 *
 * 功能：本模块的全部业务逻辑，一处收齐 ——
 *      `listSecretItems()`（列表，**只回标题**）、`getSecretItem()`（单条，含正文）、
 *      `createSecretItem()` / `updateSecretItem()` / `removeSecretItem()`（增删改）、
 *      `ownsSecretItem()`（归属校验，供路由层统一回 404）、
 *      附件（`addSecretFile()` / `listSecretFiles()` / `removeSecretFile()` / `rootsUsage()` /
 *      `validateRoot()` / `relinkFiles()`）。
 *
 * ⭐⭐ **加解密与「认文件」都不需要本文件碰密钥**：
 *    · 正文与附件元信息走密码库暴露的两个公开业务方法 `this.sealForUser(uid, obj)` / `this.openForUser(uid, row)`；
 *    · 附件字节走 `this.sealBytes(uid, buf, aad)` / `this.openBytes(uid, parts, aad)`；
 *    · 重新关联（`relinkFiles()`）**完全不解密** —— 它只 `stat` 候选文件 ＋ 读几十字节明文头
 *      （固定 24 字节 ＋ 元信息）。
 *    （`modules/vault/store.js`，方案 42 §二·2 / §2.7·10）。
 *
 * ⭐⭐ **本文件不做任何加解密**：
 *    ⛔ **不许** `require('../vault/lib/crypto.js')`：那违反「`lib/` 零非本模块引用」，
 *    也会让「换密钥 / 改 KDF」这件事变成两个模块都要改（铁律 7 / 决策 76：跨模块只走 `store.js`）。
 *
 * ⭐ **为什么不能另起一套主密码**（这一版最要紧的产品判断）：加密信息与密码库在界面上是
 *    同一屏的两格（网址 ｜ 密码 ｜ 加密信息），用户心里就是「一个保险箱」。再让他记一个主密码
 *    是纯负担，而且**必然有人忘** —— 忘了就是一个永久打不开的库。
 *    ⇒ 两者共用同一个 DEK 与**同一个解锁态**：锁密码库 = 加密信息一起锁，解锁一起回来。
 *    ⚠️ 这是**刻意的耦合**，⛔ 别在实现里改成两套独立解锁（那会产生两块同时存在的明文窗口，
 *    反而更容易泄漏）。安全边界的变化写在 `03-数据安全与备份.md` 与分册 `29-加密信息.md`。
 *
 * ⚠️ **失败方向**（与密码库同一条口径）：
 *    · 未解锁 ⇒ 403（闸门在 `_vaultDek()`，本模块连「有几条」都不回答）；
 *    · 越权 / 不存在 ⇒ 404（同一个 404，⛔ 不用 403 区分「存在但不归你」）；
 *    · 密文解不开 ⇒ 400「已损坏，请从备份恢复」（⛔ 不冒充 404：记录确实在，只是坏了）；
 *    · 实验室库打不开 ⇒ 503（由门面的 `_runOnDb()` 在进 op 之前拦下，点名是哪个库）。
 *
 * @author zx
 * @date   2026-11-07
 * @since 0.9.7
 * 相关：docs/公共/架构文档/29-加密信息.md、16-密码库.md、docs/公共/开发方案/42-加密信息.md
 */
const fs = require('node:fs');
const path = require('node:path');
const { nowStamp, notFoundErr, badRequest } = require('../../core/store/helpers.js');
const trimApi = require('../../core/trim-api.js');
// ⭐ 0.9.8 第 11 轮：这两条判据已搬到 core（跨模块共用，唯一出处），本文件只引用
const { normPath, isGranted } = require('../../core/grant-path.js');
const blob = require('./lib/blob.js');

/**
 * 功能：这个路径现在是不是一个**读得到**的普通文件（重新关联判「这一行还活着吗」用它）。
 *
 * 说明：⚠️ 判据用 `isFile()` 而不是「stat 成功」：被换成一个同名目录时，那一行同样是废的
 *      （下载会拿到 `EISDIR`），必须算「已经不在原位置」。
 * @param {string} p - 绝对路径
 * @returns {boolean} 是普通文件则为 true
 */
function isReadableFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_e) {
    return false;
  }
}

/**
 * 功能：把文件按块复制到目标（**不用 `fs.copyFile`**）。
 *
 * 说明：⭐⭐ 两条理由，都是踩出来的：
 *      ① `fs.copyFileSync` 底层走 `copy_file_range`，在 overlayfs / 一些网络盘上会直接
 *         `EPERM`（2026-11-08 迁移用例实测：同一块盘、同一目录权限，`copyfile` 被拒，
 *         而 `read` + `write` 就没问题）；
 *      ② 分块复制**内存恒定**（1 MiB 缓冲），200 MB 的附件也不会把进程撑爆 ——
 *         与上传/下载那条链路口径一致。
 *      ⚠️ 收尾 `fsync` 再关：迁移完立刻改库里的 `root`，不能出现「库说搬好了、盘上还没落」。
 *      ⚠️ 失败时**不清理**目标文件（半截文件由调用方按 `out.failed` 处理，且它不会进库）。
 * @param {string} srcPath - 源文件
 * @param {string} dstPath - 目标文件（覆盖）
 * @returns {void}
 * @throws {Error} 读 / 写 / 落盘失败
 */
function copyFileBlocks(srcPath, dstPath) {
  const CHUNK = 1024 * 1024;
  const rs = fs.openSync(srcPath, 'r');
  try {
    const ws = fs.openSync(dstPath, 'w');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const n = fs.readSync(rs, buf, 0, CHUNK, null);
        if (!n) break;
        let off = 0;
        while (off < n) off += fs.writeSync(ws, buf, off, n - off);
      }
      fs.fsyncSync(ws);
    } finally {
      fs.closeSync(ws);
    }
  } finally {
    fs.closeSync(rs);
  }
}

/**
 * 功能：这个路径是不是一个目录（重新关联判「`<sub>/<uid>/` 这个形状成立吗」用它）。
 * @param {string} p - 绝对路径
 * @returns {boolean} 是目录则为 true
 */
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_e) {
    return false;
  }
}

/**
 * 功能：列一个目录的**直接子目录**（按名字排序、最多 `limit` 个）—— 重新关联「向下看一层」用。
 *
 * 说明：⚠️ 只读一层、而且限量：用户可能把根指到一个有几千个子目录的大盘，
 *      真去翻就是「递归全盘」的另一种形态。
 *      ⚠️ 读不到（权限 / 已删）⇒ 空数组，**不抛** —— 调用方只是「没找到」，不是出错。
 * @param {string} dir - 目录
 * @param {number} limit - 最多返回几个
 * @returns {Array.<string>} 子目录的绝对路径
 */
function directSubdirs(dir, limit) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
  return ents
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .slice(0, limit)
    .map((n) => path.join(dir, n));
}

/**
 * 功能：这一行的 `rel` 是不是**本账号的标准形状**（`<uid>/<两位分片>/<id>.zxdesk`）。
 *
 * 说明：⭐⭐ `rel` 来自数据库，理论上是我们自己写的；但它同时是**拼路径**的输入 ——
 *      一旦里面出现 `..` 或绝对路径，`path.join` 会跳到别处去（读到别人的文件）。
 *      所以「标准形状」这一判据的用途是**安全 ＋ 快速定位**：形状对 ⇒ 可以直接去那个位置看一眼。
 *      ⚠️ 它**不是身份判据** —— 是不是「这条附件」由文件头里的 `uid` / `id` 决定
 *      （`isOurFile()`）。形状不对不等于「不是我们的文件」，只是「不能直接按它去路径」，
 *      这时走 `indexByHeader()` 按头找（文件被改名时唯一的路）。
 *      ⚠️ 严格到逐字符相等（含分片补零）：宁可多扫一趟，也不拿可疑路径去拼。
 * @param {number} uid - 账号 id
 * @param {number} fid - 附件 id
 * @param {*} rel - 行里的相对路径
 * @returns {boolean} 形状合规则为 true
 */
function relIsOurs(uid, fid, rel) {
  const shard = String(Number(fid) % 100).padStart(2, '0');
  return String(rel == null ? '' : rel) === `${Number(uid)}/${shard}/${Number(fid)}.zxdesk`;
}

/**
 * 功能：从文件头里读出这条附件的**身份**（`uid` / `id` / 用途标记）。
 *
 * 说明：⭐⭐ 这是「认文件」的第一判据，也是唯一可靠的判据：
 *      **文件名不是身份** —— 用户可以改名、恢复工具会改扩展名、同一个 id 在别的目录下
 *      也可能有同名文件。而头里的元信息是上传那一刻写进去的、进了每一帧的 AAD，
 *      改了它就解不开（`aadOf()` 把整份头算进去）。
 *      ⚠️ 只取四个字段，⛔ 不把整个 `meta` 当判据：多一个字段就多一条「升级后老文件认不出」的路。
 * @param {Object} header - `blob.readHeaderOnly()` 的结果
 * @returns {{app: string, kind: string, mod: string, uid: ?number, id: ?number}} 身份
 */
function identityOf(header) {
  const meta = (header && header.meta) || {};
  const num = (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return {
    app: String(meta.app == null ? '' : meta.app),
    kind: String(meta.kind == null ? '' : meta.kind),
    mod: String(meta.mod == null ? '' : meta.mod),
    uid: num(meta.uid),
    id: num(meta.id),
  };
}

/**
 * 功能：这份头**是不是**「本应用 · 加密信息 · 这个账号 · 这一条」。
 *
 * 说明：⭐⭐ 四个条件缺一不可 —— 尤其 `uid`：同一台 NAS 多人用，别人的 `.zxdesk`
 *      与我们的长得一模一样（同魔数、同版本、同块大小），只有头部 `uid` 能分开。
 *      ⚠️ `id` 也必须是它：`rel` 一旦被改过 / 文件被复制到别处，光有大小与魔数证明不了什么。
 * @param {number} uid - 账号 id
 * @param {number} fid - 附件 id
 * @param {Object} header - 文件头
 * @returns {boolean} 是这一条则为 true
 */
function isOurFile(uid, fid, header) {
  const who = identityOf(header);
  return (
    who.app === 'zxdesk' &&
    who.kind === 'secret-file' &&
    who.uid === Number(uid) &&
    who.id === Number(fid)
  );
}

/**
 * 功能：在某个目录下核对一条候选 —— 返回 `'ok'` / `'damaged'` / `'missing'`。
 *
 * 说明：⭐⭐ 前四道是**廉价判据**（只读头 ＋ 一次 `stat`）：`magic === 'ZXDS'` 且 `ver === 2`、
 *      `plainSize === 行里的 size`、文件长度 === `24 + metaLen + totalFrames × 32 + size`。
 *      四道全过**仍然不能证明是原件** —— 同大小、同头、内容不同的另一个文件照样能过。
 *      ⇒ **第五道关**：整文件 SHA-256 必须等于行里的 `sha256`（`blob.digestOf()` 顺序读一遍）。
 *      ⚠️ 这一道是这个动作**唯一的开销**（一次全文件读），所以排在最后：前四道已经挡掉绝大多数情形，
 *      只有真的像原件的候选才值得读一遍 —— 而「关联」会改库里的 `root`，认错一次就是把一条附件
 *      绑到别人的文件上，这一遍读值得。
 *      ⚠️ `row.sha256` 为空（升级前上传的 / 手工改过库）⇒ 直接 `damaged`，⛔ 不退回前四道：
 *      不写一条永远得不到测试的兼容分支，它半年后会变成谁都不敢删的死路。
 *      ⚠️ 轻的活仍然只做轻的：⛔ 别把哈希挪到列表 / 面板的统计里（那会让打开设置页就读几个 GB）。
 *      ⚠️ 不解密：头是明文，`plainSize` 本来就要给 Range 用 —— 认文件不需要 DEK。
 *      ⚠️ 读盘异常一律归 `damaged`（文件在、但没法确认是它），⛔ 不归 `missing`：
 *      两者的用户话术不同（「对不上」vs「没找到」）。
 * @param {string} dir - 候选根
 * @param {{rel: string, size: number}} row - 附件行
 * @returns {'ok'|'damaged'|'missing'} 核对结论
 */
function probeCandidate(dir, uid, row) {
  return probeCandidateAt(dir, uid, row, row.rel);
}

/**
 * 功能：在某个目录下核对**指定相对路径**的那个文件是不是这一行（`probeCandidate()` 的实现体）。
 *
 * 说明：⭐ 与 `probeCandidate()` 分开，是为了「**文件被改名**」这条兜底路：
 *      按头扫出来的位置不叫 `<id>.zxdesk`，但那确实是这一行的文件 —— 判据必须能吃进
 *      任意 `rel`，否则「按头认人」认出来之后仍然核不过去。
 * @param {string} dir - 根目录
 * @param {number} uid - 账号 id
 * @param {Object} row - `secrets_files` 行
 * @param {string} rel - 要核对的那个文件在 `dir` 下的相对路径
 * @returns {'ok'|'damaged'|'missing'|'foreign'} 判定
 */
function probeCandidateAt(dir, uid, row, rel) {
  const abs = path.join(dir, String(rel));
  let st;
  try {
    st = fs.statSync(abs);
  } catch (_e) {
    return 'missing';
  }
  if (!st.isFile()) return 'missing';
  let fd = null;
  try {
    fd = fs.openSync(abs, 'r');
    const header = blob.readHeaderOnly(fd);
    // ⭐⭐ 第一判据是**头里的身份**（账号 ＋ 附件 id），不是文件名：
    //    这个名字、这个大小、这个魔数都可能撞上别人的文件，只有头里的 uid/id 是上传时写死的。
    if (!isOurFile(uid, row.id, header)) return 'foreign';
    if (Number(header.plainSize) !== Number(row.size)) return 'damaged';
    if (Number(st.size) !== blob.fileSizeOf(header)) return 'damaged';
    // ⭐ 最后一道：内容指纹。没有指纹的行一律「对不上」—— 宁可让用户重传，也不认一个说不清的文件
    const want = String(row.sha256 == null ? '' : row.sha256).trim().toLowerCase();
    if (!want) return 'damaged';
    if (blob.digestOf(fd) !== want) return 'damaged';
    return 'ok';
  } catch (_e) {
    return 'damaged';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        /* 已关闭 */
      }
    }
  }
}

/**
 * 功能：在某个根下**按文件头**认人 —— 扫 `<根>/<账号>/` 两层，把「属于本账号的附件文件」
 *      收成 `附件 id → 真实相对路径`（不看文件名、不看扩展名）。
 *
 * 说明：⭐⭐ 这是「文件改名之后也能认回来」的唯一办法，也是 `rel` 不再是身份的体现：
 *      只要头里的 `uid` 是本人、`id` 是某一行，那份文件就是那一行 —— 它叫什么都无所谓。
 *      ⚠️ 扫的是**所有普通文件**（不按 `.zxdesk` 过滤）：按扩展名过滤等于又回到「靠文件名」，
 *      而用户完全可能把 `12.zxdesk` 改成 `12.bak`。
 *      ⚠️ 必须**限量**：只读每个文件的头（几十字节），最多看 `limit` 个文件、只走两层
 *      （`<账号>/<两位分片>/`），不递归整个盘 —— 否则「认文件」会变成一次全盘遍历。
 * @param {string} root - 附件根
 * @param {number} uid - 账号 id
 * @param {number} [limit] - 最多看多少个文件（缺省 400：附件几十到几百，够用且不会卡）
 * @returns {Map.<number, {rel: string, abs: string}>} id → 真实位置
 */
function indexByHeader(root, uid, limit) {
  const cap = Number(limit) > 0 ? Number(limit) : 400;
  const mine = path.join(String(root), String(Number(uid)));
  /** @type {Map.<number, {rel: string, abs: string}>} */
  const idx = new Map();
  let seen = 0;

  /**
   * 功能：递归看一层目录（深度由 `depth` 控制，最多两层）。
   * @param {string} dirAbs - 绝对目录
   * @param {string} relPrefix - 相对根的路径前缀
   * @param {number} depth - 还能往下走几层
   * @returns {void}
   */
  const walk = (dirAbs, relPrefix, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const e of ents) {
      if (seen >= cap) return;
      if (e.isDirectory()) {
        if (depth > 0) walk(path.join(dirAbs, e.name), `${relPrefix}/${e.name}`, depth - 1);
        continue;
      }
      if (!e.isFile()) continue;
      seen += 1;
      const abs = path.join(dirAbs, e.name);
      let fd = null;
      try {
        fd = fs.openSync(abs, 'r');
        const who = identityOf(blob.readHeaderOnly(fd));
        // 身份三项 ＋ 「头里确实写了 id」：这一条不需要比对某一行，它就是在**建索引**
        if (who.app !== 'zxdesk' || who.kind !== 'secret-file' || who.uid !== Number(uid) || who.id === null) continue;
        if (!idx.has(who.id)) idx.set(who.id, { rel: `${relPrefix}/${e.name}`, abs });
      } catch (_e) {
        /* 不是我们的文件（魔数不对）/ 读不了：跳过，不算错误 */
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch (_e) {
            /* 已关闭 */
          }
        }
      }
    }
  };

  walk(mine, String(Number(uid)), 1);
  return idx;
}

/**
 * 功能：把一行密文读成「标题（＋可选正文）」—— **新老两种形状都认**。
 *
 * 说明：⭐⭐ 0.9.8 把标题与正文拆成两组密文（列表只解标题、正文点开才解）。
 *      老行没有 `title_cipher`（升级前写的是 `{title, body}` 一整块）⇒ 只能整块解一次：
 *      这是**唯一为老数据留的兼容分支**，因为那是用户亲手敲的字（不像附件可以重传）。
 *      下次保存会自动写成新形状（`updateSecretItem()` 写两组、并把老列清空）。
 *      ⚠️ `withBody === false` 时**新形状根本不解正文** —— 这才是拆列的全部收益所在。
 * @param {Object} store - Store 实例（借它的 `openForUser()`）
 * @param {number} uid - 账号 id
 * @param {Object} row - `secrets_items` 行
 * @param {boolean} withBody - 要不要正文
 * @returns {{title: string, body: ?string}} 正文没要时 `body` 为 null
 * @throws {Error} 未解锁（403）、密文损坏（解不开）
 */
function readItem(store, uid, row, withBody) {
  const hasNew = String(row.title_cipher == null ? '' : row.title_cipher) !== '';
  if (hasNew) {
    const t = store.openForUser(uid, { iv: row.title_iv, cipher: row.title_cipher, tag: row.title_tag });
    if (!withBody) return { title: String((t && t.title) || ''), body: null };
    const b = store.openForUser(uid, { iv: row.body_iv, cipher: row.body_cipher, tag: row.body_tag });
    return { title: String((t && t.title) || ''), body: String((b && b.body) || '') };
  }
  // 老形状：一整块 {title, body}
  const obj = store.openForUser(uid, row);
  return {
    title: String((obj && obj.title) || ''),
    body: withBody ? String((obj && obj.body) || '') : null,
  };
}

/**
 * ⭐⭐ 0.9.8 第 11 轮：`normPath()` / `isGranted()` **已搬到 `core/grant-path.js`**。
 *
 * 说明：它们从「加密信息专用」变成了「跨模块共用」—— 设置页的「个人授权目录」与加密信息
 *      必须按**同一口径**判「有没有授权」，各写一份的分歧表现是「界面说已授权、读文件说不在范围」。
 *      搬家只动位置：两份实现逐字相同，本文件的行为一个字都没变。
 */

/**
 * 功能：从「飞牛已授权的目录」里挑一个当附件根。
 *
 * 说明：⭐ 优先级只有一条：**路径里带本应用名**（`zxdesk`，不分大小写）的排前面 ——
 *      管理员多半会专门建一个 `.../ZXDesk` 目录；没有就按字母序取第一个，结果可预期。
 *      ⚠️ 这一步只是「挑」，不代表目录一定可写；写不进去会在上传时如实报错。
 * @param {Array.<string>} paths - 候选目录
 * @param {string} fallback - 候选为空时返回它（调用方已判过空，这里只兜底）
 * @returns {?string} 选中的目录
 */
function pickBestRoot(paths, fallback) {
  const list = (Array.isArray(paths) ? paths : []).map((x) => String(x)).filter(Boolean);
  if (!list.length) return String(fallback || '') || null;
  const named = list.filter((x) => /zxdesk/i.test(x));
  return (named.length ? named : list).slice().sort()[0];
}

/**
 * 功能：把附件 mime 归到四类之一（列表概要只报计数，不报文件名）。
 * @param {string} mime - mime
 * @returns {'image'|'video'|'audio'|'file'} 类别
 */
function kindOf(mime) {
  const m = String(mime || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

module.exports = {
  /**
   * 功能：列出该账号的全部加密信息 —— **只回标题与时间，不回正文**（列表页用）。
   *
   * 说明：⭐⭐ 列表**刻意不解密正文**：一条记录的主体就是那段长文本秘密（证件号 / 密钥 /
   *      许可证）。把正文一次性吐给列表页，等于每打开一次这一屏就把它整本摊在内存与网络里，
   *      而用户此刻可能只是在找「那条叫什么」。
   *      ⚠️ 密文是一整块（`{title, body}` 一起加密），所以解密本身无法只解一半 ——
   *      但**响应体里只有 `title`**，正文在服务端进程内就被丢掉了，不会上网、不会进前端内存。
   *      ⚠️ 单条解不开（密文被改过 / 手工编辑坏了）**不静默跳过**：跳过会让用户以为
   *      「这条不见了」，而真相是「这条坏了」。这里标 `broken: true` 一并返回，标题留空。
   *
   * ⭐ 0.9.8：**分页 ＋ 只解标题**（拆列之后列表不再解正文）＋ 每条带附件概要（只报计数）。
   *      `broken` 是**本页**的损坏条数（全库条数看 `total`）。
   * @param {number} uid - 账号 id
   * @param {{limit?: number, offset?: number}} [opts] - 分页（缺省 50 / 0）
   * @returns {{items: Array.<Object>, broken: number, total: number, hasMore: boolean}}
   *      摘要列表、本页损坏条数、总条数、还有没有下一页
   * @throws {Error} 未解锁（403）、实验室库不可用（503）
   */
  listSecretItems(uid, opts) {
    // ⚠️⭐ 这一句**必须无条件先跑**，不能只靠下面循环里的 `openForUser()` 兜底：
    //    一个「还没设主密码 / 已锁定」且**一条记录都没有**的账号，循环体一次都不执行 ⇒
    //    那种情况下会回 200 `{items: [], broken: 0}` —— 等于既回答了「你有几条」（0 条），
    //    又让「未解锁一律 403」这条规矩在空列表上破了个洞。
    //    第一版就是这么写的，被 `secrets.test.js` ⑦ 的「另一个账号没解锁也能读列表」抓个正着。
    this.vaultAssertUnlocked(uid);
    const u = Number(uid);
    const src = opts && typeof opts === 'object' ? opts : {};
    const limit = Math.max(1, Math.min(200, Number(src.limit) || 50));
    const offset = Math.max(0, Number(src.offset) || 0);
    // ⭐ 总条数用 COUNT(*)：不解密、不取行 —— 「共 N 条」与翻页判据都靠它
    const total = Number(this._bk.countSecrets(u)) || 0;
    const rows = this._bk.listSecretsPage(u, limit, offset);
    /** @type {Array.<Object>} */
    const items = [];
    let broken = 0;
    for (const row of rows) {
      try {
        // ⭐ 只要标题：新形状的行正文根本没被解过（拆列的全部意义）
        const it = readItem(this, uid, row, false);
        items.push({
          id: row.id,
          title: it.title,
          broken: false,
          updated_at: row.updated_at,
          files: this.secretFilesSummary(uid, row.id),
        });
      } catch (_e) {
        // ⚠️ 403 不许被这里吞掉：`openForUser()` 在「刚超时」的那一刻也会抛 403，
        //    而把它降级成「这条坏了」会把「你被锁了」说成「你的数据坏了」——
        //    那是完全不同处置方式的两件事。⇒ 只把**非 403** 的失败算成损坏。
        if (_e && _e.status === 403) throw _e;
        broken += 1;
        items.push({ id: row.id, title: '', broken: true, updated_at: row.updated_at, files: null });
      }
    }
    return { items, broken, total, hasMore: offset + rows.length < total };
  },

  /**
   * 功能：判断某条加密信息是否属于该账号（路由层在「详情 / 编辑 / 删除」前统一用它回 404）。
   *
   * 说明：⭐ 它**不需要解锁**：只比对 `id` 与 `user_id`、不碰任何密文列 —— 所以
   *      「未解锁时探某个 id 存不存在」也只会得到 404，不泄露任何内容
   *      （与密码库的 `ownsVaultEntry()` 同一条理由）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {boolean} 属于该账号则为 true
   */
  ownsSecretItem(uid, id) {
    return !!this._bk.getSecretRow(Number(uid), id);
  },

  /**
   * 功能：取一条加密信息的**完整内容**（标题 ＋ 正文），供单条查看 / 编辑用。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {{id: number, title: string, body: string, updated_at: ?string}} 完整条目
   * @throws {Error} 未解锁（403）、不存在或不归本人（404）、密文损坏（400）
   */
  getSecretItem(uid, id) {
    const row = this._bk.getSecretRow(Number(uid), id);
    if (!row) throw notFoundErr('这条加密信息');
    let it;
    try {
      it = readItem(this, uid, row, true);
    } catch (e) {
      if (e && e.status === 403) throw e; // 锁了就说锁了（见 `listSecretItems` 里那段说明）
      throw badRequest('这条记录已损坏，解不出内容（可能是数据库被手工改动过，请从备份恢复）');
    }
    return {
      id: row.id,
      title: it.title,
      body: String(it.body == null ? '' : it.body),
      updated_at: row.updated_at,
    };
  },

  /**
   * 功能：新建一条加密信息（整条加密后落库到**实验室库**）。
   *
   * 说明：⚠️ 「标题与正文不能都为空」由路由层查（与密码库「新增时密码必填」同一手法）：
   *      编辑那一趟可能只带其中一个字段，把它塞进 store 会让「只改正文」变成 400。
   *      ⚠️ IV 由密码库的 `sealForUser()` 内部随机生成（每条独立），本层无从指定。
   *      ⚠️ 先加密封装、再落库：加密失败（未解锁）时**一行都不会写**。
   *
   * @param {number} uid - 账号 id
   * @param {{title?: string, body?: string}} item - 明文条目
   * @returns {{id: number}} 新条目 id
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  createSecretItem(uid, item) {
    this._assertWritable();
    const src = item && typeof item === 'object' ? item : {};
    // ⭐ 标题与正文**各封装一组**：列表只解标题，正文点开才解（拆列的全部意义）
    const title = this.sealForUser(uid, { title: String(src.title == null ? '' : src.title) });
    const body = this.sealForUser(uid, { body: String(src.body == null ? '' : src.body) });
    const stamp = nowStamp();
    const row = this._bk.addSecret(Number(uid), {
      // 老形状三列写空串：它们是 NOT NULL，而「有没有 `title_cipher`」才是新老形状的判据
      iv: '',
      cipher: '',
      tag: '',
      title_iv: title.iv,
      title_cipher: title.cipher,
      title_tag: title.tag,
      body_iv: body.iv,
      body_cipher: body.cipher,
      body_tag: body.tag,
      created_at: stamp,
      updated_at: stamp,
    });
    return { id: row.id };
  },

  /**
   * 功能：编辑一条加密信息 —— 只改请求里真的带了的字段，改完**整条重新加密**。
   *
   * 说明：⭐ 「整条重新加密」是刻意的（而不是只改密文里的某一段）：密文是**一整块**，
   *      字段级加密会让「一条记录里几个字段的 IV 一样不一样」变成需要推理的事。
   *      ⚠️ **每次写入都换新 IV**（`sealForUser()` 内部生成）—— 复用旧 IV 是 GCM 的致命错误。
   *      ⚠️ 一条都没改到（不属于本人 / 已被删）→ 返回 false，由路由层收口成 404。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @param {{title?: string, body?: string}} patch - 只含要改的字段
   * @returns {boolean} 是否真的改到了
   * @throws {Error} 未解锁（403）、条目不存在（404）、密文损坏（400）、数据层只读（503）
   */
  updateSecretItem(uid, id, patch) {
    this._assertWritable();
    const row = this._bk.getSecretRow(Number(uid), id);
    if (!row) throw notFoundErr('这条加密信息');
    let cur;
    try {
      cur = readItem(this, uid, row, true);
    } catch (e) {
      if (e && e.status === 403) throw e;
      throw badRequest('这条记录已损坏，解不出内容，无法修改（请从备份恢复）');
    }
    const next = {
      title: String((cur && cur.title) || ''),
      body: String((cur && cur.body) || ''),
    };
    const src = patch && typeof patch === 'object' ? patch : {};
    ['title', 'body'].forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) {
        next[k] = String(src[k] == null ? '' : src[k]);
      }
    });
    const t = this.sealForUser(uid, { title: next.title });
    const b = this.sealForUser(uid, { body: next.body });
    // ⚠️ 老形状三列**一起清空**：这条记录从此按新形状读（否则库里会留着一份更旧的整块密文，
    //    两份都在时「用哪一份」就成了解释题）。清空是安全的 —— 新列已经写好了。
    return this._bk.updateSecret(
      Number(uid),
      id,
      ['title_iv', 'title_cipher', 'title_tag', 'body_iv', 'body_cipher', 'body_tag', 'iv', 'cipher', 'tag', 'updated_at'],
      [t.iv, t.cipher, t.tag, b.iv, b.cipher, b.tag, '', '', '', nowStamp()],
    );
  },

  /**
   * 功能：删除一条加密信息（密文行整行删掉）。
   *
   * 说明：⚠️ 删也是写操作，而且它同时需要「证明你在场」（未解锁不许删）——
   *      所以既过 `_assertWritable()`（主库只读闸门）也过 `openForUser` 那一道解锁闸门。
   *      ⚠️ 这里用 `ownsSecretItem` 之外的一条路：直接看 `removeSecret` 的返回值，
   *      由路由层收口成 404（路由层已经先用 `ownsSecretItem()` 挡过一次越权）。
   *
   * @param {number} uid - 账号 id
   * @param {number} id - 条目 id
   * @returns {boolean} 是否真的删掉了一行
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  removeSecretItem(uid, id) {
    this._assertWritable();
    const row = this._bk.getSecretRow(Number(uid), id);
    if (!row) return false;
    // ⚠️ 只为过「已解锁」这道闸（`vaultAssertUnlocked()` 是密码库的公开方法，锁着时抛 403）。
    //    ⚠️ 别改成 `openForUser()`：删一条记录**不需要**先把正文解出来 —— 那是多余的暴露，
    //    而且密文一旦损坏，它会让人连「删掉这条坏记录」都做不到（只能整库恢复）。
    this.vaultAssertUnlocked(uid);
    return this._bk.removeSecret(Number(uid), id);
  },

  // ==========================================================================================
  // 附件（0.9.8 · 方案 42 §2.7 / 决策 144）
  //
  // ⚠️ 这一整段的共同前提：**文件本体不在库里**，库只留元信息；磁盘上是分块 AEAD 的密文文件
  //（格式见 `lib/blob.js`）。所有方法都先过 `vaultAssertUnlocked()` / `_assertWritable()`，
  // 与正文链路同一个门槛 —— ⛔ 不给文件开一条绕过库的后门。
  // ==========================================================================================

  /**
   * 功能：算本模块的**默认附件根** —— `<数据目录>/<库>/<模块名>`（主库时没有中间那层）。
   *
   * 说明：⭐⭐ 默认根**由 `database` 派生**，⛔ 不在这里手写 `'lab'`（方案 42 §2.7·3 的红线）：
   *      「库在哪、默认文件在哪」永远同一个答案；转正时删掉 `module.json` 的 `database` 那一行，
   *      默认根自动变成 `<数据目录>/secrets/`（数据由迁移工具搬）。
   *      ⚠️ 判据问的是 `_dbFor()`（`SCHEMA.dbOf()` 的门面），而不是自己读 module.json ——
   *      映射的**唯一出处**在 `core/store/schema/index.js`，这里再读一遍就是第二份真相。
   *
   * @param {string} moduleName - 模块名（`secrets`）
   * @returns {string} 绝对路径（不保证存在）
   */
  filesRoot(moduleName) {
    const name = String(moduleName || 'secrets');
    // 「本模块第一张表」= 归属那条链的起点；它的库就是整个模块的库
    const db = this._dbFor('secrets_items');
    const base = db === 'main' ? this.dataDir : path.join(this.dataDir, db);
    return path.join(base, name);
  },

  /**
   * 功能：该账号当前该用的附件根 —— **必须由用户授权过**，没有就报错（⛔ 不再回落到默认根）。
   *
   * 说明：⭐⭐ 附件目录改成「飞牛用户自己授权」之后，**「没授权」就是没有目录**。
   *      以前没设置时会悄悄落到 `<数据目录>/secrets`（应用账号能读写就用了）—— 那等于
   *      「谁能打开这个应用，谁就能让应用去读写应用账号能碰的任何地方」，与「每个用户授权自己的目录」
   *      不是一回事。⛔ 别把回落加回来：它会让「未授权」这个状态在界面上永远不出现。
   *      ⚠️ **每个上传请求开始时取一次**，然后把值写进 `secrets_files.root`：
   *      之后用户再换目录，旧附件仍按它自己那一行的 `root` 读（决策 144 ②）。
   * @param {number} uid - 账号 id
   * @returns {string} 绝对路径
   * @throws {Error} 未授权（409）—— 话术与 `assertRootAuthorized()` 保持一致
   */
  resolveRoot(uid) {
    const root = this._bk.getSecretRoot(Number(uid));
    if (!root) {
      throw Object.assign(new Error('还没有授权附件目录 —— 请先在「附件位置」里选一个文件夹'), {
        code: 'ROOT_NOT_AUTHORIZED',
        status: 409,
      });
    }
    return String(root);
  },

  /**
   * 功能：校验用户输入的附件根目录 —— 方案 42 §2.7·9 的六条，每条都回中文 400 话术。
   *
   * 说明：⚠️ **不替用户 `mkdir -p`**：打错一个字时，自动建目录会在错误的位置留下一串空目录，
   *      而用户以为"设置成功了"。不存在就 400，让他自己建好再来。
   *      ⚠️ 拒绝 `<数据目录>` 本身：附件别和库文件混在同一层（备份 / 迁移时最容易误伤）。
   *      ⚠️ 拒绝系统目录：那是"手滑把 /etc 选成附件目录"的最后一道拦。
   * @param {*} input - 用户输入
   * @returns {string} 归一化后的绝对路径（去掉尾随分隔符）
   * @throws {Error} 任一条不合格时抛出 400
   */
  validateRoot(input) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) throw badRequest('请填写附件目录（绝对路径）');
    if (raw.length > 1024) throw badRequest('路径太长（最多 1024 个字符）');
    if (raw.includes('..')) throw badRequest('路径里不能出现「..」');
    if (!path.isAbsolute(raw)) throw badRequest('请填写绝对路径（以 / 开头）');
    const root = path.normalize(raw).replace(/[\\/]+$/, '') || '/';
    if (root === '/') throw badRequest('不能把根目录 / 当附件目录');
    const SYS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/var', '/lib', '/lib64'];
    if (SYS.includes(root) || SYS.some((d) => root.startsWith(d + '/'))) {
      throw badRequest('这是系统目录，不能用来存附件');
    }
    const dataDir = path.normalize(this.dataDir).replace(/[\\/]+$/, '');
    if (root === dataDir) throw badRequest('不能选数据目录本身 —— 附件请放到单独的文件夹');
    let st;
    try {
      st = fs.statSync(root);
    } catch (_e) {
      // ⭐ 0.9.8 第 6 轮：话术里**不再带内部路径**（`/vol1/...` 对用户没有意义，
      //    而且他是从飞牛选择器里选的目录，那边显示的是语义化路径 —— 再抄一遍黑话只会让人怀疑自己选错了）
      throw badRequest('这个目录不存在 —— 请先建好文件夹再选');
    }
    if (!st.isDirectory()) throw badRequest('这个路径不是文件夹');
    try {
      fs.accessSync(root, fs.constants.W_OK);
    } catch (_e) {
      throw badRequest('这个目录当前不可写，请换一个（或用 chown/chmod 给应用账号写权限）');
    }
    return root;
  },

  /**
   * 功能：附件位置只能用**空文件夹** —— 已经有东西的一律拒。
   *
   * 说明：⭐⭐ 附件根是「这套数据的家」：一个已经有东西的目录里，第一次写入就可能撞上同名文件，
   *      而且「换目录时要不要迁移」那个问题在非空目录上根本答不清（挪进去会混在别人的文件里）。
   *      ⚠️ **同一个目录再来一次要放行**：那是「原样保存」，不是换成新目录（否则用户点两次就报错）。
   *      ⚠️ 只看**顶层有没有条目**：不递归、不按类型筛 —— 「有两个空子目录」也算非空。
   *      ⛔ 不替用户建目录：要空文件夹就在选择器里点「新建文件夹」。
   * @param {string} dir - 已经过 `validateRoot()` 的绝对路径
   * @param {string} [current] - 当前登记的根（与它相同时放行）
   * @returns {void}
   * @throws {Error} 非空时抛 400（话术说清「怎么得到空文件夹」）
   */
  assertRootEmpty(dir, current) {
    const p = String(dir || '');
    const cur = String(current || '');
    if (p && cur && p === cur) return; // 原样保存：不做任何改动，也就没有「混进别人文件」的风险
    let names;
    try {
      names = fs.readdirSync(p);
    } catch (_e) {
      throw badRequest('这个文件夹读不出来 —— 请换一个');
    }
    // ⭐ 空 ⇒ 正是要的（这是常态，先判掉，别让下面的例外把它绕成一次多余的盘读）
    if (!names.length) return;
    // ⭐ 例外：这个目录**以前就是本应用的附件目录**（根里有我们写的那封 `说明.txt`）⇒ 放行。
    //    没有这一条，「把整个附件文件夹挪到别处、再指回来」那条路会被自己挡住
    //    （那条路只能走「重新关联」，而不是换目录）。
    if (this.looksLikeOurRoot(p)) return;
    throw badRequest(
      `附件位置要用空文件夹 —— 这个文件夹里已经有 ${names.length} 项了，` +
        '请换一个空的（或者在选择器里点「＋ 新建文件夹」建一个）',
    );
  },

  /**
   * 功能：这个目录是不是**本应用以前用过的附件目录** —— 根里那封 `说明.txt` 是唯一凭据。
   *
   * 说明：⚠️ 只读前 120 个字符并认里面两处字样，⛔ 不做全文件比对：说明文字以后会改，
   *      认死全文等于「改一句文案就失效」。
   * @param {string} dir - 目录绝对路径
   * @returns {boolean} 是（或至少像）本应用的附件根为 true
   */
  looksLikeOurRoot(dir) {
    try {
      const head = fs.readFileSync(path.join(String(dir), '说明.txt'), 'utf8').slice(0, 120);
      return head.includes('ZXDesk') && head.includes('加密信息');
    } catch (_e) {
      return false;
    }
  },

  /**
   * 功能：某个附件在根下的**相对路径** —— `<uid>/<两位分片>/<id>.zxdesk`。
   *
   * 说明：⚠️ `<uid>` 那一级是**防撞名的唯一手段**：两个账号把根设成同一个共享文件夹时，
   *      只用 id 会出现「别人的附件覆盖我的」（方案 42 §2.7·9）。
   *      ⚠️ 文件名只用 `<id>.zxdesk`，⛔ 绝不用用户给的名字：那会把秘密写在文件名上。
   * @param {number} uid - 账号 id
   * @param {number} fid - 附件 id
   * @returns {string} 相对路径（用 `/` 连接，落库用）
   */
  secretFileRel(uid, fid) {
    const shard = String(Number(fid) % 100).padStart(2, '0');
    return `${Number(uid)}/${shard}/${Number(fid)}.zxdesk`;
  },

  /**
   * 功能：这一行**现在**是不是完好可用（文件在 ＋ 头里写的就是它）。
   *
   * 说明：⭐⭐ 「文件存在」不等于「这一行可用」：同一个位置可能被另一个文件顶了名
   *      （恢复工具、手工复制、别的账号的同名文件）。以前 `relinkFiles()` 只要看到
   *      「路径上有个文件」就跳过这一行，于是那种行永远修不回来 —— 点开才报 400。
   *      现在判据加一条：**头里的 `uid` / `id` 必须是它**（`isOurFile()`）。
   *      ⚠️ 只 open ＋ 读几十字节头，不读内容、不解密；一行一次，几百行也就几十毫秒。
   * @param {number} uid - 账号 id
   * @param {Object} row - `secrets_files` 行
   * @returns {boolean} 文件在且身份对得上为 true
   */
  secretRowIntact(uid, row) {
    const abs = this.secretFilePath(row);
    if (!isReadableFile(abs)) return false;
    let fd = null;
    try {
      fd = fs.openSync(abs, 'r');
      return isOurFile(uid, row.id, blob.readHeaderOnly(fd));
    } catch (_e) {
      return false;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (_e) {
          /* 已关闭 */
        }
      }
    }
  },

  /**
   * 功能：把一行的 `root` ＋ `rel` 拼成磁盘上的绝对路径（读 / 删都用它）。
   * @param {{root: string, rel: string}} row - `secrets_files` 行
   * @returns {string} 绝对路径
   */
  secretFilePath(row) {
    return path.join(String(row.root), String(row.rel));
  },

  /**
   * 功能：登记一条附件（**先落文件、后插行**由调用方保证）。
   *
   * 说明：⭐ 文件名与 mime 会先加密成 `meta_*` 三列再落库 —— 库里看不到「离婚协议.pdf」这种字眼。
   *      ⚠️ `size` 是明文：Range 与 `Content-Length` 都在解密前计算，加密它没有意义。
   * @param {number} uid - 账号 id
   * @param {number} itemId - 加密信息 id
   * @param {{name: string, mime: string, size: number, root: string, rel: string}} meta - 元信息
   * @returns {{id: number, size: number, created_at: string}} 新行摘要
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  addSecretFile(uid, itemId, meta) {
    this._assertWritable();
    const src = meta && typeof meta === 'object' ? meta : {};
    const sealed = this.sealForUser(uid, {
      name: String(src.name == null ? '' : src.name),
      mime: String(src.mime == null ? '' : src.mime),
    });
    const stamp = nowStamp();
    const row = this._bk.insertSecretFile(Number(uid), {
      item_id: Number(itemId),
      meta_iv: sealed.iv,
      meta_cipher: sealed.cipher,
      meta_tag: sealed.tag,
      size: Number(src.size) || 0,
      root: String(src.root || ''),
      rel: String(src.rel || ''),
      // ⭐ 上传时还不知道指纹（文件还没写完）⇒ 先空串，收尾与 `rel` 一起补
      sha256: String(src.sha256 || ''),
      created_at: stamp,
    });
    return { id: row.id, size: row.size, created_at: stamp };
  },

  /**
   * 功能：列出某条加密信息下的附件（**解密后的名字与 mime**，⛔ 不含任何密文材料）。
   *
   * 说明：⚠️ 单条元信息解不开**不静默跳过**：跳过会让用户以为「那个附件没了」，
   *      而真相是「那一行坏了」。这里标 `broken: true` 照常返回（与正文列表同一条口径）。
   * @param {number} uid - 账号 id
   * @param {number} itemId - 加密信息 id
   * @returns {Array.<Object>} `[{id, name, mime, size, created_at, broken}]`
   * @throws {Error} 未解锁（403）
   */
  listSecretFiles(uid, itemId) {
    this.vaultAssertUnlocked(uid);
    const out = [];
    for (const row of this._bk.listSecretFilesOfItem(Number(uid), Number(itemId))) {
      try {
        const meta = this.openForUser(uid, { iv: row.meta_iv, cipher: row.meta_cipher, tag: row.meta_tag });
        out.push({
          id: row.id,
          name: String((meta && meta.name) || ''),
          mime: String((meta && meta.mime) || ''),
          size: Number(row.size) || 0,
          created_at: row.created_at,
          broken: false,
        });
      } catch (e) {
        if (e && e.status === 403) throw e;
        out.push({ id: row.id, name: '', mime: '', size: Number(row.size) || 0, created_at: row.created_at, broken: true });
      }
    }
    return out;
  },

  /**
   * 功能：一条加密信息的**附件概要**（四类计数 ＋ 读不出的条数）—— 列表那一行用。
   *
   * 说明：⭐ 只算计数，⛔ 不回文件名：列表本来就只回标题，把文件名塞进去等于把
   *      「这条存了什么」摊到列表接口上。分类靠解密后的 mime（`meta_*` 是密文），
   *      所以这一步**必然要解密附件元信息**（每条约几十到几百字节，代价可忽略）。
   *      ⚠️ 单条元信息解不开不静默丢：记进 `broken`，界面照实说「读不出 N」。
   * @param {number} uid - 账号 id
   * @param {number} itemId - 加密信息 id
   * @returns {{image: number, video: number, audio: number, file: number, broken: number}} 计数
   * @throws {Error} 未解锁（403）
   */
  secretFilesSummary(uid, itemId) {
    this.vaultAssertUnlocked(uid);
    const out = { image: 0, video: 0, audio: 0, file: 0, broken: 0 };
    for (const row of this._bk.listSecretFilesOfItem(Number(uid), Number(itemId))) {
      try {
        const meta = this.secretFileMeta(uid, row);
        out[kindOf(meta && meta.mime)] += 1;
      } catch (e) {
        if (e && e.status === 403) throw e;
        out.broken += 1;
      }
    }
    return out;
  },

  /**
   * 功能：取某条加密信息下的**原始行**（含 `root` / `rel`）—— 删条目时把文件交给调用方删。
   *
   * 说明：⚠️ 只有删除路径需要它：`root` / `rel` 是磁盘位置，不该出现在任何响应体里。
   * @param {number} uid - 账号 id
   * @param {number} itemId - 加密信息 id
   * @returns {Array.<Object>} 行数组
   * @throws {Error} 未解锁（403）
   */
  secretFileRowsOfItem(uid, itemId) {
    this.vaultAssertUnlocked(uid);
    return this._bk.listSecretFilesOfItem(Number(uid), Number(itemId));
  },

  /**
   * 功能：按附件 id 取一条行；越权与不存在都抛 **404**（同一个 404，⛔ 不用 403 区分）。
   * @param {number} uid - 账号 id
   * @param {number} fid - 附件 id
   * @returns {Object} 行（含 root/rel，仅供服务端用）
   * @throws {Error} 未解锁（403）、不存在或不归本人（404）
   */
  secretFileFor(uid, fid) {
    this.vaultAssertUnlocked(uid);
    const row = this._bk.getSecretFile(Number(uid), Number(fid));
    if (!row) throw notFoundErr('这个附件');
    return row;
  },

  /**
   * 功能：删一条附件 —— 先删行、返回该行（调用方据此 `unlink` 文件）。
   *
   * 说明：⭐ 顺序是「先删行、再删文件」：反过来的话，`unlink` 成功而删行失败，
   *      会留下一条指向空文件的记录（点开就 500）。现在最坏是留一个孤儿文件 —— 占盘，但不骗人。
   * @param {number} uid - 账号 id
   * @param {number} fid - 附件 id
   * @returns {?Object} 被删的行；没删到返回 null
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  removeSecretFile(uid, fid) {
    this._assertWritable();
    this.vaultAssertUnlocked(uid);
    const row = this._bk.getSecretFile(Number(uid), Number(fid));
    if (!row) return null;
    this._bk.deleteSecretFile(Number(uid), Number(fid));
    return row;
  },

  /**
   * 功能：解密一条附件的元信息（名字 ＋ mime）—— **读路径与响应头都用它**。
   *
   * 说明：⚠️ 解不开时**不抛**：返回空名字 ＋ 空 mime，由调用方按 `application/octet-stream`
   *      照常发字节（文件本身还能读出来，只是名字丢了 —— 那比整条 500 有用）。
   *      ⚠️ 名字与 mime **只从密文里取**，⛔ 绝不回显上传时那个请求头（那条已经过去了）。
   * @param {number} uid - 账号 id
   * @param {{meta_iv: string, meta_cipher: string, meta_tag: string}} row - 附件行
   * @returns {{name: string, mime: string, broken: boolean}} 元信息
   * @throws {Error} 未解锁（403）
   */
  secretFileMeta(uid, row) {
    this.vaultAssertUnlocked(uid);
    try {
      const meta = this.openForUser(uid, { iv: row.meta_iv, cipher: row.meta_cipher, tag: row.meta_tag });
      return { name: String((meta && meta.name) || ''), mime: String((meta && meta.mime) || ''), broken: false };
    } catch (e) {
      if (e && e.status === 403) throw e;
      return { name: '', mime: '', broken: true };
    }
  },

  /**
   * 功能：上传收尾 —— 把 `<id>.zxdesk` 的真实相对路径补进行里（`addSecretFile()` 时 `rel` 还是空的）。
   *
   * 说明：⚠️ 顺序必须是「文件已 `rename` 成功」之后再调它：先补 rel 再改名，崩在中间会得到
   *      一条指向不存在文件的记录（点开 400），而反过来最坏只留一个没人引用的 `.zxdesk`。
   * @param {number} uid - 账号 id
   * @param {number} fid - 附件 id
   * @param {string} rel - 相对路径
   * @returns {boolean} 改到行则为 true
   * @throws {Error} 数据层只读（503）
   */
  setSecretFileRel(uid, fid, rel, sha256) {
    this._assertWritable();
    return this._bk.updateSecretFileRel(Number(uid), Number(fid), String(rel), String(sha256 == null ? '' : sha256));
  },

  /**
   * 功能：该账号的附件用量（条数 ＋ 明文字节合计）—— 给界面显示「已用 X MB」，**不拦人**。
   * @param {number} uid - 账号 id
   * @returns {{count: number, bytes: number}} 用量
   * @throws {Error} 未解锁（403）
   */
  secretUsage(uid) {
    this.vaultAssertUnlocked(uid);
    const u = this._bk.secretFilesUsage(Number(uid));
    return { count: Number(u.count) || 0, bytes: Number(u.bytes) || 0 };
  },

  /**
   * 功能：按**用过的根**分组统计（当前根 ＋ 旧根），给「附件位置」面板用。
   *
   * 说明：⭐⭐ 这就是「用户自行备份」的落点（决策 144 ③）：只写「附件不进备份」等于把问题丢回去，
   *      面板必须给出「该复制哪几个文件夹、各有多大」。
   * @param {number} uid - 账号 id
   * @returns {Array.<{root: string, count: number, bytes: number, missing: number, current: boolean}>}
   *      分组用量（条数多的在前）；`missing` = 这一组里**文件已经不在原位置**的条数
   * @throws {Error} 未解锁（403）
   */
  rootsUsage(uid) {
    this.vaultAssertUnlocked(uid);
    // ⚠️ 这里**不能**调 `resolveRoot()`：它现在「没授权就抛 409」，而面板正是要在未授权时
    //    把「用过的目录 / 用量」显示出来——那是用户判断「该选哪个目录」的依据。
    const current = this._bk.getSecretRoot(Number(uid)) || '';
    /** @type {Map.<string, {root: string, count: number, bytes: number, missing: number, current: boolean}>} */
    const map = new Map();
    for (const row of this._bk.listSecretFiles(Number(uid))) {
      const root = String(row.root || '');
      if (!map.has(root)) map.set(root, { root, count: 0, bytes: 0, missing: 0, current: root === current });
      const it = map.get(root);
      it.count += 1;
      it.bytes += Number(row.size) || 0;
      // ⭐ 0.9.8（重新关联）：面板每条根要能说「缺失 N 条」—— 判据就是**这一行的文件还在不在**
      //    （只 `stat`，不解密、不读内容）。⚠️ 一次面板打开 = 每行一次 stat：
      //    附件条数一般几十到几百，代价可忽略；⛔ 别为了省这一下改成缓存的"上次结论"，
      //    那会在用户刚把文件夹挪回来时显示「缺失」——正是他要看这一行的那一刻。
      if (!isReadableFile(this.secretFilePath(row))) it.missing += 1;
    }
    // 未授权时**不画**那个空根：它会显示成一行「（未记录） 0 个」，纯噪音
    if (current && !map.has(current)) map.set(current, { root: current, count: 0, bytes: 0, missing: 0, current: true });
    return [...map.values()].map((it) => Object.assign(it, { current: it.root === current })).sort((a, b) => b.count - a.count);
  },

  /**
   * 功能：算「账号库里记的那个附件目录」现在的状态 —— 面板合并后只剩这一块，状态就挂在它身上。
   *
   * 说明：⭐⭐ 2026-11-09 老大的口径：
   *      · 面板**只显示当前这一个目录**（不再列「用过的目录」）；
   *      · 这个路径本身就写在账号的记录里（`getSecretRoot()`），所以状态描述的是**这个路径**：
   *        `missing`（路径缺失）＝ 这个目录不在了（被删 / 被挪走 / 存储没挂上）；
   *        `partial`（部分缺失）＝ 目录在，但**这个目录里**还有附件文件打不开；
   *        `normal`（正常）＝ 目录在、附件也都在；`none` ＝ 还没设过目录。
   *      ⚠️ `missing` 只在「目录不在」时成立，**不因为个别文件缺失就降级** ——
   *      那样用户会以为整个目录没了（这两句话说的是完全不同的处置：一个去重新定位目录，
   *      一个去找那几个文件）。
   *      ⚠️⚠️ **统计范围只到「这个路径」**（老大 2026-11-09：「路径是每个用户自己选择的，不能按全账号算。
   *      每个账号都是独立的附件路径」）：`count` / `bytes` / `missing` **只数 `row.root === 当前根` 的行**。
   *      ① 每个账号的附件路径各自独立（`listSecretFiles(uid)` 本来就只取本账号）；
   *      ② 同一账号换过目录之后，留在旧目录里的行**不属于这个路径**，⛔ 不许把它们算进这个路径的状态 ——
   *         否则用户只是换了个新目录，就被一条早已不在的旧文件拖成「部分缺失」，指错了排查方向。
   *      ⚠️ 每次打开面板都真 `stat`（目录一次 ＋ 本路径下每行一次）：附件几十到几百条，代价可忽略；
   *      ⛔ 不缓存结论 —— 用户刚把文件夹挪回来那一刻，正是他要看这个状态的那一刻。
   * @param {number} uid - 账号 id
   * @returns {{status: string, root: string, path_exists: boolean, count: number, bytes: number, missing: number, checked_at: string}}
   *      `count` / `bytes` = **这个路径下**的附件（换目录时要问的「搬不搬 N 个」就是这个 N）；
   *      `missing` = **这个路径下**打不开的附件数（⛔ 不含别的路径）
   * @throws {Error} 未解锁（403）
   */
  rootState(uid) {
    this.vaultAssertUnlocked(uid);
    const u = Number(uid);
    const root = String(this._bk.getSecretRoot(u) || '');
    /** 目录本身在不在（`stat` 失败＝不在；是文件不是目录也算不在） @type {boolean} */
    let pathExists = false;
    if (root) {
      try {
        pathExists = fs.statSync(root).isDirectory();
      } catch (_e) {
        pathExists = false;
      }
    }
    let count = 0;
    let bytes = 0;
    let missing = 0;
    for (const row of this._bk.listSecretFiles(u)) {
      // ⚠️ 只算**这个路径**（见上面第 ⚠️⚠️ 条）：别的路径的行属于别的目录，与这里的结论无关
      if (String(row.root || '') !== root) continue;
      count += 1;
      bytes += Number(row.size) || 0;
      if (!isReadableFile(this.secretFilePath(row))) missing += 1;
    }
    /** @type {string} */
    let status = 'none';
    if (root) status = !pathExists ? 'missing' : missing > 0 ? 'partial' : 'normal';
    return {
      status,
      root,
      path_exists: pathExists,
      count,
      bytes,
      missing,
      checked_at: nowStamp(),
    };
  },

  /**
   * 功能：批量把内部路径转成**可展示**的串（语义化优先，转不到退「`…/末两段`」）。
   *
   * 说明：⭐ 唯一出口是 `trimApi.convertPaths()`（5 分钟缓存、一次最多 50 条、失败不抛）。
   *      本方法只负责「一条都不漏」：**输入里出现过的路径，返回值里必有键** ——
   *      这样路由层可以直接 `map.get(x) || x`，不必在每个调用点各写一次兜底。
   *      ⚠️ 返回值只用于展示：授权白名单、`root` 落库、`rel` 拼路径**全都只认原始 path**
   *      （`semanticPath` 不是唯一标识，也不该被当成路径用）。
   * @param {Array.<string>} paths - 内部绝对路径（可含重复 / 空值）
   * @returns {Promise.<Map.<string, string>>} `路径 → 展示串`
   */
  async displayPaths(paths) {
    const raw = Array.isArray(paths) ? paths : [paths];
    /** @type {Array.<string>} */
    const list = [];
    for (const p of raw) {
      const s = String(p == null ? '' : p);
      if (s && !list.includes(s)) list.push(s);
    }
    /** @type {Map.<string, string>} */
    const out = new Map();
    if (!list.length) return out;
    /** @type {Map.<string, string>} */
    let got;
    try {
      got = await trimApi.convertPaths(list);
    } catch (_e) {
      // ⚠️ 连 convertPaths 都抛（理论上不会，它自己已经 catch）也照旧兜底
      got = new Map();
    }
    // ⭐⭐ 0.9.8 第 8 轮（老大 2026-11-09：「如果不能显示转换后的路径就显示原始的」）：
    //    兜底从「`…/末两段`」改成**原始路径本身**。这是**口径变更**，不是回退 ——
    //    第 6 轮定的是「页面上不出现 `/vol1/...`」，本轮由老大明确推翻：
    //    宁可看到真路径，也不要一个「改了样、还得再解释一句」的假路径。
    //    ⚠️ 判断用的字段（`current` / `roots[].root` / `available`）一个字都没动：
    //    这里只决定**给人看**的那三处字符串。
    //    ⚠️ 长路径靠 CSS 的 `word-break: break-all` 换行，⛔ 不再截断。
    for (const p of list) out.set(p, got.get(p) || p);
    return out;
  },

  /**
   * 功能：读「路径转语义化」这个能力**现在**的结论（只给「附件位置」面板说一句人话）。
   *
   * 说明：⭐⭐ 0.9.8 第 6 轮补：`convertPath` 拿不到时页面会退成 `…/末两段`，而「拿不到」
   *      有四种原因（没 token / 网关不可达 / 系统低于 1.2.0401 / 应用没登记 `trim.file.path`），
   *      在界面上表现完全一样 —— 用户只会说「这功能没做」。这里把服务端记下的原因交出去，
   *      面板照着说一句可操作的提示，⛔ 不让它继续静默降级。
   * @returns {{ok: boolean, code: string, reason: string, status: ?string, msg: string, resultKind: string, at: number}}
   *   副本（不含路径、不含 token；`status` / `msg` / `resultKind` 只给排查用，界面不显示）
   */
  pathConvertInfo() {
    return trimApi.convertStatus();
  },

  /**
   * 功能：判断某个绝对路径**现在**是否落在「本会话可读的位置」里（阅读器的第 3 道关）。
   *
   * 说明：⭐⭐ 0.9.8 第 6 轮（方案 §9.3 第 3 条）：没有这一道，阅读器就变成一个
   *      「按路径读任意文件」的原语 —— 它可以被拿来当加密 oracle 用。
   *      判据是「**授权列表 ∪ 库里记过的根**」：
   *      · 优先用飞牛的授权列表（共享 ＋ 个人）：那是用户/管理员明确点过头的范围；
   *      · 网关不可达（局域网直连 / Windows / 安卓客户端）时只有库里的根可用 ——
   *        那种情况下「读得到的范围」本来就等于「用户自己配过的附件目录」。
   *      ⚠️ 返回 `{ok:false}` 时的话术由调用方给（这里只说事实，不说「怎么办」）。
   * @param {number} uid - 账号 id
   * @param {string} abs - 已经 `realpath` 过的绝对路径
   * @param {?Object} gwUser - 网关身份
   * @returns {Promise.<{ok: boolean}>} 在范围内为 `{ok:true}`
   */
  async secretPathAllowed(uid, abs, gwUser) {
    /** @type {Array.<string>} */
    const cands = [];
    const info = this._bk.getSecretRootInfo(Number(uid));
    if (info && info.root) cands.push(String(info.root));
    for (const row of this._bk.listSecretFiles(Number(uid))) {
      if (row && row.root) cands.push(String(row.root));
    }
    const av = await this.availableRoots(gwUser, false);
    if (av && Array.isArray(av.paths)) cands.push(...av.paths);
    const roots = [...new Set(cands.map((x) => normPath(x)).filter(Boolean))];
    if (!roots.length) return { ok: false };
    return { ok: isGranted(normPath(abs), roots) };
  },

  /**
   * 功能：**浏览**授权目录 —— 列出某一层里的子目录与 `.zxdesk` 加密文件（阅读器的自有选择器）。
   *
   * 说明：⭐⭐ 阅读器不再借飞牛宿主选择器：那条通道只在宿主内嵌页里存在，
   *      安卓 / Windows / 局域网直连一律打不开。改成「应用自己列目录」之后，
   *      这四个端走的是同一条路，而且**判据仍是服务端的授权范围**（`secretPathAllowed()`），
   *      ⛔ 不因为「是界面自己列出来的」就放行。
   *      ⚠️ 安全上有四条：
   *      ① 只认**用户自己登记过的根**（`resolveRoot()`，没授权就 409）与授权树内的路径；
   *      ② 路径先 `normalize` 再 `realpath` —— 软链接不能把列表带到树外；
   *      ③ 只回**名字 / 路径 / 大小 / 时间**，⛔ 不读文件内容、不解密、不需要主密码；
   *      ④ 隐藏项（`.` 开头）不列：那是元文件与半成品，列出来只会让人误点。
   *
   * @param {number} uid - 账号 id
   * @param {string} rawDir - 要列的目录（绝对路径；空串 ＝ 从根开始）
   * @param {?Object} gwUser - 网关身份
   * @returns {Promise.<{root: string, dir: string, parent: ?string, atRoot: boolean, dirs: Array.<Object>, files: Array.<Object>, truncated: boolean}>} 目录内容
   * @throws {Error} 未授权（409）/ 不在授权范围（403）/ 目录不存在（404）/ 参数非法（400）
   */
  async secretBrowse(uid, rawDir, gwUser) {
    const base = normPath(this.resolveRoot(uid));
    const asked = String(rawDir == null ? '' : rawDir).trim();
    if (asked.length > 1024) throw badRequest('路径太长（最多 1024 个字符）');
    if (/[\u0000-\u001f\u007f]/.test(asked)) throw badRequest('路径里含有控制字符');
    const dir = asked ? path.normalize(asked) : base;
    if (!path.isAbsolute(dir)) throw badRequest('需要给一个绝对路径');
    /** @type {string} */
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch (_e) {
      throw Object.assign(new Error('这个目录不在了 —— 可能被删掉、改名，或存储没挂上'), { status: 404 });
    }
    let st;
    try {
      st = fs.statSync(real);
    } catch (_e) {
      throw Object.assign(new Error('这个目录读不了'), { status: 403 });
    }
    if (!st.isDirectory()) throw badRequest('这个路径不是一个目录');
    const allowed = await this.secretPathAllowed(uid, real, gwUser);
    if (!allowed.ok) {
      throw Object.assign(new Error('这个文件夹还没授权给 ZXDesk —— 请先在「附件位置」里选一次'), {
        status: 403,
        code: 'PATH_NOT_AUTHORIZED',
      });
    }
    let ents;
    try {
      ents = fs.readdirSync(real, { withFileTypes: true });
    } catch (_e) {
      throw Object.assign(new Error('读不了这个目录（权限不足？）'), { status: 403 });
    }
    /** 单层最多列这么多 —— 一个塞了几万个文件的目录没必要全画出来 @type {number} */
    const MAX = 300;
    const dirs = [];
    const files = [];
    let truncated = false;
    for (const e of ents) {
      if (dirs.length + files.length >= MAX) {
        truncated = true;
        break;
      }
      if (!e.name || e.name.startsWith('.')) continue;
      const abs = path.join(real, e.name);
      if (e.isDirectory()) {
        dirs.push({ name: e.name, path: abs });
        continue;
      }
      // ⚠️ 只列**普通文件**且后缀是 `.zxdesk`：软链接一律不列（它可能是树外的一个入口，
      //    列出来等于让人以为「这里有个能读的文件」）
      if (!e.isFile()) continue;
      if (path.extname(e.name).toLowerCase() !== '.zxdesk') continue;
      let size = null;
      let mtime = '';
      try {
        const fst = fs.statSync(abs);
        size = Number(fst.size) || 0;
        mtime = new Date(fst.mtimeMs).toISOString();
      } catch (_e) {
        /* 读不到大小就显示「—」 */
      }
      files.push({ name: e.name, path: abs, size, mtime });
    }
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh');
    dirs.sort(byName);
    files.sort(byName);
    const atRoot = normPath(real) === base;
    return {
      root: base,
      dir: real,
      parent: atRoot ? null : path.dirname(real),
      atRoot,
      dirs,
      files,
      truncated,
    };
  },

  /**
   * 功能：按磁盘绝对路径反查**本账号**库里对应的那一行附件（没有就 null）。
   *
   * 说明：⚠️ 只用于「拿文件名 / 类型 / 上传时间」这些**显示用**信息：
   *      这些字段在 `secrets_files` 的**加密列**里（要 DEK 才解得开），所以查不到行时
   *      调用方必须能接受「没有名字」——阅读器仍然应该能打开文件（方案 §10.5 的兜底名）。
   *      ⚠️ 比较前两边都过 `normPath()`：`rel` 拼出来的路径可能带尾斜杠或多层分隔符。
   * @param {number} uid - 账号 id
   * @param {string} abs - 绝对路径
   * @returns {?Object} `secrets_files` 行；不在本账号名下为 null
   */
  secretOpenRow(uid, abs) {
    const want = normPath(abs);
    if (!want) return null;
    for (const row of this._bk.listSecretFiles(Number(uid))) {
      if (!row || !row.rel) continue;
      try {
        if (normPath(this.secretFilePath(row)) === want) return row;
      } catch (_e) {
        /* 这一行的根不可用：跳过（它不可能是我们要找的那个文件） */
      }
    }
    return null;
  },

  /**
   * 功能：阅读器打开一个 `.zxdesk` 之前的**六道校验**（方案 §9.3），通过则回文件事实。
   *
   * 说明：⭐⭐ 六条一条都不能省 —— 它们各自挡的是一种具体的事故：
   *      ① 路径形状（绝对 / ≤1024 / 无控制字符）—— 挡注入与奇怪的输入；
   *      ② 必须是**普通文件**且后缀 `.zxdesk` —— 挡「拿目录 / 别的后缀当输入」；
   *      ③ `realpath` 之后必须仍在本会话可读的范围内 —— 挡「读任意路径」（`secretPathAllowed()`）；
   *      ④ 头必须是 `ZXDS` / `ver===2` / `metaLen ≤ 1024` —— 旧版 `SDB1` 原样回它那句话；
   *      ⑤ 文件长度必须与头自洽 —— 截断当场发现（否则要等到解帧时才炸，那时响应已发）；
   *      ⑥ `plainSize ≤ 300 MB` —— 内存与时间都有上界。
   *      ⚠️ 只读几十字节头、**不解密**、不需要主密码：这一步是「这个文件是什么」，
   *      不是「我能不能看它」—— 后者由钥匙决定（方案 §10.3）。
   * @param {number} uid - 会话账号 id
   * @param {string} rawPath - 文件管理器传进来的路径
   * @param {?Object} gwUser - 网关身份
   * @returns {Promise.<Object>} `{abs, header, size, at, ownerUid, fileId, row}`
   * @throws {Error} 任一条不合格时抛出（400 / 403 / 404，话术见各自分支）
   */
  async secretOpenTarget(uid, rawPath, gwUser) {
    const raw = String(rawPath == null ? '' : rawPath).trim();
    if (!raw) throw badRequest('没有拿到文件路径');
    if (raw.length > 1024) throw badRequest('路径太长（最多 1024 个字符）');
    if (/[\u0000-\u001f\u007f]/.test(raw)) throw badRequest('路径里含有控制字符');
    if (!path.isAbsolute(raw)) throw badRequest('需要给一个绝对路径');
    const abs = path.normalize(raw);
    if (path.extname(abs).toLowerCase() !== '.zxdesk') {
      throw badRequest('这个文件不是 ZXDesk 的加密附件（后缀应当是 .zxdesk）');
    }
    let st;
    try {
      st = fs.statSync(abs);
    } catch (_e) {
      throw Object.assign(new Error('这个位置没有文件 —— 可能已经被移走或删掉了'), { status: 404 });
    }
    if (!st.isFile()) throw badRequest('这个路径不是一个文件');
    // ⚠️ `realpath` 是必需的一步：软链接可以把「已授权目录里的一个入口」指到 `/etc/shadow`
    /** @type {string} */
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch (_e) {
      real = abs;
    }
    const allowed = await this.secretPathAllowed(uid, real, gwUser);
    if (!allowed.ok) {
      throw Object.assign(new Error('这个文件夹还没授权给 ZXDesk —— 选一次就行'), {
        status: 403,
        code: 'PATH_NOT_AUTHORIZED',
      });
    }
    let fd = null;
    try {
      fd = fs.openSync(real, 'r');
      let header;
      try {
        header = blob.readHeaderOnly(fd);
      } catch (e) {
        // ⚠️ 原样回它那句话：**旧版格式**删掉重传就好，**真坏了**要去找备份 —— 两种处置不同
        throw badRequest((e && e.message) || '附件已损坏，请从备份或重新上传恢复');
      }
      if (Number(st.size) !== blob.fileSizeOf(header)) {
        throw badRequest('附件已损坏（文件长度与文件头对不上），请从备份或重新上传恢复');
      }
      if (Number(header.plainSize) > 300 * 1024 * 1024) {
        throw badRequest('这个文件太大，阅读器最大打开 300 MB（可以先下载下来再解开）');
      }
      const meta = header.meta || {};
      return {
        abs: real,
        header,
        size: Number(header.plainSize),
        at: String(meta.at || ''),
        ownerUid: Number(meta.uid) || 0,
        fileId: Number(meta.id) || 0,
        row: this.secretOpenRow(uid, real),
      };
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (_e) {
          /* 已关闭 */
        }
      }
    }
  },

  /**
   * 功能：读该账号自选的附件根（没设过返回 null）。
   * @param {number} uid - 账号 id
   * @returns {?string} 绝对路径
   * @throws {Error} 未解锁（403）
   */
  secretRootSetting(uid) {
    this.vaultAssertUnlocked(uid);
    return this._bk.getSecretRoot(Number(uid));
  },

  /**
   * 功能：附件根**整行信息**（目录 ＋ 授权人 ＋ 授权时间）；没设过返回 null。
   *
   * 说明：⭐ 与 `secretRootSetting()` 分开：那个回的是「路径字符串」（界面与老调用方都按它判断
   *      「设没设过」），这个回的是「谁在什么时候授权的」—— 两件事混在一个返回值里，
   *      下次改其中一个就要动所有调用方。
   * @param {number} uid - 账号 id
   * @returns {?{root: string, root_uid: ?number, root_username: ?string, authorized_at: ?string}} 信息
   * @throws {Error} 未解锁（403）
   */
  secretRootInfo(uid) {
    this.vaultAssertUnlocked(uid);
    return this._bk.getSecretRootInfo(Number(uid));
  },

  /**
   * 功能：设置该账号的附件根目录（**只影响之后的上传**，⛔ 不搬旧文件）。
   *
   * 说明：⭐ 决策 144 ②：几百 MB 的搬迁放在请求里必然超时或半途而废，所以「改根＝只改去向」。
   *      旧附件仍按各自行里的 `root` 读；界面上要说清这一点。
   * @param {number} uid - 账号 id
   * @param {string} root - 已经过 `validateRoot()` 的绝对路径
   * @returns {{root: string}} 落库后的根
   * @throws {Error} 未解锁（403）、数据层只读（503）
   */
  async authorizeRoot(uid, root, gwUser) {
    this._assertWritable();
    this.vaultAssertUnlocked(uid);
    const abs = normPath(root);
    if (!abs) throw badRequest('没有拿到目录路径 —— 请重新选一次');
    const owner = gwUser && Number.isInteger(Number(gwUser.uid)) ? gwUser : null;
    // ⭐⭐ **先作废缓存，再查一次**：用户刚刚在飞牛选择器里点完「用这个目录」，
    //    授权是在那一下发生的，而这份列表有 30 秒内存缓存 —— 不先清掉就会拿「授权之前」
    //    的结果去判「授权之后」的路径，于是同一个动作时对时错（2026-11-08 真机反馈的正是它）。
    trimApi.invalidate(owner ? owner.uid : null);
    const shared = await this.sharedFoldersSafe();
    const user = owner === null ? { paths: [], ok: false } : await this.userFoldersSafe(owner.uid);

    // ⚠️ 两种「查不到」必须分开说：网关不可达时不是「你没授权」，是「我们现在问不到」——
    //    混成一句话会让用户跑去飞牛里反复授权，而那里明明已经配好了。
    if (!shared.ok && !user.ok) {
      throw Object.assign(
        new Error('暂时读不到飞牛的授权信息，请点【刷新】再试一次（网关可能刚重启）'),
        { code: 'TRIM_UNREACHABLE', status: 409 },
      );
    }

    const granted = [...(shared.ok ? shared.paths : []), ...(user.ok ? user.paths : [])];
    if (!isGranted(abs, granted)) {
      throw badRequest(
        '这个目录不在已授权范围内 —— 请到 飞牛 设置 → 应用 → ZXDesk → 访问权限 里授权它（或它的上层目录），回来点【刷新】再选',
      );
    }
    return abs;
  },

  /**
   * 功能：设置附件根 —— 校验授权后落库（**不搬文件**）。
   *
   * 说明：⚠️ 界面走的是 `changeSecretRoot()`（它会先问「要不要迁移」）；
   *      这个方法留给「不需要迁移」的调用方与测试，语义与以前一致。
   * @param {number} uid - 账号 id
   * @param {string} root - 新目录
   * @param {?Object} gwUser - 网关身份
   * @returns {Promise.<{root: string, root_uid: ?number, root_username: string}>} 落库结果
   * @throws {Error} 未解锁（403）、目录未授权（400）、读不到授权信息（409）
   */
  async setSecretRoot(uid, root, gwUser) {
    const abs = await this.authorizeRoot(uid, root, gwUser);
    return this.persistRoot(uid, abs, gwUser);
  },

  /**
   * 功能：把**已校验过**的附件根落库（授权人 / 时间 ＋ 目录里那份说明）。
   *
   * 说明：⚠️ 与 `authorizeRoot()` 分开是为了「先搬文件、后改设置」这个顺序（见 `changeSecretRoot()`）：
   *      迁移中途失败时设置还没改，旧附件仍在旧根、照样打得开；反过来先落库再搬，
   *      一失败就是「设置指向新目录、文件还在旧目录」—— 界面上每条都变成「不在原位置」。
   * @param {number} uid - 账号 id
   * @param {string} abs - 已经 `authorizeRoot()` 校验过的绝对路径
   * @param {?Object} gwUser - 网关身份
   * @returns {{root: string, root_uid: ?number, root_username: string}} 落库结果
   */
  persistRoot(uid, abs, gwUser) {
    const owner = gwUser && Number.isInteger(Number(gwUser.uid)) ? gwUser : null;
    this._bk.setSecretRoot(Number(uid), String(abs), nowStamp(), {
      root_uid: owner ? owner.uid : null,
      root_username: owner ? owner.username || '' : '飞牛应用授权',
      authorized_at: nowStamp(),
    });
    // ⭐ 目录里放一份说明（幂等）：数字命名的 .zxdesk 文件对用户毫无解释力
    this.writeRootTip(abs);
    return {
      root: String(abs),
      root_uid: owner ? owner.uid : null,
      root_username: owner ? owner.username || '' : '飞牛应用授权',
    };
  },

  /**
   * 功能：改附件根 —— 校验授权、按需**搬已有附件**、最后落库。
   *
   * 说明：⭐⭐ 0.9.8加的「迁移」：以前换目录只改去向（老附件留在老目录），
   *      于是备份要备两个目录、用户也说不清「到底存在哪」。现在换目录时问两件事
   *      （要不要迁移 / 要不要删旧的），这里按答案执行：
   *      · `migrate: true` ⇒ 把**旧根下本账号的附件**逐条搬到新根的同一 `rel` 下；
   *      · `deleteOld: true` ⇒ 优先用 `rename`（同盘瞬时、天然就是「搬走」）；
   *        跨盘（`EXDEV`）退化成「复制 → 校验大小 → 删源」；
   *      · `deleteOld: false` ⇒ 只 `copy`，旧目录原样留着（当备份用）。
   *      ⚠️ **顺序是「先搬、后落库」**：搬的过程逐条改每一行的 `root`，失败的行走不到那一步
   *      ⇒ 它们仍然指向旧目录，照旧打得开；一条都没搬成功也不会把设置改掉。
   *      ⚠️ **只碰本账号的 `<uid>/` 子树**：`rel` 先过 `relIsOurs()`（防 `..` 穿越），
   *      清理空目录只 `rmdir`（空才会成功），⛔ 绝不 `rm -rf`，⛔ 不删根级的 `说明.txt`。
   * @param {number} uid - 账号 id
   * @param {string} root - 新目录（未校验）
   * @param {?Object} gwUser - 网关身份
   * @param {{migrate?: boolean, deleteOld?: boolean}} [opts] - 两个问题（缺省都不做）
   * @returns {Promise.<{root: string, root_uid: ?number, root_username: string, move: ?Object}>}
   *      `move` 为 null 表示没迁移（只改去向）
   * @throws {Error} 未解锁（403）、目录未授权（400）、读不到授权信息（409）、写库失败
   */
  async changeSecretRoot(uid, root, gwUser, opts) {
    const src = opts && typeof opts === 'object' ? opts : {};
    const migrate = src.migrate === true;
    const deleteOld = src.deleteOld === true;
    const abs = await this.authorizeRoot(uid, root, gwUser);
    const prev = String(this._bk.getSecretRoot(Number(uid)) || '');
    let move = null;
    // 同一个目录、或第一次设置目录：没有「旧根」可搬，只落库
    if (migrate && prev && normPath(prev) !== abs) {
      move = this.migrateFiles(uid, prev, abs, { deleteOld });
    }
    const saved = this.persistRoot(uid, abs, gwUser);
    return Object.assign({}, saved, { move });
  },

  /**
   * 功能：把**旧根下本账号的附件**搬到新根（`changeSecretRoot()` 的执行体）。
   *
   * 说明：⭐⭐ 为什么逐条搬而不是整目录 `rename`：附件目录里可能还有**别的账号**的
   *      `<uid>/` 子树（同一台 NAS 多人用），整目录搬会把别人的文件也带走。
   *      ⚠️ 每成功一条就**立刻**改这一行的 `root`：中途出错 / 断电时，已经搬过去的那些
   *      仍然打得开（库与磁盘一致），没搬的仍在旧目录（也一致）—— 没有「两边都说有、其实没有」的中间态。
   *      ⚠️ 大小校验只用 `stat`（不重算哈希）：搬运的是我们自己的密文文件，
   *      完整性判据在「读取」那一侧（AAD ＋ 每次解密都验 tag），这里只需要防「复制到一半」。
   * @param {number} uid - 账号 id
   * @param {string} fromRoot - 旧根
   * @param {string} toRoot - 新根
   * @param {{deleteOld?: boolean}} [opts] - 要不要把旧目录里的文件删掉
   * @returns {{moved: number, missing: number, failed: number, foreign: number, bytes: number, purged: boolean}}
   *      `moved` 搬成功条数、`missing` 旧目录里本来就找不到、`failed` 出错条数、
   *      `foreign` 位置上是的**别人的 / 别的条目**的文件（头里的 uid/id 对不上，⛔ 不搬）、
   *      `purged` 旧目录是否已按用户要求清空
   */
  migrateFiles(uid, fromRoot, toRoot, opts) {
    this._assertWritable();
    this.vaultAssertUnlocked(uid);
    const deleteOld = !!(opts && opts.deleteOld);
    const out = { moved: 0, missing: 0, failed: 0, foreign: 0, bytes: 0, purged: false };
    const from = normPath(fromRoot);
    const to = normPath(toRoot);
    if (!from || !to || from === to) return out;

    const rows = this._bk
      .listSecretFiles(Number(uid))
      .filter((r) => normPath(r.root) === from);

    for (const row of rows) {
      // ⚠️ 形状不对的行一律不搬：`rel` 是拼路径的输入，出现 `..` 会搬别人的文件
      if (!relIsOurs(uid, row.id, row.rel)) {
        out.failed += 1;
        continue;
      }
      const srcPath = path.join(from, String(row.rel));
      const dstPath = path.join(to, String(row.rel));
      if (!isReadableFile(srcPath)) {
        // 旧目录里本来就没有这个文件（用户手工删过 / 只恢复了库）—— 不算失败，搬不动就是搬不动
        out.missing += 1;
        continue;
      }
      // ⭐⭐ **搬之前先认人**：读几十字节头，确认「这确实是我这条」。
      //    ⛔ 不能因为「名字叫 <id>.zxdesk」就搬 —— 用户可能改过名、也可能有别的账号的
      //    文件恰好落在这个位置；搬错一个就是「把别人的密文搬进我的目录、还改了自己的指针」。
      try {
        const hfd = fs.openSync(srcPath, 'r');
        try {
          if (!isOurFile(uid, row.id, blob.readHeaderOnly(hfd))) {
            out.foreign += 1;
            continue;
          }
        } finally {
          fs.closeSync(hfd);
        }
      } catch (_e) {
        out.failed += 1;
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        if (deleteOld) {
          try {
            fs.renameSync(srcPath, dstPath);
          } catch (e) {
            // 跨盘（`EXDEV`）时 `rename` 必然失败 ⇒ 退化成「复制 → 校验 → 删源」
            if (!e || e.code !== 'EXDEV') throw e;
            copyFileBlocks(srcPath, dstPath);
            if (fs.statSync(dstPath).size !== fs.statSync(srcPath).size) {
              throw new Error('复制出来的文件大小不一致', { cause: e });
            }
            fs.unlinkSync(srcPath);
          }
        } else {
          copyFileBlocks(srcPath, dstPath);
          if (fs.statSync(dstPath).size !== fs.statSync(srcPath).size) {
            throw new Error('复制出来的文件大小不一致');
          }
        }
        this._bk.updateSecretFileRoot(Number(uid), row.id, to);
        out.moved += 1;
        out.bytes += Number(row.size) || 0;
      } catch (_e) {
        out.failed += 1;
      }
    }

    // ⭐ 只有「一条没落下」才清旧目录：有 missing / failed 时旧目录里还躺着真文件，
    //    这一步就绝不能碰（清掉的可能是最后一次能读到的副本）。
    if (deleteOld && out.failed === 0 && out.missing === 0 && out.foreign === 0) {
      this.purgeOwnDirs(from, uid);
      out.purged = true;
    }
    return out;
  },

  /**
   * 功能：清掉旧根下**本账号**的空目录（`<uid>/<两位分片>/` 与 `<uid>/`）。
   *
   * 说明：⚠️ 只用 `rmdir`（空目录才会成功，非空直接报错被吞掉）—— 这是「删空壳」而不是
   *      「删文件」：万一里面还有没搬走的文件，`rmdir` 自己会拒绝，比任何 `unlink` 都安全。
   *      ⛔ 不碰根级的 `说明.txt`（那是本应用写的说明，留在旧目录里对用户仍有意义）。
   * @param {string} fromRoot - 旧根
   * @param {number} uid - 账号 id
   * @returns {void}
   */
  purgeOwnDirs(fromRoot, uid) {
    const mine = path.join(normPath(fromRoot), String(Number(uid)));
    let shards;
    try {
      shards = fs.readdirSync(mine, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (_e) {
      return;
    }
    for (const name of shards) {
      try {
        fs.rmdirSync(path.join(mine, name));
      } catch (_e) {
        /* 非空 / 没权限：留着，不解释 */
      }
    }
    try {
      fs.rmdirSync(mine);
    } catch (_e) {
      /* 同上 */
    }
  },

  /**
   * 功能：撤销授权 —— 清库里的目录设置（**⛔ 不删任何文件**），再调平台删掉那条授权。
   *
   * 说明：⚠️ 顺序是「先清库、再调平台」：平台调用失败时本地已经不敢再用这个目录了
   *      （那才是安全的方向）；反过来先调平台，一失败就会留下「库里还指着一个已被撤销的目录」。
   *      ⚠️ 必须让用户明白「停止使用」与「删除文件」是两回事 —— 话术在界面上。
   * @param {number} uid - 账号 id
   * @returns {Promise.<{cleared: boolean, remote: string}>} 本地是否清掉、平台那边结果
   * @throws {Error} 未解锁（403）
   */
  async revokeSecretRoot(uid) {
    this._assertWritable();
    this.vaultAssertUnlocked(uid);
    const info = this._bk.getSecretRootInfo(Number(uid));
    const cleared = this._bk.clearSecretRoot(Number(uid));
    if (!info) return { cleared, remote: 'none' };
    if (info.root_uid == null) return { cleared, remote: 'no-owner' };
    try {
      await trimApi.delUserAccessibleFolder(info.root_uid, info.root);
      return { cleared, remote: 'deleted' };
    } catch (e) {
      // ⚠️ 平台那边删不掉（网关不可达 / 已被别人撤掉）不算失败：本地已经不用它了
      return { cleared, remote: 'failed:' + ((e && e.message) || e) };
    }
  },

  /**
   * 功能：飞牛**已经授权给本应用**的目录（共享授权 ＋ 当前飞牛用户的个人授权，去重）。
   *
   * 说明：⭐⭐ 顺序就是优先级：管理员在「应用设置 → 访问权限」里配给本应用的目录排前面
   *      —— 那是最省事的一条路（配一次，谁都能用），用户不必在自己的页面里再选一遍。
   *      ⚠️ 没有网关身份（局域网直连 / 独立客户端）时只有共享授权那一份；
   *      两份都查不到就回空数组，由调用方决定「自动挑」还是「报 409」。
   * ⭐ `fresh === true` 时**先作废缓存**再查：「刷新」按钮与面板打开时的语义就是
   *      「我要看现在的授权状态」，拿 30 秒前的列表回它等于没刷新（用户刚在飞牛里加完目录，
   *      面板却还说没有 —— 那正是「有时候行有时候不行」的第三种表现）。
   * @param {?{uid: number}} gwUser - 网关身份
   * @param {boolean} [fresh] - 是否先作废缓存（默认 false，走 30 秒缓存）
   * @returns {Promise.<{paths: Array.<string>, ok: boolean}>} 目录列表；`ok` = 有没有真的问到
   *      （`false` 表示网关不可达 —— 调用方据此决定是「沿用旧设置」还是「当作授权被撤」）
   */
  async availableRoots(gwUser, fresh) {
    if (fresh) trimApi.invalidate();
    const out = [];
    let ok = false;
    try {
      out.push(...(await trimApi.getSharedAccessibleFolders()));
      ok = true;
    } catch (_e) {
      /* 网关不可达：这一份查不到 */
    }
    const owner = gwUser && Number.isInteger(Number(gwUser.uid)) ? Number(gwUser.uid) : null;
    if (owner !== null) {
      try {
        out.push(...(await trimApi.getUserAccessibleFolders(owner)));
        ok = true;
      } catch (_e) {
        /* 同上 */
      }
    }
    return { paths: [...new Set(out.map((x) => String(x)).filter(Boolean))], ok };
  },

  /**
   * 功能：附件接口的**取值总入口** —— 库里有目录就直接用，没有就自动挑一个飞牛已授权的。
   *
   * 说明：⭐⭐ 这是 2026-11-08 点名简化掉的那一块：「飞牛平台自己就有授权，
   *      别再让用户在我们页面里再选一遍」。规则很短：
   *      ① 库里已有 `root`、且它还在飞牛的授权列表里 ⇒ 直接用；
   *      ② 没有 / 失效 ⇒ 从授权列表里**自动挑一个**（路径带 `zxdesk` 的优先）并落库；
   *      ③ 一个都没有 ⇒ 409，话术是「请前往飞牛 App 或网页端的 ZXDesk 工作台中进行授权目录」
   *        （客户端弹的就是这一句）。
   *      ⚠️ 网关不可达（直连 / 独立客户端）时用库里已有的 `root` 就够：授权是服务端状态，
   *      其它端沿用；内容安全靠主密码。
   * @param {number} uid - 账号 id
   * @param {?{uid: number, username?: string}} [gwUser] - 网关身份（`gatewayUser(req)`）
   * @returns {Promise.<string>} 可用的附件根
   * @throws {Error} 未解锁（403）、一个可用目录都没有（409）
   */
  async assertRootAuthorized(uid, gwUser) {
    this.vaultAssertUnlocked(uid);
    const info = this._bk.getSecretRootInfo(Number(uid));
    const shared = await this.sharedFoldersSafe();
    const owner = gwUser && Number.isInteger(Number(gwUser.uid)) ? Number(gwUser.uid) : null;
    const user = owner === null ? { paths: [], ok: false } : await this.userFoldersSafe(owner);

    /** 功能：一个都没有时的统一说法（直接指到飞牛设置里，不再让用户在我们页面里授权）。 */
    const none = () =>
      Object.assign(
        new Error(
          '请前往飞牛 App 或网页端的 ZXDesk 工作台中进行授权目录（授权后回来点「刷新」）',
        ),
        { code: 'ROOT_NOT_AUTHORIZED', status: 409 },
      );

    if (info) {
      // ⭐ 按**来源**决定怎么验：带 `root_uid` 的来自「用户个人授权」，否则来自「应用共享授权」。
      //    ⚠️ 问不到的那一份不算「被撤」（网关不可达 / 直连 / 独立客户端）⇒ 沿用库里的设置。
      if (info.root_uid == null) {
        if (!shared.ok) return info.root;
        if (isGranted(info.root, shared.paths)) return info.root;
        if (user.ok && isGranted(info.root, user.paths)) return info.root;
        throw none();
      }
      if (!user.ok) return info.root;
      if (isGranted(info.root, user.paths)) return info.root;
      if (shared.ok && isGranted(info.root, shared.paths)) return info.root;
      throw none();
    }

    const all = [...(shared.ok ? shared.paths : []), ...(user.ok ? user.paths : [])];
    if (!all.length) throw none();
    const pick = pickBestRoot(all, this.filesRoot('secrets'));
    this._bk.setSecretRoot(Number(uid), pick, nowStamp(), {
      root_uid: owner,
      root_username: owner !== null && gwUser.username ? String(gwUser.username) : '飞牛应用授权',
      authorized_at: nowStamp(),
    });
    this.writeRootTip(pick);
    return pick;
  },

  /**
   * 功能：查共享授权目录，**失败不抛**（回 `{paths: [], ok: false}`）。
   * @returns {Promise.<{paths: Array.<string>, ok: boolean}>} 列表与「有没有真的问到」
   */
  async sharedFoldersSafe() {
    try {
      return { paths: await trimApi.getSharedAccessibleFolders(), ok: true };
    } catch (_e) {
      return { paths: [], ok: false };
    }
  },

  /**
   * 功能：查某个飞牛用户的个人授权目录，**失败不抛**。
   * @param {number} ownerUid - 飞牛用户 uid
   * @returns {Promise.<{paths: Array.<string>, ok: boolean}>} 列表与「有没有真的问到」
   */
  async userFoldersSafe(ownerUid) {
    try {
      return { paths: await trimApi.getUserAccessibleFolders(Number(ownerUid)), ok: true };
    } catch (_e) {
      return { paths: [], ok: false };
    }
  },

  /**
   * 功能：在附件根里写一份 `说明.txt`（**幂等**：已存在就不动）。
   *
   * 说明：⭐ 目录里只有随机编号的 `.zxdesk`，用户打开文件管理器会一脸问号。
   *      这份说明是**给用户看的**，所以写中文、不写实现细节。
   *      ⚠️ 写不进去（只读目录 / 没权限）只忽略：它不该挡住「设置目录」这件事。
   * @param {string} root - 附件根（绝对路径）
   * @returns {boolean} 写成功（或已存在）为 true
   */
  writeRootTip(root) {
    const file = path.join(String(root), '说明.txt');
    const text = [
      '这是 ZXDesk「加密信息」的附件目录。',
      '',
      '1. 每个 .zxdesk 文件都是一条附件的密文；文件名只是内部编号，不含原文件名。',
      '2. 请不要删除这里的文件。改名或挪位置也能认回来（软件看的是文件内容里的标记，不是文件名），',
      '   但没必要动它 —— 认回来总要走一遍核对。',
      '3. 备份时请把整个目录一起复制；恢复时需要你自己的主密码。',
      '4. 要换位置：到 ZXDesk 的「加密信息 → 附件位置」里重新选择。',
      '   会问你要不要把已有附件一起搬过去；不搬的话，改的只是以后上传的位置。',
      '',
    ].join('\n');
    try {
      if (fs.existsSync(file)) return true;
      fs.writeFileSync(file, text, 'utf8');
      return true;
    } catch (_e) {
      return false;
    }
  },

  /**
   * 功能：**重新关联** —— 用户把附件目录挪走（换盘 / 整理 / 改挂载点）之后，拿新目录把旧附件认回来
   *      （0.9.8）。只改 `secrets_files.root`，`rel` 与文件本体一个字不动。
   *
   * 说明：⭐⭐ **凭什么认**（三条，缺一就会认错）：
   *      ① `rel` 是**确定性**的（`<uid>/<两位分片>/<id>.zxdesk`）—— 同一行在哪个根下都长这样；
   *      ② 候选文件读 **头（24 字节 ＋ 元信息）**：`magic === 'ZXDS'` 且 `ver === 2`、
   *        `plainSize === 行里的 size`、文件长度 === `24 + metaLen + totalFrames × 32 + size`；
   *      ③ 三条全过才关联。只认路径不认内容 ⇒ 会关联到同名残留；只认内容不认路径 ⇒ 要在全盘找（不可接受）。
   *      ⚠️⚠️ **不解密、不需要 DEK**：头与 `size` 都是明文元数据（`size` 本来就要给 Range 用）。
   *      这条很重要 —— 「认文件」不该要求主密码已经解出来，否则「锁着的时候没法整理目录」。
   *      ⚠️ **只挑失效行**：`path.join(row.root, row.rel)` 现在 `stat` 得到的行**一律不动** ——
   *      两份都在时保留能用的那份，⛔ 不静默改指向（用户可能只是复制了一份备份）。
   *      ⚠️ **只 stat ＋ 读 24 B**：不递归全盘、不按文件名匹配、不搬文件（`rename` / `copy` 一个都没有）。
   *      ⚠️ 选到**上一层目录**时（用户把整包目录选成它的父目录），只看 `root` 的**直接子目录**
   *      （≤50 个、按名字排序）里有没有 `<sub>/<uid>/` 这个形状；命中就用 `<sub>`，并**把设置也改成它** ——
   *      用户少走一次「再选一次」。
   *      ⚠️ 失败方向：单行读盘出错只算 `damaged` / `missing`，**不抛**；但**写库失败会抛**，
   *      此时已经改过的行保留（那些都是「确实更对了」的改动，回滚反而更糟），由调用方如实回 500。
   *
   * @param {number} uid - 账号 id
   * @param {string} root - 候选根（调用方应已过 `validateRoot()`）
   * @returns {{found: number, relinked: number, damaged: number, missing: number, actualRoot: ?string}}
   *      `found` = 核对通过、认回来的候选；`relinked` = 真的写进库的行数；
   *      `damaged` = 文件在、但对不上（⛔ 不改）；`missing` = 连文件都没有 / `rel` 认不出；
   *      `actualRoot` = 命中在子目录时那个实际目录（否则 null）
   * @throws {Error} 未解锁（403）、数据层只读（503）、写库失败（500）
   */
  relinkFiles(uid, root) {
    this._assertWritable();
    this.vaultAssertUnlocked(uid);
    const u = Number(uid);
    const dir = String(root || '');
    const info = this._bk.getSecretRootInfo(u);
    /** @type {{found: number, relinked: number, damaged: number, missing: number, actualRoot: ?string}} */
    const out = { found: 0, relinked: 0, damaged: 0, missing: 0, actualRoot: null };

    // ---- ① 先挑「现在不完整」的行：还能用的一个都不许动 ----
    //    ⚠️ 「不完整」包括「位置上有文件但头不是它」—— 只看文件存不存在会让那种行永远修不回来
    const stale = [];
    for (const row of this._bk.listSecretFiles(u)) {
      if (this.secretRowIntact(u, row)) continue;
      stale.push(row);
    }
    if (!stale.length) return out; // 用户只是换了个新目录、旧附件都还在 ⇒ 全 0、一行不改

    // ⭐⭐ `rel` 形状**不再是门槛**：它只决定「先去哪儿找」，身份由文件头判（见 `isOurFile()`）。
    //    以前形状不合的行直接算「认不回来」—— 那正是「靠文件名辨认」的老做法：
    //    用户把 `12.zxdesk` 改成 `12.bak`、或恢复工具改了名，明明文件就在那儿，却一律认不回来。
    const testable = stale;

    /** 每个目录的「按头索引」只建一次（扫两次子目录时不重复读盘） @type {Map.<string, Map>} */
    const idxCache = new Map();
    /**
     * 功能：取某个目录的按头索引（懒建、按目录缓存）。
     * @param {string} at - 目录
     * @returns {Map.<number, {rel: string, abs: string}>} id → 真实位置
     */
    const indexAt = (at) => {
      const key = String(at);
      if (!idxCache.has(key)) idxCache.set(key, indexByHeader(at, u));
      return idxCache.get(key);
    };

    /**
     * 功能：在某个目录下把候选行挨个核对一遍。
     *
     * 说明：⭐ 两段：**先按标准位置找**（绝大多数命中，只读几十字节头），
     *      找不到再**按头在索引里找**（文件被改名 / `rel` 被改过时唯一的路）。
     *      后一段认出来之后会把库里的 `rel` 改成真实路径 —— 否则下次还是找不到它。
     * @param {string} at - 目录
     * @returns {{ok: Array.<{row: Object, rel: string}>, bad: Array.<Object>, gone: number}}
     *      命中（行 ＋ 真实 rel）、在但不对、彻底没有
     */
    const scanAt = (at) => {
      const ok = [];
      const bad = [];
      let gone = 0;
      const idx = indexAt(at);
      for (const row of testable) {
        // 快路径：`rel` 形状合规时先看那个位置
        if (relIsOurs(u, row.id, row.rel)) {
          const v = probeCandidate(at, u, row);
          if (v === 'ok') {
            ok.push({ row, rel: String(row.rel) });
            continue;
          }
          if (v === 'damaged') {
            bad.push(row);
            continue;
          }
        }
        // 慢路径：按头找（⛔ 不看文件名）
        const hit = idx.get(Number(row.id));
        if (!hit) {
          // 位置上是别人的文件（`foreign`）与「压根没有」都算「这条不在这儿」——
          // 对用户来说都是「缺失」，而「在但不对」只留给**本应用但坏了**的那一种。
          gone += 1;
          continue;
        }
        const v2 = probeCandidateAt(at, u, row, hit.rel);
        if (v2 === 'ok') ok.push({ row, rel: hit.rel });
        else bad.push(row);
      }
      return { ok, bad, gone };
    };

    // ---- ② 先按「选中的那个目录」找 ----
    let target = dir;
    let hit = scanAt(dir);

    // ---- ③ 一条都没命中 ⇒ 向下看一层（用户多半是选到了上层目录）----
    if (!hit.ok.length) {
      let best = null;
      for (const sub of directSubdirs(dir, 50)) {
        // 形状判据：`<sub>/<uid>/` 得是个目录 —— 不合形状的直接跳过，不进去翻
        if (!isDirectory(path.join(sub, String(u)))) continue;
        const r = scanAt(sub);
        if (r.ok.length && (!best || r.ok.length > best.ok.length)) best = { sub, ok: r.ok, bad: r.bad, gone: r.gone };
      }
      if (best) {
        target = best.sub;
        hit = { ok: best.ok, bad: best.bad, gone: best.gone };
        out.actualRoot = best.sub;
      }
    }

    out.found = hit.ok.length;
    out.damaged = hit.bad.length;
    out.missing = hit.gone;

    // ---- ④ 认回来的行：改 root；**文件名对不上时连 rel 一起改**（那是它现在的真实位置）----
    for (const it of hit.ok) {
      const row = it.row;
      // ⚠️ 顺序：先改 rel（指向真实文件），再改 root（指向真实目录）——
      //    反过来会有一瞬间「新的 root ＋ 旧的 rel」，指针指向一个不存在的文件。
      if (String(row.rel) !== String(it.rel)) this.setSecretFileRel(u, row.id, it.rel, row.sha256);
      if (this._bk.updateSecretFileRoot(u, row.id, target)) out.relinked += 1;
    }
    // ---- ⑤ 命中在子目录 ⇒ 顺手把设置也改过去（⛔ 只在「确实更对了」时改）----
    if (out.actualRoot) {
      /** @type {?string} 校验通过的实际目录（`null` = 不能当设置用） */
      let safe = null;
      try {
        safe = this.validateRoot(out.actualRoot);
      } catch (_e) {
        // ⚠️ 子目录不可写（只读挂载 / 权限不对）⇒ **不改设置**：改了会让之后的上传全部失败。
        //    但行照旧指向它 —— 读不需要写权限，用户至少能把旧附件下载出来。
      }
      if (safe) {
        // ⚠️ 这里**不走** `setSecretRoot()`：它不是「用户新授权一个目录」，而是「同一批目录
        //    换个层次」—— 重新查授权列表会把一次本该秒回的操作变成一次网关往返，
        //    而且用户此刻并没有做授权动作。只把路径改成实际子目录，授权人那两个字段原样保留。
        this._bk.setSecretRoot(u, safe, nowStamp(), {
          root_uid: info && info.root_uid != null ? info.root_uid : null,
          root_username: info && info.root_username != null ? info.root_username : null,
          authorized_at: info && info.authorized_at != null ? info.authorized_at : null,
        });
        out.actualRoot = safe;
      }
    }
    return out;
  },
};
