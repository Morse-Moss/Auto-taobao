// 只读：把科塔当前落地页上「可点的东西」捞出来（文字 + href），
// 目的是给人一条能照着点的路径，而不是让他去猜菜单。
// 不点击、不导航、不新建页签，只读 DOM。
import { writeFileSync } from 'node:fs';

const PORT = 19044;
const expr = `(() => {
  const out = { href: location.href, title: document.title };
  const anchors = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
    text: (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    href: a.href,
  })).filter((x) => x.text || x.href);
  const seen = new Set();
  out.anchors = anchors.filter((x) => {
    const k = x.href;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 60);
  // 页面文字里跟「订购 / 领取 / 洞察 / 服务市场」有关的元素的全文
  const kw = /订购|续订|领取|开通|服务市场|服务洞察|我的订购|权限/;
  out.hits = Array.from(document.querySelectorAll('*'))
    .filter((el) => el.children.length === 0 && kw.test(el.innerText || ''))
    .map((el) => {
      const a = el.closest('a[href]');
      return { text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        tag: el.tagName, nearestAnchor: a ? a.href : null };
    }).slice(0, 40);
  return JSON.stringify(out);
})()`;

const list = await (await fetch(`http://127.0.0.1:${PORT}/targets`, { signal: AbortSignal.timeout(8000) })).json();
const tabs = (Array.isArray(list) ? list : []).filter((t) => String(t.url ?? '').includes('sycm.taobao.com'));
const out = { at: new Date().toISOString(), port: PORT, reads: [] };
for (const tab of tabs) {
  const r = await fetch(`http://127.0.0.1:${PORT}/eval?target=${encodeURIComponent(tab.targetId)}`,
    { method: 'POST', body: expr, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  try { out.reads.push(JSON.parse(JSON.parse(text).value)); } catch { out.reads.push({ parseError: text.slice(0, 300) }); }
}
writeFileSync('D:/Retire/sycm-automation/tmp/keta-page-anchors.json', JSON.stringify(out, null, 1));

const L = [`at=${out.at}`, ''];
for (const r of out.reads) {
  L.push('===== ' + (r.href ?? '(读不到)'));
  L.push('-- 可点链接（去重后）');
  for (const a of r.anchors ?? []) L.push(`   [${a.text || '(无文字)'}]  ${a.href}`);
  L.push('-- 命中关键词的元素');
  for (const h of r.hits ?? []) L.push(`   <${h.tag}> ${h.text}  →  ${h.nearestAnchor ?? '(不是链接)'}`);
  L.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/keta-page-anchors.txt', L.join('\n'));
console.log(L.join('\n'));
