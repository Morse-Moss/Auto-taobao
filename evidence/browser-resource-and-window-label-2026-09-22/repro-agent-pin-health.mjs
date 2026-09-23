#!/usr/bin/env node

// 只读：问每个代理「你现在管着几个页签、其中几个是钉住的」。
//
// 为什么这一格重要：代理对自己的页签有一套回收机制（闲置 15 分钟收走、代理退出时关掉），
// 而 `/pin` 是唯一的豁免。所以「窗口上的店名标志能不能一直在」
// 先要问「它有没有被钉住」—— 这是**代理自己的计数**，不是我们的推断。
//
// 全程只读：只发 GET /health。
//
// 跑法（仓库根）：node evidence/browser-resource-and-window-label-2026-09-22/repro-agent-pin-health.mjs
//
// 自定位：本文件在 <repo>/evidence/<批次>/ 下，所以 runtime/ 在 ../../runtime。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const { PROJECT_PORTS, SHOP_BROWSERS } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'runtime', 'browser-ports.mjs')).href
);

const INSTANCES = [
  ['竞品链', PROJECT_PORTS.competitorProxy],
  ['商家浏览器', PROJECT_PORTS.dailyReportProxy],
  ...Object.entries(SHOP_BROWSERS).map(([key, entry]) => [key, entry.proxyPort]),
];

for (const [name, port] of INSTANCES) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
    const text = await res.text();
    console.log(`${name.padEnd(12)} 代理 ${port}  HTTP ${res.status}  ${text.slice(0, 300)}`);
  } catch (error) {
    console.log(`${name.padEnd(12)} 代理 ${port}  读不到：${error.message}`);
  }
}
