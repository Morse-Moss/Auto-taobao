// 只读：量「商品数据底单 / 商品询单数据底单」上每一行的日期读法，判断哪些天是「旧式」（UTC 读法与 +8 读法差一天）。
import { loadFeishuCredentials, productDataTargets } from '../../../runtime/feishu-targets.mjs';

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

function report(label, rows, dateField) {
  console.log(`\n=== ${label}（字段「${dateField}」）总行数 = ${rows.length} ===`);
  const byDay = new Map();
  let nullDate = 0;
  for (const r of rows) {
    const raw = r.fields?.[dateField];
    if (raw === undefined || raw === null || raw === '') { nullDate += 1; continue; }
    const plus8 = dPlus8(raw);
    const utc = dUtc(raw);
    if (!byDay.has(plus8)) byDay.set(plus8, { n: 0, legacy: 0, modern: 0, samples: [] });
    const b = byDay.get(plus8);
    b.n += 1;
    if (utc === plus8) b.modern += 1;
    else { b.legacy += 1; if (b.samples.length < 2) b.samples.push(`${raw}（UTC读=${utc}）`); }
  }
  console.log(`  「日期为空」的行 = ${nullDate}`);
  console.log('  日期(+8读法)  行数  旧式(差一天)  新式(一致)  样例时间戳');
  for (const [d, b] of [...byDay.entries()].sort()) {
    console.log(`  ${d}  ${String(b.n).padStart(5)}  ${String(b.legacy).padStart(11)}  ${String(b.modern).padStart(10)}  ${b.samples.join(' , ')}`);
  }
  const days = [...byDay.keys()].sort();
  console.log(`  最早 = ${days[0]}   最晚 = ${days[days.length - 1]}`);
}

report('商品数据底单', await pull(t.productTable), '统计日期');
report('商品询单数据底单', await pull(t.inquiryTable), '数据日期');
