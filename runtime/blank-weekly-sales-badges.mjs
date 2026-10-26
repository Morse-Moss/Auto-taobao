// 把「月收货人数」里的徽标文案从计数列摘出去（留空），原文落到 sidecar 留证。
//
// 为什么必须摘：下游 import-core 的 numericValue 对这个列是强校验，
// 「本月行业热销」「行业销量Top3」会抛 SOURCE_VALUE_INVALID 让整批导入失败。
// 为什么不能折算成数字：徽标是「有没有进榜」，不是「卖了多少」，前20→20 属于编造。
// 为什么不能留在列里：目标字段虽是文本，但下游公式（月收货金额、客单价带分类）
// 会拿这一列做乘法，塞文案只会得到错误而不是空白。
//
// 只动这一列，其余逐格不动——写后回读逐格 diff 自证。
import fs from 'node:fs';
import path from 'node:path';
import { extractSalesBadges, isCountLike, parseCsv, toCsv } from './taobao-search-core.mjs';

const [, , csvPath, badgesOut] = process.argv;
if (!csvPath) {
  console.error('用法：node runtime/blank-weekly-sales-badges.mjs <csv> [badges.json]');
  process.exit(2);
}

const table = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const headers = table[0];
const columnIndex = headers.indexOf('月收货人数');
const serialIndex = headers.indexOf('序号');
const linkIndex = headers.indexOf('商品链接');
if (columnIndex < 0) throw new Error('CSV 缺少「月收货人数」列');

const before = table.slice(1).filter((row) => row.some((cell) => cell.trim()))
  .map((row) => headers.map((_, index) => String(row[index] ?? '')));

const asObjects = (rows) => rows.map((row) => Object.fromEntries(headers.map((name, index) => [name, row[index] ?? ''])));
const badges = extractSalesBadges(asObjects(before));

// 先只改数组，最后统一转对象写盘
const after = before.map((row) => {
  const next = [...row];
  const value = next[columnIndex].trim();
  if (value && !isCountLike(value)) next[columnIndex] = '';
  return next;
});

// 序号必须仍连续 1..N，链接仍非空——摘值不能动行序
after.forEach((row, offset) => {
  if (row[serialIndex] !== String(offset + 1)) throw new Error(`序号断了：第 ${offset + 2} 行是 ${row[serialIndex]}`);
  if (!row[linkIndex].trim()) throw new Error(`第 ${offset + 2} 行商品链接为空`);
});

fs.writeFileSync(csvPath, toCsv(asObjects(after), headers), 'utf8');
if (badgesOut) {
  fs.mkdirSync(path.dirname(badgesOut), { recursive: true });
  fs.writeFileSync(badgesOut, `${JSON.stringify({ total: badges.length, badges }, null, 2)}\n`, 'utf8');
}

// 写后自检：toCsv 收的是**对象**数组；传数组行时它每个字段都取不到，会写出 16 个空列。
// 2026-10-26 就这么踩过一次（1384 行全空，靠 build 报 rows:0 才发现）。
// 所以这里不看自己写的变量，回读文件逐格比。
const reread = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const rereadHeaders = reread[0];
if (rereadHeaders.length !== headers.length || rereadHeaders.some((name, index) => name !== headers[index])) {
  throw new Error('写后自检失败：表头与源不一致');
}
const rereadRows = reread.slice(1).filter((row) => row.some((cell) => cell.trim()));
if (rereadRows.length !== before.length) {
  throw new Error(`写后自检失败：行数 ${rereadRows.length}，应为 ${before.length}`);
}
let unexpected = 0;
const changedCells = [];
for (let rowIndex = 0; rowIndex < rereadRows.length; rowIndex += 1) {
  for (let column = 0; column < headers.length; column += 1) {
    const was = before[rowIndex][column];
    const now = String(rereadRows[rowIndex][column] ?? '');
    if (was === now) continue;
    // 唯一允许的改动：月收货人数由非计数文案变成空
    if (column === columnIndex && now === '' && !isCountLike(was)) {
      changedCells.push({ row: rowIndex + 2, from: was });
      continue;
    }
    unexpected += 1;
  }
}
if (unexpected !== 0) throw new Error(`写后自检失败：${unexpected} 处非预期改动`);

console.log(JSON.stringify({
  rows: before.length,
  blanked: changedCells.length,
  stillNonNumeric: after.filter((row) => row[columnIndex].trim() && !isCountLike(row[columnIndex])).length,
  badgesDistinct: [...new Set(badges.map((badge) => badge.月收货人数原文))],
  csv: csvPath,
  badgesFile: badgesOut ?? null,
}, null, 2));
