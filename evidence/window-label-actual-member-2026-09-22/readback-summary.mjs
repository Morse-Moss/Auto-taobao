// 从 `04`/`05` 那种 `/targets` 快照里，把每台窗口标签页 URL 上的参数摘成一张表 ——
// 用来回答「新版到底有没有落到窗口上」。
//
// 为什么单独留一份：这是**回读**那一步的实现（写完必须独立回读核对，不许只看写入方的自报）。
// 路径按自身位置算，所以放在 evidence 目录里也能直接跑。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = process.argv[2] ?? path.join(import.meta.dirname, '05-live-readback-after-commit.json');
const report = JSON.parse(readFileSync(file, 'utf8'));

console.log(`读的是：${path.basename(file)}`);
console.log('店名        | 登记表会员名            | 标签页 URL 上的 actual      | state');
console.log('----------- | ----------------------- | --------------------------- | -----');
for (const [shop, row] of Object.entries(report.shops)) {
  const tab = (row.tabs ?? []).find((line) => line.includes('窗口标签页'));
  if (!tab) {
    console.log(`${shop}  | （这个窗口没有标签页）`);
    continue;
  }
  const query = new URL(tab.slice(tab.indexOf('file:'))).searchParams;
  console.log(`${shop.padEnd(11)} | ${String(row.memberName ?? '-').padEnd(23)} | `
    + `${String(query.get('actual') ?? '（没有！新版没落上去）').padEnd(27)} | ${query.get('state') ?? '（不带）'}`);
}
console.log(`failed=${report.failed}`);
