import { readFileSync } from 'node:fs';

export const INQUIRY_HEADERS = Object.freeze(['商品名称','商品编号','咨询人数','询单人数','当日询单人数','询单转化率','当日询单转化率','当日付款人数','当日付款金额','延最终付款人数','延最终付款金额','延最终付款件数']);
const TARGET = Object.freeze({ 商品名称:'名称', 商品编号:'商品ID', 延最终付款人数:'最终付款人数', 延最终付款金额:'最终付款金额', 延最终付款件数:'最终付款件数' });
const NUMERIC = new Set(['咨询人数','当日询单人数','当日付款人数','当日付款金额']);

export function parseInquiryRows(rows, date, sourceShop) {
  // Excel may expose the Chinese BIFF labels as a legacy-codepage mojibake string
  // through xlrd/COM. The report contract is positional and its header is the
  // sixth used row, so require the stable 12-column shape as a fallback.
  const headerIndex = rows.findIndex((r) => INQUIRY_HEADERS.every((h, i) => String(r[i] ?? '').trim() === h));
  const fallback = headerIndex >= 0 ? headerIndex : rows.findIndex((r, i) => i >= 4 && r.length >= INQUIRY_HEADERS.length && String(r[1] ?? '').includes('���'));
  if (fallback < 0) throw new Error('询单报表缺少 12 列标准表头');
  const data = rows.slice(fallback + 1).filter((r) => r.length >= INQUIRY_HEADERS.length
    && r[1] && !['平均值','汇总值'].includes(String(r[0]).trim()) && String(r[1]).trim() !== '-');
  return data.map((row) => ({ header: INQUIRY_HEADERS, row: [date, ...row], sourceShop }));
}

export function buildInquiryFields(entry) {
  const [, ...row] = entry.row; const fields = { 数据日期: Date.UTC(...entry.row[0].split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v))) };
  INQUIRY_HEADERS.forEach((name, i) => {
    const target = TARGET[name] ?? name; const value = String(row[i] ?? '').trim();
    if (name === '商品名称' || name === '商品编号' || !NUMERIC.has(name)) fields[target] = value;
    else if (value !== '') fields[target] = Number(value.replaceAll(',', ''));
  });
  return fields;
}

export function inquiryKey(date, id) { return `${date}|${String(id)}`; }

export function planInquiryImport({ rows, existing = [] }) {
  const dateOf = (value) => new Date(Number(value)).toISOString().slice(0, 10);
  const existingKeys = new Set(existing.map((r) => inquiryKey(dateOf(r.fields?.['数据日期']), r.fields?.['商品ID'] ?? '')));
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
