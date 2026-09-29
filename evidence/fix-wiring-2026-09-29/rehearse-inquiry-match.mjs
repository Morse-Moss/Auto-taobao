// 真机排练（写路径演练）：把**真实**询单表当成夹具，验证修复后的选行逻辑。
//
// 为什么能在「一个浏览器都没起」的情况下做：本脚本走的是 **OpenAPI**（tenant token），
// 不碰浏览器、不碰 CDP。而这次修的正是 OpenAPI 侧的匹配口径
// —— 所以「用真实表验证真实匹配」比在假夹具上再跑一遍有意义得多。
//
// 只读：一次写入都不发。`--commit` 若真要发，会在最后一行显式拒绝。
//
// ⚠️ 证据副本自重定位仓库根：复制进 `evidence/` 后 `../runtime/...` 这种 CWD 相对路径
// 会指错（本项目吃过「证据脚本复制后跑不起来」）⇒ 用文件自身位置算根 + 动态 import。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mod = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
const { loadFeishuCredentials, dailyReportTargets } = await mod('runtime/feishu-targets.mjs');
const { FeishuClient } = await mod('skills/xws-to-feishu-base/scripts/feishu-client.mjs');
const { findDailyStoreRow } = await mod('skills/sycm-alimama-daily-report/scripts/inquiry-core.mjs');

const T = dailyReportTargets('kcne');
const cred = loadFeishuCredentials('kcne');
const client = new FeishuClient({ appId: cred.appId, appSecret: cred.appSecret,
  appToken: T.baseToken, tableId: T.inquiryTable });

// --- 1. 从 API 读「店铺」字段的选项表（与 run-inquiry-backfill.mjs 同一段逻辑）---
const items = await client.listFieldItems();
const shopField = items.find((i) => i.field_name === '店铺');
const options = (shopField?.property?.options ?? []).filter((o) => o?.id);
const optionIdOf = (name) => options.filter((o) => o.name === name).map((o) => o.id);
console.log(`[选项表] 店铺字段 type=${shopField?.type}，选项 ${options.length} 个`);

// --- 2. 逐店验：修复前的判据 vs 修复后的判据 ---
const records = await client.listRecords();
const epoch09 = new Date('2026-09-28T00:00:00+08:00').getTime();
const epoch27 = new Date('2026-09-27T00:00:00+08:00').getTime();

const oldStyle = (rows, epoch, shop) => rows.filter((r) => Number(r.fields?.['日期']) === epoch
  && String(r.fields?.['店铺'] ?? '').trim() === shop).length;

console.log('\n=== 09-28（那 12 行是选项 id 形态；修复前必失败的一天）===');
for (const shop of ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝']) {
  const ids = optionIdOf(shop);
  const optionId = ids.length === 1 ? ids[0] : null;
  const before = oldStyle(records, epoch09, shop);
  const after = findDailyStoreRow(records, epoch09, shop, { optionId });
  console.log(`${shop.padEnd(6)} optionId=${String(optionId).padEnd(12)} 修复前候选=${before} 修复后候选=${after.candidateCount}`
    + ` record=${after.record?.record_id ?? '-'} matchedBy=${after.matchedBy ?? '-'}`);
}

console.log('\n=== 09-27（历史店名形态；修复前后都必须照旧能命中）===');
for (const shop of ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝']) {
  const ids = optionIdOf(shop);
  const optionId = ids.length === 1 ? ids[0] : null;
  const before = oldStyle(records, epoch27, shop);
  const after = findDailyStoreRow(records, epoch27, shop, { optionId });
  console.log(`${shop.padEnd(6)} 修复前候选=${before} 修复后候选=${after.candidateCount}`
    + ` record=${after.record?.record_id ?? '-'} matchedBy=${after.matchedBy ?? '-'}`);
}

console.log('\n=== 边界：未登记在选项表里的店名（不该被 id 形态误伤）===');
const ghost = findDailyStoreRow(records, epoch09, '不存在的店', { optionId: null });
console.log(`候选=${ghost.candidateCount}（必须 0）`);

console.log('\n本次排练未发任何写请求（只读了 fields 与 records）。');
