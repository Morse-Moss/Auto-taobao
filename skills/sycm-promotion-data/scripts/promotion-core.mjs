// 飞书日期字段一律用「北京时间零点」。理由（2026-09-28 实测）：
// 「商品数据看板」里带日期条件的查找引用（关键词花费／人群花费等引用本表）要求两个日期字段的
// **时间戳精确相等**，而看板是人工维护的、三张底单 2026-09-01~09-19 的历史数据也都是北京时间零点。
// 原先写 `Date.UTC(y, m-1, d)`（世界时零点）比看板早 8 小时 ⇒ 看板上 09-23 起整天引用不到值。
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/** 北京时区某天的零点，返回飞书日期字段要的毫秒数。入参 month 为 1~12。 */
const toBeijingMidnight = (year, month, day) => Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS;

const PROMOTION_IDENTITY_FIELDS = Object.freeze(['日期', '场景ID', '原二级场景ID', '计划ID', '主体ID']);
export function promotionKey(row, headers) {
  const values = Array.isArray(row) ? Object.fromEntries(headers.map((name, index) => [name, row[index]])) : row;
  return JSON.stringify(PROMOTION_IDENTITY_FIELDS.map((name) => [
    name,
    name === '日期' && values[name] !== null && values[name] !== undefined
      ? (Number.isFinite(Number(values[name])) ? Number(values[name]) : values[name])
      : (values[name] === null || values[name] === undefined ? null : String(values[name])),
  ]));
}

export function validatePromotionReport(headers, rows, { date } = {}) {
  if (!Array.isArray(headers) || !headers.includes('日期') || !headers.includes('场景ID') || !headers.includes('计划ID')) {
    throw new Error('商品报表缺少日期/场景ID/计划ID表头');
  }
  if (![76, 78].includes(headers.length)) throw new Error(`不支持的商品报表列数: ${headers.length}`);
  // 「平台导出零数据」是一个**合法形态**，不是文件损坏（2026-10-21 加）。
  //
  // 现场：2026-10-20 网林家居的推广 ZIP 只有 596 B，解包后是「78 列表头 + 一个空行」，
  // 文件以 `\n\n` 结尾。Python `csv.reader` 会为这个空行产出一个**空数组 `[]`**，
  // 于是下面那条「行列数与表头不一致」把**一天的正常空数据**判成了坏文件 ——
  // 而且这个错在批量导入时会把整批（另外两家有数据的店）一起打掉。
  //
  // 判据必须区分三件事，它们的现场长得很像但处置完全不同：
  //   ① 零数据（本店当天没投放）⇒ 合法的空报表，写入 0 行、收据记 empty，**不算缺口**；
  //   ② 文件截断（真损坏）    ⇒ 该抛错，绝不能当成「今天没数据」静默吞掉；
  //   ③ 行内字段缺失          ⇒ 该抛错。
  // 所以「空」只在**每一行都是空行**时才成立：只要出现一行既有长度又不等于表头，
  // 就仍然走原来的抛错分支。空行本身不接受任何非零长度 —— 单行缺一半列的那种坏文件
  // 不可能拿到「空」这个免死金牌。
  const blank = (row) => !Array.isArray(row) || row.length === 0;
  if (rows.length > 0 && rows.every(blank)) {
    // 日期校验对空集恒真：没有行就没有「错日期的行」，不需要额外分支。
    return { columns: headers.length, rows: 0, empty: true, blankRows: rows.length };
  }
  // 混进空行也不接受：空行在中间意味着文件被截断或被追加了垃圾。
  const bad = rows.findIndex((row) => !Array.isArray(row) || row.length !== headers.length);
  if (bad >= 0) throw new Error(`商品报表第${bad + 2}行列数与表头不一致`);
  // 数据日期必须**逐行**等于目标日（2026-10-17 加）。
  // 为什么必须在这里钉，而不是「记一笔 observedDates 就算核对过了」：
  // ① 商品链的同日重跑会复用平台上已存在的任务（见 product-report-core 的 reuseCandidateTask），
  //    而任务名里只有提交时刻、看不出参数 ⇒ **同名任务完全可能装的是另一天的数据**；
  // ② 导入器本身不按日期过滤行（幂等键含日期，所以错日期的行会被当成「新数据」整批写进去）。
  // 少了这条，一次复用就能把 10-15 的推广数据写成 10-16 的，且收据上看不出任何异常。
  if (date !== undefined && date !== null) {
    const wrong = rows.findIndex((row) => String(row[0] ?? '').trim() !== date);
    if (wrong >= 0) {
      throw new Error(`商品报表数据日期不是目标日 ${date}：第${wrong + 1}行是 ${JSON.stringify(String(rows[wrong]?.[0] ?? ''))}`
        + '（复用平台任务时最可能出现；不许把别的日期的数据写进目标日）');
    }
  }
  return { columns: headers.length, rows: rows.length };
}
export function buildPromotionFields(headers, values, targetNames) {
  const fields = {};
  headers.forEach((name, i) => {
    const target = targetNames.includes(name) ? name : null; const value = values[i];
    if (!target || target.startsWith('字段 ')) return;
    if (target === '日期') { const [y, m, d] = String(value).split('-').map(Number); fields[target] = toBeijingMidnight(y, m, d); return; }
    if (value === '' || value === null || value === undefined) return;
    if (typeof value === 'number') fields[target] = value;
    else if (/^-?\d+(?:\.\d+)?$/u.test(String(value).trim()) && !['场景名字','原二级场景名字','计划名字','主体ID','主体类型','主体名称'].includes(target)) fields[target] = Number(value);
    else fields[target] = value;
  });
  return fields;
}
export function planPromotionImport({ rows, existing, headers, targetNames }) {
  const existingKeys = new Set(existing.map((r) => promotionKey(r.fields ?? {}, headers))); const seen = new Set(); const records=[]; const manifest=[];
  for (const row of rows) { const fields=buildPromotionFields(headers,row,targetNames); const key=promotionKey(fields, headers); if(existingKeys.has(key)||seen.has(key)) continue; seen.add(key); records.push(fields); manifest.push({key, date:fields['日期'], sceneId:fields['场景ID'], sourceFields:headers.length}); }
  return {records,manifest};
}
