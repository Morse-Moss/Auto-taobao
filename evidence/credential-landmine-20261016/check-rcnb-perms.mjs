// 只读：核 kcne 应用对外组织(rcnb)几张 base 的权限状态（对照已知事实：日报 base 写入 403/91403）。
// 只发 GET（+ 换 token 的 POST）。不写任何东西。
import { readFileSync } from 'node:fs';
import { dailyReportTargets, promotionDailyTargets, PRODUCT_DATA_MONTH_BASES } from 'file:///D:/Retire/sycm-automation/runtime/feishu-targets.mjs';

const API = 'https://open.feishu.cn/open-apis';
const env = {};
for (const line of readFileSync('E:/小红书/.env.feishu-kcne.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const token = (await (await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
})).json()).tenant_access_token;
console.log('kcne token:', token ? 'OK' : 'FAIL');

const j = async (url) => { const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }); let b; try { b = await r.json(); } catch { b = { code: 'non-json' }; } return { http: r.status, code: b.code, msg: b.msg ?? b.message ?? '' }; };

const bases = [
  ['日报（对照·已知非协作者）', dailyReportTargets('kcne').baseToken],
  ['推广1部 promotionDaily', promotionDailyTargets('kcne').baseToken],
  ['商品1部（rcnb）', 'LQgZbi78oaAmIYsc4urcwk9rnNf'],
  ['商品2部（rcnb）', 'LLWcbIuVFaBm6yshX9Xc8DFZn9d'],
];
// 顺带把注册表里 2026-10 的实际取值也打出来（核对与上面硬编码的两个 token 是否一致）。
try {
  const oct = PRODUCT_DATA_MONTH_BASES?.['2026-10'];
  console.log('注册表 2026-10 =', JSON.stringify(oct).slice(0, 400), '\n');
} catch (e) { console.log('（注册表读取失败：', e.message, '）\n'); }

for (const [label, tok] of bases) {
  const members = await j(`${API}/drive/v1/permissions/${tok}/members?type=bitable`);
  const app = await j(`${API}/bitable/v1/apps/${tok}`);
  console.log(`${label}\n  token=${tok}\n  协作者接口 → HTTP ${members.http} code=${members.code} ${members.msg}\n  app 信息   → HTTP ${app.http} code=${app.code} ${app.msg}`);
}
console.log('\n（对照口径：日报 base 已知 kcne 只有链接分享级只读 ⇒ 写入 403/91403。');
console.log(' 若商品/推广 base 的协作者接口与日报 base 同形，则写入大概率同样被拒。）');
