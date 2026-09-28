// 只读：把「旧式」（UTC 读法与 +8 读法差一天）的行整条打出来，看它们到底是什么。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 向上找仓库根的哨兵文件 VERSION ⇒ 与所在目录深度无关（tmp/ 原件与 evidence/ 副本可逐字相同）
let ROOT = path.dirname(fileURLToPath(import.meta.url));
while (!fs.existsSync(path.join(ROOT, 'VERSION'))) ROOT = path.dirname(ROOT);

const { loadFeishuCredentials, productDataTargets } = await import(pathToFileURL(path.join(ROOT, 'runtime/feishu-targets.mjs')).href);

const c = loadFeishuCredentials('kcne');
const auth = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
})).json();
const H = { Authorization: `Bearer ${auth.tenant_access_token}` };
const t = productDataTargets('kcne');

const dUtc = (v) => new Date(Number(v)).toISOString().slice(0, 10);
const dPlus8 = (v) => new Date(Number(v) + 8 * 3600 * 1000).toISOString().slice(0, 10);

async function pull(tableId) {
  const out = []; let pt = '';
  for (;;) {
    const u = `https://open.feishu.cn/open-apis/bitable/v1/apps/${t.baseToken}/tables/${tableId}/records?page_size=500` + (pt ? `&page_token=${pt}` : '');
    const j = await (await fetch(u, { headers: H })).json();
    out.push(...(j.data.items ?? []));
    if (!j.data.has_more) break; pt = j.data.page_token;
  }
  return out;
}

function dumpLegacy(label, rows, dateField, fromDay) {
  console.log(`\n=== ${label}：${fromDay} 及以后的「旧式」行 ===`);
  const hit = rows.filter((r) => {
    const raw = r.fields?.[dateField];
    if (raw === undefined || raw === null || raw === '') return false;
    return dPlus8(raw) >= fromDay && dUtc(raw) !== dPlus8(raw);
  });
  console.log(`  条数 = ${hit.length}`);
  for (const r of hit) {
    const f = r.fields ?? {};
    const raw = f[dateField];
    const keys = Object.keys(f);
    const nonEmpty = keys.filter((k) => f[k] !== undefined && f[k] !== null && f[k] !== '');
    console.log(`\n  record_id = ${r.record_id}`);
    console.log(`    ${dateField} = ${raw}   (+8读=${dPlus8(raw)}  UTC读=${dUtc(raw)})`);
    console.log(`    非空字段数 = ${nonEmpty.length} / ${keys.length}`);
    console.log(`    非空字段内容 = ${JSON.stringify(nonEmpty.map((k) => [k, f[k]]))}`);
  }
}

dumpLegacy('商品询单数据底单', await pull(t.inquiryTable), '数据日期', '2026-09-20');
dumpLegacy('商品数据底单', await pull(t.productTable), '统计日期', '2026-09-20');
