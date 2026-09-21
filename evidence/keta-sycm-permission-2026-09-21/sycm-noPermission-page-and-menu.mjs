// 只读：把两件事取回来
//  1) 平台自己给出的 no_permission 页面正文（这就是「为什么被挡」的官方说法）；
//  2) getMenuV2.json 里**那一个菜单节点**（menuPath 含 performance / frame/shop）的原文，
//     逐字段比两家的差别（菜单在两边都存在，差别在节点里的可见/授权标记）。
import { writeFileSync } from 'node:fs';

const HOSTS = [
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tb', label: '盖文淘宝（对照·健康）', port: 19043 },
];

const expr = `(async () => {
  const out = {};
  try {
    const r = await fetch('/custom/no_permission?code=5903&message=No%20Buy%20Func%20Permission.&ref_url=https://sycm.taobao.com/qos/service/frame/shop/performance',
      { credentials: 'include' });
    const t = await r.text();
    out.noPermission = { status: r.status, redirected: r.redirected, finalUrl: r.url, textLen: t.length,
      bodyText: (document.createElement('div').innerHTML = t, ''), raw: t.replace(/<script[\\s\\S]*?<\\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, 700) };
  } catch (e) { out.noPermission = { error: String(e) }; }
  try {
    const r = await fetch('/oneauth/api/getMenuV2.json?viewMode=s', { credentials: 'include' });
    const j = await r.json();
    const hits = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const path = String(node.menuPath || '');
      const name = String(node.menuName || '');
      if (/performance|frame\\/shop/.test(path) || /店铺绩效|绩效/.test(name)) {
        hits.push({
          menuName: name, menuPath: path, parentId: node.parentId ?? null,
          isVisible: node.isVisible ?? null, visible: node.visible ?? null,
          hasAuth: node.hasAuth ?? null, auth: node.auth ?? null,
          exAttr: node.exAttr ?? null,
          allKeys: Object.keys(node).slice(0, 25)
        });
      }
      Object.values(node).forEach((v) => { if (v && typeof v === 'object') walk(v); });
    };
    walk(j);
    out.menuNodes = hits.slice(0, 12);
    out.menuCode = j.code ?? null;
  } catch (e) { out.menu = { error: String(e) }; }
  return JSON.stringify(out, null, 1);
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
  try { return { ok: true, value: JSON.parse(JSON.parse(text).value) }; } catch { return { ok: false, raw: text.slice(0, 600) }; }
};

const lines = [];
for (const host of HOSTS) {
  lines.push(`===== ${host.label} =====`);
  const list = await targets(host.port).catch(() => []);
  const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
  if (!tab) { lines.push('  没有 sycm 页签'); continue; }
  const result = await evalOn(host.port, tab.targetId);
  lines.push(result.ok ? JSON.stringify(result.value, null, 1) : `读失败 ${JSON.stringify(result).slice(0, 400)}`);
  lines.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-noPermission-page-and-menu.txt', lines.join('\n'));
console.log(lines.join('\n'));
