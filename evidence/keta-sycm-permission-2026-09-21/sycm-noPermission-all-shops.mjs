// 五家店一起做同一个服务端请求，看「谁被退回 no_permission」。
// 路径刻意用**不带 /new 的那个**（`/qos/service/frame/shop/performance`）：它由服务端做权限判定，
// 带 /new 的那个只回一个 SPA 外壳（两边都 200），看不出差别。
//
// 只发 GET，不改任何状态。
import { writeFileSync } from 'node:fs';

const PATH = '/qos/service/frame/shop/performance';
const HOSTS = [
  { key: 'dailyReport', label: '商家浏览器', port: 19023 },
  { key: 'likelin', label: '里可林淘宝', port: 19041 },
  { key: 'wanglin', label: '网林天猫', port: 19042 },
  { key: 'gaiwen-tb', label: '盖文淘宝', port: 19043 },
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tm', label: '盖文天猫', port: 19045 },
];

const expr = `(async () => {
  try {
    const r = await fetch(${JSON.stringify(PATH)}, { credentials: 'include' });
    const t = await r.text();
    return JSON.stringify({
      status: r.status,
      redirected: r.redirected,
      finalUrl: r.url,
      denied: r.url.indexOf('no_permission') >= 0,
      code: (r.url.match(/code=(\\d+)/) || [])[1] || null,
      message: decodeURIComponent((r.url.match(/message=([^&]+)/) || [])[1] || '') || null,
      textLen: t.length,
      bodyHead: t.replace(/\\s+/g, ' ').slice(0, 200)
    });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

const targets = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/targets`, { signal: AbortSignal.timeout(8000) });
  return r.json();
};
const evalOn = async (port, targetId) => {
  const r = await fetch(`http://127.0.0.1:${port}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expr, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) return { ok: false, httpStatus: r.status, raw: text.slice(0, 300) };
  try { return { ok: true, value: JSON.parse(JSON.parse(text).value) }; } catch { return { ok: false, raw: text.slice(0, 400) }; }
};

const rows = [];
for (const host of HOSTS) {
  const row = { ...host, currentUrl: null, result: null };
  const list = await targets(host.port).catch(() => []);
  const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
  if (!tab) { row.result = { error: '没有 sycm 页签' }; rows.push(row); continue; }
  row.currentUrl = String(tab.url);
  row.result = await evalOn(host.port, tab.targetId);
  rows.push(row);
}

writeFileSync('D:/Retire/sycm-automation/tmp/sycm-noPermission-all-shops.json', JSON.stringify(rows, null, 1));

const lines = ['把同一个请求发给五家店的生意参谋页签，看服务端判定：', `  路径 ${PATH}`, ''];
for (const row of rows) {
  const v = row.result?.value;
  if (!v) { lines.push(`${row.label}（${row.port}）  读失败 ${JSON.stringify(row.result).slice(0, 160)}`); continue; }
  const verdict = v.denied ? `被拒（no_permission code=${v.code} ${v.message}）` : '放行（停在原路径）';
  lines.push(`${row.label}（${row.port}）  ${verdict}`);
  lines.push(`    当前页签：${String(row.currentUrl).slice(0, 90)}`);
  if (v.denied) lines.push(`    finalUrl=${v.finalUrl}`);
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-noPermission-all-shops.txt', lines.join('\n'));
console.log(lines.join('\n'));
