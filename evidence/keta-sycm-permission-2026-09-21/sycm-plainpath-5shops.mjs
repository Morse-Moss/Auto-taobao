// 只读判定表：五家店各自对 /qos/service/frame/shop/performance 的**服务端**应答。
// 判据：redirected / finalUrl / 正文里的提示语。
// 只发 GET；不改任何状态。
import { writeFileSync } from 'node:fs';

const HOSTS = [
  { label: '里可林淘宝', port: 19041 },
  { label: '网林天猫', port: 19042 },
  { label: '盖文淘宝', port: 19043 },
  { label: '科塔淘宝', port: 19044 },
  { label: '盖文天猫', port: 19045 },
];

const expr = `(async () => {
  const out = {};
  try {
    const r = await fetch('/qos/service/frame/shop/performance', { redirect: 'follow', credentials: 'include' });
    const t = await r.text();
    out.status = r.status;
    out.redirected = r.redirected;
    out.finalUrl = r.url;
    out.textLen = t.length;
  } catch (e) { out.err = String(e); }
  try {
    const r2 = await fetch('/custom/no_permission?code=5903&message=No%20Buy%20Func%20Permission.', { redirect: 'follow', credentials: 'include' });
    const t2 = await r2.text();
    out.noPerm = { status: r2.status, textLen: t2.length,
      text: t2.replace(/<script[\\s\\S]*?<\\/script>/gi, ' ').replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 400) };
  } catch (e) { out.noPerm = { err: String(e) }; }
  return JSON.stringify(out);
})()`;

const targets = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/targets`, { signal: AbortSignal.timeout(8000) });
  return r.json();
};
const evalOn = async (port, targetId, expression) => {
  const r = await fetch(`http://127.0.0.1:${port}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expression, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  if (!r.ok) return { ok: false, httpStatus: r.status, raw: text.slice(0, 300) };
  try { return { ok: true, value: JSON.parse(JSON.parse(text).value) }; }
  catch { return { ok: false, raw: text.slice(0, 400) }; }
};

const rows = [];
for (const host of HOSTS) {
  const row = { ...host, nowAt: null, result: null };
  const list = await targets(host.port).catch(() => []);
  const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
  if (!tab) { row.error = '没有 sycm 页签'; rows.push(row); continue; }
  row.nowAt = String(tab.url);
  row.result = (await evalOn(host.port, tab.targetId, expr)).value ?? null;
  rows.push(row);
}

writeFileSync('D:/Retire/sycm-automation/tmp/sycm-plainpath-5shops.json', JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));

const L = [`at=${new Date().toISOString()}`, ''];
L.push('店铺            | 现在停在哪 | redirected | finalUrl');
for (const r of rows) {
  if (r.error || !r.result) { L.push(`${r.label} 读失败 ${r.error ?? JSON.stringify(r.result).slice(0, 120)}`); continue; }
  const v = r.result;
  const verdict = v.redirected ? '★ 被重定向（无权限）' : '正常 200';
  L.push(`${r.label}  |  ${v.redirected ? 'BOUNCED' : 'OK'}  |  redirected=${v.redirected}  |  ${v.finalUrl}`);
  L.push(`    当前页签: ${r.nowAt}`);
  if (v.redirected) L.push(`    提示页原文: ${v.noPerm?.text ?? JSON.stringify(v.noPerm)}`);
  L.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-plainpath-5shops.txt', L.join('\n'));
console.log(L.join('\n'));
