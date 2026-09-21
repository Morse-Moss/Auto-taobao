// 收尾排除法：同一个请求、同一个 p_url，只把「谁发的」与「Referer」两个变量分开。
//   A) 带 referrer（默认，页面在 portal/home.htm）
//   B) 不带 referrer（referrerPolicy:'no-referrer'）
//   C) 再问一次 `/qos/service/frame/shop/performance` 但把 host 写成 https 形式
// 若三种都是 5903 ⇒ 与「发起页是谁」无关，是**这个账号**的功能权限。
// 同时取回「当前登录的会员/店铺」信息，供收信人核对是不是这家店。
import { writeFileSync } from 'node:fs';

const HOSTS = [
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tb', label: '盖文淘宝（对照·健康）', port: 19043 },
];

const expr = `(async () => {
  const out = { cases: [] };
  const ask = async (label, pUrl, opts) => {
    const entry = { label, pUrl };
    try {
      const path = '/oneauth/api/permission.json?_v2=2&p_url=' + encodeURIComponent(pUrl);
      const r = await fetch(path, Object.assign({ credentials: 'include' }, opts || {}));
      const t = await r.text();
      entry.status = r.status;
      entry.body = t.replace(/\\s+/g, ' ').slice(0, 200);
    } catch (e) { entry.error = String(e); }
    out.cases.push(entry);
  };
  await ask('A 默认（带 referrer）', 'http://sycm.taobao.com/qos/service/frame/shop/performance');
  await ask('B 不带 referrer', 'http://sycm.taobao.com/qos/service/frame/shop/performance', { referrerPolicy: 'no-referrer' });
  await ask('C https 形式', 'https://sycm.taobao.com/qos/service/frame/shop/performance');
  await ask('D 对照：/new 那条（两边都该放行）', 'http://sycm.taobao.com/qos/service/frame/shop/performance/new');
  try {
    const r = await fetch('/oneauth/api/permission.json?type=all_modules', { credentials: 'include' });
    const j = await r.json();
    const d = j.data;
    out.modulesType = Array.isArray(d) ? 'array' : typeof d;
    const flat = JSON.stringify(d);
    out.hasPerfModule = flat.indexOf('sycm_v2_qos_shop_performance') >= 0;
    out.hasPerfNewModule = flat.indexOf('sycm_v2_qos_shop_performance_new_v2') >= 0;
    out.perfId11536 = flat.indexOf('11536') >= 0;
    out.perfId12816 = flat.indexOf('12816') >= 0;
    out.modulesHead = flat.slice(0, 400);
  } catch (e) { out.allModules = { error: String(e) }; }
  try {
    const r = await fetch('/oneauth/api/permission.json?p_url=' + encodeURIComponent('http://sycm.taobao.com/portal/home.htm'),
      { credentials: 'include' });
    out.portal = (await r.text()).replace(/\\s+/g, ' ').slice(0, 200);
  } catch (e) { out.portal = { error: String(e) }; }
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
  lines.push(result.ok ? JSON.stringify(result.value, null, 1) : `读失败 ${JSON.stringify(result).slice(0, 400)}`);
  lines.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-account-scope-confirm.txt', lines.join('\n'));
console.log(lines.join('\n'));
