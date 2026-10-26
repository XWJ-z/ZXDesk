/**
 * modules/trip/track.js —— 轨迹屏与打卡表单的**共用片段**（0.8.6 ·  / §7.6）
 *
 * 功能：把「轨迹屏该长什么样」与「打卡表单有哪些字段」写成**纯片段函数**，两端各自包进自己的容器。
 *
 * ⭐⭐ **为什么共用 HTML 片段**：两端版式各写各的指的是
 *      **骨架与排版**；而「这张图怎么画、统计条写哪几个数字、打卡表单有哪几个字段」
 *      是**判据**。两份判据的下场很具体：一端画了 `<polyline fill="none">`、另一端漏了 ——
 *      漏的那端**照样渲染**，只是一块乱涂的色块，而**所有用例都绿**。
 *      ⇒ 本文件不碰 DOM（只回字符串），⛔ 不 import `shared.js` 之外的任何东西。
 *
 * ⚠️ **动作名由调用方给**（`mk` 参数）：两端的事件机制不同（电脑端 `data-trip` ＋ 委托、
 *    手机端 `data-act` ＋ 宿主 `ACTIONS` 表）⇒ 本文件只写动词（`checkin` / `rec-start` / …），
 *    属性串由两端自己拼。**这正好让「漏登记一个动作」在原地暴露**（手机端有护栏扫 `data-act`）。
 *
 * ⚠️⭐ **按钮类名也由调用方给**（`cls` 参数）：两端的按钮体系**不同** —— 电脑端是
 *    `btn btn-primary`（主）/ `btn btn-subtle btn-sm`（次），手机端是 `btn primary` / `btn ghost sm`。
 *    ⛔ 别在这里写死 `btn` 或 `btn-ghost`：电脑端的 `.btn` **单独用没有底色**、`.btn-ghost` 更是
 *    **30×30 的方形图标键**（当文字按钮用会让文字逐字换行、溢出那个盒子盖住下面几行），
 *    而手机端**根本没有 `.btn-ghost` 这个类**（会落回浏览器原生按钮）。
 *    2026-09-29 「电脑端排版混乱」与「手机端按键样式不对」两件事，根子都在这里。
 *
 * ⭐ 0.8.33（「行程：暂时前端移除【打卡】…全面隐藏」）：
 *    · `trackBodyHtml()` **只画轨迹点** —— 喂给 `tripTrackSvg()` 的已经是 `tripTrackOnly()`
 *      那一份（「打卡点不是走过的路」，本来就不进里程）⇒ 图上不再有打卡点标记；
 *    · 统计条里的「N 个打卡点」一起去掉，空态那颗「📍 打个卡」也不画
 *      ⇒ 这个函数**不再需要 `mk` / `cls`**（两个参数已从签名里去掉）；
 *    · `trackMarksHtml()`（打卡点列表）与 `checkinFieldsHtml()`（打卡表单）**代码留着不删**，
 *      只是没有任何入口会调用它们。
 *
 * @author zx
 * @date   2026-09-28
 * @since 0.8.33
 * 相关：docs/公共/架构文档/24-行程.md、docs/公共/开发方案/25-行程-1期.md
 */

import { esc } from '../../core/dom.js';
import { tripDistanceText, tripDurationText, tripStampText, tripTrackOnly, tripTrackStats, tripTrackSvg } from './trip-shared.js';

/** 轨迹图的画布尺寸（**用户单位** = `viewBox`；实际显示多大由 CSS 决定） */
export const TRACK_W = 640;
export const TRACK_H = 360;

/**
 * 功能：⭐ 画轨迹图 ＋ 统计条 ＋ 那句必须有的「这不是地图」。
 *
 * 说明：⚠️ 没有轨迹点时回**空态**（一句人话），⛔ **不画一张空画布**（方案 §5.5）。
 *      ⚠️⭐ **只画轨迹点**（`tripTrackOnly()` —— 与里程同一个口径）：打卡点不是走过的路，
 *      既不该出现在图上，也不该出现在统计条里（⭐ 0.8.33）。
 *
 * @param {Array.<Object>} points - 全部点（可含打卡点，本函数自己滤掉）
 * @returns {string} HTML
 */
