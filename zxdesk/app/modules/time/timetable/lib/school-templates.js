'use strict';
/**
 * modules/timetable/lib/school-templates.js —— **高校模板**的唯一数据源（内置作息 + 内置课表版式）
 * 功能：把「某所学校长什么样」写成**数据**而不是代码 —— 每所学校两块：
 * ① `schedules`（**内置作息表**要的那份）：逐节时间，第 1 节 08:30–09:15、第 2 节 09:20–10:05……；
 * @author zx
 * @date   2026-09-13
 * @since 0.9.7
 * 相关：docs/公共/架构文档/06-课表.md、docs/公共/开发方案/09-模块化重构.md
 */

/**
 * 内置高校清单 —— **加一所学校就在数组里加一项**。
 *
 */
const SCHOOLS = [
  {
    code: 'cqu-renwen',
    school: '重庆人文科技学院',
    sort_order: 10,
    variants: [
      {
        campus: '',
        campus_label: '',
        total_weeks: 17,
        // 作息时间表原文：「周末、法定节假日等前一天，下午第一节课从 13:30 开始上课」
        // （平时下午第一节 14:00 → 13:30 = 提前 30 分钟；「几点之后算下午」用默认的 12:00）
        holiday_advance_minutes: 30,
        holiday_pm_from: '12:00',
        day_parts: [
          ['上午', 4],
          ['下午', 5],
          ['晚上', 3],
        ],
        schedule: [
          [1, '08:30', '09:15'],
          [2, '09:20', '10:05'],
          [3, '10:20', '11:05'],
          [4, '11:10', '11:55'],
          [5, '14:00', '14:45'],
          [6, '14:50', '15:35'],
          [7, '15:40', '16:25'],
          [8, '16:40', '17:25'],
          [9, '17:30', '18:15'],
          [10, '19:00', '19:45'],
          [11, '19:50', '20:35'],
          [12, '20:40', '21:25'],
        ],
        // 课表版式：教务系统导出的 .xls 里就是 5 个时段块（上午 2 + 2 / 下午 3 + 2 / 晚上 3）
        grid: {
          row_mode: 'block',
          rows: [
            ['上午', [1, 2]],
            ['上午', [3, 4]],
            ['下午', [5, 6, 7]],
            ['下午', [8, 9]],
            ['晚上', [10, 11, 12]],
          ],
        },
        source:
          '学校作息时间表（docs/fnos/课表数据/重庆人文科技学院/作息时间表图片）' +
          '＋ 教务系统「学生个人课表」导出文件里的时段块起止时间交叉核对',
        note: '上午 4 节 / 下午 5 节 / 晚上 3 节，全天 12 小节；每节 45 分钟、课间 5 分钟。',
      },
    ],
  },
  {
    code: 'cq-cust',
    school: '重庆城市科技学院',
    sort_order: 20,
    variants: [
      {
        campus: 'main',
        campus_label: '主教学楼',
        total_weeks: 17,
        holiday_advance_minutes: 0,
        holiday_pm_from: '',
        day_parts: [
          ['上午', 4],
          ['下午', 4],
          ['晚上', 2],
        ],
        schedule: [
          [1, '08:20', '09:05'],
          [2, '09:15', '10:00'],
          [3, '10:30', '11:15'],
          [4, '11:25', '12:10'],
          [5, '14:00', '14:45'],
          [6, '14:55', '15:40'],
          [7, '16:00', '16:45'],
          [8, '16:55', '17:40'],
          [9, '18:50', '19:35'],
          [10, '19:45', '20:30'],
        ],
        // 课表版式：这所学校的课表是「大节」行 —— 一行两小节（第一节 = 01-02 节）
        grid: {
          row_mode: 'big',
          rows: [
            ['第一节', [1, 2]],
            ['第二节', [3, 4]],
            ['第三节', [5, 6]],
            ['第四节', [7, 8]],
            ['第五节', [9, 10]],
          ],
        },
        source: '学校作息时间表（docs/fnos/课表数据/重庆城市科技学院/作息时间表图片，「主教学楼」一列）',
        note: '上午 4 节 / 下午 4 节 / 晚上 2 节，全天 10 小节；课表按「大节」排版（一行两小节）。',
      },
      {
        campus: 'other',
        campus_label: '其他教学楼',
        total_weeks: 17,
        holiday_advance_minutes: 0,
        holiday_pm_from: '',
        day_parts: [
          ['上午', 4],
          ['下午', 4],
          ['晚上', 2],
        ],
        schedule: [
          [1, '08:20', '09:05'],
          [2, '09:15', '10:00'],
          // 与「主教学楼」**只差第三、四节**（10:20/11:15 对 10:30/11:25）——
          [3, '10:20', '11:05'],
          [4, '11:15', '12:00'],
          [5, '14:00', '14:45'],
          [6, '14:55', '15:40'],
          [7, '16:00', '16:45'],
          [8, '16:55', '17:40'],
          [9, '18:50', '19:35'],
          [10, '19:45', '20:30'],
        ],
        grid: {
          row_mode: 'big',
          rows: [
            ['第一节', [1, 2]],
            ['第二节', [3, 4]],
            ['第三节', [5, 6]],
            ['第四节', [7, 8]],
            ['第五节', [9, 10]],
          ],
        },
        source: '学校作息时间表（docs/fnos/课表数据/重庆城市科技学院/作息时间表图片，「其他教学楼」一列）',
        note: '与「主教学楼」相比只有第三、四节不同（10:20–11:05 / 11:15–12:00）。',
      },
    ],
  },
  {
    code: 'cq-dzkj',
    school: '重庆电子科技职业大学',
    sort_order: 30,
    variants: [
      {
        campus: '',
        campus_label: '',
        total_weeks: 17,
        holiday_advance_minutes: 0,
        holiday_pm_from: '',
        day_parts: [
          ['上午', 4],
          ['下午', 4],
          ['晚上', 3],
        ],
        schedule: [
          [1, '08:30', '09:15'],
          [2, '09:20', '10:05'],
          [3, '10:25', '11:10'],
          [4, '11:15', '12:00'],
          [5, '14:00', '14:45'],
          [6, '14:50', '15:35'],
          [7, '15:55', '16:40'],
          [8, '16:45', '17:30'],
          [9, '18:30', '19:15'],
          [10, '19:20', '20:05'],
          [11, '20:10', '20:55'],
        ],
        // 课表版式：这所学校的时段块自己就写着节次范围（「1,2节」「9,10,11节」），照抄
        grid: {
          row_mode: 'block',
          rows: [
            ['1,2节', [1, 2]],
            ['3,4节', [3, 4]],
            ['5,6节', [5, 6]],
            ['7,8节', [7, 8]],
            ['9,10,11节', [9, 10, 11]],
          ],
        },
        source: '教务系统「学生个人课表」导出文件（docs/fnos/课表数据/重庆电子科技职业大学/*.xls）里的时段块起止时间',
        note: '上午 4 节 / 下午 4 节 / 晚上 3 节，全天 11 小节；每节 45 分钟、课间 5 分钟。',
      },
    ],
  },
];

