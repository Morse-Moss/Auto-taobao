// 把 2026-09-24 这一天「五家店」的数据清掉，为「删除再重写」做准备。
//
// 为什么只清两处（见下方每条判据的出处）：
//   1) 底单：只删「本链能重放的那五家」（源页头名：里可林家居 / 网林家居旗舰店 /
//      盖文全卫定制 / 盖文旗舰店 / 科塔全卫定制）。出现别的店铺名就整体停手 —— 删了补不回来。
//   2) 「各店铺数据日报」的 12 行（每天一行，不是底单的派生行）**必须保留**：
//      run-inquiry-backfill.mjs 没有创建行的通路，只匹配已存在的那一行 —— 删行等于让回填无从下手。
//      它 33 个字段里 28 个是派生列（Lookup/Formula），只有 5 个手写列（日期/店铺/补单金额/询单量/同层同行询单量），
//      所以这里只清「本链要回填的那两列」，并把「其余手写列非空」当成硬停条件（别处让人记过东西）。
//
// 安全形态：
//   · 默认**只枚举 + 落快照**，不删。加 --apply 才真删/真清。
//   · 任何一条判据不成立就整体停手（exit 2），不做「尽力而为」的部分执行。
//   · 删/清之后两侧独立回读，回执写进 post-delete-verification.json。
//   · 幂等复核要写到另一个文件名 —— 重跑本脚本会覆盖自己的回执（2026-09-17 踩过，见 sop §9.3 第 6 条）。
import { mkdirSync, writeFileSync } from 'node:fs';

import { dailyReportTargets, loadFeishuCredentials } from '../../runtime/feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const DAY = '2026-09-24';
const EPOCH = Date.parse(`${DAY}T00:00:00+08:00`);
const APPLY = process.argv.includes('--apply');
const OUT_DIR = 'D:/Retire/sycm-automation/evidence/daily-report-2026-09-24-clear';

// 本轮要重写的五家（运营叫法）——用于匹配询单表的「店铺」列。
const REWRITE_KEYS = ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝'];
// 底单「店铺名称」列用的是源页头名；这五个是本轮驱动确实能重放的五家（2026-09-25 跑前日志逐字核对过）。
const DELETABLE_SOURCE_SHOPS = ['里可林家居', '网林家居旗舰店', '盖文全卫定制', '盖文旗舰店', '科塔全卫定制'];

const DERIVED_TYPES = new Set([19, 20, 21, 1001, 1002, 1003, 1004]);
const STRUCTURAL = new Set(['日期', '店铺', '数据月份', '统计日期', '店铺名称', '父记录']);
const MINE = new Set(['询单量', '同层同行询单量']);

const targets = dailyReportTargets('kcne');
const credentials = loadFeishuCredentials('kcne');

const auth = await fetch(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
}).then((r) => r.json());
const bearer = auth.tenant_access_token ?? auth.data?.tenant_access_token;
if (!bearer) throw new Error(`auth failed: ${JSON.stringify(auth)}`);

