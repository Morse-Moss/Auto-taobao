// 一次性清理脚本 v2（放仓库外，不进版本库）
// 目标：删掉「总数据来源底单」与「各店铺数据日报」两张表里 2026-09-16 的全部记录。
// 默认只枚举 + 落快照；加 --apply 才真删。
//
// 安全判据（v1 太粗，会把「公式/查找列的派生值」误当成手工数据而拒绝执行）：
//   先查字段类型，把 Lookup(19) / Formula(20) 标成派生列 —— 它们的值来自底单，不是人写的，
//   删掉底单行本来就会让它们归零，因此不构成「丢失手工数据」。
//   只有【非派生、非结构、非本次我自己写的两个字段】还有内容时，才停下拒绝删。
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadFeishuCredentials, dailyReportTargets } from 'file:///D:/Retire/sycm-automation/runtime/feishu-targets.mjs';
import { FeishuClient } from 'file:///D:/Retire/sycm-automation/skills/xws-to-feishu-base/scripts/feishu-client.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const REPORT_EPOCH = 1789488000000; // 2026-09-16（北京时间当天 00:00）
const APPLY = process.argv.includes('--apply');
const OUT_DIR = 'D:/Retire/sycm-automation/evidence/daily-report-2026-09-16-clear';
const MINE = new Set(['询单量', '同层同行询单量']);
const DERIVED_TYPES = new Set([19, 20, 21, 1001, 1002, 1003, 1004]); // lookup / formula / link / 系统列
const STRUCTURAL = new Set(['日期', '店铺', '数据月份', '统计日期', '店铺名称', '父记录']);

const targets = dailyReportTargets('kcne');
const credentials = loadFeishuCredentials('kcne');

const unwrap = (cell) => {
  if (cell === null || cell === undefined) return null;
  const value = Array.isArray(cell) ? cell : [cell];
  const parts = value.map((item) => {
    if (item && typeof item === 'object') return item.text ?? item.value ?? item.name ?? JSON.stringify(item);
    return item;
  });
  return parts.join('');
};
const isTargetDate = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = typeof raw === 'object' && raw !== null ? raw.value : raw;
  return Number(num) === REPORT_EPOCH;
};

async function token() {
  const response = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
  });
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) throw new Error(`auth failed: ${response.status} ${payload.code} ${payload.msg}`);
  return payload.tenant_access_token ?? payload.data?.tenant_access_token;
}

const clientFor = (tableId) => new FeishuClient({ appId: credentials.appId,
  appSecret: credentials.appSecret, appToken: targets.baseToken, tableId });

async function inspect(tableId, dateField, label) {
  const client = clientFor(tableId);
  const fields = await client.listFields();
  const typeOf = new Map(fields.map((f) => [f.fieldName, f.type]));
  const derived = new Set(fields.filter((f) => DERIVED_TYPES.has(f.type)).map((f) => f.fieldName));
  const records = await client.listRecords();
  const hits = records.filter((r) => isTargetDate(r.fields?.[dateField]));
  const rows = hits.map((r) => {
    const handwritten = [];
    const derivedValues = {};
    for (const [name, cell] of Object.entries(r.fields ?? {})) {
      const value = unwrap(cell);
      const empty = value === null || value === '' || value === undefined;
      if (derived.has(name)) { if (!empty) derivedValues[name] = value; continue; }
      if (STRUCTURAL.has(name) || MINE.has(name)) continue;
      if (!empty) handwritten.push([name, value]);
    }
    return { recordId: r.record_id, shop: r.fields?.['店铺'] ?? r.fields?.['店铺名称'] ?? null,
      handwritten, derivedKeys: Object.keys(derivedValues).length, derivedValues };
  });
  console.log(`[${label}] 总 ${records.length} 条 → 目标日 ${hits.length} 条（派生列 ${derived.size} 个）`);
  for (const row of rows) {
    console.log(`   ${row.recordId} | ${JSON.stringify(row.shop)} | 手写列非空 ${row.handwritten.length} | 派生列有值 ${row.derivedKeys}`);
    if (row.handwritten.length) console.log(`      ⚠ 手写列内容: ${JSON.stringify(row.handwritten)}`);
  }
  const offenders = rows.filter((row) => row.handwritten.length > 0);
  return { label, tableId, total: records.length, rows, offenders: offenders.length,
    derivedFields: [...derived].sort() };
}

