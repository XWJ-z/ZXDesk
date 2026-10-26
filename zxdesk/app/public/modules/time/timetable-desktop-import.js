/**
 * modules/timetable/desktop-import.js —— 课表**导入向导**（三步：选文件 → 预览校对 → 确认入库）
 *
 * 功能：`openTtImport` 起流程并渲染第一步；`ttImportStep1` / `ttImportStep2` / `ttImportStep3`
 *      分别是选文件、预览校对、确认入库三屏；`ttPreview` 上传并解析、`ttReportHtml` 出体检报告、
 *      `ttDraftBlocksHtml` 渲染可编辑的时段块草稿、`ttReadBlockInputs` 把用户改动读回来、
 *      `ttShowReplaceWarn` 在覆盖导入前先告诉他「会删掉多少」。
 *
 * ⚠️ 0.2.0（002 报告 §5.1 ③）从课表主视图拆出，且**只在用户点「导入」时被动态加载**
 *    （`await import('./timetable-desktop-import.js')`）—— 首屏不请求本文件，模块清单里也**不放**它。
 * ⚠️ 覆盖导入前必须让人看到「会删掉多少」；体检报告里**没导进去的东西都要有一条带理由的记录**。
 *
 * ⭐ 0.5.0 模块化重构：本文件从 `public/desktop/views/timetable-import.js` **原样搬进模块目录**
 *    （方案 `09-模块化重构` §七，纯搬运不改逻辑）。只改了 import 的相对路径与静态依赖的
 *    目标（`./timetable.js` → `./timetable-desktop.js`）。**它仍然只在点「导入」时被动态加载**、不进 `modulepreload`。
 *
 * @author zx
 * @date   2026-09-12
 * @since 0.8.33
 * 相关：docs/公共/架构文档/06-课表.md、docs/公共/开发方案/09-模块化重构.md
 */
import { api, backToLogin, BASE } from '../../core/api.js';
import { $, esc } from '../../core/dom.js';
import { state } from '../../desktop/state.js';
import { toast } from '../../desktop/ui.js';
import {
  TT_MAX_UPLOAD,
  TT_WD,
  closeTtModal,
  openTimetable,
  openTtModal,
  ttDraftBlocksHtml,
  ttReadBlockInputs,
  ttTermOptions,
} from './timetable-desktop.js';

/** 高校模板在界面上的键：`学校代码|变体`（变体可为空串） */
const TT_TPL_SEP = '|';

/**
 * 功能：把一条模板清单项转成界面用的键。
 * @param {Object} t - 模板清单项（含 `code` / `campus`）
 * @returns {string} 形如 `cq-cust|main` 的键
 */
function ttTplKey(t) {
  return `${t.code}${TT_TPL_SEP}${t.campus || ''}`;
}

/**
 * 功能：把界面上的键拆回「学校代码 + 变体」。
 * @param {string} key - 形如 `cq-cust|main` 的键
 * @returns {{code: string, campus: string}} 拆开后的两项；格式不对时两项都为空串
 */
function ttTplSplit(key) {
  const i = String(key || '').indexOf(TT_TPL_SEP);
  if (i < 0) return { code: '', campus: '' };
  return { code: String(key).slice(0, i), campus: String(key).slice(i + 1) };
}

/**
 * 功能：按需拉一次**内置高校模板清单**（进导入向导时才拉，首屏不请求）。
 * 说明：失败只把清单留空并给一句提示，**绝不打断「上传课表文件」那条路** ——
 *      模板是锦上添花，文件导入才是主路径，不能因为一个可选功能把主路径一起弄挂。
 * @returns {Promise.<Array.<Object>>} 模板清单（取不到时为空数组）
 */
async function ttLoadTemplates() {
  if (state.ttTemplates.length) return state.ttTemplates;
  try {
    const r = await api('GET', '/api/timetable/templates');
    state.ttTemplates = (r && r.templates) || [];
  } catch (_e) {
    state.ttTemplates = [];
  }
  return state.ttTemplates;
}

/**
 * 功能：生成高校模板下拉的 `<option>` 列表。
 * @param {string} selected - 当前选中的键
 * @returns {string} 选项 HTML
 */