const listAll = async (tableId) => {
  const out = [];
  let pageToken;
  do {
    const q = new URLSearchParams({ page_size: '500' });
    if (pageToken) q.set('page_token', pageToken);
    const page = await fetch(`${API_ROOT}/bitable/v1/apps/${targets.baseToken}/tables/${tableId}/records?${q}`,
      { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json());
    if (page.code !== 0) throw new Error(`list ${tableId} failed ${page.code} ${page.msg}`);
    out.push(...(page.data?.items ?? []));
    pageToken = page.data?.has_more ? page.data?.page_token : undefined;
  } while (pageToken);
  return out;
};

const listFields = async (tableId) => {
  const page = await fetch(`${API_ROOT}/bitable/v1/apps/${targets.baseToken}/tables/${tableId}/fields?page_size=200`,
    { headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json());
  if (page.code !== 0) throw new Error(`fields ${tableId} failed ${page.code} ${page.msg}`);
  // 裸 OpenAPI 用 snake_case；按 `fieldName` 取会让类型映射变成空 Map（护栏静默失效）。
  return (page.data?.items ?? []).map((f) => ({ name: f.field_name ?? f.fieldName, type: f.type }));
};

const unwrap = (cell) => {
  if (cell === null || cell === undefined) return null;
  const value = Array.isArray(cell) ? cell : [cell];
  return value.map((item) => (item && typeof item === 'object'
    ? (item.text ?? item.value ?? item.name ?? JSON.stringify(item)) : item)).join('');
};
const onDay = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = typeof raw === 'object' && raw !== null ? raw.value : raw;
  return Number(num) === EPOCH;
};

const fail = (message) => {
  console.error(`\n⛔ ${message}`);
  console.error('判据不成立即整体停手：不做「尽力而为」的部分执行。');
  process.exitCode = 2;
};

// ---------- 1. 底单：找出该删的行 ----------
const sourceFields = await listFields(targets.sourceTable);
const sourceDerived = new Set(sourceFields.filter((f) => DERIVED_TYPES.has(f.type)).map((f) => f.name));
const sourceRecords = await listAll(targets.sourceTable);
const sourceOnDay = sourceRecords.filter((r) => onDay(r.fields?.['统计日期']));

const sourceRows = sourceOnDay.map((r) => {
  const shop = unwrap(r.fields?.['店铺名称']);
  const foreign = [];
  for (const [name, cell] of Object.entries(r.fields ?? {})) {
    if (sourceDerived.has(name) || STRUCTURAL.has(name)) continue;
    const value = unwrap(cell);
    if (value !== null && value !== '') foreign.push(name);
  }
  return { recordId: r.record_id, shop, nonDerivedFilled: foreign.length };
});

console.log(`===== 底单（总数据来源底单）=====`);
console.log(`  总 ${sourceRecords.length} 条；${DAY} 命中 ${sourceOnDay.length} 条；派生列 ${sourceDerived.size} 个`);
for (const row of sourceRows) {
  console.log(`  · ${row.recordId} 店铺=${row.shop} 非派生列有值 ${row.nonDerivedFilled} 个`);
}

const unknowable = sourceRows.filter((row) => !DELETABLE_SOURCE_SHOPS.includes(row.shop));
const toDelete = sourceRows.filter((row) => DELETABLE_SOURCE_SHOPS.includes(row.shop));
console.log(`  ⇒ 待删 ${toDelete.length} 行：${toDelete.map((r) => r.shop).join(' / ')}`);
console.log(`  ⇒ 本链无通路重放、因此拒绝删 ${unknowable.length} 行：${unknowable.map((r) => r.shop).join(' / ') || '（没有）'}`);

// 判据 A：该日每一行的店铺名都必须是本链能重放的那五家之一。
if (unknowable.length > 0) {
  fail(`底单 ${DAY} 里有 ${unknowable.length} 行的店铺名不在「本链能重放」的名单里`
    + `（${unknowable.map((r) => r.shop).join(' / ')}）—— 删错就补不回来。`);
}
// 判据 B：待删行数不能超过五家（多了说明有重合/脏行）。
if (toDelete.length > REWRITE_KEYS.length) {
  fail(`待删行数 ${toDelete.length} > 本轮要重写的店铺数 ${REWRITE_KEYS.length}。`);
}

// ---------- 2. 各店铺数据日报：只清本链那两列 ----------
const inquiryFields = await listFields(targets.inquiryTable);
const inquiryDerived = new Set(inquiryFields.filter((f) => DERIVED_TYPES.has(f.type)).map((f) => f.name));
const inquiryRecords = await listAll(targets.inquiryTable);
const inquiryOnDay = inquiryRecords.filter((r) => onDay(r.fields?.['日期']));

const inquiryRows = inquiryOnDay.map((r) => {
  const shop = unwrap(r.fields?.['店铺']);
  const strangers = [];
  for (const [name, cell] of Object.entries(r.fields ?? {})) {
    if (inquiryDerived.has(name) || STRUCTURAL.has(name) || MINE.has(name)) continue;
    const value = unwrap(cell);
    if (value !== null && value !== '') strangers.push([name, value]);
  }
  return { recordId: r.record_id, shop,
    inquiry: unwrap(r.fields?.['询单量']), peer: unwrap(r.fields?.['同层同行询单量']), strangers };
});

console.log(`\n===== 各店铺数据日报（询单表）=====`);
console.log(`  总 ${inquiryRecords.length} 条；${DAY} 命中 ${inquiryOnDay.length} 条；派生列 ${inquiryDerived.size} 个`);
for (const row of inquiryRows) {
  const mark = REWRITE_KEYS.includes(row.shop) ? '〔本轮重写〕' : '〔不动〕';
  console.log(`  · ${row.recordId} ${mark} 店铺=${row.shop}`
    + ` 询单量=${row.inquiry || '（空）'} 同层同行询单量=${row.peer || '（空）'}`
    + ` 其它手写列非空 ${row.strangers.length} 个${row.strangers.length ? ` → ${JSON.stringify(row.strangers)}` : ''}`);
}

// 判据 C：12 行都在（删行会让回填无从下手，所以这一表只清字段、不删行）。
if (inquiryOnDay.length !== 12) {
  fail(`询单表 ${DAY} 只有 ${inquiryOnDay.length} 行（应为 12）—— 行不全时先查清楚，别清字段。`);
}
// 判据 D：除了本链那两个字段，没有别的手写内容（有人记过东西就停手问人）。
const offenders = inquiryRows.filter((row) => row.strangers.length > 0);
if (offenders.length > 0) {
  fail(`询单表有 ${offenders.length} 行存在「非派生、非本链」的内容，拒绝清字段。`);
}
// 判据 E：目标五行都在。
const missing = REWRITE_KEYS.filter((key) => !inquiryRows.some((row) => row.shop === key));
if (missing.length > 0) fail(`询单表 ${DAY} 里找不到这几行：${missing.join(' / ')}`);

const snapshot = {
  takenAt: new Date().toISOString(), reportDate: DAY, apply: APPLY,
  note: '删除前的枚举快照。派生列（Lookup/Formula）的值来自底单，随底单行一起归零属于预期。',
  source: { total: sourceRecords.length, onDay: sourceRows },
  inquiry: { total: inquiryRecords.length, onDay: inquiryRows },
  decision: { deleteSource: toDelete.map((r) => r.recordId),
    clearInquiryFields: inquiryRows.filter((r) => REWRITE_KEYS.includes(r.shop)).map((r) => r.recordId) },
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/pre-delete-snapshot.json`, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`\n快照已写 ${OUT_DIR}/pre-delete-snapshot.json`);

if (process.exitCode === 2) { console.log('有判据不成立 ⇒ 不执行任何删除。'); throw new Error('preconditions failed'); }
if (!APPLY) { console.log('（未加 --apply：什么都没删、什么都没清）'); process.exit(0); }

// ---------- 3. 执行 ----------
const deleted = [];
const cleared = [];
const failures = [];

for (const row of toDelete) {
  // 单条 DELETE：batch_delete 在这张 base 上报 1254043 RecordIdNotFound（sop §9.3 第 3 条）。
  const res = await fetch(`${API_ROOT}/bitable/v1/apps/${targets.baseToken}/tables/${targets.sourceTable}/records/${row.recordId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${bearer}` } }).then((r) => r.json());
  if (res.code === 0 && res.data?.deleted) { deleted.push(row); console.log(`  已删底单 ${row.recordId} ${row.shop}`); }
  else { failures.push({ table: 'source', ...row, code: res.code, msg: res.msg });
    console.log(`  失败底单 ${row.recordId} → ${res.code} ${res.msg}`); }
}

for (const row of inquiryRows.filter((r) => REWRITE_KEYS.includes(r.shop))) {
  const res = await fetch(`${API_ROOT}/bitable/v1/apps/${targets.baseToken}/tables/${targets.inquiryTable}/records/${row.recordId}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { 询单量: null, 同层同行询单量: null } }) }).then((r) => r.json());
  if (res.code === 0) { cleared.push(row); console.log(`  已清 ${row.recordId} ${row.shop} 的两个字段`); }
  else { failures.push({ table: 'inquiry', ...row, code: res.code, msg: res.msg });
    console.log(`  失败 ${row.recordId} → ${res.code} ${res.msg}`); }
}

