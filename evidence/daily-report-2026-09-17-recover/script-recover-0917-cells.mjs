#!/usr/bin/env node
// 09-17 那两个手写列的**恢复**脚本（2026-09-19 事故的收尾）。
//
// 背景（全部有据，见 ../daily-report-2026-09-17-clear/）：
//   09-18 晚那份计划为了「重写 09-17」清掉了 4 家的 `询单量` / `同层同行询单量`（8 格），
//   重跑拖到 09-19 上午，而 SYCM 的「同行同层均值」只在目标日仍是「昨天」时才有
//   ⇒ 三家走降级路径只写回了 `询单量`，`同层同行询单量` 空着；盖文淘宝那轮更早停手，两格都空着。
//
// 这个脚本把**已经被写进飞书、后来被清掉**的那两个值写回去。值不重采 —— 只从
//   删除前的快照 `post-delete-verification.json` 里取（那是 09-18 17:19 从生意参谋页读到的原始值，
//   当时 09-17 还是「昨日」，同行基准取得到）。
//
// 纪律（全部 fail-closed，任一不成立即**整体停手、一个字都不写**）：
//   A. 每天必须有**默认 dry-run**，只有显式 `--apply` 才写；
//   B. 目标行按（日期 + 店铺叫法）必须**恰好命中一行**；
//   C. 该行的 record_id 必须与删除前快照里的 record_id **一致**（证明是同一行，不是按店名瞎认）；
//   D. **只补空白**：任何一格已有值与快照不一致 ⇒ 停手报人，绝不覆盖；
//   E. 写后回读：两格必须等于快照值，且**除这两列外逐字段逐字不变**；
//   F. 快照里那一行的值必须齐全（缺一个就停手 —— 半份数据比没有更危险）。
//
// 用法：
//   node script-recover-0917-cells.mjs                      # dry-run，默认三家
//   node script-recover-0917-cells.mjs --apply              # 真写
//   node script-recover-0917-cells.mjs --shops 里可林淘宝,网林天猫,科塔淘宝,盖文淘宝 --apply
//
// 注意（写进 SOP 的时序约束）：**`--allow-missing-peer` 的降级回填要求「同层同行」那格是空的**。
// 所以「先补回同行值」与「之后还要重跑同一天的降级回填」不能共存 ——
// 要跑那家的降级回填，就把它放到 `--shops` 的最后一步（先跑回填、再补同行格）。

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const SNAPSHOT_PATH = path.resolve(HERE, '../daily-report-2026-09-17-clear/post-delete-verification.json');
const SHOP_FILE = '里可林淘宝,网林天猫,科塔淘宝';

const { dailyReportTargets, loadFeishuCredentials } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'runtime', 'feishu-targets.mjs')).href);
const { appendAudit, describeAuditRow } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'runtime', 'daily-report-audit.mjs')).href);
const { selectDailyStoreRecord } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'skills', 'sycm-alimama-daily-report', 'scripts', 'inquiry-core.mjs')).href);
const { reportDateEpoch } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'skills', 'sycm-alimama-daily-report', 'scripts', 'daily-report-core.mjs')).href);

const WRITTEN_FIELDS = ['询单量', '同层同行询单量'];

function parseArgs(argv) {
  const args = { date: '2026-09-17', shops: SHOP_FILE, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--apply') args.apply = true;
    else if (key === '--date') args.date = argv[++i];
    else if (key === '--shops') args.shops = argv[++i];
    else throw new Error(`unknown argument: ${key}`);
  }
  args.shops = args.shops.split(',').map((s) => s.trim()).filter(Boolean);
  if (args.shops.length === 0) throw new Error('--shops 不能为空');
  return args;
}

