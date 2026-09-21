// 只读对照：在**页面内部**对几个候选入口做一次 fetch，看服务端怎么回答。
//
// 目的：分清「弹回」是 ①服务端 302（权限/状态），还是 ②前端 JS 自己跳走。
// 判据：redirected / finalUrl / status / 正文长度 / 正文里有没有「无权」「开通」这类字样。
//
// 只发 GET；不点击、不写库。对健康的盖文淘宝（19043）做同一条对照。
import { writeFileSync } from 'node:fs';

const PATHS = [
  '/qos/service/frame/shop/performance/new',
  '/qos/service/frame/shop/performance',
  '/mc/free/sycm',
  '/portal/home.htm',
];

const HOSTS = [
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tb', label: '盖文淘宝（对照·健康）', port: 19043 },
];

const exprFor = (path) => `(async () => {
  const out = { path: ${JSON.stringify(path)} };
  try {
    const r = await fetch(${JSON.stringify(path)}, { redirect: 'follow', credentials: 'include' });
    const text = await r.text();
    out.status = r.status;
    out.redirected = r.redirected;
    out.finalUrl = r.url;
    out.textLen = text.length;
    out.head = text.replace(/\\s+/g, ' ').slice(0, 300);
    out.hasLogin = /请登录|登录后查看|亲，请登录/.test(text);
    out.hasNoRight = /无权限|无权访问|没有权限|开通|订购|购买|升级/.test(text);
  } catch (e) { out.error = String(e); }
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
  if (!r.ok) return { ok: false, httpStatus: r.status, raw: text.slice(0, 400) };
  try { return { ok: true, value: JSON.parse(JSON.parse(text).value) }; }
  catch { return { ok: false, raw: text.slice(0, 500) }; }
};

const report = { probedAt: new Date().toISOString(), hosts: [] };

for (const host of HOSTS) {
  const row = { ...host, sycmTargetId: null, currentUrl: null, fetches: [] };
  const list = await targets(host.port).catch(() => []);
  const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
  if (!tab) { row.error = '没有 sycm 页签'; report.hosts.push(row); continue; }
  row.sycmTargetId = tab.targetId;
  row.currentUrl = String(tab.url);
  for (const path of PATHS) {
    const result = await evalOn(host.port, tab.targetId, exprFor(path));
    row.fetches.push({ path, ...result });
  }
  report.hosts.push(row);
}

writeFileSync('D:/Retire/sycm-automation/tmp/sycm-entry-http-compare.json', JSON.stringify(report, null, 1));

const lines = [`probedAt=${report.probedAt}`, ''];
for (const row of report.hosts) {
  lines.push(`===== ${row.label}（${row.port}）当前在 ${row.currentUrl} =====`);
  for (const f of row.fetches) {
    const v = f.value;
    if (!v) { lines.push(`  ${f.path}  → 读失败 ${JSON.stringify(f).slice(0, 200)}`); continue; }
    if (v.error) { lines.push(`  ${v.path}  → 抛错 ${v.error}`); continue; }
    lines.push(`  ${v.path}`);
    lines.push(`      status=${v.status}  redirected=${v.redirected}  textLen=${v.textLen}`);
    lines.push(`      finalUrl=${v.finalUrl}`);
    lines.push(`      hasLogin=${v.hasLogin}  hasNoRight=${v.hasNoRight}`);
    lines.push(`      head=${String(v.head).slice(0, 180)}`);
  }
  lines.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-entry-http-compare.txt', lines.join('\n'));
console.log(lines.join('\n'));
