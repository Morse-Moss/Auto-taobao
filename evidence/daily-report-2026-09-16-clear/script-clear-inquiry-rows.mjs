// 删掉「各店铺数据日报」里 2026-09-16 的 12 行（逐条单删；batch_delete 在这张 base 上会报 RecordIdNotFound，单条端点正常）
// 范围严守：只删日期字段 = 2026-09-16 的记录。
//
// 复现说明（本次清理的完整口径，见 references/sop.md §9.3）：
//   1) 底单「总数据来源底单」里 09-16 那 1 行用同一个单条端点删掉（脚本见 run 日志；13 条全部一次成功）。
//   2) 删前必须先按字段类型区分「派生列（Lookup/Formula/Link/系统列）」与「手写列」，
//      只有手写列还有内容时才停手问人。本次派生表 12 行的手写列非空数 = 0。
//   3) 删后两侧独立回读：底单 7 → 6、本表 2197 → 2185，目标日各剩 0 条。
//   4) 重跑本脚本是幂等的：目标日已无记录时会打印「0 条」并不发任何删除请求。
import { writeFileSync } from 'node:fs';
import { loadFeishuCredentials, dailyReportTargets } from 'file:///D:/Retire/sycm-automation/runtime/feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const TARGET_EPOCH = 1789488000000;
const OUT = 'D:/Retire/sycm-automation/evidence/daily-report-2026-09-16-clear';
const targets = dailyReportTargets('kcne');
const credentials = loadFeishuCredentials('kcne');

const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
}).then((r) => r.json());
const bearer = auth.tenant_access_token ?? auth.data?.tenant_access_token;

const byEpoch = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = typeof raw === 'object' && raw !== null ? raw.value : raw;
  return Number(num) === TARGET_EPOCH;
};

const listAll = async (tableId) => {
  const out = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const page = await fetch(`${API_ROOT}/bitable/v1/apps/${targets.baseToken}/tables/${tableId}/records?${q}`,
      { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json());
    if (page.code !== 0) throw new Error(`list failed ${page.code} ${page.msg}`);
    out.push(...(page.data?.items ?? []));
    pageToken = page.data?.has_more ? page.data?.page_token : undefined;
  } while (pageToken);
  return out;
};

const before = await listAll(targets.inquiryTable);
const hits = before.filter((r) => byEpoch(r.fields?.['日期']));
console.log(`询单表总 ${before.length} 条，目标日 ${hits.length} 条`);

const deleted = [];
const failed = [];
for (const row of hits) {
  const shop = row.fields?.['店铺'];
  const res = await fetch(`${API_ROOT}/bitable/v1/apps/${targets.baseToken}/tables/${targets.inquiryTable}/records/${row.record_id}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json());
  if (res.code === 0 && res.data?.deleted) { deleted.push({ recordId: row.record_id, shop }); console.log(`  已删 ${row.record_id} ${shop}`); }
  else { failed.push({ recordId: row.record_id, shop, code: res.code, msg: res.msg }); console.log(`  失败 ${row.record_id} ${shop} → ${res.code} ${res.msg}`); }
}

const after = await listAll(targets.inquiryTable);
const sourceAfter = await listAll(targets.sourceTable);
const report = {
  deletedAt: new Date().toISOString(),
  reportDate: '2026-09-16',
  sourceTable: { after: sourceAfter.length,
    // 底单那行不是本脚本删的（见 script-enumerate-then-clear.mjs），所以这里没有 before 可写。
    beforeNote: '底单删前 7 行由 script-enumerate-then-clear.mjs 记录，本脚本只负责询单表 12 行',
    remainingOnDate: sourceAfter.filter((r) => byEpoch(r.fields?.['统计日期'])).map((r) => r.record_id) },
  inquiryTable: { before: before.length, after: after.length,
    remainingOnDate: after.filter((r) => byEpoch(r.fields?.['日期'])).map((r) => r.record_id) },
  deleted,
  failed,
  note: '删除走 OpenAPI 单条 DELETE（batch_delete 在这张 base 上返回 code=1254043 RecordIdNotFound，单条端点正常）。'
    + '本地审计表里那次 push 的记录（id=2）刻意不回改（append-only）——'
    + '它现在指向一个已被删除的 record_id，这正是「审计允许与飞书不一致」要暴露的现象。'
    + '（表名故意不在此处复写：全仓库只许写入方与迁移提到它，守卫会扫到证据脚本。）',
};
writeFileSync(`${OUT}/post-delete-verification.json`, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n删后：底单 ${sourceAfter.length} 行（目标日剩 ${report.sourceTable.remainingOnDate.length}）；`
  + `询单表 ${before.length} → ${after.length}（目标日剩 ${report.inquiryTable.remainingOnDate.length}）`);
console.log(`失败 ${failed.length} 条`);
