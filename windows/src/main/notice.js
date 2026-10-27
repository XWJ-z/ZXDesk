/**
 * 公告：拉取 `/api/notices/<platform>`、校验、本地缓存、已读记录。
 *
 * 与「版本更新」的区别：公告是纯文本内容，一条坏数据不该让整屏消失 ⇒
 * 逐条校验，坏条目跳过并记日志（更新清单则相反：任何一项不合格都整份拒收）。
 *
 * 已读不落在这里：由调用方（controller）读写偏好，本模块只负责算「还有几条没读」。
 * 这样「已读」跟着用户走，缓存文件被删也不会把老公告再弹一遍。
 */

import fs from 'node:fs';
import path from 'node:path';

import { checkUpdateUrl } from './update/urls.js';

/** 线上公告接口（Windows 专属；四端各有自己的地址）。 */
export const DEFAULT_NOTICE_URL = 'https://api.zxdesk.xwjznh.cn/api/notices/windows';

/** 单次最多收多少条：服务端已限 20，这里再兜一层，防异常响应把弹窗撑爆。 */
const MAX_ITEMS = 20;

/** 单条正文上限：公告是短消息，超长一定是数据写错了。 */
const MAX_CONTENT = 20_000;

/**
 * 顶置公告（菜单栏公告条）的文案上限。
 * 公告条宽度受菜单栏限制（客户端 420px ≈ 30 字），文案再长也只能显示开头，
 * ⇒ 服务端就该写短句；这里截断是兜底，⛔ 不是鼓励写长句。
 */
const MAX_MARQUEE = 200;

/**
 * 校验并规整公告响应。
 * @param {unknown} payload
 * @returns {{ok:true, items:object[], updated:string, skipped:number}|{ok:false, kind:'invalid', message:string}}
 */
export function parseNotices(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, kind: 'invalid', message: '响应不是对象' };
  }
  if (payload.ok !== true) {
    return { ok: false, kind: 'invalid', message: `接口返回失败：${payload.message || '未说明原因'}` };
  }
  if (!Array.isArray(payload.data)) {
    return { ok: false, kind: 'invalid', message: '响应缺 data 数组' };
  }

  const items = [];
  let skipped = 0;
  for (const row of payload.data.slice(0, MAX_ITEMS)) {
    const item = normalizeItem(row);
    if (item) items.push(item);
    else skipped += 1;
  }
  return {
    ok: true,
    items,
    updated: String(payload.updated || ''),
    // 顶置公告：独立字段（DSH 的 marquee 同义），不是 items[0]
    marquee: normalizeMarquee(payload.marquee),
    // 字段在不在，决定「降级」还是「没配」：旧服务端没有这个字段，新服务端没配就是空串
    hasMarquee: Object.prototype.hasOwnProperty.call(payload, 'marquee'),
    skipped,
  };
}

/** 单条公告的字段收敛；缺 id 或标题的直接丢掉（客户端要靠 id 记已读）。 */
function normalizeItem(row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id ?? '').trim().slice(0, 64);
  const title = String(row.title ?? '').trim().slice(0, 128);
  if (!id || !title) return null;
  return {
    id,
    title,
    content: String(row.content ?? '').slice(0, MAX_CONTENT),
    level: row.level === 'important' ? 'important' : 'info',
    pinned: row.pinned === true,
    publishedAt: row.publishedAt ? String(row.publishedAt) : '',
  };
}

/**
 * 顶置公告文案归一：换行折成空格（公告条是一行）、去首尾空白、截断。
 * 空串 = 服务端没配（或已撤下）⇒ 客户端不显示公告条。
 */
export function normalizeMarquee(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MARQUEE);
}

/**
 * 拉一次公告。
 * 404 与「空数组」同义：这个端还没有公告，不是错误。
 */
