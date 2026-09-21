// 只读：从 getMenuV2 里把「店铺绩效」这一项的**面包屑**还原出来（沿 parentId 往上走）。
// 目的：Keta 的菜单里其实也有「店铺绩效」这个节点（指向 /new 那条），看它挂在谁下面、
// 与健康店的面包屑差在哪里 —— 这决定「人点进去能不能到」。
import { writeFileSync } from 'node:fs';

const HOSTS = [
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tb', label: '盖文淘宝（对照·健康）', port: 19043 },
];

const expr = `(async () => {
  const r = await fetch('/oneauth/api/getMenuV2.json?viewMode=s', { credentials: 'include' });
  const j = await r.json();
  const byId = new Map();
  const all = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.menuId !== undefined) { byId.set(String(n.menuId), n); all.push(n); }
    Object.values(n).forEach((v) => { if (v && typeof v === 'object') walk(v); });
  };
  walk(j);
  const breadcrumb = (node) => {
    const out = [];
    let cur = node;
    for (let i = 0; i < 6 && cur; i += 1) {
      out.unshift({ id: cur.menuId, name: cur.menuName, path: cur.menuPath, visible: cur.isVisible });
      cur = cur.parentId === undefined ? null : byId.get(String(cur.parentId));
    }
    return out;
  };
  const hits = all.filter((n) => /performance/.test(String(n.menuPath || '')) && /shop/.test(String(n.menuPath || '')));
  const perf = all.filter((n) => String(n.menuName || '').includes('绩效'));
  return JSON.stringify({
    total: all.length,
    shopPerformanceNodes: hits.map((n) => ({ id: n.menuId, name: n.menuName, path: n.menuPath, visible: n.isVisible,
      breadcrumb: breadcrumb(n) })),
    绩效节点列表: perf.map((n) => ({ id: n.menuId, name: n.menuName, path: n.menuPath, parentId: n.parentId, visible: n.isVisible }))
  }, null, 1);
})()`;

const lines = [];
for (const host of HOSTS) {
  lines.push(`===== ${host.label} =====`);
  const list = await (await fetch(`http://127.0.0.1:${host.port}/targets`, { signal: AbortSignal.timeout(8000) })).json();
  const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
  if (!tab) { lines.push('  没有 sycm 页签'); lines.push(''); continue; }
  const r = await fetch(`http://127.0.0.1:${host.port}/eval?target=${encodeURIComponent(tab.targetId)}`,
    { method: 'POST', body: expr, signal: AbortSignal.timeout(40000) });
  const text = await r.text();
  try { lines.push(JSON.stringify(JSON.parse(JSON.parse(text).value), null, 1)); }
  catch { lines.push(`  读失败 HTTP ${r.status}：${text.slice(0, 300)}`); }
  lines.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-menu-breadcrumb.txt', lines.join('\n'));
console.log(lines.join('\n'));
