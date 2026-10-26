/**
 * modules/timetable/mobile-edit.js —— 手机版课表**编辑**弹层（课程管理 / 课次 / 调课 · 0.2.3）
 *
 * 功能：手机版手动维护课表所需的弹层与动作处理 —— `ttCoursesSheet()`（课程管理）、
 *      `ttCourseFormSheet()` / `ttSessionFormSheet()`（两张表单）、`ttAdjustSheet()`（调课 / 停课），
 *      以及把上面这些动作接到 `data-act` 上的 `handleTtEditAct()`。
 *
 * ⭐ 为什么单独一个模块：`mobile/views/timetable.js` 已经 700+ 行，再塞进这一套就会越过
 *    「JS >800 行该拆」的线（08-工程规范）。这几块是**新功能**、边界清楚（都是「改数据」的弹层）。
 *
 * ⚠️ 手机版与电脑版是**两套实现**：这里刻意不复用桌面版的 `desktop-edit.js` ——
 *    版式、弹层机制（底部抽屉 vs 居中弹窗）都不同，共享的只有 REST 契约与 `core/`。
 *
 * ⚠️ 三件事刻意不在这里做：① 不在前端算「这周有没有课 / 撞不撞车」（服务端判，原话转给用户）；
 *    ② 不自己抄一份调色板（`GET /schedule` 随响应下发 `palette`）；③ 不碰作息（只读它决定节次范围）。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `public/mobile/views/timetable-edit.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了 import 的相对路径与静态依赖的
 *    目标（`./timetable.js` → `./timetable-mobile.js`）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.52
 * 相关：docs/公共/架构文档/06-课表.md、07-前端-电脑版与手机版.md、docs/公共/开发方案/09-模块化重构.md
 */

import { api } from '../../core/api.js';
import { $, esc, skeletonHtml } from '../../core/dom.js';
import { render } from '../../mobile/app.js';
import { state } from '../../mobile/state.js';
import { askConfirm, closeSheet, openSheet, toast } from '../../mobile/ui.js';
import { TT_FULL, TT_WD } from './timetable-mobile.js';

/** 上一次拉到的课程与课次 —— 表单/编辑要按 id 取对象，重拉一遍不如留着（每次打开课程管理都会刷新） */
let lastCourses = [];
let lastSessions = [];

/**
 * 功能：把节次区间写成「第 3–4 节」。
 * @param {number} ps - 起始节次
 * @param {number} pe - 结束节次
 * @returns {string} 节次文案；起始非法时为空串
 */
const perLabel = (ps, pe) => {
  const a = Number(ps);
  if (!Number.isFinite(a)) return '';
  const b = Number(pe);
  return !Number.isFinite(b) || b === a ? `第 ${a} 节` : `第 ${a}–${b} 节`;
};

/**
 * 功能：取当前学期的节次号清单（来自作息）。
 * @returns {Array.<number>} 升序节次号
 */
const perNumbers = () =>
  ((state.tt && state.tt.periods) || [])
    .map((p) => Number(p.index_no))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

/**
 * 功能：取当前学期的调色板（服务端随 `/schedule` 下发）。
 * @returns {Array.<string>} `#RRGGBB` 数组
 */
const palette = () => {
  const p = (state.tt && state.tt.palette) || [];
  return p.length ? p : ['#2563eb'];
};

/**
 * 功能：画一排可点的颜色块（单选），选中值存在 `#tt-color-hidden` 里。
 * @param {string} selected - 当前选中色
 * @returns {string} HTML
 */
function colorRow(selected) {
  const cur = selected || palette()[0];
  return `<div class="tt-colors">${palette()
    .map(
      (c) =>
        `<button type="button" class="tt-color${c === cur ? ' on' : ''}" data-act="tt-color" ` +
        `data-color="${esc(c)}" style="--c:${esc(c)}" aria-label="颜色 ${esc(c)}"></button>`,
    )
    .join('')}</div><input id="tt-color-hidden" type="hidden" value="${esc(cur)}" />`;
}

