#!/usr/bin/env node

// 只读：给「这几个浏览器实例占了多少系统资源」与「每个窗口在任务栏上显示什么」量一笔账。
//
// 量法三条（出处：技能 browser-instance-resource-budget）：
//   · 实例数只从**权威登记表**数（runtime/browser-ports.mjs），不从进程列表数 ——
//     进程列表里一个实例是多条进程，而「多出来的那几条」既可能是子进程，也可能是孤儿；
//   · 每个实例的内存用**浏览器自报的进程表**（CDP `SystemInfo.getProcessInfo`）拿 PID，
//     再回系统进程表求和 —— 不按命令行猜归属（跨机器读不到命令行是常态）；
//   · node 归属**按端口**（netstat 找 LISTENING），不按命令行。
//
// 窗口标题那一段是**唯一**能回答「业务人员一眼看到的是什么」的证据：
// 窗口标题 = 当前激活页签的 document.title，而任务栏/Alt-Tab 显示的正是它。
// 所以「挂了标志页」不等于「任务栏上看得见店名」—— 这两件事必须分开量。
//
// 全程只读：不导航、不点击、不关任何东西。
//
// 跑法（仓库根）：node evidence/browser-resource-and-window-label-2026-09-22/repro-browser-account.mjs
//
// 自定位：本文件在 <repo>/evidence/<批次>/ 下，所以 runtime/ 在 ../../runtime。
// 这一路径必须显式写死 —— 若照抄原来在 tmp/ 下的 '../runtime'，
// 「复核命令」会在文档写下它的那一刻就失效（见技能 evidence-copy-must-be-runnable）。
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const { BROWSER_PROFILES, PROJECT_PORTS, SHOP_BROWSERS } = await import(
  pathToFileURL(path.join(REPO_ROOT, 'runtime', 'browser-ports.mjs')).href
);

const MB = (bytes) => Math.round(bytes / 1024 / 1024);

/** PowerShell 的 stdout 默认按系统 ANSI 编码出（本机＝GBK），中文会乱码 ⇒ 命令里先强制 UTF-8。 */
const PS_PREFIX = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ';

function powershell(script) {
  const res = spawnSync('powershell', ['-NoProfile', '-Command', PS_PREFIX + script],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return String(res.stdout ?? '').replace(/^\uFEFF/u, '').trim();
}

// ---- 系统进程表：pid → 工作集（字节） ----
function readRssByPid() {
  const res = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const rss = new Map();
  for (const line of String(res.stdout ?? '').split(/\r?\n/u)) {
    // "msedge.exe","1234","Console","1","123,456 K"
    const cells = line.slice(1, -1).split('","');
    if (cells.length < 5) continue;
    const pid = Number(cells[1]);
    const kb = Number(String(cells[4]).replace(/[^\d]/gu, ''));
    if (Number.isInteger(pid) && Number.isFinite(kb)) rss.set(pid, kb * 1024);
  }
  return rss;
}

// ---- 端口 → 监听它的 PID（node 归属的唯一判据） ----
function readListeners() {
  const res = spawnSync('netstat', ['-ano'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const byPort = new Map();
  for (const line of String(res.stdout ?? '').split(/\r?\n/u)) {
    const cells = line.trim().split(/\s+/u);
    if (cells[0] !== 'TCP' || cells[3] !== 'LISTENING') continue;
    const port = Number(String(cells[1]).split(':').pop());
    const pid = Number(cells[4]);
    if (Number.isInteger(port) && Number.isInteger(pid)) byPort.set(port, pid);
  }
  return byPort;
}

/** msedge 全表（含父子关系）：孤儿的判据要用到它。 */
function readEdgeTable() {
  const json = powershell("@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
    + 'Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress');
  if (!json) return [];
  const parsed = JSON.parse(json);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((r) => ({
    pid: Number(r.ProcessId), parent: Number(r.ParentProcessId),
  }));
}

/** 有主窗口的 msedge 进程 → 任务栏标题。窗口属于哪个实例，靠 PID 认。 */
function readWindowTitles() {
  const json = powershell('@(Get-Process msedge -ErrorAction SilentlyContinue | '
    + 'Where-Object { $_.MainWindowTitle } | Select-Object Id,MainWindowTitle) | ConvertTo-Json -Compress');
  if (!json) return new Map();
  const parsed = JSON.parse(json);
  return new Map((Array.isArray(parsed) ? parsed : [parsed])
    .map((r) => [Number(r.Id), String(r.MainWindowTitle)]));
}

/** 每个实例自报的进程表（PID 列表 + 主进程 PID + 页签数）。 */
async function browserProcesses(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`,
    { signal: AbortSignal.timeout(4000) })).json();
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`,
    { signal: AbortSignal.timeout(4000) })).json();
  const processes = await new Promise((resolve) => {
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    const timer = setTimeout(() => { try { socket.close(); } catch { /* noop */ } resolve(null); }, 6000);
    socket.addEventListener('error', () => { clearTimeout(timer); resolve(null); });
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' })));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      if (message?.id !== 1) return;
      clearTimeout(timer);
      try { socket.close(); } catch { /* noop */ }
      resolve(message.result?.processInfo ?? []);
    });
  });
  const list = processes ?? [];
  return {
    processes: list,
    // type==='browser' 就是主进程；`id` 是字符串，转数字才能和进程表对上。
    mainPid: Number(list.find((p) => p.type === 'browser')?.id ?? list[0]?.id ?? NaN),
    pages: Array.isArray(pages) ? pages.filter((p) => p.type === 'page').length : null,
  };
}

