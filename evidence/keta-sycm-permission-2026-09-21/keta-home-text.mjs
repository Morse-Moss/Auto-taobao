// 只读：把科塔当前页面的**可见文字**抓一段下来（用于核对「人工看上去正常」这件事）。
// 只读 DOM，不发任何请求、不改任何状态。
import { writeFileSync } from 'node:fs';

const PORT = 19044;
const expr = `(async () => {
  const t = (document.body && document.body.innerText) ? document.body.innerText : '';
  return JSON.stringify({ href: location.href, title: document.title, len: t.length, text: t.replace(/\\n{2,}/g, '\\n').trim().slice(0, 1200) });
})()`;

const list = await (await fetch(`http://127.0.0.1:${PORT}/targets`, { signal: AbortSignal.timeout(8000) })).json();
const tabs = Array.isArray(list) ? list : [];
const out = { at: new Date().toISOString(), port: PORT, tabs: tabs.map((t) => ({ targetId: t.targetId, url: t.url })), read: [] };

for (const tab of tabs) {
  if (!String(tab.url ?? '').includes('sycm.taobao.com')) continue;
  const r = await fetch(`http://127.0.0.1:${PORT}/eval?target=${encodeURIComponent(tab.targetId)}`,
    { method: 'POST', body: expr, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  try { out.read.push(JSON.parse(JSON.parse(text).value)); } catch { out.read.push({ parseError: text.slice(0, 300) }); }
}

writeFileSync('D:/Retire/sycm-automation/tmp/keta-home-text.json', JSON.stringify(out, null, 1));
const L = [`at=${out.at}`, ''];
for (const t of out.tabs) L.push(`页签: ${t.url}`);
L.push('');
for (const r of out.read) {
  L.push(`--- ${r.href ?? '(读不到)'}  len=${r.len ?? '?'}`);
  L.push(r.text ?? JSON.stringify(r));
  L.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/keta-home-text.txt', L.join('\n'));
console.log(L.join('\n'));
