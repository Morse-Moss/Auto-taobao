// 只读对照：把五家店（+商家浏览器）那一页生意参谋的**客户端状态**读一遍，找差异。
// 不点击、不导航、不写任何东西 —— 只 POST /eval 读一次。
//
// 想回答的问题：健康的四家与科塔，在这一页上有什么**结构性**不同
// （URL / 存储的键 / iframe / 导航条目 / 是否被重定向过）。
import { writeFileSync } from 'node:fs';

const SYCM_FRAGMENT = 'sycm.taobao.com';
const PROXIES = [
  { key: 'dailyReport', label: '商家浏览器', port: 19023 },
  { key: 'likelin', label: '里可林淘宝', port: 19041 },
  { key: 'wanglin', label: '网林天猫', port: 19042 },
  { key: 'gaiwen-tb', label: '盖文淘宝', port: 19043 },
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tm', label: '盖文天猫', port: 19045 },
];

// 表达式全 ASCII，返回 JSON 字符串（与仓库里 read-page.mjs 同一口径）。
const expr = `(() => {
  const ls = {};
  try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i);
    ls[k] = String(localStorage.getItem(k)).slice(0, 120); } } catch (e) { ls.__err = String(e); }
  const ss = {};
  try { for (let i = 0; i < sessionStorage.length; i += 1) { const k = sessionStorage.key(i);
    ss[k] = String(sessionStorage.getItem(k)).slice(0, 120); } } catch (e) { ss.__err = String(e); }
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const body = document.body ? (document.body.innerText || '') : '';
  return JSON.stringify({
    href: location.href,
    origin: location.origin,
    pathname: location.pathname,
    hash: location.hash,
    title: document.title,
    readyState: document.readyState,
    bodyLen: body.length,
    bodyHead: body.replace(/\\s+/g, ' ').slice(0, 220),
    cookieNames: document.cookie.split(';').map((s) => s.trim().split('=')[0]).filter(Boolean),
    lsKeys: Object.keys(ls),
    ssKeys: Object.keys(ss),
    ls,
    ss,
    iframeCount: document.querySelectorAll('iframe').length,
    iframeSrcs: [...document.querySelectorAll('iframe')].map((f) => String(f.src).slice(0, 160)).slice(0, 8),
    navType: nav.type || null,
    navRedirectCount: (nav.redirectCount === undefined ? null : nav.redirectCount),
    navName: nav.name || null,
    hasLoginForm: Boolean(document.querySelector('input[type=password]'))
  });
})()`;

const out = { probedAt: new Date().toISOString(), hosts: [] };

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/targets`, { signal: AbortSignal.timeout(8000) });
  return response.json();
}

async function evalOn(port, targetId) {
  const response = await fetch(`http://127.0.0.1:${port}/eval?target=${encodeURIComponent(targetId)}`,
    { method: 'POST', body: expr, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) return { ok: false, httpStatus: response.status, raw: text.slice(0, 400) };
  try { return { ok: true, httpStatus: response.status, value: JSON.parse(JSON.parse(text).value) }; }
  catch { return { ok: false, httpStatus: response.status, raw: text.slice(0, 600) }; }
}

for (const entry of PROXIES) {
  const row = { ...entry, sycmTargetId: null, state: null, error: null };
  try {
    const targets = await listTargets(entry.port);
    const sycmTab = (Array.isArray(targets) ? targets : [])
      .find((tab) => String(tab.url ?? '').includes(SYCM_FRAGMENT));
    if (!sycmTab) { row.error = '这一页上没有 sycm 页签'; out.hosts.push(row); continue; }
    row.sycmTargetId = sycmTab.targetId;
    row.tabUrlFromTargets = String(sycmTab.url);
    row.state = await evalOn(entry.port, sycmTab.targetId);
  } catch (error) {
    row.error = `${error?.name}: ${error?.message ?? error}`;
  }
  out.hosts.push(row);
}

writeFileSync('D:/Retire/sycm-automation/tmp/sycm-tab-state-compare.json', JSON.stringify(out, null, 1));

const lines = [`probedAt=${out.probedAt}`, ''];
for (const row of out.hosts) {
  lines.push(`===== ${row.label}（代理 ${row.port}）=====`);
  if (row.error) { lines.push(`  ${row.error}`); lines.push(''); continue; }
  const v = row.state?.value;
  if (!v) { lines.push(`  eval 失败：${JSON.stringify(row.state).slice(0, 300)}`); lines.push(''); continue; }
  lines.push(`  href=${v.href}`);
  lines.push(`  title=${v.title}  readyState=${v.readyState}  bodyLen=${v.bodyLen}  iframes=${v.iframeCount}`);
  lines.push(`  navType=${v.navType}  navRedirectCount=${v.navRedirectCount}  navName=${String(v.navName).slice(0, 90)}`);
  lines.push(`  cookieNames=${JSON.stringify(v.cookieNames)}`);
  lines.push(`  localStorage keys=${JSON.stringify(v.lsKeys)}`);
  lines.push(`  sessionStorage keys=${JSON.stringify(v.ssKeys)}`);
  lines.push(`  bodyHead=${String(v.bodyHead).slice(0, 160)}`);
  lines.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-tab-state-compare.txt', lines.join('\n'));
console.log(lines.join('\n'));
