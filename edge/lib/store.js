/**
 * 功能：`chrome.storage.local` 的**唯一**读写口（分层纪律 2：其它模块只传值，⛔ 自己碰 storage）。
 *
 * 数据模型（方案 §五）：
 * - `edge:conn`  连接信息 —— ⛔ 只存地址与缓存，**不存任何凭据**（Cookie 每次用前现读）；
 * - `edge:cache` 侧边栏首屏缓存（TTL 60 s，M3 接入）；
 * - `edge:update` 版本检测结果（启动时写一次，气泡与角标都从这里读）；
 * - `pref:eula` 许可协议接受记录（`{version, at}`；未同意前不发起版本检测）。
 * 迁移位：`v` —— 读到不认识的 `v` ⇒ 当没连过（清空重来），⛔ 不猜。
 */

const KEY_CONN = 'edge:conn';
const KEY_CACHE = 'edge:cache';

async function readKey(key) {
  const bag = await chrome.storage.local.get(key);
  const v = bag[key];
  if (!v || typeof v !== 'object' || v.v !== 1) return null; // 没存过 / 不认识的版本 ⇒ 没连过
  return v;
}

/** @returns {Promise<?object>} 连接信息（origin/base/input/mode/link/hostPermGranted/lastVerified/isValid） */
export async function getConn() {
  return readKey(KEY_CONN);
}

/**
 * 功能：写连接信息。`patch` 与现有记录合并（缺省沿用），`v:1` 迁移位永远由这里盖。
 * @param {object} patch - 要写的字段
 */
export async function setConn(patch) {
  const cur = (await getConn()) || { v: 1 };
  const next = { ...cur, ...patch, v: 1 };
  await chrome.storage.local.set({ [KEY_CONN]: next });
  return next;
}

/** 功能：断开连接 —— 删连接信息与缓存；⛔ 不碰浏览器 Cookie。 */
export async function clearConn() {
  await chrome.storage.local.remove([KEY_CONN, KEY_CACHE]);
}

/** 侧边栏首屏缓存（M3 接入；TTL 判定也在这里做，调用方只管取） */
export async function getCache(maxAgeMs = 60_000) {
  const c = await readKey(KEY_CACHE);
  if (!c) return null;
  if (!c.at || Date.now() - c.at > maxAgeMs) return null; // 过期就当没有，⛔ 不拿旧的当实时
  return c;
}

/** @param {{items: Array, tags: Array}} data */
export async function setCache(data) {
  await chrome.storage.local.set({ [KEY_CACHE]: { v: 1, at: Date.now(), ...data } });
}

export async function clearCache() {
  await chrome.storage.local.remove(KEY_CACHE);
}

// ---- 0.1.4：授权一次过----

const KEY_LAST = 'edge:last-conn';

/** @returns {Promise<?object>} 最近一次 SW 自动续跑的连接结果 {status, at}（v:1 迁移位同上） */
export async function getLastConn() {
  return readKey(KEY_LAST);
}

export async function setLastConn(data) {
  await chrome.storage.local.set({ [KEY_LAST]: { v: 1, at: Date.now(), ...data } });
}

/**
 * 连接意图：`storage.session`（浏览器活着就在，授权与否都不丢——任务单硬规则 2）。
 * 写入方是设置页（在授权手势里，⛔ 绕道消息会丢手势）；这里只管 SW 侧「取走即清」。
 */
export async function setPending(pc) {
  await chrome.storage.session.set({ pendingConnect: pc });
}

export async function clearPending() {
  await chrome.storage.session.remove('pendingConnect');
}

/** 功能：SW `permissions.onAdded` 里取走连接意图（原子：取出即删，防双跑）。 */
export async function takePending() {
  const bag = await chrome.storage.session.get('pendingConnect');
  const pc = bag.pendingConnect || null;
  if (pc) await chrome.storage.session.remove('pendingConnect');
  return pc;
}

// ---- 0.1.6：版本检测结果 ----

const KEY_UPDATE = 'edge:update';

/** @returns {Promise<?object>} 最近一次检测结果 {current, latest, url, dismissed}（v:1 迁移位同上） */
export async function getUpdate() {
  return readKey(KEY_UPDATE);
}

/**
 * 功能：写检测结果。与现有记录合并 —— `dismissed` 不能被新一轮检测抹掉，
 * 否则每次启动都会把用户关过的提示重新弹出来。
 * @param {object} patch
 */
export async function setUpdate(patch) {
  const cur = (await getUpdate()) || { v: 1 };
  const next = { ...cur, ...patch, v: 1, at: Date.now() };
  await chrome.storage.local.set({ [KEY_UPDATE]: next });
  return next;
}

// ---- 0.1.6：许可协议接受记录 ----

/**
 * 偏好键（`pref:` 前缀与主题、打开方式同一套；不走 `v:1` 迁移位）。
 * ⚠️ 放这里而不是 UI 直读，是因为 **SW 也要读它** —— 未同意协议就不许发起版本检测。
 */
const KEY_EULA = 'pref:eula';

/** @returns {Promise<?object>} `{version, at}`；没接受过返回 null */
export async function getEula() {
  const bag = await chrome.storage.local.get(KEY_EULA);
  const rec = bag[KEY_EULA];
  return rec && typeof rec === 'object' ? rec : null;
}

/** @param {{version:string}} rec - 只记版本与时间，⛔ 不记任何身份信息 */
export async function setEula(rec) {
  await chrome.storage.local.set({ [KEY_EULA]: { ...rec, at: Date.now() } });
}