export function trackBodyHtml(points) {
  const list = Array.isArray(points) ? points : [];
  const svg = tripTrackSvg(tripTrackOnly(list), { w: TRACK_W, h: TRACK_H });
  if (!svg) return '<p class="trip-empty">这一段还没有轨迹点。</p>';
  const st = tripTrackStats(list);
  const bits = [
    `里程 ${tripDistanceText(st.distance_m)}`,
    `时长 ${tripDurationText(st.duration_ms)}`,
    `${st.count} 个轨迹点`,
  ];
  return `<div class="trip-canvas">${svg}</div>
    <p class="trip-stats">${bits.join(' ｜ ')}</p>
    <p class="trip-hint"><b>这不是地图</b> —— 坐标只存在本机，不出网。</p>`;
}

/**
 * 功能：画打卡点列表（每个点可改名 / 删除）—— ⭐ 只列 `kind = 'checkin'` 的那些。
 *
 * @param {Array.<Object>} points - 全部点
 * @param {function(string, ?number): string} mk - 动作名 → 属性串
 * @param {{p: string, s: string}} cls - 两端各自的按钮类名
 * @returns {string} HTML（没有打卡点时回空串）
 */
export function trackMarksHtml(points, mk, cls) {
  const marks = (Array.isArray(points) ? points : [])
    .filter((p) => p.kind === 'checkin')
    .slice()
    .sort((a, b) => Number(a.at) - Number(b.at));
  if (!marks.length) return '';
  return `<h4 class="trip-sub">打卡点</h4>
    <ul class="trip-checkins">${marks
      .map((p) => {
        const acc = p.accuracy === null || p.accuracy === undefined ? '' : ` · 精度 ±${Math.round(p.accuracy)} m`;
        const note = p.note ? `<div class="trip-ci-note">${esc(p.note)}</div>` : '';
        return `<li class="trip-checkin">
            <div class="trip-ci-main">
              <div class="trip-ci-name">${esc(p.label || '未命名')}</div>
              <div class="trip-ci-sub">${esc(tripStampText(p.at))}${acc}</div>
              ${note}
            </div>
            <div class="trip-ci-acts">
              <button class="${cls.s}" type="button" ${mk('rename-point', p.id)}>改名</button>
              <button class="${cls.s}" type="button" ${mk('del-point', p.id)}>删除</button>
            </div>
          </li>`;
      })
      .join('')}</ul>`;
}

/**
 * 功能：⭐ 画记录面板（记录中 / 有积压 / 出错了才有内容）。
 *
 * 说明：⭐ 方案 §7.6-5 点名的失败路径：批量发失败 ⇒ 本地继续攒 ⇒ **页面上挂一条
 *      「有 N 个点还没传上去」＋ 一颗「重试」**。⛔ 不许静默 —— 那等于这一趟白走。
 *      ⚠️ 这句话**也解释了离线可用**：路上没网，回来点一下「重试」就补上了。
 *
 * @param {Object} rec - `recorderInfo()` 的快照
 * @param {function(string, ?number): string} mk - 动作名 → 属性串
 * @param {{p: string, s: string}} cls - 两端各自的按钮类名
 * @returns {string} HTML（没什么可说的时回空串）
 */
export function trackRecHtml(rec, mk, cls) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const queued = Number(r.queued) || 0;
  if (!r.recording && !queued && !r.error) return '';
  const live = r.recording
    ? `<div class="trip-rec-live">● 正在记录 · ${Number(r.sent) + queued} 个点 · ${tripDistanceText(
        tripTrackStats(r.pending || []).distance_m,
      )}</div>`
    : '';
  const backlog = queued
    ? `<div class="trip-rec-warn">有 ${queued} 个点还没传上去${r.error ? `（${esc(r.error)}）` : ''}。
        <button class="${cls.s}" type="button" ${mk('rec-retry')}>重试</button></div>`
    : '';
  const acts = r.recording
    ? `<button class="${cls.p}" type="button" ${mk('rec-stop')}>结束记录</button>`
    : '';
  return `<div class="trip-rec">${live}${backlog}${acts}</div>`;
}