function ttTemplateOptions(selected) {
  if (!state.ttTemplates.length) return '<option value="">（暂时读不到高校模板）</option>';
  return state.ttTemplates
    .map((t) => {
      const key = ttTplKey(t);
      const parts = (t.day_parts || []).map((d) => `${d.label}${d.count}`).join('/');
      const label = `${t.name} · ${t.periods} 小节${parts ? '（' + parts + '）' : ''}`;
      return `<option value="${esc(key)}"${key === selected ? ' selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

/**
 * 功能：把选中那条模板的出处与说明写进下方的提示框（并同步「几行 / 几节」）。
 * 说明：⚠️ 模板是内置数据，**必须把出处摊开给用户看** —— 作息是照着上课的东西，
 *      猜错一次就是一学期的事，用户有权知道这份数据是从哪来的。
 * @returns {void}
 */
function ttSyncTplNote() {
  const box = $('#tt-tpl-note');
  if (!box) return;
  const { code, campus } = ttTplSplit(($('#tt-tpl') || {}).value || '');
  const t = state.ttTemplates.find((x) => x.code === code && (x.campus || '') === campus);
  if (!t) {
    box.textContent = '';
    return;
  }
  const rows = (t.row_labels || []).join(' / ');
  box.innerHTML =
    `${esc(t.periods)} 个小节 · 课表画 <b>${esc(rows)}</b> ${t.blocks} 行 · 默认 ${t.total_weeks} 周` +
    (t.holiday_advance_minutes
      ? `<br>节假日前一天下午提前 <b>${t.holiday_advance_minutes} 分钟</b>（可在学期设置里改）`
      : '') +
    `<br><span class="ttu">数据出处：${esc(t.source || '—')}</span>`;
}

/**
 * 功能：初始化导入向导的暂存状态，并打开第 1 步弹窗。
 * 说明：已有学期时默认「覆盖本学期」，没有学期时默认「新建学期」；
 *      ⭐ 0.3.5 起第 1 步多了一个「来源」选择 —— **上传课表文件**（原来的唯一路径）或
 *      **选一所内置高校模板**（只给你这所学校的作息与课表版式，不含课程）。
 * @returns {void}
 */
export function openTtImport() {
  state.ttWizard = {
    step: 1,
    source: 'file', // 'file' 上传文件 | 'template' 高校模板
    file: null,
    templateKey: '',
    mode: state.ttTerms.length ? 'replace' : 'new',
    termId: state.ttTermId || (state.ttTerms[0] && state.ttTerms[0].id) || null,
    preview: null,
    flat: null,
    counts: null,
  };
  ttImportStep1();
  // 清单只在第一次进向导时拉；到了就地重画第 1 步（文件已选的话会被清掉，所以放在最前面拉）
  if (!state.ttTemplates.length) {
    ttLoadTemplates().then(() => {
      const w = state.ttWizard;
      if (w && w.step === 1 && !w.file) ttImportStep1();
    });
  }
}

/**
 * 功能：渲染导入向导第 1 步：选来源（文件 / 高校模板）、选导入方式、选目标学期，并请求服务端预览。
 * 说明：确认前先在本地拦一次文件体积 —— 服务端的 413 是兜底，
 *      能在本地说清楚就别让用户白等一次往返。
 * @returns {void}
 */
export function ttImportStep1() {
  const w = state.ttWizard;
  const byTpl = w.source === 'template';
  if (!w.templateKey && state.ttTemplates.length) w.templateKey = ttTplKey(state.ttTemplates[0]);
  openTtModal(
    '导入课表 · 第 1 步 / 3',
    `
    <div class="tt-field">
      <label>从哪来</label>
      <div class="tt-radios">
        <label><input type="radio" name="tt-src" value="file"${!byTpl ? ' checked' : ''} /> 上传课表文件（教务系统导出）</label>
        <label><input type="radio" name="tt-src" value="template"${byTpl ? ' checked' : ''} /> 选一所高校模板（只要作息，课程自己加）</label>
      </div>
    </div>
    <div class="tt-field" id="tt-file-wrap"${byTpl ? ' style="display:none"' : ''}>
      <label>课表文件</label>
      <input id="tt-file" type="file" accept=".xls,.csv,.txt,.tsv" />
      <div class="tt-tip">支持 <b>.xls</b>（Excel 97-2003）与 <b>CSV / TSV</b>；.xlsx 请先另存为 .xls 或 CSV UTF-8。</div>
    </div>
    <div class="tt-field" id="tt-tpl-wrap"${byTpl ? '' : ' style="display:none"'}>
      <label>高校模板</label>
      <select id="tt-tpl">${ttTemplateOptions(w.templateKey)}</select>
      <div class="tt-tip" id="tt-tpl-note"></div>
      <div class="tt-tip">⚠️ 模板<b>只有作息与版式、没有课程</b>，课程请在「⚙ 设置 → 课程管理」里加。</div>
    </div>
    <div class="tt-field">
      <label>导入方式</label>
      <div class="tt-radios">
        <label><input type="radio" name="tt-mode" value="new"${w.mode === 'new' ? ' checked' : ''} /> 新建学期（旧课表原样保留）</label>
        <label><input type="radio" name="tt-mode" value="replace"${w.mode === 'replace' ? ' checked' : ''} /> 覆盖本学期（⚠️ 先清空）</label>
        <label><input type="radio" name="tt-mode" value="append"${w.mode === 'append' ? ' checked' : ''} /> 追加（只加不重复的）</label>
      </div>
    </div>
    <div class="tt-field" id="tt-target-wrap"${w.mode === 'new' ? ' style="display:none"' : ''}>
      <label>目标学期</label>
      <select id="tt-target">${ttTermOptions(w.termId)}</select>
      <div class="tt-tip" id="tt-replace-warn"></div>
    </div>
    <div class="tt-tip">没有课表？先 <a href="/api/timetable/template.csv" download>下载 CSV 模板</a> 填一份再上传。</div>
  `,
    '预览',
  );
  $('#tt-file').addEventListener('change', (e) => {
    w.file = (e.target.files && e.target.files[0]) || null;
  });
  $('#tt-tpl').addEventListener('change', (e) => {
    w.templateKey = e.target.value;
    ttSyncTplNote();
  });
  ttSyncTplNote();
  /**
   * 功能：按当前导入方式同步界面：新建时隐藏目标学期，覆盖时刷新「会删掉多少」的警告文案。
   * @returns {void}
   */
  const syncMode = () => {
    $('#tt-target-wrap').style.display = w.mode === 'new' ? 'none' : 'block';
    if (w.mode === 'replace' && w.termId) ttShowReplaceWarn(w.termId);
    else $('#tt-replace-warn').textContent = '';
  };
  document.querySelectorAll('input[name=tt-mode]').forEach((r) =>
    r.addEventListener('change', () => {
      w.mode = r.value;
      syncMode();
    }),
  );
  document.querySelectorAll('input[name=tt-src]').forEach((r) =>
    r.addEventListener('change', () => {
      w.source = r.value;
      // ⚠️ 只切两块区域的显隐，**不整屏重画** —— 重画会把已经选好的文件清掉
      $('#tt-file-wrap').style.display = w.source === 'file' ? 'block' : 'none';
      $('#tt-tpl-wrap').style.display = w.source === 'template' ? 'block' : 'none';
    }),
  );
  $('#tt-target').addEventListener('change', (e) => {
    w.termId = Number(e.target.value);
    syncMode();
  });
  syncMode();

  $('#tt-modal-ok').onclick = async () => {
    try {
      if (w.mode !== 'new') w.termId = Number($('#tt-target').value);
      if (w.source === 'template') {
        const { code, campus } = ttTplSplit($('#tt-tpl').value);
        if (!code) return toast('请先选一所高校模板', true);
        $('#tt-modal-ok').disabled = true;
        toast('正在读取模板…');
        w.preview = await api(
          'GET',
          `/api/timetable/templates/draft?code=${encodeURIComponent(code)}&campus=${encodeURIComponent(campus)}`,
        );
      } else {
        if (!w.file) return toast('请先选择课表文件', true);
        // ⚠️ 先在本地拦一次体积：服务端的 413 是兜底，能在本地说清楚就别让用户等一次往返
        if (w.file.size > TT_MAX_UPLOAD) {
          return toast('文件太大（上限 2MB）。课表文件一般只有几十 KB，请确认选对了文件。', true);
        }
        $('#tt-modal-ok').disabled = true;
        toast('正在解析文件…');
        w.preview = await ttPreview(w.file);
      }
      w.flat = [];
      w.preview.draft.courses.forEach((c) =>
        c.sessions.forEach((s) => w.flat.push({ course: c.name, teacher: c.teacher, session: s })),
      );
      ttImportStep2();
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('#tt-modal-ok').disabled = false;
    }
  };
}

/**
 * 功能：统计指定学期现有的课程门数与课次条数，写进覆盖导入的警告框。
 * 说明：覆盖导入前必须让用户看到「会删掉多少」（不写数字的确认框等于没确认）；
 *      统计失败时清空提示，不阻断导入流程。
 * @param {number} termId - 要统计的学期 id
 * @returns {Promise.<void>}
 */
export async function ttShowReplaceWarn(termId) {
  const box = $('#tt-replace-warn');
  box.textContent = '正在统计本学期现有数据…';
  try {
    const sch = await api('GET', `/api/timetable/terms/${termId}/schedule`);
    const n = new Set(sch.cells.map((c) => c.course_id)).size;
    box.innerHTML = `⚠️ 覆盖会先<b>删除本学期现有的 ${n} 门课 / ${sch.cells.length} 条课次</b>，再写入新数据。`;
  } catch (_e) {
    box.textContent = '';
  }
}

/**
 * 功能：把课表文件直传服务端预览接口，取回解析草稿与体检报告（不写库）。
 * 说明：这里不走 `api()` —— 预览接口要发二进制请求体，只能用 `fetch()` 自己处理；
 *      遇到 401 直接回登录页，避免用户停在一个看起来「卡住」的页面上。
 * @param {File} file - 用户选择的课表文件
 * @returns {Promise.<Object>} 服务端解析出的预览数据
 * @throws {Error} 登录过期或服务端返回非 2xx 时抛出；后者在错误对象上附带服务端返回的 `saw` 诊断信息
 */
export async function ttPreview(file) {
  const res = await fetch(BASE + '/api/timetable/import/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const j = await res.json().catch(() => null);
  if (res.status === 401) {
    backToLogin();
    throw new Error('登录已过期，正在回到登录页…');
  }
  if (!res.ok) {
    const e = new Error((j && j.error) || 'HTTP ' + res.status);
    e.saw = j && j.saw;
    throw e;
  }
  return j;
}

/**
 * 功能：把导入解析的体检报告渲染成一串键值行：文件概况、作息总量、解析结果、作息判定，
 *      再按需追加教师职称归一化、备注里的网格外课程、未识别条目与各类提示。
 * 说明：凡是"没导进去的东西"都要有一条带理由的记录（见方案 §8.9）。
 * @param {Object} g - 服务端返回的诊断数据
 * @returns {string} 体检报告区的 HTML
 */
export function ttReportHtml(g) {
  const conf = { high: '✅ 两个信号一致', medium: '⚠️ 有多组可能，已选最接近常规的', low: '⚠️ 存疑，请人工确认' };
  const byTemplate = g.source === 'template';
  const rows = [
    byTemplate
      ? ['模板', `${esc(g.sheetName)} · ${g.periods} 个小节 / ${g.blocks} 个时段块`]
      : [
          '文件',
          `${esc(String(g.source).toUpperCase())} · 工作表「${esc(g.sheetName)}」 · ${g.rows} 行 × ${g.cols} 列`,
        ],
    [
      '作息',
      `${g.blocks} 个时段块 / ${g.periods} 个小节 · 每节 ${g.schedule.classMinutes} 分钟 · 课间 ${g.schedule.breakMinutes} 分钟`,
    ],
    byTemplate
      ? ['结果', '内置模板不含课程，导入后是一个<b>有作息、没有课</b>的学期']
      : ['结果', `${g.courses} 门课 / ${g.sessions} 条课次（原始 ${g.rawEntries} 条，合并重复 ${g.duplicates} 条）`],
    ['作息判定', `${conf[g.schedule.confidence] || g.schedule.confidence}：${esc(g.schedule.note)}`],
  ];
  if (g.teacherTitlesOmitted) rows.push(['已归一化', `教师职称已省略（${g.teacherTitlesOmitted} 位）`]);
  if (g.remarkExtra.length) {
    rows.push([
      '备注里的网格外课程',
      `${g.remarkExtra.map(esc).join('、')} —— 已按原文保留在学期备注里，<b>未生成课次</b>`,
    ]);
  }
  if (g.unparsed.length) rows.push(['⚠️ 未识别', `${g.unparsed.length} 条（见下方清单，不会导入）`]);
  (g.warnings || []).forEach((x) => rows.push(['提示', esc(x)]));
  return `<div class="tt-report">${rows
    .map(([k, v]) => `<div class="tt-report-row"><span>${k}</span><div>${v}</div></div>`)
    .join('')}</div>`;
}

/**
 * 功能：渲染导入向导第 2 步：体检报告 + 学期名与开学日期 + 作息校对 + 课次勾选，
 *      并在确认时把用户的校对结果组装成载荷提交入库。
 * 说明：用户改过作息就提交空的 periods，让服务端按块重排逐节时间（periods 是纯派生物）；
 *      课次按「课程名」归并，同一门课的多个课次收进同一个 courses 条目。
 * @returns {void}
 */
export function ttImportStep2() {
  const w = state.ttWizard;
  const d = w.preview.draft;
  const total = w.flat.length;
  const byDay = [1, 2, 3, 4, 5, 6, 7]
    .map((wd) => {
      const list = w.flat
        .map((it, i) => ({ it, i }))
        .filter((x) => x.it.session.weekday === wd)
        .sort((a, b) => a.it.session.period_start - b.it.session.period_start);
      if (!list.length) return '';
      return `<div class="tt-ds-day"><h5>${TT_WD[wd - 1]}</h5>${list
        .map(
          (x) => `<label class="tt-ds-row">
        <input type="checkbox" data-i="${x.i}" checked />
        <span class="tt-ds-p">${String(x.it.session.period_start).padStart(2, '0')}–${String(
          x.it.session.period_end,
        ).padStart(2, '0')} 节</span>
        <span class="tt-ds-c">${esc(x.it.course)}</span>
        <span class="tt-ds-m">${esc(x.it.session.weeks)}周 · ${esc(x.it.session.room || '')}</span>
      </label>`,
        )
        .join('')}</div>`;
    })
    .join('');

  openTtModal(
    '预览与校对 · 第 2 步 / 3',
    `
    ${ttReportHtml(w.preview.diagnostics)}
    <div class="tt-two">
      <div class="tt-field">
        <label>学期名</label>
        <input id="tt-d-name" type="text" value="${esc(d.term.name)}" />
      </div>
      <div class="tt-field">
        <label>第 1 周星期一</label>
        <input id="tt-d-start" type="date" value="${esc(d.term.start_monday || '')}" />
      </div>
    </div>
    <div class="tt-tip">${
      d.term.start_monday_guessed
        ? `${w.source === 'template' ? '模板' : '文件'}里没有开学日期，上面<b>按今天猜的</b>，请按实际改。`
        : '文件里没有开学日期，可留空（但标不出「本周」）。'
    }</div>
    <div class="tt-field">
      <label>作息（${w.source === 'template' ? '来自内置模板' : '已从文件识别'}，可改）</label>
      ${ttDraftBlocksHtml(d.blocks)}
    </div>
    <div class="tt-field">
      <label>课次（共 ${total} 条，取消勾选即可不要）</label>
      <div class="tt-ds">${
        byDay ||
        (w.source === 'template'
          ? '<div class="es-text">模板不含课程 —— 导入后去「⚙ 设置 → 课程管理」加课。</div>'
          : '<div class="es-text">没有解析出任何课次</div>')
      }</div>
    </div>
  `,
    '确认导入',
  );

  $('#tt-modal-ok').onclick = async () => {
    try {
      const blocks = ttReadBlockInputs($('#tt-modal-body'));
      const changed = JSON.stringify(blocks) !== JSON.stringify(d.blocks);
      const keep = new Set(
        [...document.querySelectorAll('#tt-modal-body input[type=checkbox]')]
          .filter((x) => x.checked)
          .map((x) => Number(x.dataset.i)),
      );
      const courses = [];
      w.flat.forEach((it, i) => {
        if (!keep.has(i)) return;
        let c = courses.find((x) => x.name === it.course);
        if (!c) {
          c = { name: it.course, teacher: it.teacher || '', sessions: [] };
          courses.push(c);
        }
        c.sessions.push(it.session);
      });
      // ⭐ 模板来源**允许一条课次都没有**（它本来就只带作息）；文件来源仍然要求至少一条 ——
      // 文件解析出 0 条课次说明这份文件不是课表，放它过去只会造出一个空学期。
      if (!courses.length && w.source !== 'template') return toast('至少要保留一条课次', true);
      const payload = {
        mode: w.mode,
        term_id: w.mode === 'new' ? undefined : w.termId,
        term: {
          name: $('#tt-d-name').value.trim() || d.term.name,
          start_monday: $('#tt-d-start').value || '',
          total_weeks: d.term.total_weeks,
          remark: d.term.remark,
          meta: d.term.meta,
          // ⭐ 高校模板会带「节假日前一天下午提前」（人文科技学院就是提前 30 分钟）——
          //    它在学期设置里可改，但**不在第 2 步的界面上**，所以必须原样透传，
          //    否则「选了模板」与「这所学校的真实作息」会差这一条，而且不报错。
          holiday_advance_minutes: d.term.holiday_advance_minutes || 0,
          holiday_pm_from: d.term.holiday_pm_from || '',
        },
        blocks,
        // 用户改过作息 → 让服务端按块重排逐节时间（periods 是纯派生物）
        periods: changed ? [] : d.periods,
        courses,
      };
      $('#tt-modal-ok').disabled = true;
      const r = await api('POST', '/api/timetable/import/commit', payload);
      state.ttTermId = r.term_id;
      ttImportStep3(
        r,
        courses.reduce((a, c) => a + c.sessions.length, 0),
      );
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('#tt-modal-ok').disabled = false;
    }
  };
}

/**
 * 功能：渲染导入向导第 3 步：展示本次导入的结果（学期 / 课程 / 课次 / 时段块与小节），
 *      确认后关闭弹窗并跳到刚导入的学期。
 * @param {Object} r - 服务端导入接口的返回结果
 * @param {number} kept - 用户在第 2 步实际勾选保留的课次条数
 * @returns {void}
 */
export function ttImportStep3(r, kept) {
  const fromTemplate = !!(state.ttWizard && state.ttWizard.source === 'template');
  openTtModal(
    '导入完成 · 第 3 步 / 3',
    `<div class="tt-done">
      <div class="tt-done-ico">✅</div>
      <h3>导入完成</h3>
      <dl class="kv-grid">
        <dt>学期</dt><dd>${esc((state.ttTerms.find((t) => t.id === r.term_id) || {}).name || '')}</dd>
        <dt>课程</dt><dd>${r.courses} 门</dd>
        <dt>课次</dt><dd>${r.sessions} 条${kept !== r.sessions ? `（你保留了 ${kept} 条中的 ${r.sessions} 条）` : ''}</dd>
        <dt>时段块 / 小节</dt><dd>${r.blocks} / ${r.periods}</dd>
        ${r.dropped ? `<dt>已跳过重复</dt><dd>${r.dropped} 条</dd>` : ''}
      </dl>
      ${
        fromTemplate
          ? '<div class="tt-tip">模板只带作息与版式，课表是空的；去「⚙ 设置 → 课程管理」加课。</div>'
          : ''
      }
    </div>`,
    '看课表',
  );
  $('#tt-modal-ok').onclick = async () => {
    closeTtModal();
    await openTimetable(r.term_id);
  };
}
