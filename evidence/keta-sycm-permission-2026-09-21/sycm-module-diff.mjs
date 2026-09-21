// 只读：把 tmp/sycm-modules-dump.mjs 导出的两家模块台账并排 diff。
// 用法：node tmp/sycm-module-diff.mjs   （先分别跑 dump：19044 keta / 19043 gaiwen）
import { readFileSync, writeFileSync } from 'node:fs';

const read = (key) => JSON.parse(readFileSync(`D:/Retire/sycm-automation/tmp/modules-${key}.json`, 'utf8'));
const keta = read('keta');
const gaiwen = read('gaiwen');
const keyOf = (e) => `${e[0]}|${e[1]}`;
const ketaKeys = new Set(keta.map(keyOf));
const gaiwenKeys = new Set(gaiwen.map(keyOf));

const lines = [
  '两家生意参谋账号的模块台账 diff（moduleId / 名称 / hasPermission / 到期日）',
  `  科塔淘宝（19044）模块数=${keta.length}`,
  `  盖文淘宝（19043，对照）模块数=${gaiwen.length}`,
  '',
  '【盖文有、科塔没有】',
  ...gaiwen.filter((e) => !ketaKeys.has(keyOf(e)))
    .map((e) => `  · id=${e[0]}  ${e[1]}  hasPermission=${e[2]}  到期=${e[3]}`),
  '',
  `【科塔有、盖文没有】共 ${keta.filter((e) => !gaiwenKeys.has(keyOf(e))).length} 条（下面只列非灰度/非人群包的订购项）`,
  ...keta.filter((e) => !gaiwenKeys.has(keyOf(e)) && !/灰度|人群|AB测试|专项|测试/.test(String(e[1])))
    .map((e) => `  · id=${e[0]}  ${e[1]}  到期=${e[3]}`),
];
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-module-diff2.txt', lines.join('\n'));
console.log(lines.join('\n'));