/**
 * 功能：拉取当前学期的课程与课次。
 *
 * ⚠️ 0.5.5（「课程管理设置：点击加载延迟太大」）：课次原先只能**逐门课**调
 *    `/courses/:id/sessions` ⇒ 打开一次是 **1 + N 次串行请求**（一门课等一次往返），
 *    课一多就要等好几秒。现在服务端补了「按学期整份取课次」的接口
 *    （`GET /api/timetable/sessions?term_id=`），这里降到 **2 次**；
 *    这两次**互不依赖**，所以一起发（要的是「减请求数」——
 *    两次并发的服务端排队代价可忽略，但能省掉一整个往返）。
 *
 * @returns {Promise.<void>} 结果写进模块级的 `lastCourses` / `lastSessions`
 */
async function loadCourses() {
  const [courses, sessions] = await Promise.all([
    api('GET', `/api/timetable/courses?term_id=${state.ttTermId}`),
    api('GET', `/api/timetable/sessions?term_id=${state.ttTermId}`),
  ]);
  lastCourses = Array.isArray(courses) ? courses : [];
  lastSessions = Array.isArray(sessions) ? sessions : [];
}

/**
 * 「课程管理」弹层的底部按钮 —— 取数前后各开一次弹层，两处必须是同一份（抄第二遍就会漂移）。
 * @type {string}
 */
const COURSES_FOOT =
  '<button class="btn primary" data-act="tt-c-add">＋ 添加课程</button>' +
  '<button class="btn ghost" data-act="sheet-close">关闭</button>';

/**
 * 功能：打开「课程管理」弹层 —— 课程与课次的列表 + 增删改入口。
 *
 * 说明：⭐ 这是**没导入过教务文件的人唯一能填进课表的地方**（0.2.3 之前手机版同样只能靠导入）。
 *      ⭐ 0.5.5（「点击加载延迟太大」）：现在**先开弹层再取数** ——
 *      取数要跨好几条请求，原先「等全部回来才开弹层」的表现是**点了没反应**，
 *      比「等一会儿」难受得多。先摆骨架，取完用同一套渲染重画（与导入向导
 *      `ttLoadTemplates().then(() => ttImportSheet())` 同一个手法）。
 *
 * @returns {Promise.<void>}
 */
export async function ttCoursesSheet() {
  if (!state.ttTermId) return toast('先建一个学期', true);
  openSheet('课程管理', skeletonHtml(3), COURSES_FOOT);
  try {
    await loadCourses();
  } catch (e) {
    closeSheet();
    return toast(e.message, true);
  }
  const body =
    (lastCourses.length
      ? `<div class="m-tip">本学期共 <b>${lastCourses.length}</b> 门课、<b>${lastSessions.length}</b> 条课次。</div>`
      : '<div class="m-tip">还没有课程 —— 点「＋ 添加课程」，或用「⬆ 导入课表」。</div>') +
    lastCourses
      .map((c) => {
        const mine = lastSessions.filter((s) => Number(s.course_id) === Number(c.id));
        return `<div class="tt-course">
          <div class="tt-course-head">
            <i class="tt-course-dot" style="background:${esc(c.color || '#2563eb')}"></i>
            <b>${esc(c.name)}</b>
            <span>${[c.short_name, c.teacher].filter(Boolean).map(esc).join(' · ')}</span>
          </div>
          ${
            mine
              .map(
                (s) =>
                  `<button class="tt-srow" type="button" data-act="tt-s-edit" data-id="${s.id}" data-course="${c.id}">` +
                  `${TT_WD[(Number(s.weekday) || 1) - 1]} ${perLabel(s.period_start, s.period_end)} · ${esc(
                    s.weeks || '周次未填',
                  )} 周${s.room ? ' · ' + esc(s.room) : ''}</button>`,
              )
              .join('') || '<div class="m-tip">这门课还没有课次（没有课次就不会出现在课表里）</div>'
          }
          <div class="tt-crow">
            <button class="btn ghost sm" type="button" data-act="tt-s-add" data-id="${c.id}">＋ 课次</button>
            <button class="btn ghost sm" type="button" data-act="tt-c-edit" data-id="${c.id}">编辑</button>
            <button class="btn ghost sm" type="button" data-act="tt-c-del" data-id="${c.id}">删除</button>
          </div>
        </div>`;
      })
      .join('') +
    (perNumbers().length
      ? ''
      : '<div class="m-tip warn">⚠️ 没有作息表就<b>加不了课次</b>，先去「⚙ 设置 → 作息设置」填。</div>');
  openSheet('课程管理', body, COURSES_FOOT);
}

