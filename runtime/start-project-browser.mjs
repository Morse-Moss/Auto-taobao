#!/usr/bin/env node
// 项目专用调试浏览器启动器。
//
// 为什么需要它（2026-09-15 实测结论，别再走弯路）：
//   1) 本项目的采集/SKU 富化必须用**真实浏览器**（小旺神插件 + 真实登录态），
//      所以浏览器要开远程调试端口给 CDP 代理连。
//   2) 端口必须是**固定的**：调试 Edge 用内置 "Allow remote debugging" 开关时端口是随机的，
//      每次重启都变，代理就得跟着改。这里用 --remote-debugging-port 钉死。
//   3) **父进程必须活着**：agent 会话的沙箱只让本会话内的进程互相连。
//      直接用 `Start-Process`（在沙箱外）起 msedge，进程活不过那次调用，
//      而且它的端口在本会话里一律 ECONNREFUSED。所以这里 spawn 之后 setInterval 保活。
//
// 用法（要放在后台任务里跑，它会一直活着）：
//   node runtime/start-project-browser.mjs
//   PROJECT_BROWSER_PORT=9222 PROJECT_BROWSER_PROFILE=D:/Retire/edge-debug-profile node runtime/start-project-browser.mjs
//
// 起来之后配套的代理：
//   CDP_PROXY_PORT=3457 CDP_BROWSER_PORT=9222 node runtime/isolated-proxy/cdp-proxy.mjs
// 跑导出时还要带：
//   XWS_PROXY=http://127.0.0.1:3457  XWS_BROWSER_ID=edge-isolated

import { spawn } from 'node:child_process';

const EDGE = process.env.PROJECT_BROWSER_EXE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = process.env.PROJECT_BROWSER_PROFILE || 'D:/Retire/edge-debug-profile';
const PORT = String(process.env.PROJECT_BROWSER_PORT || '9222');
const START_URL = process.env.PROJECT_BROWSER_URL || 'about:blank';

async function waitForDevTools(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return JSON.parse(await r.text());
      last = `HTTP ${r.status}`;
    } catch (e) { last = e.cause?.code || e.message; }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`调试端口 ${PORT} 在 ${timeoutMs}ms 内没有就绪（最后错误：${last}）`);
}

const child = spawn(EDGE, [
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  START_URL,
], { stdio: 'ignore' });

console.log(`[browser] msedge pid=${child.pid} profile=${PROFILE} port=${PORT}`);
child.on('exit', (code) => console.log(`[browser] msedge exited code=${code}`));

try {
  const v = await waitForDevTools();
  console.log(`[browser] READY ${v.Browser} on ${PORT}`);
} catch (error) {
  console.error(`[browser] ${error.message}`);
  process.exitCode = 1;
}

const stop = () => { try { child.kill(); } catch { /* already gone */ } process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// 保活：父进程退出会让子进程一起被回收，端口随即对会话内不可见。
setInterval(() => {}, 60000);
