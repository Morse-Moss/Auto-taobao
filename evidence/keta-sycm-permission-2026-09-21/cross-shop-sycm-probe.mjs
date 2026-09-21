// 只读：五家店 + 商家浏览器的当前页签清单，重点看「生意参谋工作页」在不在。
// 不改任何状态：只发 GET /targets 与 GET /health。
import { writeFileSync } from 'node:fs';

const WORK_FRAGMENT = 'sycm.taobao.com/qos/service/frame/shop/performance';
const ALIMAMA_FRAGMENT = 'one.alimama.com';

const PROXIES = [
  { key: 'dailyReport', label: '商家浏览器', port: 19023 },
  { key: 'likelin', label: '里可林淘宝', port: 19041 },
  { key: 'wanglin', label: '网林天猫', port: 19042 },
  { key: 'gaiwen-tb', label: '盖文淘宝', port: 19043 },
  { key: 'keta', label: '科塔淘宝', port: 19044 },
  { key: 'gaiwen-tm', label: '盖文天猫', port: 19045 },
];

const out = { probedAt: new Date().toISOString(), hosts: [] };

for (const entry of PROXIES) {
  const base = `http://127.0.0.1:${entry.port}`;
  const row = { ...entry, reachable: false, proxyError: null, tabs: [], health: null };
  try {
    const response = await fetch(`${base}/targets`, { signal: AbortSignal.timeout(8000) });
    const targets = await response.json();
    row.reachable = true;
    row.httpStatus = response.status;
    row.tabCount = Array.isArray(targets) ? targets.length : null;
    row.tabs = (Array.isArray(targets) ? targets : []).map((tab) => {
      const url = String(tab.url ?? '');
      return {
        targetId: tab.targetId ?? tab.id ?? null,
        type: tab.type ?? null,
        url,
        title: tab.title ?? null,
        isSycmWorkPage: url.includes(WORK_FRAGMENT),
        isSycmAny: url.includes('sycm.taobao.com'),
        isAlimama: url.includes(ALIMAMA_FRAGMENT),
      };
    });
    row.sycmCount = row.tabs.filter((tab) => tab.isSycmWorkPage).length;
    row.sycmAnyCount = row.tabs.filter((tab) => tab.isSycmAny).length;
  } catch (error) {
    row.proxyError = `${error.name}: ${error.message}`;
  }
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) });
    row.health = await health.json();
  } catch (error) {
    row.health = { error: error.message };
  }
  out.hosts.push(row);
}

writeFileSync('D:/Retire/sycm-automation/tmp/cross-shop-sycm-probe.json', JSON.stringify(out, null, 1));

const lines = [`probedAt=${out.probedAt}`];
for (const row of out.hosts) {
  if (!row.reachable) { lines.push(`${row.label} ${row.port}  连不上：${row.proxyError}`); continue; }
  lines.push(`${row.label} ${row.port}  页签=${row.tabCount}  工作页=${row.sycmCount}  含sycm=${row.sycmAnyCount}`
    + `  pinned=${row.health?.pinnedTabs ?? '?'}  managed=${row.health?.managedTabs ?? '?'}`);
  for (const tab of row.tabs) {
    lines.push(`    ${tab.isSycmWorkPage ? '[工作页✓]' : '[        ]'} ${String(tab.targetId).slice(0, 8)}  ${tab.url}`);
  }
}
writeFileSync('D:/Retire/sycm-automation/tmp/cross-shop-sycm-probe.txt', lines.join('\n'));
console.log(lines.join('\n'));