/**
 * 功能：打开「课程」表单（新建或编辑）—— 课程名 / 简称 / 教师 / 颜色 / 课程备注。
 * @param {?Object} course - 传入为编辑，不传为新建
 * @returns {void}
 */
export function ttCourseFormSheet(course) {
  // ⚠️ 新建课程必须挂在某个学期下（课次也按学期走）—— 0.4.4 第二版起「新建」菜单里
  //    可以直接点进来，所以这里也要挡一道，别让用户填完一圈再收到一个 400
  if (!course && !state.ttTermId) return toast('先建一个学期', true);
  const c = course || {};
  openSheet(
    course ? '编辑课程' : '添加课程',
    `<label class="fld"><span>课程名（必填）</span>
       <input id="tt-f-name" type="text" value="${esc(c.name || '')}" placeholder="如 计算机网络" /></label>
     <label class="fld"><span>简称（课表上显示它）</span>
       <input id="tt-f-short" type="text" value="${esc(c.short_name || '')}" placeholder="如 计网" /></label>
     <label class="fld"><span>教师</span>
       <input id="tt-f-teacher" type="text" value="${esc(c.teacher || '')}" /></label>
     <div class="fld"><span>颜色（课条底色，上面压白字）</span>${colorRow(c.color)}</div>
     <div class="m-tip">这些颜色都<b>实测过</b>白字对比度，挑哪个都看得清。</div>
     <label class="fld"><span>课程备注（这门课）</span>
       <textarea id="tt-f-remark" placeholder="如：期末考试 1/12、上课带电脑">${esc(c.remark || '')}</textarea></label>
     <div class="m-tip">⚠️ 给的是<b>这门课</b>，每节都显示；单日的事请填<b>本节备注</b>。</div>`,
    '<button class="btn primary" data-act="tt-c-save"' +
      (course ? ` data-id="${course.id}"` : '') +
      '>保存</button><button class="btn ghost" data-act="tt-courses">返回</button>',
  );
}

/**
 * 功能：打开「课次」表单（新建或编辑）—— 星期 / 起止节次 / 周次 / 教室 / 教师 / 课堂备注。
 *
 * 说明：⚠️ 节次只能从**作息里真实存在的节次**里选：写一个作息没有的节次，整周格子里没有那一行，
 *      课会「加进去了但看不见」。作息为空时明确拒绝并指路，而不是给空下拉。
 *
 * @param {Object} course - 所属课程
 * @param {?Object} session - 传入为编辑，不传为新建
 * @returns {void}
 */
export function ttSessionFormSheet(course, session) {
  const s = session || {};
  const nums = perNumbers();
  if (!nums.length) {
    openSheet(
      '添加课次',
      '<div class="m-tip warn">⚠️ 没有<b>作息时间表</b>就没法选「第几节」。</div>' +
        '<div class="m-tip">先去填一张作息表，回来就能加了。</div>',
      '<button class="btn primary" data-act="tt-settings">去作息设置</button>' +
        '<button class="btn ghost" data-act="sheet-close">关闭</button>',
    );
    return;
  }
  const lo = nums[0];
  const opts = (sel) =>
    nums.map((n) => `<option value="${n}"${n === sel ? ' selected' : ''}>第 ${n} 节</option>`).join('');
  const totalWeeks = Number((state.tt && state.tt.term && state.tt.term.total_weeks) || 17);
  const ps = Number(s.period_start) || lo;
  const pe = Number(s.period_end) || ps;
  openSheet(
    session ? '编辑课次' : '添加课次',
    `<div class="m-tip">给《${esc(course.name)}》${session ? '改一条课次' : '加一条课次'}；一门课可以有多条。</div>
     <label class="fld"><span>星期</span><select id="tt-f-wd">${TT_FULL.map(
       (w, i) => `<option value="${i + 1}"${i + 1 === (Number(s.weekday) || 1) ? ' selected' : ''}>${w}</option>`,
     ).join('')}</select></label>
     <label class="fld"><span>周次</span>
       <input id="tt-f-weeks" type="text" value="${esc(s.weeks || `1-${totalWeeks}`)}" placeholder="如 1-16 / 1-16单" /></label>
     <div class="tt-two-fld">
       <label class="fld"><span>从第几节</span><select id="tt-f-ps">${opts(ps)}</select></label>
       <label class="fld"><span>到第几节</span><select id="tt-f-pe">${opts(pe)}</select></label>
     </div>
     <label class="fld"><span>教室</span><input id="tt-f-room" type="text" value="${esc(s.room || '')}" /></label>
     <label class="fld"><span>教师（留空＝沿用课程的）</span>
       <input id="tt-f-teacher" type="text" value="${esc(s.teacher || '')}" /></label>
     <div class="m-tip">⚠️ 本节备注按<b>日期</b>挂在这一天这一节上，请在课次详情里改。</div>`,
    '<button class="btn primary" data-act="tt-sess-save" data-course="' +
      course.id +
      '"' +
      (session ? ` data-id="${session.id}"` : '') +
      '>保存</button><button class="btn ghost" data-act="tt-courses">返回</button>',
  );
}

