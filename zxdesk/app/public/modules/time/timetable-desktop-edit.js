/**
 * modules/timetable/desktop-edit.js —— 课表**编辑**弹层（课程管理 / 课次 / 调课 · 0.2.3）
 *
 * 功能：手动维护课表所需的三个弹层 —— `openTtCourses`（课程管理：课程与课次的增删改）、
 *      `openTtCourseForm` / `openTtSessionForm`（两张表单）、`openTtAdjust`（调课 / 停课）。
 *
 * ⭐ 为什么单独一个模块：电脑版课表视图已经 700+ 行，再塞进这一套就会越过「JS >800 行该拆」的线
 *    （见 08-工程规范）。而这几块是**新功能**、边界清楚（都是「改数据」的弹层），
 *    与 `timetable.js`（渲染课表）分开正好。
 *
 * ⚠️ **依赖方向是单向的**：本模块**静态**依赖 `timetable.js`（借用它的弹窗壳、星期表、刷新函数），
 *    而 `timetable.js` 只在点击时用**动态 `import()`** 反向调这里（`ttAdjustLazy` / `ttCoursesLazy`）——
 *    静态边只有一条，两边不会成环。因此本文件**不进 `index.html` 的 modulepreload**
 *    清单：它是点击才加载的低频入口，静态挂上去只会让首屏多一个请求。
 *
 * ⚠️ 三件事刻意不在这里做：
 *    ① **不自己算「这周有没有课」** —— 周次判定、撞车、单双周劈开全在服务端（
 *       同一套口径只留一份，否则两端迟早不一致）；
 *    ② **不改用户数据以外的任何东西** —— 表单只发用户填的字段，缺省值由服务端补；
 *    ③ **不碰作息** —— 节次表来自「作息设置」，这里只读它来决定下拉范围。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `public/desktop/views/timetable-edit.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了 import 的相对路径与静态依赖的
 *    目标（`./timetable.js` → `./timetable-desktop.js`）。它**仍然不进 `modulepreload`**（懒加载入口，见上）。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.9.5
 * 相关：docs/公共/架构文档/06-课表.md、07-前端-电脑版与手机版.md、docs/公共/开发方案/09-模块化重构.md
 */

import { api } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
import { state } from '../../desktop/state.js';
import { toast } from '../../desktop/ui.js';
import { TT_WD, closeTtModal, loadTtSchedule, openTtModal, openTtSettings, ttPeriodText } from './timetable-desktop.js';

/**
 * 功能：取当前学期的调色板（由服务端随 `/schedule` 一起下发，不在前端另抄一份）。
 * @returns {Array.<string>} `#RRGGBB` 颜色数组；接口没给时回落到一个安全的单色
 */
function palette() {
  const p = (state.tt && state.tt.palette) || [];
  return p.length ? p : ['#2563eb'];
}

/**
 * 功能：把调色板画成一排可点的色块（单选）。
 * @param {string} selected - 当前选中的颜色
 * @returns {string} 色块行的 HTML
 */
function ttColorRowHtml(selected) {
  const cur = selected || palette()[0];
  return (
    '<div class="tt-colors">' +
    palette()
      .map(
        (c) =>
          `<button type="button" class="tt-color${c === cur ? ' on' : ''}" data-tt-color="${esc(c)}" ` +
          `style="--c:${esc(c)}" title="${esc(c)}" aria-label="颜色 ${esc(c)}"></button>`,
      )
      .join('') +
    '</div>'
  );
}

/**
 * 功能：接管色块行 —— 点谁谁选中，并把选中值写到隐藏字段里供保存时读取。
 * @param {Element} root - 弹窗正文容器
 * @returns {void}
 */
function bindColorRow(root) {
  const box = root.querySelector('#tt-color-hidden');
  root.querySelectorAll('.tt-color').forEach((b) => {
    b.onclick = () => {
      root.querySelectorAll('.tt-color').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      if (box) box.value = b.dataset.ttColor;
    };
  });
}

/**
 * 功能：把一门课的课次写成一行可点的按钮文案（星期 + 节次 + 周次 + 教室）。
 * @param {Object} s - 课次行
 * @returns {string} 一行文案
 */