const blank = (value) => value === null || value === undefined || String(value).trim() === '';
const num = (value) => (blank(value) ? null : Number(value));
const withoutWritten = (fields) => Object.fromEntries(
  Object.entries(fields ?? {}).filter(([name]) => !WRITTEN_FIELDS.includes(name)));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(SNAPSHOT_PATH)) throw new Error(`快照不存在：${SNAPSHOT_PATH}`);
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  assert.equal(snapshot.reportDate, args.date, `快照的报表日是 ${snapshot.reportDate}，与 --date ${args.date} 不一致`);

  const bySnapshot = new Map((snapshot.cleared ?? []).map((row) => [row.shop, row]));
  const targets = args.shops.map((shop) => {
    const row = bySnapshot.get(shop);
    if (!row) throw new Error(`快照里没有「${shop}」这家（快照里是：${[...bySnapshot.keys()].join('、')}）`);
    // 判据 F：快照那一行必须齐全
    if (row.inquiry === null || row.inquiry === undefined || row.peer === null || row.peer === undefined) {
      throw new Error(`快照里「${shop}」的值不全：${JSON.stringify(row)} —— 停手，半份数据不写`);
    }
    assert.match(String(row.recordId), /^recv/iu, `快照里「${shop}」的 recordId 不像飞书 id：${row.recordId}`);
    return { shop, recordId: row.recordId, expected: { inquiry: Number(row.inquiry), peer: Number(row.peer) } };
  });

  const T = dailyReportTargets('kcne');
  const credentials = loadFeishuCredentials('kcne');
  const clientModule = await import(pathToFileURL(path.join(REPO_ROOT,
    'skills', 'xws-to-feishu-base', 'scripts', 'feishu-client.mjs')).href);
  const client = new clientModule.FeishuClient({ appId: credentials.appId, appSecret: credentials.appSecret,
    appToken: T.baseToken, tableId: T.inquiryTable });

  const [tables, fields, records] = await Promise.all([
    client.listTables(), client.listFields(), client.listRecords(),
  ]);
  const table = tables.find((item) => item.tableId === T.inquiryTable);
  if (table?.name !== '各店铺数据日报') throw new Error(`目标表名不是「各店铺数据日报」：${table?.name ?? 'missing'}`);
  for (const [name, type] of WRITTEN_FIELDS.map((n) => [n, 2])) {
    const field = fields.find((item) => item.fieldName === name);
    if (!field || field.type !== type) throw new Error(`字段类型不对 ${name}: ${JSON.stringify(field)}`);
  }

  const epoch = reportDateEpoch(args.date);

  // ---- 第一遍：把所有店都检查完，任何一家不对就一个字都不写 ----
  const plan = [];
  const preSnapshot = [];
  for (const target of targets) {
    const record = selectDailyStoreRecord(records, epoch, target.shop);
    // 判据 C
    assert.equal(record.record_id, target.recordId,
      `「${target.shop}」的 record_id 与快照不一致：现在 ${record.record_id}，快照 ${target.recordId}`);
    const current = { inquiry: num(record.fields?.['询单量']), peer: num(record.fields?.['同层同行询单量']) };
    const e = target.expected;
    let disposition;
    if (current.inquiry === null && current.peer === null) disposition = 'WRITE_BOTH';
    else if (current.peer === null && current.inquiry === e.inquiry) disposition = 'WRITE_PEER_ONLY';
    else if (current.inquiry === e.inquiry && current.peer === e.peer) disposition = 'ALREADY_VERIFIED';
    else throw new Error(`「${target.shop}」的现值既不是空的、也不等于快照：`
      + `现值 ${JSON.stringify(current)}，快照 ${JSON.stringify(e)} —— 停手报人，绝不覆盖`);

    plan.push({ ...target, disposition, current,
      values: disposition === 'WRITE_BOTH' ? { 询单量: e.inquiry, 同层同行询单量: e.peer }
        : disposition === 'WRITE_PEER_ONLY' ? { 同层同行询单量: e.peer } : {} });
    preSnapshot.push({ shop: target.shop, recordId: target.recordId, fields: record.fields ?? null });
  }

  mkdirSync(HERE, { recursive: true });
  writeFileSync(path.join(HERE, 'pre-recover-snapshot.json'),
    `${JSON.stringify({ at: new Date().toISOString(), reportDate: args.date, snapshotSource: SNAPSHOT_PATH,
      records: preSnapshot }, null, 2)}\n`, 'utf8');
  writeFileSync(path.join(HERE, 'recover-plan.json'),
    `${JSON.stringify({ at: new Date().toISOString(), reportDate: args.date, mode: args.apply ? 'apply' : 'dry-run',
      target: { appToken: T.baseToken, tableId: T.inquiryTable, tableName: table.name },
      plan: plan.map(({ shop, recordId, disposition, current, expected, values }) =>
        ({ shop, recordId, disposition, current, expected, values })) }, null, 2)}\n`, 'utf8');

  console.log(`报表日 ${args.date}｜目标表 ${table.name}｜${plan.length} 家｜模式 ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  for (const item of plan) {
    console.log(`  ${item.shop.padEnd(6)} ${item.disposition.padEnd(15)} 现值=${JSON.stringify(item.current)}`
      + ` 快照=${JSON.stringify(item.expected)} 将写=${JSON.stringify(item.values)}`);
  }
  if (!args.apply) {
    console.log('\n[dry-run] 一个字都没写。要写就加 --apply。');
    return;
  }

  // ---- 第二遍：真写 + 回读 ----
  const receipts = [];
  for (const item of plan) {
    if (item.disposition === 'ALREADY_VERIFIED') {
      receipts.push({ shop: item.shop, recordId: item.recordId, status: 'ALREADY_VERIFIED', wrote: false });
      continue;
    }
    const [recordId] = await client.batchUpdateRecords([{ record_id: item.recordId, fields: item.values }]);
    assert.equal(recordId, item.recordId);

    const after = selectDailyStoreRecord(await client.listRecords(), epoch, item.shop);
    const afterCells = { inquiry: num(after.fields?.['询单量']), peer: num(after.fields?.['同层同行询单量']) };
    // 判据 E：两格都等于快照
    assert.deepEqual(afterCells, item.expected,
      `「${item.shop}」写后回读不等于快照：${JSON.stringify(afterCells)} vs ${JSON.stringify(item.expected)}`);
    // 判据 E：除这两列外逐字不变
    const beforeRow = preSnapshot.find((row) => row.shop === item.shop);
    assert.deepEqual(withoutWritten(after.fields), withoutWritten(beforeRow.fields),
      `「${item.shop}」除这两列外有别的字段被改动了 —— 停手`);
    receipts.push({ shop: item.shop, recordId: item.recordId, status: 'RECOVERED_AND_VERIFIED',
      wrote: true, values: item.values, after: afterCells });

    const audit = await appendAudit(describeAuditRow({
      action: 'inquiry-backfill', outcome: 'ok', reportDate: args.date, shopName: item.shop,
      recordId: item.recordId, mode: 'recover-from-snapshot',
      environment: { computedAt: new Date().toISOString(), node: process.version },
      detail: { reason: '写回被 09-17 重写操作清掉的手写列；值来自删除前快照，未重采',
        snapshotSource: SNAPSHOT_PATH, disposition: item.disposition,
        prewrite: item.current, values: item.values, unchangedOtherFields: true },
    }));
    console.log(`  ${item.shop} 已写回 ${JSON.stringify(item.values)}｜审计 ${audit.written ? 'id=' + audit.id : '未写入：' + audit.reason}`);
  }

  writeFileSync(path.join(HERE, 'recover-receipt.json'),
    `${JSON.stringify({ at: new Date().toISOString(), reportDate: args.date, snapshotSource: SNAPSHOT_PATH,
      receipts }, null, 2)}\n`, 'utf8');
  console.log('\n全部完成，收据：' + path.join(HERE, 'recover-receipt.json'));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