/**
 * 功能：打开「调课 / 停课」弹层 —— 口径：范围要能选「本节 / 此后全部」。
 *
 * 说明：⭐ 两个范围的落法完全不同，界面上说清（用户要知道「此后全部会切开这条课次」）：
 *      · 本节 → 只影响第 N 周这一次，写一行调整（可撤销）；此后全部 → 把课次在第 N 周处劈成两条。
 *      ⚠️ 撞车 / 单双周 / 节次范围一律由服务端判，前端只把服务端的原话转给用户。
 *
 * @param {Object} cell - 课次（`/schedule` 的 cells 元素；被停掉的那一周由调整行合成等价对象）
 * @returns {void}
 */
export function ttAdjustSheet(cell) {
  if (!cell || !cell.session_id) return;
  const nums = perNumbers();
  if (!nums.length) return toast('这个学期还没有作息时间表，先去「作息设置」填一下', true);
  const totalWeeks = Number((state.tt && state.tt.term && state.tt.term.total_weeks) || 17);
  const cur = ((state.tt && state.tt.adjustments) || []).find((a) => Number(a.session_id) === Number(cell.session_id));
  const week = Number(cur && cur.week_no) || Number(state.tt && state.tt.week) || 1;
  // ⭐ 跨周调课：目标周（没调过 / 同周调课 ⇒ 与源周相同）
  const toWeek = Number(cur && cur.to_week_no) || week;
  const isCancel = !!(cur && cur.kind === 'cancel');
  const lo = nums[0];
  const opts = (sel) =>
    nums.map((n) => `<option value="${n}"${n === sel ? ' selected' : ''}>第 ${n} 节</option>`).join('');
  // ⚠️ 入参有两种来源：点课次卡片时是 `/schedule` 的 cell（有 weekday / period_start / room），
  //    点**课表上方调整条的「改」**时是调整行本身（只有 origin_*）—— 后者尤其重要，因为
  //    **被停课的那一周格子里什么都没有**，那条路是它唯一能改回来的入口。不回落 origin_* 的话，
  //    弹层会预填成「星期一第 1 节」，用户一保存就把课挪到了完全不相干的地方。
  const curWd = Number(cell.weekday) || Number(cell.origin_weekday) || 1;
  const curPs = Number(cell.period_start) || Number(cell.origin_period_start) || lo;
  const curPe = Number(cell.period_end) || Number(cell.origin_period_end) || curPs;
  const curRoom = cell.room === undefined ? cell.origin_room || '' : cell.room;
  openSheet(
    `调课 / 停课 · ${cell.short_name || cell.name || '这节课'}`,
    `<div class="m-tip">现在是 <b>${TT_FULL[curWd - 1]} ${perLabel(curPs, curPe)}</b>${
      cell.weeks ? `（${esc(cell.weeks)} 周）` : ''
    }。</div>
     <div class="tt-two-fld">
       <label class="fld"><span>从哪一周</span>
         <input id="tt-a-week" type="number" min="1" max="${totalWeeks}" value="${week}" /></label>
       <label class="fld" id="tt-a-toweek-wrap"><span>调到哪一周</span>
         <input id="tt-a-toweek" type="number" min="1" max="${totalWeeks}" value="${toWeek}" /></label>
     </div>
     <div class="m-tip" id="tt-a-toweek-tip">「调到哪一周」与「从哪一周」不同 = 跨周调课（源周变灰并写明去向）。</div>
     <label class="fld"><span>范围</span>
       <div class="tt-radios">
         <label><input type="radio" name="tt-a-scope" value="one" checked /> <b>本节</b>：只调这一周这一次（可撤销）</label>
         <label><input type="radio" name="tt-a-scope" value="onward" /> <b>此后全部</b>：从这一周起一直改（会切成两条课次）</label>
       </div></label>
     <label class="fld"><span>做什么</span>
       <div class="tt-radios">
         <label><input type="radio" name="tt-a-kind" value="move"${
           isCancel ? '' : ' checked'
         } /> 调课（换时间 / 换教室）</label>
         <label><input type="radio" name="tt-a-kind" value="cancel"${
           isCancel ? ' checked' : ''
         } /> 停课（这一周不上）</label>
       </div></label>
     <div id="tt-a-move">
       <label class="fld"><span>调到星期几</span><select id="tt-a-wd">${TT_FULL.map(
         (w, i) => `<option value="${i + 1}"${i + 1 === curWd ? ' selected' : ''}>${w}</option>`,
       ).join('')}</select></label>
       <div class="tt-two-fld">
         <label class="fld"><span>从第几节</span><select id="tt-a-ps">${opts(curPs)}</select></label>
         <label class="fld"><span>到第几节</span><select id="tt-a-pe">${opts(curPe)}</select></label>
       </div>
       <label class="fld"><span>教室（已带出原值，可改）</span>
         <input id="tt-a-room" type="text" value="${esc(curRoom)}" /></label>
     </div>
     <label class="fld" id="tt-a-note-wrap"><span>说明（只对「本节」有用）</span>
       <input id="tt-a-note" type="text" value="${esc((cur && cur.note) || '')}" placeholder="如：教室被占用" /></label>
     <div class="m-tip" id="tt-a-hint"></div>`,
    '<button class="btn primary" data-act="tt-adj-save" data-id="' +
      cell.session_id +
      '" data-course="' +
      cell.course_id +
      '">确定</button>' +
      (cur
        ? `<button class="btn danger" data-act="tt-adj-undo" data-id="${cell.session_id}" data-course="${cell.course_id}" data-week="${cur.week_no}">撤销这次调整</button>`
        : '') +
      '<button class="btn ghost" data-act="sheet-close">取消</button>',
  );
  // 单选 / 周次一变就更新提示与可见区（就近绑定：这两个控件只在本次弹层里有效）
  const root = $('#sheet-body');
  const hint = () => {
    const kind = root.querySelector('input[name="tt-a-kind"]:checked').value;
    const scope = root.querySelector('input[name="tt-a-scope"]:checked').value;
    const w = Number(($('#tt-a-week') || {}).value) || 1;
    // ⭐ 「此后全部就不要显示调整到哪一周了」——
    //    此后全部（劈周次）与停课都不谈目标周 ⇒ 那一格与它下面的说明一起收起来。
    const showTo = kind === 'move' && scope === 'one';
    const toWrap = $('#tt-a-toweek-wrap');
    if (toWrap) toWrap.hidden = !showTo;
    const toTip = $('#tt-a-toweek-tip');
    if (toTip) toTip.hidden = !showTo;
    const tw = showTo ? Number(($('#tt-a-toweek') || {}).value) || w : w;
    const cross = kind === 'move' && tw !== w;
    const box = $('#tt-a-move');
    if (box) box.hidden = kind === 'cancel';
    const nw = $('#tt-a-note-wrap');
    if (nw) nw.hidden = scope === 'onward';
    $('#tt-a-hint').innerHTML =
      kind === 'cancel'
        ? `只停<b>第 ${w} 周</b>这一次；可用课表上方的调整条撤销。`
        : scope === 'onward'
          ? `⚠️ <b>此后全部</b>：这条课次在第 ${w} 周处切成两条，第 ${w} 周起按新的来。`
          : cross
            ? `第 ${w} 周这一格会<b>变灰</b>并写明「调到第 ${tw} 周 …」；第 ${tw} 周多出这一次课。`
            : `只影响<b>第 ${w} 周</b>这一次；可用课表上方的调整条撤销。`;
  };
  root.querySelectorAll('input[name="tt-a-scope"],input[name="tt-a-kind"]').forEach((r) => {
    r.onchange = hint;
  });
  $('#tt-a-week').oninput = hint;
  $('#tt-a-toweek').oninput = hint;
  hint();
}

