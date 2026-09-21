// 只读：从 `/oneauth/api/permission.json?type=all_modules` 里把与「店铺绩效/qos」相关的模块条目挑出来，
// 逐字段并排（moduleCode / moduleName / hasPermission / startDate / endDate / remainDate / todayOrder）。
// 这是账号级授权的原始台账 —— 用它可以指出「哪一项、什么时候到期、现在是不是没权限」。
import { writeFileSync } from 'node:fs';

const HOSTS = [
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tb', label: '盖文淘宝（对照·健康）', port: 19043 },
];

const expr = `(async () => {
  const r = await fetch('/oneauth/api/permission.json?type=all_modules', { credentials: 'include' });
  const j = await r.json();
  const list = Array.isArray(j.data) ? j.data : [];
  const fmt = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString().slice(0, 19) : null);
  const pick = (e) => ({
    moduleId: e.moduleId ?? null,
    moduleCode: e.moduleCode ?? null,
    moduleName: e.moduleName ?? null,
    hasPermission: e.hasPermission ?? null,
    isTab: e.isTab ?? null,
    todayOrder: e.todayOrder ?? null,
    remainDate: e.remainDate ?? null,
    startDate: fmt(e.startDate),
    endDate: fmt(e.endDate)
  });
  const hit = (e) => /qos|performance|绩效|考核|服务/.test(String(e.moduleCode || '') + String(e.moduleName || ''));
  return JSON.stringify({
    total: list.length,
    matched: list.filter(hit).map(pick),
    noPermissionCount: list.filter((e) => e.hasPermission !== true).length
  }, null, 1);
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
  if (!result.ok) { lines.push(`  读失败 ${JSON.stringify(result).slice(0, 400)}`); lines.push(''); continue; }
  lines.push(`  模块总数=${result.value.total}  其中 hasPermission!==true 的=${result.value.noPermissionCount}`);
  for (const e of result.value.matched) {
    lines.push(`  · moduleId=${e.moduleId}  ${e.moduleName}  hasPermission=${e.hasPermission}  remainDate=${e.remainDate}`
      + `  ${e.startDate} → ${e.endDate}`);
  }
  lines.push('');
}
writeFileSync('D:/Retire/sycm-automation/tmp/sycm-module-grants.txt', lines.join('\n'));
console.log(lines.join('\n'));
