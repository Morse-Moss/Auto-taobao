#!/usr/bin/env node
// 独立回读：不信导入器的自报，自己去表里读回来逐项对。
//
// 导入器（import-runner）写完后确实已经自校验过一次「记录数 + 附件数」，
// 但那是同一个进程、同一份内存里的期望值。这个脚本是**另一个进程、另一次读取**，
// 期望值来自 CSV，所以它能抓到「写进去的东西不是源数据」这类问题。
//
// 用法：
//   node runtime/verify-weekly-import-readback.mjs --table <tableId> --csv <csv>
//        [--expect-null-sales 23]
//
// 退出码：0 = 全过；1 = 有问题；2 = 参数错。
import fs from 'node:fs';
import { FeishuClient } from '../skills/xws-to-feishu-base/scripts/feishu-client.mjs';
import { parseCsv } from './taobao-search-core.mjs';
import { activeProfileName, competitorBaseToken, envFilePath } from './feishu-targets.mjs';

function parseArgs(argv) {
  const args = { expectNullSales: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} 缺少取值`);
    if (key === '--table') args.table = value;
    else if (key === '--csv') args.csv = value;
    else if (key === '--expect-null-sales') args.expectNullSales = Number(value);
    else throw new Error(`未知参数：${key}`);
    index += 1;
  }
  if (!args.table) throw new Error('--table 必填');
  if (!args.csv) throw new Error('--csv 必填');
  return args;
}

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(envFilePath(activeProfileName()), 'utf8').split(/\r?\n/u)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const index = text.indexOf('=');
    if (index < 1) continue;
    let value = text.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[text.slice(0, index).trim()] = value;
  }
  return env;
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
const client = new FeishuClient({
  appId: env.FEISHU_APP_ID,
  appSecret: env.FEISHU_APP_SECRET,
  appToken: competitorBaseToken(activeProfileName()),
  tableId: args.table,
});

const table = parseCsv(fs.readFileSync(args.csv, 'utf8'));
const headers = table[0];
const csvRows = table.slice(1).filter((row) => row.some((cell) => cell.trim()));
const bySerial = new Map(csvRows.map((row) => [String(row[0]), row]));

const records = await client.listRecords();
const fields = await client.listFields();
const problems = [];

if (records.length !== csvRows.length) {
  problems.push(`记录数不符：表 ${records.length} vs CSV ${csvRows.length}`);
}

// 序号连续性：从表里读到的序号集合必须正好是 1..N
const serials = records.map((record) => Number(record.fields?.序号));
const missingSerial = [];
for (let expected = 1; expected <= csvRows.length; expected += 1) {
  if (!serials.includes(expected)) missingSerial.push(expected);
}
if (missingSerial.length > 0) {
  problems.push(`序号缺 ${missingSerial.length} 个，例：${missingSerial.slice(0, 10).join(',')}`);
}
const duplicatedSerial = serials.filter((value, index) => serials.indexOf(value) !== index);
if (duplicatedSerial.length > 0) {
  problems.push(`序号重复 ${new Set(duplicatedSerial).size} 个，例：${[...new Set(duplicatedSerial)].slice(0, 10).join(',')}`);
}

// 逐行比四列：链接、标题、平台、店铺名（都是不该被写坏的列）
const textColumns = ['商品链接', '商品标题', '平台', '店铺名'];
let mismatched = 0;
const mismatchSamples = [];
for (const record of records) {
  const row = bySerial.get(String(record.fields?.序号));
  if (!row) continue;
  for (const column of textColumns) {
    const columnIndex = headers.indexOf(column);
    const want = String(row[columnIndex] ?? '');
    const raw = record.fields?.[column];
    const got = raw === null || raw === undefined ? '' : String(raw);
    if (got !== want) {
      mismatched += 1;
      if (mismatchSamples.length < 5) {
        mismatchSamples.push({ 序号: record.fields?.序号, column, got: got.slice(0, 40), want: want.slice(0, 40) });
      }
    }
  }
}
if (mismatched > 0) problems.push(`${mismatched} 处文本列与 CSV 不符`);

// 附件：每行都必须有且只有 1 个 file_token
let attachmentTotal = 0;
let rowsWithoutImage = 0;
for (const record of records) {
  const value = record.fields?.商品图片;
  const count = Array.isArray(value) ? value.length : 0;
  attachmentTotal += count;
  if (count === 0) rowsWithoutImage += 1;
}
if (rowsWithoutImage > 0) problems.push(`${rowsWithoutImage} 行没有附件`);
if (attachmentTotal !== csvRows.length) {
  problems.push(`附件总数 ${attachmentTotal}，应为 ${csvRows.length}`);
}

// 周期戳：三个日期字段必须每行都有值，且与 CSV 无关（由 --period-* 传入）
const stampFields = ['数据开始日期', '数据结束日期', '采集时间'].filter((name) => fields.some((f) => f.fieldName === name));
const stampMissing = Object.fromEntries(stampFields.map((name) => [
  name,
  records.filter((record) => {
    const value = record.fields?.[name];
    return value === null || value === undefined || value === '';
  }).length,
]));
for (const [name, count] of Object.entries(stampMissing)) {
  if (count > 0) problems.push(`${count} 行缺「${name}」`);
}

// 月收货人数为空的必须正好是「徽标行」那批
const nullSales = records.filter((record) => {
  const value = record.fields?.月收货人数;
  return value === null || value === undefined || String(value).trim() === '';
}).length;
if (args.expectNullSales !== null && nullSales !== args.expectNullSales) {
  problems.push(`月收货人数为空 ${nullSales} 行，应为 ${args.expectNullSales} 行`);
}

// 价格：字段声明是 type=2（数字），但**读接口把它返回成字符串**——
// 已知正确的上周表（tblBowNVwjlj4MwG）读回来同样是 "612" 而不是 612，
// 所以查 typeof 会给出假红。这里改成查「值与 CSV 数值一致」，比查表示形式更硬。
const priceColumn = headers.indexOf('价格');
let priceMissing = 0;
let priceMismatched = 0;
const priceSamples = [];
for (const record of records) {
  const raw = record.fields?.价格;
  if (raw === null || raw === undefined || String(raw).trim() === '') { priceMissing += 1; continue; }
  const actual = Number(String(raw).replaceAll(',', ''));
  if (!Number.isFinite(actual)) { priceMismatched += 1; continue; }
  const row = bySerial.get(String(record.fields?.序号));
  if (!row) continue;
  const expected = Number(String(row[priceColumn] ?? '').replaceAll(',', ''));
  if (Number.isFinite(expected) && Math.abs(actual - expected) > 1e-6) {
    priceMismatched += 1;
    if (priceSamples.length < 5) priceSamples.push({ 序号: record.fields?.序号, got: actual, want: expected });
  }
}
if (priceMissing > 0) problems.push(`${priceMissing} 行的「价格」为空`);
if (priceMismatched > 0) problems.push(`${priceMismatched} 行的「价格」与 CSV 数值不符`);

const summary = {
  ok: problems.length === 0,
  tableId: args.table,
  records: records.length,
  csvRows: csvRows.length,
  attachments: attachmentTotal,
  fieldCount: fields.length,
  monthlyBuyersNull: nullSales,
  expectedNullSales: args.expectNullSales,
  textMismatch: mismatched,
  mismatchSamples,
  priceMismatched,
  priceSamples,
  stampMissing,
  problems,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = problems.length === 0 ? 0 : 1;
