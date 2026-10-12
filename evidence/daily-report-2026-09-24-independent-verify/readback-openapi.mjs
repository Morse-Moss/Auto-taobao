// 独立回读（OpenAPI 全量翻页）：2026-09-24 五家店铺日报。
//
// 这一份**不依赖**那一轮的 summary.json，也不碰浏览器；判据全部来自飞书 OpenAPI。
// 目标与凭据的唯一来源是 runtime/feishu-targets.mjs（dailyReportTargets / loadFeishuCredentials）。
//
// 用法：node readback-openapi.mjs [输出 json 路径]
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO = 'D:/Retire/sycm-automation';
const TARGET_DATE = '2026-09-24';
const OUT = process.argv[2] || `${REPO}/evidence/daily-report-2026-09-24-independent-verify/readback.json`;

const { dailyReportTargets, loadFeishuCredentials } = await import(
  pathToFileURL(`${REPO}/runtime/feishu-targets.mjs`).href
);
const { FeishuClient } = await import(
  pathToFileURL(`${REPO}/skills/xws-to-feishu-base/scripts/feishu-client.mjs`).href
);

const T = dailyReportTargets('kcne');
const cred = loadFeishuCredentials('kcne');

// ---- 取值规整 -------------------------------------------------------------
// 文本字段可能是 string，也可能是 [{text}] / [{type,text}]；日期字段是 ms 数字。
function textOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => (item && typeof item === 'object' ? (item.text ?? item.name ?? '') : String(item)));
    const joined = parts.filter((s) => s !== '').join('');
    return joined === '' ? null : joined;
  }
  if (typeof value === 'object') return value.text ?? value.name ?? JSON.stringify(value);
  return String(value);
}

// 「统计日期」/「日期」是 +08 零点的时间戳：按 UTC 渲染会退一天，必须显式 +08。
function dateOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return new Date(value + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const n = Number(s);
  return Number.isFinite(n) && n > 1e11 ? new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10) : s;
}

function present(value) {
  const t = textOf(value);
  return t === null || t === '' ? null : t;
}

async function readTable(logical, tableId) {
  const client = new FeishuClient({ appId: cred.appId, appSecret: cred.appSecret, appToken: T.baseToken, tableId });
  const total = await client.getRecordCount();
  const records = await client.listRecords();
  const fields = await client.listFields();
  return { logical, tableId, total, records, fields: fields.map((f) => `${f.fieldName}(type=${f.type})`) };
}

const source = await readTable('source', T.sourceTable);
const inquiry = await readTable('inquiry', T.inquiryTable);

// ---- 底单：按 +08 日期分组 -------------------------------------------------
const sourceByDate = new Map();
const sourceKeysSample = new Set();
for (const r of source.records) {
  const f = r.fields ?? {};
  for (const k of Object.keys(f)) sourceKeysSample.add(k);
  const d = dateOf(f['统计日期']);
  if (!sourceByDate.has(d)) sourceByDate.set(d, []);
  sourceByDate.get(d).push({
    recordId: r.record_id,
    shopName: present(f['店铺名称']),
    shopLookup: present(f['店铺']),
  });
}

// ---- 询单表：按 +08 日期分组 ----------------------------------------------
const inquiryByDate = new Map();
const inquiryKeysSample = new Set();
for (const r of inquiry.records) {
  const f = r.fields ?? {};
  for (const k of Object.keys(f)) inquiryKeysSample.add(k);
  const d = dateOf(f['日期']);
  if (!inquiryByDate.has(d)) inquiryByDate.set(d, []);
  inquiryByDate.get(d).push({
    recordId: r.record_id,
    shop: present(f['店铺']),
    inquiry: present(f['询单量']),
    peer: present(f['同层同行询单量']),
    rawInquiry: f['询单量'] ?? null,
    rawPeer: f['同层同行询单量'] ?? null,
  });
}

const recentDates = (map, n = 10) =>
  [...map.entries()]
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .slice(0, n)
    .map(([date, rows]) => ({ date, count: rows.length }));

const dupCheck = (map) => {
  const out = [];
  for (const [date, rows] of map) {
    const by = new Map();
    for (const row of rows) {
      const key = `${row.shopName ?? row.shop ?? '(无名)'}`;
      by.set(key, (by.get(key) ?? 0) + 1);
    }
    for (const [shop, n] of by) if (n > 1) out.push({ date, shop, count: n });
  }
  return out;
};

const KNOWN_FIVE = ['里可林家居', '网林家居旗舰店', '盖文全卫定制', '盖文旗舰店', '科塔全卫定制'];
const INQUIRY_FIVE = ['盖文天猫', '里可林淘宝', '网林天猫', '盖文淘宝', '科塔淘宝'];
const REF_RECORD = 'recvtXf8pkKky0';

const sourceOnDate = sourceByDate.get(TARGET_DATE) ?? [];
const inquiryOnDate = inquiryByDate.get(TARGET_DATE) ?? [];
const refRecord = inquiry.records.find((r) => r.record_id === REF_RECORD) ?? null;

const report = {
  at: new Date().toISOString(),
  atLocal: new Date().toLocaleString('sv-SE'),
  target: { profile: 'kcne', baseToken: T.baseToken, sourceTable: T.sourceTable, inquiryTable: T.inquiryTable, credentialFile: cred.file },
  source: {
    tableId: T.sourceTable,
    totalRecords: source.total,
    listedRecords: source.records.length,
    recentDates: recentDates(sourceByDate),
    onDate: TARGET_DATE,
    onDateCount: sourceOnDate.length,
    onDateRows: sourceOnDate,
    onDateShops: sourceOnDate.map((r) => r.shopName),
    missingFromFive: KNOWN_FIVE.filter((name) => !sourceOnDate.some((r) => r.shopName === name)),
    unexpectedShops: sourceOnDate.map((r) => r.shopName).filter((n) => !KNOWN_FIVE.includes(n)),
    duplicates: dupCheck(sourceByDate),
  },
  inquiry: {
    tableId: T.inquiryTable,
    totalRecords: inquiry.total,
    listedRecords: inquiry.records.length,
    recentDates: recentDates(inquiryByDate),
    onDate: TARGET_DATE,
    onDateCount: inquiryOnDate.length,
    onDateRows: inquiryOnDate,
    five: INQUIRY_FIVE.map((shop) => {
      const hit = inquiryOnDate.find((r) => r.shop === shop);
      return hit
        ? { shop, found: true, recordId: hit.recordId, 询单量: hit.inquiry, 同层同行询单量: hit.peer }
        : { shop, found: false, recordId: null, 询单量: null, 同层同行询单量: null };
    }),
    duplicates: dupCheck(inquiryByDate),
    referenceRecord: refRecord
      ? { recordId: REF_RECORD, found: true, 日期: dateOf(refRecord.fields?.['日期']), 店铺: present(refRecord.fields?.['店铺']), 询单量: present(refRecord.fields?.['询单量']), 同层同行询单量: present(refRecord.fields?.['同层同行询单量']) }
      : { recordId: REF_RECORD, found: false },
  },
  fieldInventory: {
    sourceKeys: [...sourceKeysSample],
    inquiryKeys: [...inquiryKeysSample],
    sourceFieldSignature: source.fields,
    inquiryFieldSignature: inquiry.fields,
  },
};

// 供直接拼接成证据文件的读法辅助：key 一律 UTF-8，不转义中文。
writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
console.log(`written ${OUT}`);
