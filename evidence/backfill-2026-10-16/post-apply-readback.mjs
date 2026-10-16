// 写入后独立回读：不复用导入器的 afterRows，自己重数底单并逐项对账
//  ① 总行数（预期 1068 = 19 基线 + 1049 新写）
//  ② 逐日期分布（预期 10-08..10-15 = 131/131/131/133/129/130/132/132，其余为 8-31/9-29 残留）
//  ③ 写入前快照的 19 个 record_id 全部仍在（基线行没被冲掉）
//  ④ 全表去重键（日期+场景ID+原二级场景ID+计划ID+主体ID）无重复
//  ⑤ 抽样对账：盖文天猫 10-11 源 ZIP 的「花费」合计 vs 底单中该店该日的合计
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadFeishuCredentials } from '../../runtime/feishu-targets.mjs';
import { FeishuClient } from '../../skills/xws-to-feishu-base/scripts/feishu-client.mjs';

const c = loadFeishuCredentials('kcne');
const client = new FeishuClient({
  appId: c.appId,
  appSecret: c.appSecret,
  appToken: 'FhCUbn7vVaEc26sRjMAccQJAn5e',
  tableId: 'tblC6QPcGOQu1D0T',
});
const rs = await client.listRecords();
const pre = JSON.parse(readFileSync(new URL('./pre-apply-snapshot.json', import.meta.url), 'utf8'));
const nowIds = new Set(rs.map((r) => r.record_id));
const missing = pre.recordIds.filter((id) => !nowIds.has(id));

// 日期字段在飞书里是 epoch 毫秒（UTC+8 零点）——按 CST 日期归一
const dayOf = (ms) => {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};
const byDate = {};
for (const r of rs) {
  const day = dayOf(r.fields['日期']);
  byDate[day] = (byDate[day] || 0) + 1;
}

// 去重键（与导入器 planPromotionImport 同口径）
const keyOf = (r) => JSON.stringify([
  r.fields['日期'], r.fields['场景ID'], r.fields['原二级场景ID'],
  r.fields['计划ID'], r.fields['主体ID'],
]);
const seen = new Map();
const dups = [];
for (const r of rs) {
  const k = keyOf(r);
  if (seen.has(k)) dups.push({ key: k, ids: [seen.get(k), r.record_id] });
  else seen.set(k, r.record_id);
}

// 抽样对账：盖文天猫 2026-10-11 源 ZIP（已由 bash+py 预解析为 JSON；
// node 的 spawn 在本机间歇性 EBUSY，见 1.9.8 的同类修复，故解析步骤外置）
const src = JSON.parse(readFileSync(new URL('./sample-gaiwen-tmall-1011.json', import.meta.url), 'utf8'));
const idxDate = src.headers.indexOf('日期');
const idxSpend = src.headers.indexOf('花费');
const srcRows = src.rows.filter((r) => String(r[idxDate]).trim() === '2026-10-11');
const srcSpend = srcRows.reduce((a, r) => a + (Number(r[idxSpend]) || 0), 0);
// 抽样对账：盖文天猫 2026-10-11。记录身份不靠字段名模糊匹配，直接用 apply 收据的
// manifest（recordIds[i] ↔ manifest[i]，两者等长已验）取该店被写下的 record_id
const applyReceipt = JSON.parse(readFileSync(new URL('./import-apply/2026-10-11/receipt.json', import.meta.url), 'utf8'));
if (applyReceipt.recordIds.length !== applyReceipt.manifest.length) throw new Error('recordIds 与 manifest 不等长，无法按店对账');
const targetIds = applyReceipt.manifest
  .map((m, i) => (m.shop === '盖文天猫' ? applyReceipt.recordIds[i] : null))
  .filter(Boolean);
const byId = new Map(rs.map((r) => [r.record_id, r]));
const written = targetIds.map((id) => byId.get(id)).filter(Boolean);
const writtenSpend = written.reduce((a, r) => a + (Number(r.fields['花费']) || 0), 0);

const expected = { '2026-10-08': 131, '2026-10-09': 131, '2026-10-10': 131, '2026-10-11': 133, '2026-10-12': 129, '2026-10-13': 130, '2026-10-14': 132, '2026-10-15': 132 };
const dateVerdicts = Object.entries(expected).map(([d, n]) => `${d}:${byDate[d] ?? 0}/${n}${byDate[d] === n ? '' : ' ⚠️不符'}`);
const spendDiff = Math.abs(srcSpend - writtenSpend);

const report = {
  at: new Date().toISOString(),
  totalRows: rs.length,
  expectedTotal: pre.count + 1049,
  baselineMissing: missing.length,
  byDate,
  dateVerdicts,
  duplicateKeys: dups.length,
  sample: {
    shop: '盖文天猫', date: '2026-10-11',
    sourceRows: srcRows.length, writtenRows: written.length,
    sourceSpend: Number(srcSpend.toFixed(2)), writtenSpend: Number(writtenSpend.toFixed(2)),
    spendDiff: Number(spendDiff.toFixed(2)),
  },
  verdict: rs.length === pre.count + 1049 && missing.length === 0 && dups.length === 0
    && Object.entries(expected).every(([d, n]) => byDate[d] === n)
    && srcRows.length === written.length && spendDiff < 0.01 ? 'PASS' : 'FAIL',
};
console.log(JSON.stringify(report, null, 1));
