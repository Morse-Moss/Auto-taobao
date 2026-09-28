import { readFileSync } from 'node:fs';

export const INQUIRY_HEADERS = Object.freeze(['商品名称','商品编号','咨询人数','询单人数','当日询单人数','询单转化率','当日询单转化率','当日付款人数','当日付款金额','延最终付款人数','延最终付款金额','延最终付款件数']);
const TARGET = Object.freeze({ 商品名称:'名称', 商品编号:'商品ID', 延最终付款人数:'最终付款人数', 延最终付款金额:'最终付款金额', 延最终付款件数:'最终付款件数' });
const NUMERIC = new Set(['咨询人数','当日询单人数','当日付款人数','当日付款金额']);

// 飞书日期字段一律用「北京时间零点」。理由（2026-09-28 实测）：
// 「商品数据看板」里带日期条件的查找引用要求两个日期字段的**时间戳精确相等**，而看板是人工维护的
// （全仓无代码写它）、两张底单 2026-09-01~09-19 的历史数据也都是北京时间零点。
// 原先写 `Date.UTC(y, m-1, d)`（世界时零点）比看板早 8 小时 ⇒ 看板上 09-23 起整天引用不到值。
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

/** 北京时区某天的零点，返回飞书日期字段要的毫秒数。入参 month 为 1~12。 */
const toBeijingMidnight = (year, month, day) => Date.UTC(year, month - 1, day) - BEIJING_OFFSET_MS;

/** 把飞书返回的日期时间戳读成 `YYYY-MM-DD`。加 8 小时对「北京零点」与「世界时零点」两种存法都读得对。 */
const readBeijingDay = (value) => new Date(Number(value) + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

// 同一列在导出侧出现过两种写法。**必须都认**，理由是实测出来的（2026-09-27）：
//   · 仓库里 2026-09-23 存档的原始导出 `evidence/product-inquiry-2026-09-23/gaiwen-*.xls`
//     （契约就是照着它写的）真实列名是 `最终付款人数/最终付款金额/最终付款件数`，**没有「延」**；
//   · 2026-09-26 新采的五份导出，列名同样是这三个无「延」写法。
// 那么契约里的「延」从哪来？它是那一次「跑通」时的产物：当时走 xlrd 读、中文 BIFF 标签变成乱码，
// 匹配命中的是下面 ③ 那个「第 6 个使用行 + 12 列形状」的兜底（形状对得上，真列名根本没被读出来）。
// 于是这条链一直「能跑」，直到 2026-09-26 的机器上 COM（pywin32）可用、中文被正确解出来 ⇒
// 逐字匹配与乱码兜底同时失效 ⇒ 五家店询单全灭（报「缺少 12 列标准表头」）。
// 注意：别名只影响**识别**；写回飞书的列序与目标字段仍由 INQUIRY_HEADERS / TARGET 决定，不受影响。
const HEADER_ALIASES = Object.freeze({
  延最终付款人数: ['延最终付款人数', '最终付款人数'],
  延最终付款金额: ['延最终付款金额', '最终付款金额'],
  延最终付款件数: ['延最终付款件数', '最终付款件数'],
});

/** 某一行是不是契约表头（逐列接受该列的任一别名写法）。导出侧换个写法不该让整条链停摆。 */
export function headerMatches(row) {
  return INQUIRY_HEADERS.every((name, index) => (HEADER_ALIASES[name] ?? [name]).includes(String(row[index] ?? '').trim()));
}

export function parseInquiryRows(rows, date, sourceShop) {
  const headerIndex = rows.findIndex(headerMatches);
  // 乱码兜底：xlrd 路径下中文 BIFF 标签会变成 `���…`，那时只能靠形状认。
  const fallback = headerIndex >= 0 ? headerIndex : rows.findIndex((r, i) => i >= 4 && r.length >= INQUIRY_HEADERS.length && String(r[1] ?? '').includes('���'));
  // 失败时把**实际看到的表头**带出去：上一版只报「缺少 12 列标准表头」，
  // 于是「到底是列名变了、还是采到了另一张表」只能靠人重新解一遍文件才知道（2026-09-27 就是这么被卡住的）。
  if (fallback < 0) {
    const seen = rows.find((r) => String(r[0] ?? '').trim() === '商品名称' && r.length >= 6) ?? [];
    throw new Error(`询单报表缺少 12 列标准表头：实际表头=${JSON.stringify(seen.map((value) => String(value)))}`);
  }
  const data = rows.slice(fallback + 1).filter((r) => r.length >= INQUIRY_HEADERS.length
    && r[1] && !['平均值','汇总值'].includes(String(r[0]).trim()) && String(r[1]).trim() !== '-');
  return data.map((row) => ({ header: INQUIRY_HEADERS, row: [date, ...row], sourceShop }));
}

export function buildInquiryFields(entry) {
  const [, ...row] = entry.row;
  const [year, month, day] = String(entry.row[0]).split('-').map(Number);
  const fields = { 数据日期: toBeijingMidnight(year, month, day) };
  INQUIRY_HEADERS.forEach((name, i) => {
    const target = TARGET[name] ?? name; const value = String(row[i] ?? '').trim();
    if (name === '商品名称' || name === '商品编号' || !NUMERIC.has(name)) fields[target] = value;
    else if (value !== '') fields[target] = Number(value.replaceAll(',', ''));
  });
  return fields;
}

export function inquiryKey(date, id) { return `${date}|${String(id)}`; }

export function planInquiryImport({ rows, existing = [] }) {
  const existingKeys = new Set(existing.map((r) => inquiryKey(readBeijingDay(r.fields?.['数据日期']), r.fields?.['商品ID'] ?? '')));
  const seen = new Set(); const records = []; const manifest = [];
  for (const entry of rows) {
    const key = inquiryKey(entry.row[0], entry.row[2]);
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key); const fields = buildInquiryFields(entry);
    const prior = existing.find((r) => String(r.fields?.['商品ID'] ?? '') === String(entry.row[2]));
    if (prior?.fields?.名称 && String(fields.名称).includes('�')) fields.名称 = prior.fields.名称;
    records.push(fields); manifest.push({ date: entry.row[0], productId: String(entry.row[2]), shop: entry.sourceShop });
  }
  return { records, manifest };
}

export function readInquiryRows(file, date, sourceShop, readXls) { return parseInquiryRows(readXls(file), date, sourceShop); }