function sessText(s) {
  const wk = s.weeks ? `${s.weeks} 周` : '周次未填';
  return `${TT_WD[(Number(s.weekday) || 1) - 1]} ${ttPeriodText(s.period_start, s.period_end)} · ${wk}${
    s.room ? ' · ' + s.room : ''
  }`;
}

/**
 * 功能：打开「课程管理」弹窗 —— 列出本学期的课程与课次，并给出增删改入口。
 *
 * 说明：⭐ 这是**没导入过教务文件的人唯一能填进课表的地方**（0.2.3 之前课表只能靠导入，
 *      空课表时前端一个新增入口都没有）。数据每次都现拉，所以「保存完再调一次本函数」
 *      就是刷新，不必手工改 DOM。
 *
 * @returns {Promise.<void>}
 */
export async function openTtCourses() {
  if (!state.ttTermId) return toast('先建一个学期', true);
  let courses = [];
  let sessions = [];
  try {
    // ⭐ 0.5.5（「课程管理 点击加载延迟太大」）：服务端补了「按学期整份取课次」的
    //    接口（`GET /api/timetable/sessions?term_id=`），这里从 **1 + N 次请求**降到 **2 次** ——
    //    原先是逐门课拉 `/courses/:id/sessions`。 写得明确：「**减请求数是唯一有效的办法**」
    //    （HTTP/1.1 每源 6 并发 + `node:sqlite` 全同步查询 + Node 单线程 ⇒ 请求越多服务端排队越久）。
    //    两次互不依赖，一起发。
    const r = await Promise.all([
      api('GET', `/api/timetable/courses?term_id=${state.ttTermId}`),
      api('GET', `/api/timetable/sessions?term_id=${state.ttTermId}`),
    ]);
    courses = Array.isArray(r[0]) ? r[0] : [];
    sessions = Array.isArray(r[1]) ? r[1] : [];
  } catch (e) {
    return toast(e.message, true);
  }

  const body =
    (courses.length
      ? `<div class="tt-tip">本学期共 <b>${courses.length}</b> 门课、<b>${sessions.length}</b> 条课次。</div>`
      : `<div class="tt-tip">还没有课程 —— 点下面「＋ 添加课程」，或用「⬆ 导入课表」。</div>`) +
    '<div class="tt-course-list">' +
    courses
      .map((c) => {
        const mine = sessions.filter((s) => Number(s.course_id) === Number(c.id));
        const rows = mine.length
          ? mine
              .map(
                (s) =>
                  `<button type="button" class="tt-sess-row" data-tt-s-edit="${s.id}" data-tt-s-course="${c.id}">` +
                  `${esc(sessText(s))}</button>`,
              )
              .join('')
          : '<span class="ttu">这门课还没有课次（没有课次就不会出现在课表里）</span>';
        return (
          `<div class="tt-course" data-cid="${c.id}">` +
          '<div class="tt-course-head">' +
          `<span class="tt-course-dot" style="background:${esc(c.color || '#2563eb')}"></span>` +
          `<b>${esc(c.name)}</b>` +
          `<span class="tt-course-sub">${[c.short_name, c.teacher].filter(Boolean).map(esc).join(' · ')}</span>` +
          `<button type="button" class="btn btn-subtle btn-sm" data-tt-s-add="${c.id}">＋ 课次</button>` +
          `<button type="button" class="btn btn-subtle btn-sm" data-tt-c-edit="${c.id}">编辑</button>` +
          `<button type="button" class="btn btn-subtle btn-sm" data-tt-c-del="${c.id}">删除</button>` +
          '</div>' +
          `<div class="tt-course-sess">${rows}</div>` +
          (mine.length > 1
            ? '<div class="tt-tip">一门课可以有多条课次（星期 / 节次 / 周次不同）。</div>'
            : '') +
          '</div>'
        );
      })
      .join('') +
    '</div>' +
    '<div class="tt-set-actions"><button id="tt-c-add" class="btn btn-primary btn-sm" type="button">＋ 添加课程</button>' +
    (state.tt && state.tt.periods && state.tt.periods.length
      ? ''
      : '<span class="tt-set-warn">⚠️ 没有作息表就<b>加不了课次</b>，先去「⚙ 设置 → 作息设置」填。</span>') +
    '</div>';

  openTtModal('课程管理', body);
  const root = $('#tt-modal-body');

  $('#tt-c-add').onclick = () => openTtCourseForm(null);
  root.querySelectorAll('[data-tt-c-edit]').forEach((b) => {
    b.onclick = () => openTtCourseForm(courses.find((c) => Number(c.id) === Number(b.dataset.ttCEdit)));
  });
  root.querySelectorAll('[data-tt-s-add]').forEach((b) => {
    const c = courses.find((x) => Number(x.id) === Number(b.dataset.ttSAdd));
    b.onclick = () => openTtSessionForm(c, null);
  });
  root.querySelectorAll('[data-tt-s-edit]').forEach((b) => {
    const c = courses.find((x) => Number(x.id) === Number(b.dataset.ttSCourse));
    b.onclick = () =>
      openTtSessionForm(
        c,
        sessions.find((s) => Number(s.id) === Number(b.dataset.ttSEdit)),
      );
  });
  root.querySelectorAll('[data-tt-c-del]').forEach((b) => {
    b.onclick = () => {
      const c = courses.find((x) => Number(x.id) === Number(b.dataset.ttCDel));
      if (!c) return;
      // ⚠️ 删除是破坏性的（连带它名下所有课次），所以就地二次确认 —— 与作息设置同一套做法，
      //    不用 `confirm()`（在飞牛的 iframe 壳里样式不可控）
      const row = root.querySelector(`.tt-course[data-cid="${c.id}"]`);
      const info = sessions.filter((s) => Number(s.course_id) === Number(c.id)).length;
      if (row) {
        row.querySelector('.tt-course-sess').innerHTML =
          `<span class="tt-del-warn">⚠️ 删掉《${esc(c.name)}》会连带删掉它的 <b>${info}</b> 条课次，` +
          '撤销不了。</span>' +
          `<button type="button" class="btn btn-danger btn-sm" data-tt-c-del-yes="${c.id}">确认删除</button>` +
          '<button type="button" class="btn btn-subtle btn-sm" data-tt-c-del-no="1">取消</button>';
      }
      row.querySelector('[data-tt-c-del-yes]').onclick = async () => {
        try {
          await api('DELETE', `/api/timetable/courses/${c.id}`);
          await loadTtSchedule();
          toast('已删除课程');
          await openTtCourses();
        } catch (e) {
          toast(e.message, true);
        }
      };
      row.querySelector('[data-tt-c-del-no]').onclick = () => openTtCourses();
    };
  });
}

