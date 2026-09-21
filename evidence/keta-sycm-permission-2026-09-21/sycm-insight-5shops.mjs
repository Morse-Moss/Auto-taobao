// 只读：把五家店「服务洞察 / 绩效」那一项**在账号台账里的原文**并排列出来。
// 直接回答「为什么其他四家都行、就科塔不行」——同一字段、同一时刻、五家一起读。
import { writeFileSync } from 'node:fs';

const SHOPS = [
  { key: 'likelin', label: '里可林淘宝', port: 19041 },
  { key: 'wanglin', label: '网林天猫', port: 19042 },
  { key: 'gaiwen-tb', label: '盖文淘宝', port: 19043 },
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tm', label: '盖文天猫', port: 19045 },
];

const expr = `(async () => {
  const out = {};
  const r = await fetch('/oneauth/api/permission.json?type=all_modules', { credentials: 'include' });
  const j = await r.json();
  const list = Array.isArray(j.data) ? j.data : [];
  const fmt = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : null);
  const pick = (e) => ({ id: e.moduleId ?? null, name: e.moduleName ?? null, code: e.moduleCode ?? null,
    has: e.hasPermission === true, remain: e.remainDate ?? null, from: fmt(e.startDate), to: fmt(e.endDate) });
  out.total = list.length;
  out.insight = list.filter((e) => /服务洞察|service-analyze/i.test(String(e.moduleName || '') + String(e.moduleCode || ''))).map(pick);
  out.perf = list.filter((e) => /绩效/.test(String(e.moduleName || ''))).map(pick);
  return JSON.stringify(out, null, 1);
})()`;

const rows = [];
for (const shop of SHOPS) {
  const row = { ...shop, data: null, error: null };
  try {
    const list = await (await fetch(`http://127.0.0.1:${shop.port}/targets`, { signal: AbortSignal.timeout(8000) })).json();
    const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
    if (!tab) throw new Error('没有 sycm 页签');
    const r = await fetch(`http://127.0.0.1:${shop.port}/eval?target=${encodeURIComponent(tab.targetId)}`,
      { method: 'POST', body: expr, signal: AbortSignal.timeout(40000) });
    const text = await r.text();
    row.data = JSON.parse(JSON.parse(text).value);
  } catch (error) {
    row.error = `${error?.name}: ${error?.message ?? error}`;
  }
  rows.push(row);
}

writeFileSync('D:/Retire/sycm-automation/tmp/sycm-insight-5shops.json', JSON.stringify(rows, null, 1));

const lines = ['五家店账号台账里的「服务洞察」相关项（同一时刻一起读）：', ''];
for (const row of rows) {
  lines.push(`===== ${row.label}（代理 ${row.port}） =====`);
  if (row.error) { lines.push(`  读失败：${row.error}`); lines.push(''); continue; }
  lines.push(`  模块总数=${row.data.total}`);
  if (!row.data.insight.length) lines.push('  【服务洞察】台账里没有这一项  ←←← 这一行就是差别');
  for (const e of row.data.insight) {
    lines.push(`  【服务洞察】id=${e.id}  ${e.name}  有权限=${e.has}  ${e.from} → ${e.to}（余 ${e.remain} 天）`);
  }
  for (const e of row.data.perf) lines.push(`  【绩效类】  id=${e.id}  ${e.name}  有权限=${e.has}`);
  lines.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-insight-5shops.txt', lines.join('\n'));
console.log(lines.join('\n'));