/**
 * 功能：手机版课表编辑相关的 `data-act` 派发 —— `onAction` 把这一批动作整包交给这里。
 *
 * 说明：⚠️ 集中一处派发（而不是在 `app.js` 里摊开十几个 case）：`app.js` 是全局指令表，
 *      课表编辑的这些分支只在维护课表时用到，摊开会把它撑爆（它已经 700+ 行）。
 *
 * @param {string} act - 动作名
 * @param {HTMLElement} n - 触发节点（参数在它的 `dataset` 上）
 * @returns {void}
 */
export function handleTtEditAct(act, n) {
  /** 功能：读出触发节点上的 id 并转数字。 @returns {number} */
  const id = () => Number(n.dataset.id);
  /** 功能：按 id 找课程。 @returns {?Object} */
  const courseOf = (cid) => lastCourses.find((c) => Number(c.id) === Number(cid)) || null;
  /** 功能：保存成功后统一收尾 —— 让课表重新拉取、重画主视图，再回到课程管理。 */
  const afterSave = (msg) => {
    state.ttLoaded = false;
    render();
    toast(msg);
    ttCoursesSheet();
  };
  switch (act) {
    case 'tt-courses':
      ttCoursesSheet();
      return;
    case 'tt-c-add':
      ttCourseFormSheet(null);
      return;
    case 'tt-c-edit':
      ttCourseFormSheet(courseOf(id()));
      return;
    case 'tt-color': {
      const root = $('#sheet-body');
      root.querySelectorAll('.tt-color').forEach((x) => x.classList.remove('on'));
      n.classList.add('on');
      $('#tt-color-hidden').value = n.dataset.color;
      return;
    }
    case 'tt-c-save': {
      const name = (($('#tt-f-name') || {}).value || '').trim();
      if (!name) return toast('课程名不能为空', true);
      const payload = {
        name,
        short_name: ($('#tt-f-short') || {}).value || '',
        teacher: ($('#tt-f-teacher') || {}).value || '',
        color: ($('#tt-color-hidden') || {}).value || '',
        remark: ($('#tt-f-remark') || {}).value || '',
      };
      const cid = n.dataset.id ? id() : null;
      const req = cid
        ? api('PUT', `/api/timetable/courses/${cid}`, payload)
        : api('POST', '/api/timetable/courses', Object.assign({ term_id: state.ttTermId }, payload));
      req.then(() => afterSave('已保存')).catch((e) => toast(e.message, true));
      return;
    }
    case 'tt-c-del': {
      const c = courseOf(id());
      if (!c) return;
      const cnt = lastSessions.filter((s) => Number(s.course_id) === Number(c.id)).length;
      askConfirm({
        title: `删除《${c.name}》？`,
        text: `会连带删掉它的 ${cnt} 条课次，撤销不了。`,
        ok: '删除',
      }).then((yes) => {
        if (!yes) return;
        api('DELETE', `/api/timetable/courses/${c.id}`)
          .then(() => afterSave('已删除课程'))
          .catch((e) => toast(e.message, true));
      });
      return;
    }
    case 'tt-s-add':
      ttSessionFormSheet(courseOf(id()), null);
      return;
    case 'tt-s-edit': {
      const s = lastSessions.find((x) => Number(x.id) === id());
      ttSessionFormSheet(courseOf(n.dataset.course), s || null);
      return;
    }
    case 'tt-sess-save': {
      const weeks = ((($('#tt-f-weeks') || {}).value || '') + '').trim();
      if (!weeks) return toast('周次不能为空（如 1-16）', true);
      const sid = n.dataset.id ? id() : null;
      const payload = {
        weekday: Number(($('#tt-f-wd') || {}).value) || 1,
        period_start: Number(($('#tt-f-ps') || {}).value) || 1,
        period_end: Number(($('#tt-f-pe') || {}).value) || 1,
        weeks,
        room: ($('#tt-f-room') || {}).value || '',
        teacher: ($('#tt-f-teacher') || {}).value || '',
      };
      const base = `/api/timetable/courses/${n.dataset.course}/sessions`;
      const req = sid ? api('PUT', `${base}/${sid}`, payload) : api('POST', base, payload);
      req.then(() => afterSave('已保存')).catch((e) => toast(e.message, true));
      return;
    }
    case 'tt-adj': {
      // 从课次 id 找到那一格；找不到（例如已被停课）就退回用调整行合成的对象
      const sid = id();
      const cell =
        ((state.tt && state.tt.cells) || []).find((c) => Number(c.session_id) === sid) ||
        ((state.tt && state.tt.adjustments) || []).find((a) => Number(a.session_id) === sid);
      ttAdjustSheet(cell);
      return;
    }
    case 'tt-adj-save': {
      const root = $('#sheet-body');
      const scope = root.querySelector('input[name="tt-a-scope"]:checked').value;
      const kind = root.querySelector('input[name="tt-a-kind"]:checked').value;
      const w = Number(($('#tt-a-week') || {}).value);
      const totalWeeks = Number((state.tt && state.tt.term && state.tt.term.total_weeks) || 17);
      if (!Number.isFinite(w) || w < 1 || w > totalWeeks) return toast(`第几周要在 1 到 ${totalWeeks} 之间`, true);
      const tw = scope === 'one' ? Number(($('#tt-a-toweek') || {}).value) || w : w;
      if (!Number.isFinite(tw) || tw < 1 || tw > totalWeeks) {
        return toast(`调到第几周要在 1 到 ${totalWeeks} 之间`, true);
      }
      const body = { kind };
      if (kind === 'move') {
        // ⭐ 跨周调课：只有「本节」才带目标周（此后全部那一格是收起的，见 `hint()`）
        if (scope === 'one' && tw !== w) body.to_week_no = tw;
        body.to_weekday = Number(($('#tt-a-wd') || {}).value) || 1;
        body.to_period_start = Number(($('#tt-a-ps') || {}).value) || 1;
        body.to_period_end = Number(($('#tt-a-pe') || {}).value) || 1;
        body.to_room = ($('#tt-a-room') || {}).value || '';
      }
      const base = `/api/timetable/courses/${n.dataset.course}/sessions/${id()}`;
      const req =
        scope === 'onward'
          ? api('POST', `${base}/onward`, Object.assign({ from_week: w }, body))
          : api(
              'PUT',
              `${base}/adjustments/${w}`,
              Object.assign({}, body, { week_no: w, note: ($('#tt-a-note') || {}).value || '' }),
            );
      req
        .then((r) => {
          closeSheet();
          state.ttLoaded = false;
          render();
          if (scope === 'onward') {
            toast(
              r && r.cancelled
                ? '已从这一周起停课（这条课次整个删掉了）'
                : `已从第 ${w} 周起改掉${r && r.weeks_after ? `（${r.weeks_after}）` : ''}`,
            );
          } else {
            toast(
              kind === 'cancel'
                ? `第 ${w} 周已停课`
                : tw !== w
                  ? `第 ${w} 周已调到第 ${tw} 周`
                  : `第 ${w} 周已调到新的时间`,
            );
          }
        })
        .catch((e) => toast(e.message, true));
      return;
    }
    case 'tt-adj-undo':
      api('DELETE', `/api/timetable/courses/${n.dataset.course}/sessions/${id()}/adjustments/${n.dataset.week}`)
        .then(() => {
          closeSheet();
          state.ttLoaded = false;
          render();
          toast('已撤销这次调课');
        })
        .catch((e) => toast(e.message, true));
      return;
    default:
      // 理论上到不了这里（`app.js` 只把上面这些动作转过来）—— 但静默忽略比抛错安全
      return;
  }
}
