// 只读对照：页面自己用的那个权限查询 —— `/oneauth/api/permission.json?_v2=2&p_url=<页面 URL>`。
// 健康的四家 localStorage 里都有 `p_url=http://sycm.taobao.com/qos/service/frame/shop/performance/new`
// 这一条缓存；科塔没有。把这条查询逐字发给两边，看服务端怎么答。
//
// 三个 p_url：工作页、工作页的 /new 变体、门户首页（首页那条是**阳性对照**，两边都该放行）。
import { writeFileSync } from 'node:fs';

const HOSTS = [
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tb', label: '盖文淘宝（对照·健康）', port: 19043 },
];

const P_URLS = [
  'http://sycm.taobao.com/qos/service/frame/shop/performance/new',
  'http://sycm.taobao.com/qos/service/frame/shop/performance',
  'http://sycm.taobao.com/portal/home.htm',
];

const expr = `(async () => {
  const out = { pUrls: [] };
  const urls = ${JSON.stringify(P_URLS)};
  for (const u of urls) {
    const entry = { pUrl: u };
    try {
      const p = '/oneauth/api/permission.json?_v2=2&p_url=' + encodeURIComponent(u);
      const r = await fetch(p, { credentials: 'include' });
      const t = await r.text();
      entry.status = r.status;
      entry.redirected = r.redirected;
      entry.finalUrl = r.url;
      entry.textLen = t.length;
      entry.head = t.replace(/\\s+/g, ' ').slice(0, 320);
      entry.saysDenied = /no_permission|5903|No Buy/.test(t + r.url);
    } catch (e) { entry.error = String(e); }
    out.pUrls.push(entry);
  }
  return JSON.stringify(out, null, 1);
})()`;

const targets = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/targets`, { signal: AbortSignal.timeout(8000) });
  return r.json();
};
const evalOn = async (port, targetId) => {
  const r = await fetch(`http://127.0.0.1:${port}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expr, signal: AbortSignal.timeout(40000) });
  const text = await r.text();
  if (!r.ok) return { ok: false, httpStatus: r.status, raw: text.slice(0, 300) };
  try { return { ok: true, value: JSON.parse(JSON.parse(text).value) }; } catch { return { ok: false, raw: text.slice(0, 500) }; }
};

const lines = [];
for (const host of HOSTS) {
  lines.push(`===== ${host.label} =====`);
  const list = await targets(host.port).catch(() => []);
  const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
  if (!tab) { lines.push('  没有 sycm 页签'); continue; }
  const result = await evalOn(host.port, tab.targetId);
  if (!result.ok) { lines.push(`  读失败 ${JSON.stringify(result).slice(0, 400)}`); lines.push(''); continue; }
  for (const entry of result.value.pUrls) {
    lines.push(`  p_url=${entry.pUrl}`);
    lines.push(`      status=${entry.status}  redirected=${entry.redirected}  textLen=${entry.textLen}  saysDenied=${entry.saysDenied}`);
    lines.push(`      finalUrl=${entry.finalUrl}`);
    lines.push(`      head=${String(entry.head).slice(0, 240)}`);
  }
  lines.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-pUrl-permission-compare.txt', lines.join('\n'));
console.log(lines.join('\n'));