/**
 * 功能：打开「课程」表单（新建或编辑）—— 课程名 / 简称 / 教师 / 颜色 / 课程备注。
 * @param {?Object} course - 传入则为编辑（回填），不传为新建
 * @returns {void}
 */
export function openTtCourseForm(course) {
  // ⚠️ 新建课程必须挂在某个学期下（课次也是按学期走的）—— 一个学期都没有时先给一句人话，
  //    别让用户填完一圈再收到一个 400（0.4.4 第二版：「新建」菜单里可以直接点进来）
  if (!course && !state.ttTermId) return toast('先建一个学期', true);
  const c = course || {};
  openTtModal(
    course ? '编辑课程' : '添加课程',
    `<div class="tt-field"><label>课程名（必填）</label>
       <input id="tt-f-name" type="text" value="${esc(c.name || '')}" placeholder="如 计算机网络" maxlength="100" /></div>
     <div class="tt-two">
       <div class="tt-field"><label>简称（课条上显示它）</label>
         <input id="tt-f-short" type="text" value="${esc(c.short_name || '')}" placeholder="如 计网" maxlength="20" /></div>
       <div class="tt-field"><label>教师</label>
         <input id="tt-f-teacher" type="text" value="${esc(c.teacher || '')}" maxlength="100" /></div>
     </div>
     <div class="tt-field"><label>颜色（课条的底色，上面压白字）</label>
       ${ttColorRowHtml(c.color)}
       <input id="tt-color-hidden" type="hidden" value="${esc(c.color || palette()[0])}" />
       <div class="tt-tip">这些颜色都<b>实测过</b>白字对比度，挑哪个都看得清。</div></div>
     <div class="tt-field"><label>课程备注（这门课）</label>
       <textarea id="tt-f-remark" placeholder="如：期末考试 1/12、上课带电脑 —— 这门课的所有课次都会看到">${esc(
         c.remark || '',
       )}</textarea>
       <div class="tt-tip">⚠️ 给的是<b>这门课</b>，每节都显示；单日的事请填<b>本节备注</b>。</div></div>`,
    '保存',
  );
  bindColorRow($('#tt-modal-body'), 'tt-color-hidden');
  $('#tt-modal-ok').onclick = async () => {
    const name = $('#tt-f-name').value.trim();
    if (!name) return toast('课程名不能为空', true);
    const payload = {
      name,
      short_name: $('#tt-f-short').value.trim(),
      teacher: $('#tt-f-teacher').value.trim(),
      color: $('#tt-color-hidden').value,
      remark: $('#tt-f-remark').value.trim(),
    };
    try {
      if (course) await api('PUT', `/api/timetable/courses/${course.id}`, payload);
      else await api('POST', '/api/timetable/courses', Object.assign({ term_id: state.ttTermId }, payload));
      await loadTtSchedule();
      toast('已保存');
      await openTtCourses();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：打开「课次」表单（新建或编辑）—— 星期 / 起止节次 / 周次 / 教室 / 教师。
 *
 * 说明：⚠️ 节次下拉的**范围来自这个学期的作息表**：写一个作息里没有的节次，网格里根本没有那一行，
 *      课会「加进去了但看不见」。所以这里不给自由输入，直接按作息里的节次生成选项。
 *      ⚠️ 作息为空时**明确拒绝并指路**，而不是给一个空下拉让用户猜。
 *
 * @param {Object} course - 所属课程
 * @param {?Object} session - 传入则为编辑（回填），不传为新建
 * @returns {void}
 */
export function openTtSessionForm(course, session) {
  const s = session || {};
  const periods = ((state.tt && state.tt.periods) || []).map((p) => Number(p.index_no)).filter((n) => n > 0);
  if (!periods.length) {
    openTtModal(
      '添加课次',
      '<div class="tt-tip">⚠️ 没有<b>作息时间表</b>就没法选「第几节」，先去填一张作息表。</div>',
      '去作息设置',
    );
    $('#tt-modal-ok').onclick = () => {
      closeTtModal();
      openTtSettings();
    };
    return;
  }
  const lo = Math.min(...periods);
  const opts = (sel) =>
    periods.map((n) => `<option value="${n}"${n === sel ? ' selected' : ''}>第 ${n} 节</option>`).join('');
  const totalWeeks = (state.tt && state.tt.term && Number(state.tt.term.total_weeks)) || 17;
  const ps = Number(s.period_start) || lo;
  const pe = Number(s.period_end) || ps;
  openTtModal(
    session ? '编辑课次' : '添加课次',
    `<div class="tt-tip">给《${esc(course.name)}》${session ? '改一条课次' : '加一条课次'}。一门课可以有多条。</div>
     <div class="tt-two">
       <div class="tt-field"><label>星期</label>
         <select id="tt-f-wd">${TT_WD.map((w, i) => `<option value="${i + 1}"${i + 1 === (Number(s.weekday) || 1) ? ' selected' : ''}>${w}</option>`).join('')}</select></div>
       <div class="tt-field"><label>周次</label>
         <input id="tt-f-weeks" type="text" value="${esc(s.weeks || `1-${totalWeeks}`)}" placeholder="如 1-16 / 1-8,10-16 / 1-16单" /></div>
     </div>
     <div class="tt-two">
       <div class="tt-field"><label>从第几节</label><select id="tt-f-ps">${opts(ps)}</select></div>
       <div class="tt-field"><label>到第几节</label><select id="tt-f-pe">${opts(pe)}</select></div>
     </div>
     <div class="tt-two">
       <div class="tt-field"><label>教室</label><input id="tt-f-room" type="text" value="${esc(s.room || '')}" maxlength="100" /></div>
       <div class="tt-field"><label>教师（留空＝沿用课程的）</label><input id="tt-f-teacher" type="text" value="${esc(s.teacher || '')}" maxlength="100" /></div>
     </div>
     <!-- ⭐ 0.7.1（修订）：这里原来有一个「课堂备注（这节课）」输入框 —— 它挂在课次上、
 而课次按周重复（这几周都显示同一条）。要求「只在那一天显示」⇒ 已改成详情的
          「本节备注」（按「课次 + 日期」存），表单里不再留这个框：留着就成「填了看不见」的黑洞。 -->`,
    '保存',
  );
  const syncEnd = () => {
    const a = Number($('#tt-f-ps').value);
    const b = Number($('#tt-f-pe').value);
    if (b < a) $('#tt-f-pe').value = String(a);
  };
  $('#tt-f-ps').onchange = syncEnd;
  $('#tt-modal-ok').onclick = async () => {
    const weeks = $('#tt-f-weeks').value.trim();
    if (!weeks) return toast('周次不能为空（如 1-16）', true);
    const payload = {
      weekday: Number($('#tt-f-wd').value),
      period_start: Number($('#tt-f-ps').value),
      period_end: Number($('#tt-f-pe').value),
      weeks,
      room: $('#tt-f-room').value.trim(),
      teacher: $('#tt-f-teacher').value.trim(),
    };
    try {
      if (session) await api('PUT', `/api/timetable/courses/${course.id}/sessions/${session.id}`, payload);
      else await api('POST', `/api/timetable/courses/${course.id}/sessions`, payload);
      await loadTtSchedule();
      toast('已保存');
      await openTtCourses();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

/**
 * 功能：打开「调课 / 停课」弹窗 —— 口径：**范围要能选「本节 / 此后全部」**。
 *
 * 说明：⭐ 两个范围的落法完全不同，界面上必须说清（用户要知道「此后全部会切开这条课次」）：
 *      · **本节** → 只影响第 N 周这一次，写一行调整（可撤销）；
 *      · **此后全部** → 把这条课次在第 N 周处**劈成两条**，之后各走各的。
 *      ⚠️ 周次是可以改的（默认取当前查看的那一周）—— 全学期视图下没有「当前周」，
 *      没有这个输入框就只能逼用户先切周，反而更难用。
 *      ⭐ 跨周调课：再给一个「调到哪一周」。与源周不同 ⇒ 源周变灰写明去向、
 *      目标周多出这一次；这种只能「本节」范围（「此后全部」是把课次劈开，与「换一周」不是一回事）。
 *      ⚠️ 撞车、单双周、节次范围**一律由服务端判**，这里只把服务器的原话转给用户。
 *
 * @param {Object} cell - 被调的课次（`/schedule` 的 cells 元素；被停掉的那一周由调整行合成等价对象）
 * @returns {void}
 */
export function openTtAdjust(cell) {
  if (!cell || !cell.session_id) return;
  const term = (state.tt && state.tt.term) || {};
  const totalWeeks = Number(term.total_weeks) || 17;
  const periods = ((state.tt && state.tt.periods) || []).map((p) => Number(p.index_no)).filter((n) => n > 0);
  if (!periods.length) return toast('这个学期还没有作息时间表，先在「作息设置」里填一下', true);
  const lo = Math.min(...periods);
  const cur = ((state.tt && state.tt.adjustments) || []).find((a) => Number(a.session_id) === Number(cell.session_id));
  const week = Number(cur && cur.week_no) || Number(state.tt && state.tt.week) || 1;
  // ⭐ 跨周调课：目标周（没调过 / 同周调课 ⇒ 与源周相同）
  const toWeek = Number(cur && cur.to_week_no) || week;
  const isCancel = !!(cur && cur.kind === 'cancel');
  const opts = (sel) =>
    periods.map((n) => `<option value="${n}"${n === sel ? ' selected' : ''}>第 ${n} 节</option>`).join('');
  const curWd = Number(cell.weekday) || Number(cell.origin_weekday) || 1;
  const curPs = Number(cell.period_start) || Number(cell.origin_period_start) || lo;
  const curPe = Number(cell.period_end) || Number(cell.origin_period_end) || curPs;
  // ⚠️ `room` 要区分「没有这个属性」与「属性是空串」：点调整条上的「改」时传进来的是**调整行**，
  //    它只有 `origin_room` —— 而那条路尤其重要，因为**被停课的那一周格子里什么都没有、点不到课条**，
  //    那是它唯一能改回来的入口。不回落 `origin_*` 的话，弹层会预填成「星期一第 1 节」，
  //    用户一保存就把课挪到了完全不相干的地方。
  const curRoom = cell.room === undefined ? cell.origin_room || '' : cell.room;

  openTtModal(
    `调课 / 停课 · ${cell.short_name || cell.name || '这节课'}`,
    `<div class="tt-tip">现在是 <b>${TT_WD[curWd - 1]} ${ttPeriodText(curPs, curPe)}</b>${cell.weeks ? `（${esc(cell.weeks)} 周）` : ''}。</div>
     <div class="tt-two">
       <div class="tt-field"><label>从哪一周</label>
         <input id="tt-a-week" type="number" min="1" max="${totalWeeks}" value="${week}" /></div>
       <div class="tt-field" id="tt-a-toweek-wrap"><label>调到哪一周</label>
         <input id="tt-a-toweek" type="number" min="1" max="${totalWeeks}" value="${toWeek}" />
         <div class="tt-tip">与左边相同 = 同一周内换时间；不同 = 跨周调课。</div></div>
     </div>
     <div class="tt-field"><label>范围</label>
       <div class="tt-radios">
         <label><input type="radio" name="tt-a-scope" value="one" checked /> <b>本节</b> —— 只调这一周这一次（可随时撤销）</label>
         <label><input type="radio" name="tt-a-scope" value="onward" /> <b>此后全部</b> —— 从这一周起一直改（会把这条课次切成两条）</label>
       </div></div>
     <div class="tt-field"><label>做什么</label>
       <div class="tt-radios">
         <label><input type="radio" name="tt-a-kind" value="move"${isCancel ? '' : ' checked'} /> 调课（换时间 / 换教室）</label>
         <label><input type="radio" name="tt-a-kind" value="cancel"${isCancel ? ' checked' : ''} /> 停课（这一周不上）</label>
       </div></div>
     <div id="tt-a-move">
       <div class="tt-two">
         <div class="tt-field"><label>调到星期几</label>
           <select id="tt-a-wd">${TT_WD.map((w, i) => `<option value="${i + 1}"${i + 1 === curWd ? ' selected' : ''}>${w}</option>`).join('')}</select></div>
         <div class="tt-field"><label>教室（已带出原值，可改）</label>
           <input id="tt-a-room" type="text" value="${esc(curRoom)}" maxlength="100" /></div>
       </div>
       <div class="tt-two">
         <div class="tt-field"><label>从第几节</label><select id="tt-a-ps">${opts(curPs)}</select></div>
         <div class="tt-field"><label>到第几节</label><select id="tt-a-pe">${opts(curPe)}</select></div>
       </div>
     </div>
     <div class="tt-field" id="tt-a-note-wrap"><label>说明（只对「本节」有用）</label>
       <input id="tt-a-note" type="text" value="${esc((cur && cur.note) || '')}" placeholder="如：教室被占用 / 老师出差" maxlength="500" /></div>
     <div class="tt-tip" id="tt-a-hint"></div>
     ${cur ? '<div class="tt-tip"><button id="tt-a-undo" class="btn btn-subtle btn-sm" type="button">撤销第 ' + week + ' 周的调整</button></div>' : ''}`,
    '确定',
  );

  const root = $('#tt-modal-body');
  const hint = () => {
    const kind = root.querySelector('input[name="tt-a-kind"]:checked').value;
    const scope = root.querySelector('input[name="tt-a-scope"]:checked').value;
    const w = Number($('#tt-a-week').value) || 1;
    // ⭐ 「此后全部就不要显示调整到哪一周了」。两条都不谈目标周 ——
    //    · 此后全部 = 从这一周起把课次劈开，周次压根不变；
    //    · 停课 = 只是停掉这一次。
    //    ⇒ 那颗输入框直接收起来，内部也按「与源周相同」算（⛔ 不再靠禁用那几个单选来挡，
    //    那样「先填了第 8 周」就再也点不回此后全部了）。
    const showTo = kind === 'move' && scope === 'one';
    $('#tt-a-toweek-wrap').classList.toggle('hidden', !showTo);
    const tw = showTo ? Number($('#tt-a-toweek').value) || w : w;
    const cross = kind === 'move' && tw !== w;
    $('#tt-a-move').classList.toggle('hidden', kind === 'cancel');
    $('#tt-a-note-wrap').classList.toggle('hidden', scope === 'onward');
    $('#tt-a-hint').innerHTML =
      kind === 'cancel'
        ? `只停<b>第 ${w} 周</b>这一次；可在课表上方「调整」里撤销。`
        : scope === 'onward'
          ? `⚠️ <b>此后全部</b>：这条课次在第 ${w} 周处切成两条，第 ${w} 周起按新的来。`
          : cross
            ? `第 ${w} 周这一格会<b>变灰</b>并写明「调到第 ${tw} 周 …」；第 ${tw} 周多出这一次课（那边要空着）。`
            : `只影响<b>第 ${w} 周</b>这一次；可在课表上方「调整」里撤销。`;
  };
  root.querySelectorAll('input[name="tt-a-scope"],input[name="tt-a-kind"]').forEach((r) => {
    r.onchange = hint;
  });
  $('#tt-a-week').oninput = hint;
  $('#tt-a-toweek').oninput = hint;
  hint();
  const syncEnd = () => {
    if (Number($('#tt-a-pe').value) < Number($('#tt-a-ps').value)) $('#tt-a-pe').value = $('#tt-a-ps').value;
  };
  $('#tt-a-ps').onchange = syncEnd;
  if (cur) {
    $('#tt-a-undo').onclick = async () => {
      try {
        await api(
          'DELETE',
          `/api/timetable/courses/${cell.course_id}/sessions/${cell.session_id}/adjustments/${cur.week_no}`,
        );
        closeTtModal();
        await loadTtSchedule();
        toast('已撤销这次调课');
      } catch (e) {
        toast(e.message, true);
      }
    };
  }
  $('#tt-modal-ok').onclick = async () => {
    const scope = root.querySelector('input[name="tt-a-scope"]:checked').value;
    const kind = root.querySelector('input[name="tt-a-kind"]:checked').value;
    const w = Number($('#tt-a-week').value);
    if (!Number.isFinite(w) || w < 1 || w > totalWeeks) return toast(`第几周要在 1 到 ${totalWeeks} 之间`, true);
    // ⭐ 「此后全部」不谈目标周（输入框此时是收起的，见 `hint()`）⇒ 按源周算
    const tw = scope === 'one' ? Number($('#tt-a-toweek').value) || w : w;
    if (!Number.isFinite(tw) || tw < 1 || tw > totalWeeks) return toast(`调到第几周要在 1 到 ${totalWeeks} 之间`, true);
    const body = { kind };
    if (kind === 'move') {
      // ⭐ 跨周调课：只有「本节」才带目标周（与源周相同就不带 —— 同周换时间的老形态）
      if (scope === 'one' && tw !== w) body.to_week_no = tw;
      body.to_weekday = Number($('#tt-a-wd').value);
      body.to_period_start = Number($('#tt-a-ps').value);
      body.to_period_end = Number($('#tt-a-pe').value);
      body.to_room = $('#tt-a-room').value.trim();
    }
    try {
      if (scope === 'onward') {
        const r = await api(
          'POST',
          `/api/timetable/courses/${cell.course_id}/sessions/${cell.session_id}/onward`,
          Object.assign({ from_week: w }, body),
        );
        toast(
          r.cancelled
            ? '已从这一周起停课（这条课次整个删掉了）'
            : r.new_session_id
              ? `已切开：第 ${w - 1} 周及以前 ${r.weeks_before}，第 ${w} 周起 ${r.weeks_after}`
              : '已从这一周起改掉',
        );
      } else {
        body.week_no = w;
        body.note = $('#tt-a-note').value.trim();
        await api('PUT', `/api/timetable/courses/${cell.course_id}/sessions/${cell.session_id}/adjustments/${w}`, body);
        toast(
          kind === 'cancel'
            ? `第 ${w} 周已停课`
            : tw !== w
              ? `第 ${w} 周已调到第 ${tw} 周`
              : `第 ${w} 周已调到新的时间`,
        );
      }
      closeTtModal();
      await loadTtSchedule();
    } catch (e) {
      toast(e.message, true);
    }
  };
}