function dirSize(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(child);
        else total += statSync(child).size;
      } catch { /* 个别文件读不到就跳过，别让整个盘点点不动 */ }
    }
  };
  walk(dir);
  return total;
}

const INSTANCES = [
  {
    name: '竞品链（买家号+小旺神）', kind: 'competitor',
    browserPort: PROJECT_PORTS.competitorBrowser, proxyPort: PROJECT_PORTS.competitorProxy,
    profile: BROWSER_PROFILES.competitor,
  },
  {
    name: '商家浏览器（日报/周表/灰豚）', kind: 'dailyReport',
    browserPort: PROJECT_PORTS.dailyReportBrowser, proxyPort: PROJECT_PORTS.dailyReportProxy,
    profile: BROWSER_PROFILES.dailyReport,
  },
  ...Object.entries(SHOP_BROWSERS).map(([key, entry]) => ({
    name: key, kind: 'shop', browserPort: entry.browserPort, proxyPort: entry.proxyPort, profile: entry.profile,
  })),
];

const rss = readRssByPid();
const listeners = readListeners();
const edgeTable = readEdgeTable();
const titles = readWindowTitles();
const edgeByPid = new Map(edgeTable.map((e) => [e.pid, e]));

console.log(`机器内存：总 ${MB(os.totalmem())} MB，当前可用 ${MB(os.freemem())} MB`
  + `（可用率 ${(os.freemem() / os.totalmem() * 100).toFixed(1)}%）`);
console.log(`声明实例数：${INSTANCES.length}（来源 runtime/browser-ports.mjs）\n`);

let browserTotal = 0;
let proxyTotal = 0;
const byTypeGlobal = new Map();
const claimed = new Set();
const rows = [];

console.log('实例                     浏览器内存  进程数  GPU    渲染   页签  代理node  代理内存  profile磁盘  任务栏上显示');
for (const item of INSTANCES) {
  let info;
  try {
    info = await browserProcesses(item.browserPort);
  } catch (error) {
    console.log(`${item.name.padEnd(24)} 浏览器端口 ${item.browserPort} 读不到：${error.message}`);
    continue;
  }
  let sum = 0;
  let unread = 0;
  const byType = new Map();
  for (const process of info.processes) {
    const bytes = rss.get(Number(process.id));
    if (bytes === undefined) { unread += 1; continue; }
    sum += bytes;
    const key = process.type ?? 'other';
    byType.set(key, (byType.get(key) ?? 0) + bytes);
    byTypeGlobal.set(key, (byTypeGlobal.get(key) ?? 0) + bytes);
  }
  const proxyPid = listeners.get(item.proxyPort);
  const proxyBytes = proxyPid !== undefined ? (rss.get(proxyPid) ?? 0) : 0;
  browserTotal += sum;
  proxyTotal += proxyBytes;

  const sizeBytes = dirSize(item.profile);
  claimed.add(info.mainPid);
  for (const e of edgeTable) if (e.parent === info.mainPid) claimed.add(e.pid);

  // 窗口属于哪个实例：靠**主进程 PID** 认（Chromium 的窗口归 browser 主进程）。
  const title = titles.get(info.mainPid) ?? null;
  rows.push({
    item, mainPid: info.mainPid, browserMb: MB(sum), sizeBytes, title,
    pages: info.pages, processCount: info.processes.length,
  });

  console.log(`${item.name.padEnd(24)} ${String(MB(sum)).padStart(8)} MB${String(info.processes.length).padStart(7)} `
    + `${String(`${MB(byType.get('GPU') ?? 0)}MB`).padStart(8)} ${String(`${MB(byType.get('renderer') ?? 0)}MB`).padStart(7)} `
    + `${String(info.pages).padStart(5)} ${String(proxyPid ?? '-').padStart(9)} ${String(`${MB(proxyBytes)}MB`).padStart(8)} `
    + `${String(`${MB(sizeBytes)}MB`).padStart(10)}   ${title === null ? '（没有窗口/读不到）' : title}`
    + `${unread ? `   ⚠ 另有 ${unread} 个 PID 读不到内存（未计）` : ''}`);
}

console.log(`\n合计：浏览器 ${MB(browserTotal)} MB（${rows.reduce((a, r) => a + r.processCount, 0)} 个进程，`
  + `${rows.length} 个实例） + 代理 node ${MB(proxyTotal)} MB = 约 ${MB(browserTotal + proxyTotal)} MB`);
console.log('按进程类型分解：' + [...byTypeGlobal].sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k}=${MB(v)}MB`).join('  '));
// 注意：这一行的每一项已经是 MB ⇒ 直接相加，不要再过一次 MB()（多除一次 1024² 会显示成 0）。
console.log(`profile 磁盘合计：${MB(rows.reduce((a, r) => a + r.sizeBytes, 0))} MB`);

const unclaimed = edgeTable.filter((e) => !edgeByPid.has(e.parent) && !claimed.has(e.pid));
console.log(`\n不属于已声明实例的 msedge 主进程：${unclaimed.length} 个`);
for (const main of unclaimed) {
  const kids = edgeTable.filter((e) => e.parent === main.pid);
  const total = (rss.get(main.pid) ?? 0) + kids.reduce((a, k) => a + (rss.get(k.pid) ?? 0), 0);
  const parent = edgeByPid.has(main.parent) ? `msedge ${main.parent}` : `PID ${main.parent}（已不存在）`;
  console.log(`  PID ${main.pid} 自身 ${MB(rss.get(main.pid) ?? 0)}MB + ${kids.length} 个子进程`
    + ` = ${MB(total)}MB   ← 父进程 ${parent}`);
}
console.log(`\n进程总数核对：msedge ${edgeTable.length} 个（已认领 ${claimed.size} 个）`);