/**
 * 功能：⭐ 画打卡表单的**字段区**（不含外层容器与保存按钮——那两处两端不同）。
 *
 * 说明：⭐⭐ 定位只有两条路（方案 §三）：**网页 Geolocation** 与**手动填经纬度**。
 *      ⇒ `用当前位置` 拿不到时**自动切到手动填**（`mode`），并把原因如实写在旁边
 *      （`geoFailText()` 的三句人话）—— ⛔ 不许只说一句「定位失败」让用户去猜。
 *      ⚠️ 字段顺序：名字 → 坐标 → 归属行程；那句隐私说明**必须在场**（方案 §10.2 第 3 条）。
 *
 * @param {Object} f - 表单缓存：`{ label, lat, lng, accuracy, mode, trip_id }`
 * @param {Array.<Object>} trips - 行程列表（归属下拉用）
 * @param {string} field - 表单字段的 class（电脑端 `tt-field`、手机端 `fld`）
 * @param {function(string, ?number): string} mk - 动作名 → 属性串
 * @param {Object} ci - `{ locating: boolean, error: string }`
 * @param {{p: string, s: string}} cls - 两端各自的按钮类名
 * @returns {string} HTML
 */
export function checkinFieldsHtml(f, trips, field, mk, ci, cls) {
  const s = f && typeof f === 'object' ? f : {};
  const c = ci && typeof ci === 'object' ? ci : {};
  const manual = s.mode === 'manual' || !!c.error;
  const num = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
  const tripsOpt = (Array.isArray(trips) ? trips : [])
    .map(
      (t) =>
        `<option value="${t.id}"${Number(s.trip_id) === t.id ? ' selected' : ''}>${esc(t.title)}</option>`,
    )
    .join('');
  const hasPos = Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng));
  const posLine = hasPos
    ? `<div class="trip-ci-pos">${Number(s.lat).toFixed(4)}, ${Number(s.lng).toFixed(4)}${
        s.accuracy === null || s.accuracy === undefined ? '' : ` · 精度 ±${Math.round(s.accuracy)} m`
      }</div>`
    : '';
  return `
    <label class="${field}"><span>到了哪儿</span>
      <input id="ci-label" type="text" maxlength="60" placeholder="到了哪儿？如：杭州东站" value="${esc(s.label || '')}" />
    </label>
    <div class="trip-ci-pick">
      <button class="${cls.p}" type="button" ${mk('ci-gps')}>${c.locating ? '定位中…' : '用当前位置'}</button>
      <button class="${cls.s}" type="button" ${mk('ci-manual')}>手动填坐标</button>
    </div>
    ${c.error ? `<p class="trip-ci-err">${esc(c.error)}</p>` : ''}
    ${posLine}
    ${
      manual
        ? `<label class="${field}"><span>纬度</span><input id="ci-lat" type="text" placeholder="30.2741" value="${num(s.lat)}" /></label>
           <label class="${field}"><span>经度</span><input id="ci-lng" type="text" placeholder="120.1551" value="${num(s.lng)}" /></label>
           <p class="trip-hint">格式如 30.2741（纬度）/ 120.1551（经度），小数点在前面加个 0 就行。</p>`
        : ''
    }
    <label class="${field}"><span>归属行程</span>
      <select id="ci-trip"><option value="">不归属任何行程</option>${tripsOpt}</select>
    </label>
    <p class="trip-hint">坐标只存在你自己的设备上，不会发给任何第三方，也不会进日志。</p>`;
}