/**
 * 功能：判断一个节次号落在哪个「时段」（上午 / 下午 / 晚上）里。
 *
 * 说明：时段边界由变体的 `day_parts` 顺序累加得出；没有 `day_parts` 时返回空串。
 *
 * @param {Object} variant - 变体对象（含 `day_parts`）
 */
function dayPartOf(variant, periodIndex) {
  const parts = Array.isArray(variant.day_parts) ? variant.day_parts : [];
  let acc = 0;
  for (const [name, count] of parts) {
    acc += Number(count) || 0;
    if (periodIndex <= acc) return String(name);
  }
  return parts.length ? String(parts[parts.length - 1][0]) : '';
}

/**
 * 功能：把内置数据摊成**内置作息表**（`time_timetable_school_schedules`）的一行行记录。
 *
 * 说明：一行 = 一所学校的某一个变体里的**某一节**（第 1 节一行、第 2 节一行……）。
 * 节次号全天连续、从 1 起 —— 与 `generatePeriods()`、`breaksFromBlocks()` 是同一套编号。
 *
 */
function scheduleRows() {
  const out = [];
  for (const s of SCHOOLS) {
    s.variants.forEach((v, vi) => {
      (v.schedule || []).forEach((row, i) => {
        const [no, start, end] = row;
        out.push({
          school_code: s.code,
          school_name: s.school,
          campus: v.campus || '',
          campus_label: v.campus_label || '',
          day_part: dayPartOf(v, no),
          period_index: Number(no),
          start_time: String(start),
          end_time: String(end),
          class_minutes: 45,
          break_minutes: 5,
          source: v.source || '',
          note: v.note || '',
          // `sort_order` 必须**全局唯一**：它同时决定了数据库的读出顺序，而
          // `seedSchoolTemplates()` 是拿「库里的顺序」与「数据源的顺序」逐行比对的 ——
          // 两个变体撞上同一个 sort_order，读回来就会交错，比对永远不等、每次启动都重写一遍。
          sort_order: (s.sort_order || 0) * 1000 + vi * 100 + i,
        });
      });
    });
  }
  return out;
}

/**
 * 功能：把内置数据摊成**内置课程表**（`time_timetable_school_grids`）的一行行记录。
 *
 * 说明：⭐ 一行 = 一所学校的一个变体（即**一个可选模板**）；表里**只有版式，没有任何课程**：
 * 一天画几行（`row_labels`）、每行罩着哪几节（`row_periods`）、默认学期周数、节假日前一天设置。
 *
 */
function gridRows() {
  const out = [];
  for (const s of SCHOOLS) {
    s.variants.forEach((v, vi) => {
      const g = v.grid || {};
      const rows = Array.isArray(g.rows) ? g.rows : [];
      out.push({
        school_code: s.code,
        school_name: s.school,
        campus: v.campus || '',
        campus_label: v.campus_label || '',
        name: v.campus_label ? `${s.school} · ${v.campus_label}` : s.school,
        row_mode: g.row_mode === 'big' ? 'big' : 'block',
        row_labels: JSON.stringify(rows.map((r) => String(r[0]))),
        row_periods: JSON.stringify(rows.map((r) => (r[1] || []).map(Number))),
        total_weeks: Number(v.total_weeks) || 17,
        weekdays: '1,2,3,4,5,6,7',
        holiday_advance_minutes: Number(v.holiday_advance_minutes) || 0,
        holiday_pm_from: v.holiday_pm_from || '',
        source: v.source || '',
        note: v.note || '',
        sort_order: (s.sort_order || 0) * 1000 + vi,
      });
    });
  }
  return out;
}

module.exports = {
  SCHOOLS,
  dayPartOf,
  scheduleRows,
  gridRows,
};
