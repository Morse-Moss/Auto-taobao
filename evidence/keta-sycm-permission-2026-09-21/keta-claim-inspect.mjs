// 只读：把首页「一键领取」以及六个产品磁贴的可点结构挖出来，
// 好让他知道该点哪一个字、以及点下去是「只领一个」还是「一次全领」。
// 不点击、不导航，只读 DOM 结构与属性。
import { writeFileSync } from 'node:fs';

const PORT = 19044;
const expr = `(() => {
  const out = { href: location.href };
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const desc = (el) => ({
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 120),
    text: norm(el.innerText).slice(0, 60),
    attrs: Array.from(el.attributes).filter((a) => a.name !== 'class' && a.name !== 'style')
      .map((a) => a.name + '=' + String(a.value).slice(0, 120)),
  });
  const chains = (el, n) => {
    const L = [];
    let cur = el;
    for (let i = 0; i < n && cur; i++) { L.push(desc(cur)); cur = cur.parentElement; }
    return L;
  };
  const find = (t) => Array.from(document.querySelectorAll('span,div,a,button'))
    .filter((el) => norm(el.innerText) === t || norm(el.textContent) === t);

  const claim = find('一键领取')[0] || null;
  out.claim = claim ? { self: desc(claim), chain: chains(claim, 5) } : null;

  out.tiles = [];
  for (const name of ['市场洞察全新', '流量纵横', '品类罗盘', '数据作战室', '服务洞察', '长周期365天']) {
    const el = find(name).filter((e) => e.children.length === 0)[0];
    if (!el) { out.tiles.push({ name, found: false }); continue; }
    out.tiles.push({ name, found: true, self: desc(el), chain: chains(el, 4) });
  }

  // 「服务洞察」那一块附近的原文（往上找容器，看他点下去会看到什么）
  const sei = find('服务洞察').filter((e) => e.children.length === 0)[0];
  out.serviceInsightBlock = sei ? norm(sei.closest('div,li,a,section')?.parentElement?.innerText).slice(0, 300) : null;
  return JSON.stringify(out);
})()`;

const list = await (await fetch(`http://127.0.0.1:${PORT}/targets`, { signal: AbortSignal.timeout(8000) })).json();
const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('/mc/free/sycm'))
  ?? (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
if (!tab) { writeFileSync('D:/Retire/sycm-automation/tmp/keta-claim-inspect.txt', '没有 sycm 页签'); process.exit(0); }

const r = await fetch(`http://127.0.0.1:${PORT}/eval?target=${encodeURIComponent(tab.targetId)}`,
  { method: 'POST', body: expr, signal: AbortSignal.timeout(20000) });
const text = await r.text();
let data;
try { data = JSON.parse(JSON.parse(text).value); } catch { data = { parseError: text.slice(0, 400) }; }
writeFileSync('D:/Retire/sycm-automation/tmp/keta-claim-inspect.json', JSON.stringify(data, null, 1));

const L = [`at=${new Date().toISOString()}`, `page=${data.href ?? '?'}`, ''];
const dump = (label, obj) => {
  L.push('## ' + label);
  if (!obj) { L.push('   (没找到)'); L.push(''); return; }
  L.push('   self: <' + obj.self.tag + '> cls=' + obj.self.cls);
  L.push('   text: ' + obj.self.text);
  if (obj.self.attrs.length) L.push('   attrs: ' + obj.self.attrs.join(' | '));
  obj.chain.forEach((c, i) => L.push(`   ↑${i + 1} <${c.tag}> cls=${c.cls.slice(0, 80)}  attrs=${c.attrs.join('|').slice(0, 120)}`));
  L.push('');
};
dump('一键领取', data.claim);
for (const t of data.tiles ?? []) {
  if (!t.found) { L.push('## ' + t.name + ' —— 没找到'); L.push(''); continue; }
  dump('磁贴：' + t.name, t);
}
L.push('## 服务洞察 所在容器的原文');
L.push('   ' + (data.serviceInsightBlock ?? '(null)'));
writeFileSync('D:/Retire/sycm-automation/tmp/keta-claim-inspect.txt', L.join('\n'));
console.log(L.join('\n'));