export async function fetchNotices({ url, fetchImpl, timeoutMs = 8000 }) {
  if (typeof fetchImpl !== 'function') return { ok: false, kind: 'network', message: '没有可用的网络实现' };
  const checked = checkUpdateUrl(url);
  if (!checked.ok) return { ok: false, kind: 'insecure', message: checked.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(checked.url.href, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response || typeof response.status !== 'number') {
      return { ok: false, kind: 'network', message: '网络实现没有返回响应' };
    }
    if (response.status === 404) {
      return { ok: true, items: [], updated: '', marquee: '', hasMarquee: true, skipped: 0 };
    }
    if (!response.ok) return { ok: false, kind: 'http', status: response.status, message: `HTTP ${response.status}` };

    let payload;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, kind: 'invalid', message: '响应不是合法 JSON' };
    }
    return parseNotices(payload);
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''));
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'network',
      message: aborted ? `请求超时（${timeoutMs} 毫秒）` : error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export class NoticeService {
  /**
   * @param {object} input
   * @param {string} input.apiUrl
   * @param {Function} input.fetchImpl
   * @param {string} input.file - 缓存文件（`data/notices-cache.json`）
   * @param {string[]} [input.readIds] - 已读的公告 id
   * @param {(level:'info'|'warn', message:string)=>void} [input.log]
   * @param {()=>void} [input.onState]
   * @param {number} [input.timeoutMs]
   */
  constructor(input) {
    this.apiUrl = String(input.apiUrl || '');
    this.fetchImpl = input.fetchImpl;
    this.file = input.file;
    this.readIds = new Set((input.readIds || []).map(String));
    this.log = input.log || (() => {});
    this.onState = input.onState || (() => {});
    this.timeoutMs = Number(input.timeoutMs || 8000);

    this.pending = null;
    this.items = [];
    /** 顶置公告文案（菜单栏公告条）。空串 = 不显示公告条。 */
    this.marquee = '';
    /** 文案来源：pinned（顶置公告）/ latest（旧服务端降级）/ none。 */
    this.marqueeSource = 'none';
    this.state = {
      phase: 'idle',
      items: [],
      total: 0,
      unread: 0,
      updated: '',
      marquee: '',
      error: null,
      checkedAt: null,
    };
  }

  snapshot() {
    const base = JSON.parse(JSON.stringify(this.state));
    // 界面要逐条标「未读」，所以把 id 一并给出（只给 id，不给已读时间等无关信息）
    base.unreadIds = this.items.filter((item) => !this.readIds.has(item.id)).map((item) => item.id);
    return base;
  }

  emit() {
    try {
      this.onState(this.snapshot());
    } catch (error) {
      this.log('warn', `公告状态推送失败：${error.message}`);
    }
  }

  /**
   * 读本地缓存（同步，启动时先让菜单有内容，等网络回来再刷新）。
   * 缓存也要过一遍字段收敛：文件在本机，可能被改坏。
   */
  loadCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw?.items) ? raw.items : [];
      this.items = list.map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS);
      this.marquee = normalizeMarquee(raw?.marquee);
      this.marqueeSource = this.marquee ? 'pinned' : 'none';
      this.applyItems(String(raw?.updated || ''));
      return this.items.length;
    } catch {
      return 0;
    }
  }

  /** 拉取并更新状态；失败时保留已有内容（公告条/菜单标记不闪没）。 */
  async check({ silent = false } = {}) {
    if (this.pending) return this.pending;
    const previous = this.state.phase;
    this.state = { ...this.state, phase: 'loading', error: null };
    this.emit();
    this.pending = this.doCheck(silent, previous).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async doCheck(silent, previous) {
    const result = await fetchNotices({ url: this.apiUrl, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });
    if (!result.ok) {
      this.log('warn', `公告拉取失败（${result.kind}）：${result.message}`);
      const keep = silent && previous !== 'idle' && previous !== 'loading';
      this.state = {
        ...this.state,
        phase: keep ? previous : 'error',
        error: { kind: result.kind, message: result.message },
        checkedAt: Date.now(),
      };
      this.emit();
      return this.snapshot();
    }
    if (result.skipped > 0) this.log('warn', `公告里有 ${result.skipped} 条字段不合格，已跳过`);
    this.items = result.items;
    // 公告条文案：优先顶置公告；旧服务端（响应里没有 marquee 字段）用最新一条公告标题顶上，
    // 否则升级客户端后公告条会一直空着，看起来像坏了。新服务端但没配 ⇒ 空（不显示公告条）。
    this.marquee = result.marquee;
    this.marqueeSource = result.marquee ? 'pinned' : result.hasMarquee ? 'none' : 'latest';
    if (this.marqueeSource === 'latest') this.marquee = this.items[0]?.title || '';
    this.writeCache();
    this.applyItems(result.updated);
    this.log(
      'info',
      `公告已更新：${result.items.length} 条（未读 ${this.state.unread}）｜公告条：${
        this.marqueeSource === 'pinned' ? '顶置公告' : this.marqueeSource === 'latest' ? '服务端还没下发顶置公告，暂用最新公告标题' : '未配置'
      }`,
    );
    return this.snapshot();
  }

  applyItems(updated) {
    this.state = {
      ...this.state,
      phase: 'ready',
      items: this.items,
      total: this.items.length,
      unread: this.countUnread(),
      updated: updated || this.state.updated,
      marquee: this.marquee,
      marqueeSource: this.marqueeSource || 'none',
      error: null,
      checkedAt: Date.now(),
    };
    this.emit();
  }

  countUnread() {
    return this.items.filter((item) => !this.readIds.has(item.id)).length;
  }

  /** 换一批已读 id（启动时从偏好载入）。 */
  setReadIds(ids) {
    this.readIds = new Set((Array.isArray(ids) ? ids : []).map(String));
    this.state = { ...this.state, unread: this.countUnread() };
    this.emit();
  }

  /** 全部标记已读，返回要持久化的 id 列表（只留最近 100 条）。 */
  markAllRead() {
    for (const item of this.items) this.readIds.add(item.id);
    const ids = [...this.readIds].slice(-100);
    this.readIds = new Set(ids);
    this.state = { ...this.state, unread: 0 };
    this.emit();
    return ids;
  }

  writeCache() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ version: 1, updated: this.state.updated, marquee: this.marquee, items: this.items }, null, 2),
        'utf8',
      );
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.log('warn', `公告缓存写入失败：${error.message}`);
    }
  }
}
