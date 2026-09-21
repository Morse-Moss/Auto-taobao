// 只读：把科塔当前那一页上「与 服务/考核/绩效 有关的可点元素」列出来（文案 + 标签 + 坐标）。
// 目的是为下一步的「点进去看看」找到真正的入口，而不是凭想象去点。
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 19044);
const expr = `(() => {
  const out = { href: location.href, items: [], navTexts: [] };
  const nodes = document.querySelectorAll('a, button, li, span, div[class*=menu], div[class*=nav]');
  const seen = new Set();
  for (const el of nodes) {
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 14) continue;
    if (!/服务|考核|绩效|洞察/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.items.push({ text: t, tag: el.tagName, cls: String(el.className).slice(0, 60),
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    if (out.items.length >= 40) break;
  }
  const nav = document.querySelectorAll('div[class*=menu] a, div[class*=nav] a, ul[class*=menu] li');
  for (const el of nav) {
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t && t.length <= 12) out.navTexts.push(t);
    if (out.navTexts.length >= 60) break;
  }
  return JSON.stringify(out);
})()`;

const list = await (await fetch(`http://127.0.0.1:${PORT}/targets`, { signal: AbortSignal.timeout(8000) })).json();
const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
if (!tab) { console.error('没有 sycm 页签'); process.exit(3); }
const r = await fetch(`http://127.0.0.1:${PORT}/eval?target=${encodeURIComponent(tab.targetId)}`,
  { method: 'POST', body: expr, signal: AbortSignal.timeout(30000) });
const text = await r.text();
writeFileSync('D:/Retire/sycm-automation/tmp/keta-nav-items.txt', `${r.status}\n${text.slice(0, 6000)}\n`);
console.log(`HTTP ${r.status}  页签=${tab.targetId}`);
console.log(text.slice(0, 5000));
