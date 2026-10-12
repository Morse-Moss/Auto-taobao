// 2026-09-24 整轮重写之后的**独立回读**（2026-09-25 21:2x，用户指示「你全程监督」）。
//
// 为什么要单独写一份：链第 11 步的 readback-daily-report.mjs 走**浏览器**（19023），
// 而本轮的批次跑法是「跑完释放」—— 等我要做总核对时窗口已经收掉了，那条路走不通。
// 本脚本走**纯 OpenAPI**（凭据来自 runtime/feishu-targets.mjs 的单一事实来源），
// 与链里那一步不同通路 ⇒ 这才叫「独立」回读，而不是把链自己的回执再念一遍。
//
// 只读：全程只有 GET（auth 那次 POST 是取 token），不写、不删、不改。
import { mkdirSync, writeFileSync } from 'node:fs';

// 相对路径按**本文件位置**算是两层到仓库根（evidence/<批次目录>/ → ../.. ）。
// 2026-09-25 第一次写成三层，node 直接 ERR_MODULE_NOT_FOUND —— 与
// skills/evidence-copy-must-be-runnable 记的同一件事：证据脚本复制后深了一层就静默指错。
import { dailyReportTargets, loadFeishuCredentials } from '../../runtime/feishu-targets.mjs';

const API_ROOT = 'https://open.feishu.cn/open-apis';
const DAY = '2026-09-24';
const EPOCH = Date.parse(`${DAY}T00:00:00+08:00`);
// 09-20 科塔淘宝那行是用户明确说「不许碰、不许重跑」的，所以回读要专门把它量一遍。
const PINNED = { recordId: 'recvtXf8pkKky0', date: '2026-09-20', shop: '科塔淘宝' };
const SHOPS = ['里可林淘宝', '网林天猫', '盖文淘宝', '盖文天猫', '科塔淘宝'];
const OUT_DIR = 'D:/Retire/sycm-automation/evidence/daily-report-2026-09-24-independent-readback';

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

const unwrap = (cell) => {
  if (cell === null || cell === undefined) return '';
  const value = Array.isArray(cell) ? cell : [cell];
  return value.map((item) => (item && typeof item === 'object'
    ? (item.text ?? item.value ?? item.name ?? JSON.stringify(item)) : item)).join('').trim();
};
const onEpoch = (value, epoch) => {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = typeof raw === 'object' && raw !== null ? raw.value : raw;
  return Number(num) === epoch;
};
// 日期一律按 +08 渲染：底单「统计日期」是 +08 零点的时间戳，用 toISOString() 会退一天
// （1789833600000 本来是 09-20，UTC 渲染成 09-19）。这条在项目笔记里已经记过两次。
const renderDay = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = Number(typeof raw === 'object' && raw !== null ? raw.value : raw);
  if (!Number.isFinite(num)) return '';
  return new Date(num + 8 * 3600 * 1000).toISOString().slice(0, 10);
};

const source = await listAll(targets.sourceTable);
const inquiry = await listAll(targets.inquiryTable);

const sourceOnDay = source.filter((r) => onEpoch(r.fields?.['统计日期'], EPOCH));
const inquiryOnDay = inquiry.filter((r) => onEpoch(r.fields?.['日期'], EPOCH));

const sourceRows = sourceOnDay.map((r) => ({
  recordId: r.record_id,
  shop: unwrap(r.fields?.['店铺名称']),
}));
const inquiryRows = inquiryOnDay.map((r) => ({
  recordId: r.record_id,
  shop: unwrap(r.fields?.['店铺']),
  inquiry: unwrap(r.fields?.['询单量']),
  peer: unwrap(r.fields?.['同层同行询单量']),
}));

const pinnedRaw = inquiry.find((r) => r.record_id === PINNED.recordId);
const pinned = pinnedRaw
  ? { found: true, date: renderDay(pinnedRaw.fields?.['日期']),
    shop: unwrap(pinnedRaw.fields?.['店铺']),
    inquiry: unwrap(pinnedRaw.fields?.['询单量']), peer: unwrap(pinnedRaw.fields?.['同层同行询单量']) }
  : { found: false };

const writtenShops = SHOPS.filter((key) => inquiryRows.some((r) => r.shop === key && r.inquiry !== ''));
const missingShops = SHOPS.filter((key) => !writtenShops.includes(key));

const report = {
  readAt: new Date().toISOString(),
  reportDate: DAY,
  channel: 'OpenAPI（非浏览器，与链第 11 步不同通路）',
  baseToken: targets.baseToken,
  source: { table: targets.sourceTable, total: source.length, onDay: sourceRows.length, shops: sourceRows },
  inquiry: { table: targets.inquiryTable, total: inquiry.length, onDay: inquiryRows.length, rows: inquiryRows },
  pinned,
  criterion: {
    expectSourceRows: 5,
    srcShopsWritten: writtenShops,
    shopsMissingFields: missingShops,
  },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/readback.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const lines = [];
lines.push(`独立回读 ${report.readAt}（通路：OpenAPI）`);
lines.push(`底单：总 ${source.length} 条；${DAY} 命中 ${sourceRows.length} 条`);
for (const row of sourceRows) lines.push(`  · ${row.recordId} 店铺名称=${row.shop}`);
lines.push(`询单表：总 ${inquiry.length} 条；${DAY} 命中 ${inquiryRows.length} 条`);
for (const row of inquiryRows) {
  lines.push(`  · ${row.recordId} ${row.shop} 询单量=${row.inquiry || '（空）'} 同层同行询单量=${row.peer || '（空）'}`);
}
lines.push(`钉住的 09-20 科塔淘宝 ${PINNED.recordId}：${pinned.found
  ? `日期=${pinned.date} 店铺=${pinned.shop} 询单量=${pinned.inquiry || '（空）'} 同层同行询单量=${pinned.peer || '（空）'}`
  : '找不到（异常）'}`);
lines.push(`五家里两列都有值的：${writtenShops.join(' / ') || '（无）'}`);
lines.push(`五家里两列为空的：${missingShops.join(' / ') || '（无）'}`);
writeFileSync(`${OUT_DIR}/readback.txt`, `${lines.join('\n')}\n`, 'utf8');
console.log(lines.join('\n'));