// ---------- 4. 两侧独立回读 ----------
const sourceAfter = await listAll(targets.sourceTable);
const inquiryAfter = await listAll(targets.inquiryTable);
const sourceAfterOnDay = sourceAfter.filter((r) => onDay(r.fields?.['统计日期']));
const inquiryAfterOnDay = inquiryAfter.filter((r) => onDay(r.fields?.['日期']));

const report = {
  deletedAt: new Date().toISOString(), reportDate: DAY,
  source: { before: sourceRecords.length, after: sourceAfter.length,
    onDayAfter: sourceAfterOnDay.length,
    remainingShops: sourceAfterOnDay.map((r) => unwrap(r.fields?.['店铺名称'])) },
  inquiry: { before: inquiryRecords.length, after: inquiryAfter.length, onDayAfter: inquiryAfterOnDay.length,
    fieldsAfter: inquiryAfterOnDay.map((r) => ({ shop: unwrap(r.fields?.['店铺']),
      inquiry: unwrap(r.fields?.['询单量']), peer: unwrap(r.fields?.['同层同行询单量']) })) },
  deleted, cleared, failures,
  note: '删除走 OpenAPI 单条 DELETE（batch_delete 在这张 base 上报 1254043）。'
    + '本地审计表刻意不回改（append-only）—— 它现在还指向已被删掉的 record_id，'
    + '这正是「审计允许与飞书不一致」要暴露的现象。（表名故意不在此处复写：全仓库只许写入方与迁移提到它。）',
};
writeFileSync(`${OUT_DIR}/post-delete-verification.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`\n删后回读：底单 ${report.source.before} → ${report.source.after}（${DAY} 剩 ${report.source.onDayAfter} 行：${report.source.remainingShops.join(' / ') || '（空）'}）`);
console.log(`询单表 ${report.inquiry.before} → ${report.inquiry.after}（${DAY} 剩 ${report.inquiry.onDayAfter} 行）`);
console.log(`失败 ${failures.length} 条`);
if (failures.length > 0) process.exitCode = 1;
