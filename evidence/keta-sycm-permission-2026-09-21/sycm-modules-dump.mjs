// 只读：把**一家**的完整模块台账写成一个文件。按店分开跑，避免一次响应太大而两边都拿不到。
// 用法：node tmp/sycm-modules-dump.mjs <proxyPort> <asciiKey>
import { writeFileSync } from 'node:fs';

const [portArg, key] = process.argv.slice(2);
const port = Number(portArg);
if (!port || !key) { console.error('用法：node tmp/sycm-modules-dump.mjs <proxyPort> <asciiKey>'); process.exit(2); }

const expr = `(async () => {
  const r = await fetch('/oneauth/api/permission.json?type=all_modules', { credentials: 'include' });
  const j = await r.json();
  const list = Array.isArray(j.data) ? j.data : [];
  return JSON.stringify(list.map((e) => [
    e.moduleId ?? null, e.moduleName ?? null, e.hasPermission === true,
    (typeof e.endDate === 'number' && e.endDate > 0) ? new Date(e.endDate).toISOString().slice(0, 10) : null
  ]));
})()`;

const list = await (await fetch(`http://127.0.0.1:${port}/targets`, { signal: AbortSignal.timeout(8000) })).json();
const tab = (Array.isArray(list) ? list : []).find((t) => String(t.url ?? '').includes('sycm.taobao.com'));
if (!tab) { console.error(`代理 ${port} 上没有 sycm 页签`); process.exit(3); }

const r = await fetch(`http://127.0.0.1:${port}/eval?target=${encodeURIComponent(tab.targetId)}`,
  { method: 'POST', body: expr, signal: AbortSignal.timeout(40000) });
const text = await r.text();
if (!r.ok) { console.error(`eval HTTP ${r.status}: ${text.slice(0, 300)}`); process.exit(4); }

let parsed;
try { parsed = JSON.parse(JSON.parse(text).value); }
catch (error) { console.error(`解析失败: ${error.message}  原文头部=${text.slice(0, 300)}`); process.exit(5); }

writeFileSync(`D:/Retire/sycm-automation/tmp/modules-${key}.json`, JSON.stringify(parsed, null, 1));
console.log(`ok ${key} 模块数=${parsed.length} 来源页签=${tab.targetId} 当前=${String(tab.url).slice(0, 80)}`);
