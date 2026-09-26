import { readFileSync } from 'node:fs';

export const PRODUCT_HEADERS = Object.freeze(['统计日期','商品ID','商品名称','主商品ID','商品类型','货号','商品状态','商品标签','商品访客数','商品浏览量','平均停留时长','商品详情页跳出率','商品收藏人数','商品加购件数','商品加购人数','下单买家数','下单件数','下单金额','下单转化率','支付买家数','支付件数','支付金额','商品支付转化率','支付新买家数','支付老买家数','老买家支付金额','聚划算支付金额','访客平均价值','成功退款金额','竞争力评分','年累计支付金额','月累计支付金额','月累计支付件数','搜索引导支付转化率','搜索引导访客数','搜索引导支付买家数','结构化详情引导转化率','结构化详情引导成交占比']);
const NUMERIC_HEADERS = new Set(['主商品ID','商品访客数','商品浏览量','平均停留时长','商品收藏人数','商品加购件数','商品加购人数','下单买家数','下单件数','下单金额','支付买家数','支付件数','支付金额','支付新买家数','支付老买家数','老买家支付金额','聚划算支付金额','访客平均价值','成功退款金额','年累计支付金额','月累计支付金额','月累计支付件数','搜索引导访客数','搜索引导支付买家数']);
const TARGET_NAMES = Object.freeze({ 货号: '-', 商品状态: '当前在线' });

export function parseCsvRows(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < String(text).length; i += 1) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseProductCsv(text, sourceShop = null) {
  const rows = parseCsvRows(text);
  const headerIndex = rows.findIndex((row) => row.length === PRODUCT_HEADERS.length && row[0] === '统计日期');
  if (headerIndex < 0) throw new Error('商品报表缺少 38 列标准表头');
  const header = rows[headerIndex];
  if (header.join('\u0000') !== PRODUCT_HEADERS.join('\u0000')) throw new Error('商品报表表头与标准字段不一致');
  return rows.slice(headerIndex + 1).filter((row) => row.length >= PRODUCT_HEADERS.length)
    .map((row) => ({ header, row, sourceShop }));
}

export function readProductCsv(file, sourceShop) { return parseProductCsv(readFileSync(file, 'utf8'), sourceShop); }

export function buildProductFields(row, header = PRODUCT_HEADERS) {
  if (!Array.isArray(row) || row.length < PRODUCT_HEADERS.length) throw new Error('商品数据行列数不足');
  const fields = {};
  header.forEach((name, index) => {
    const value = row[index]; const target = TARGET_NAMES[name] ?? name;
    if (name === '统计日期') { const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/u); if (!match) throw new Error(`无效统计日期: ${value}`); fields[target] = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])); }
    else if (name === '商品类型' || name === '商品标签') return;
    else if (NUMERIC_HEADERS.has(name)) { if (value === '-' || value === '') return; const number = Number(String(value).replaceAll(',', '')); if (!Number.isFinite(number)) throw new Error(`数字字段无法解析: ${name}=${value}`); fields[target] = number; }
    else fields[target] = value;
  });
  return fields;
}

export function productKey(date, productId) { return `${date}|${productId}`; }

export function planProductImport({ rows, existing = [], shopForProduct = () => '' }) {
  const existingKeys = new Set(existing.map(({ fields = {} }) => productKey(new Date(Number(fields['统计日期'] ?? 0)).toISOString().slice(0, 10), String(fields['商品ID'] ?? ''))));
  const records = []; const manifest = []; const seen = new Set();
  for (const entry of rows) {
    const shop = entry.sourceShop; if (!shop) throw new Error(`商品 ${entry.row[1]} 缺少来源店铺`);
    const date = entry.row[0]; const id = String(entry.row[1]); const key = productKey(date, id);
    if (existingKeys.has(key) || seen.has(key)) continue;
    seen.add(key); records.push(buildProductFields(entry.row, entry.header)); manifest.push({ date, shop, productId: id });
  }
  return { records, manifest };
}