const main = async () => {
  const source = await inspect(targets.sourceTable, '统计日期', '底单');
  const inquiry = await inspect(targets.inquiryTable, '日期', '各店铺数据日报');
  const snapshot = { takenAt: new Date().toISOString(), reportDate: '2026-09-16',
    note: '删除前的枚举快照。derivedValues 是公式/查找列的派生值（来自底单），随底单行一起消失属于预期。',
    source, inquiry };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(`${OUT_DIR}/pre-delete-snapshot.json`, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`\n快照已写: ${OUT_DIR}/pre-delete-snapshot.json`);
  console.log(`待删：底单 ${source.rows.length} 条 + 询单表 ${inquiry.rows.length} 条；`
    + `手写列有内容的异常行 ${source.offenders + inquiry.offenders} 条。`);

  if (!APPLY) { console.log('（未加 --apply，什么都没删）'); return; }
  // 底单那行里「非派生列有值」是预期的 —— 那些列就是导入进去的数据本身，删它正是本次目的。
  // 真正需要拦住的是派生表（各店铺数据日报）：它的列几乎全是 lookup/formula，
  // 只有 询单量 / 同层同行询单量 是手写列（本次是我写的）；若另有手写内容，说明有人在里面记过东西。
  if (inquiry.offenders > 0) {
    console.log(`⛔ 派生表里有 ${inquiry.offenders} 行存在「非派生、非本次写入」的内容，拒绝删除。请人工确认。`);
    process.exitCode = 2;
    return;
  }
  console.log(`（说明：底单那 ${source.rows.length} 行里非派生列有值属预期 —— 那就是导入的数据本身）`);

  const bearer = await token();
  const del = async (tableId, ids, label) => {
    if (ids.length === 0) { console.log(`[${label}] 没有要删的记录`); return; }
    const response = await fetch(`${API_ROOT}/bitable/v1/apps/${targets.baseToken}/tables/${tableId}/records/batch_delete`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: ids }),
    });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) {
      console.log(`[${label}] 删除失败: HTTP ${response.status} code=${payload.code} msg=${payload.msg}`);
      process.exitCode = 1;
      return;
    }
    const deleted = payload.data?.records ?? [];
    console.log(`[${label}] 已删除 ${deleted.length || ids.length} 条`);
  };

  await del(targets.sourceTable, source.rows.map((r) => r.recordId), '底单');
  await del(targets.inquiryTable, inquiry.rows.map((r) => r.recordId), '询单表');

  // 删后回读
  const sourceAfter = await clientFor(targets.sourceTable).listRecords();
  const inquiryAfter = await clientFor(targets.inquiryTable).listRecords();
  const report = {
    deletedAt: new Date().toISOString(),
    source: { before: source.total, after: sourceAfter.length,
      remainingOnDate: sourceAfter.filter((r) => isTargetDate(r.fields?.['统计日期'])).length },
    inquiry: { before: inquiry.total, after: inquiryAfter.length,
      remainingOnDate: inquiryAfter.filter((r) => isTargetDate(r.fields?.['日期'])).length },
    deletedIds: { source: source.rows.map((r) => r.recordId), inquiry: inquiry.rows.map((r) => r.recordId) },
  };
  writeFileSync(`${OUT_DIR}/post-delete-verification.json`, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n删后回读：底单 ${report.source.before} → ${report.source.after}（目标日剩 ${report.source.remainingOnDate}）；`
    + `询单表 ${report.inquiry.before} → ${report.inquiry.after}（目标日剩 ${report.inquiry.remainingOnDate}）`);
  console.log(`回读已写: ${OUT_DIR}/post-delete-verification.json`);
};

await main();
