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
// 端口与 profile 的权威值在 `runtime/browser-ports.mjs`，这里只引用不另写一份
// （各写一份就会漂移，见该文件头部的说明与坑 35）。
//
// 用法（要放在后台任务里跑，它会一直活着）：
//   node runtime/start-project-browser.mjs
//   PROJECT_BROWSER_PORT=9222 PROJECT_BROWSER_PROFILE=D:/Retire/edge-debug-profile node runtime/start-project-browser.mjs
//   # 店铺实例（一家店一个 profile + 一个调试端口；端口与 profile 取自 runtime/browser-ports.mjs）：
//   PROJECT_BROWSER_PORT=19035 PROJECT_BROWSER_PROFILE=D:/Retire/edge-profiles/gaiwen-flagship \
//     node runtime/start-project-browser.mjs
//   # 配套代理（一店一个）：node runtime/start-shop-proxy.mjs 盖文天猫
//
// 起来之后配套的代理（老链）：
//   CDP_PROXY_PORT=3457 CDP_BROWSER_PORT=9222 node runtime/isolated-proxy/cdp-proxy.mjs
// 跑导出时还要带：
//   XWS_PROXY=http://127.0.0.1:3457  XWS_BROWSER_ID=edge-isolated

import { spawn } from 'node:child_process';
import {
  ACCOUNT_KINDS,
  BROWSER_ACCOUNT,
  BROWSER_PROFILES,
  PROJECT_PORTS,
  buildBrowserLaunchArgs,
  classifyPortUsage,
  describeBrowserRoutes,
  describeOccupant,
  extraArgsForProfile,
  inspectPort,
  normalizeProfile,
  resolvePort,
  retiredPortNumbers,
} from './browser-ports.mjs';

const EDGE = process.env.PROJECT_BROWSER_EXE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = process.env.PROJECT_BROWSER_PROFILE || BROWSER_PROFILES.competitor;
const PORT = resolvePort('PROJECT_BROWSER_PORT', PROJECT_PORTS.competitorBrowser);
const START_URL = process.env.PROJECT_BROWSER_URL || 'about:blank';

// 这个 profile 是登记表里的哪个浏览器？认不出来就说明是自定义 profile，
// 那就不该硬套某条路线的账号要求 —— 宁可让人自己确认，也不要给一句想当然的提示。
const BROWSER_KEY = Object.entries(BROWSER_PROFILES)
  .find(([, value]) => normalizeProfile(value) === normalizeProfile(PROFILE))?.[0] ?? null;

// 启动时把「这个端口该登哪种账号」念一遍。这不是文档复读：账号登错了不会报错，
// 只会让下游数据静默变形（买家链登了商家号 ⇒ 小旺神读不出市场数据）。
function describeExpectedLogin() {
  if (!BROWSER_KEY) {
    return `[browser] profile=${PROFILE} 不在登记表的两个浏览器里 —— 账号要求无从核对，请自行确认登的是哪一类账号。`;
  }
  const account = BROWSER_ACCOUNT[BROWSER_KEY];
  const hint = account === ACCOUNT_KINDS.buyer
    ? '这个 profile 必须是**买家**账号：商家号看不到别家商品详情页，小旺神会静默读不出数据。'
    : '这个 profile 必须是**商家**账号（生意参谋 / 千牛 / 阿里妈妈后台）：不要把买家号登到这里。反过来说，卖家版账号用不了小旺神，所以两条链不能合并成一个浏览器。';
  return `[browser] 承载路线：${describeBrowserRoutes(BROWSER_KEY)}；${hint}`;
}

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

// 保活：父进程退出会让子进程一起被回收，端口随即对会话内不可见。
function keepAlive() {
  setInterval(() => {}, 60000);
}

// 同一个 profile 是否已经在**另一个端口**上跑着？返回找到的端口（可能不止一个）。
//
// 为什么需要它（2026-09-17 实测，坑 52 的邻居）：Edge 按 `--user-data-dir` 单例。
// 已有实例在 9223、我们要 19022 时，19022 是空闲的 ⇒ 走下面的 spawn 分支 ⇒ 新进程把请求
// 交给已有实例后**立即退出**，于是输出只剩两行：
//     [browser] msedge exited code=0
//     [browser] 调试端口 19022 在 30000ms 内没有就绪（最后错误：ECONNREFUSED）
// 单看任一行都像「端口没起来」，真实原因是「profile 已被占用」。这条提示就是补上这句真话。
//
// 判据为什么不是 profile 目录里的 `DevToolsActivePort`：2026-09-17 实测它**两个方向都不可靠** ——
//   9222 端口空闲、文件却还在（残留）；9223 活着、文件却不存在。
// Windows 上也没有 `SingletonLock` 可看（Chromium 在 Windows 用命名互斥体，不落文件）。
// 所以改成只做「能自证的事」：在登记表已知的那几个端口里探一遍，用 profile 自证身份。
// 端口集合来自登记表（含退役值），所以这里不会出现写死的端口字面量。
async function findSiblingInstance() {
  const candidates = [...new Set([...Object.values(PROJECT_PORTS), ...retiredPortNumbers()])]
    .filter((port) => Number.isInteger(port) && port !== PORT);
  const found = [];
  for (const port of candidates) {
    const inspection = await inspectPort(port, { timeoutMs: 700 });
    if (classifyPortUsage(inspection, { expectedProfile: PROFILE }).verdict === 'ours') found.push(port);
  }
  return found;
}

function describeSibling(ports, { handedOff } = {}) {
  const lines = [];
  if (handedOff) {
    lines.push('[browser] 端口没起来，而且子进程是以 **code 0** 退出的 —— 这是 Edge 把请求交给');
    lines.push('[browser] 已有实例的典型样子（真启动失败不会 code 0）。');
  }
  if (ports.length > 0) {
    lines.push(`[browser] 同一个 profile 已经有一个实例在跑，它在端口 ${ports.join(' / ')}（profile 与期望一致）。`);
  } else {
    lines.push('[browser] 没能在登记表已知的端口上找到它 —— 它可能挂在别的端口上（例如手工起的时候另指了端口）。');
  }
  lines.push('[browser] 处置（二选一，都不需要杀浏览器）：');
  if (ports.length > 0) {
    lines.push(`[browser]   a) 复用它：起代理时带 CDP_BROWSER_PORT=${ports[0]}（脚本只认代理端口，这一跳是内部的）`);
  }
  lines.push('[browser]   b) 换一个 profile：PROJECT_BROWSER_PROFILE=<另一个目录>');
  lines.push('[browser]   顺带一提：Edge 的单例是按 profile 目录判的，所以「换端口」并不能起出第二个实例。');
  return lines.join('\n');
}

// 起之前先确认端口上是谁。坑 35 的形态之一就是「端口被另一个 profile 占着，
// 新起的 msedge 只是并入那个实例，调试端点仍然是别人的浏览器」——
// 两个账号连的是不同的人，接错了不会报错，只会把数据写到错的地方。
const inspection = await inspectPort(PORT);
const usage = classifyPortUsage(inspection, { expectedProfile: PROFILE });
// 端口是空闲的，但 profile 可能已经在别的端口上跑着 —— 那种情况上面那次端口探测看不出来。
const siblings = usage.verdict === 'ours' ? [] : await findSiblingInstance();

console.log(describeExpectedLogin());

if (usage.verdict === 'ours') {
  console.log(`[browser] REUSE ${describeOccupant(inspection)} port=${PORT}（profile 与期望一致，无需重复启动）`);
  keepAlive();
} else if (usage.verdict === 'foreign') {
  console.error(`[browser] 拒绝启动：端口 ${PORT} 已被另一个 profile 的浏览器占用。`);
  console.error(`[browser] 端口上现在是 ${describeOccupant(inspection)}`);
  console.error(`[browser] 期望的 profile 是 ${PROFILE}`);
  console.error('[browser] 商家号与买家号不能共用同一个浏览器实例，继续启动只会把调试端点接到别人身上。');
  console.error('[browser] 处置：先停掉占用者，或用 PROJECT_BROWSER_PORT 换一个空闲端口。');
  process.exitCode = 1;
} else if (siblings.length > 0) {
  console.error(describeSibling(siblings));
  process.exitCode = 1;
} else {
  if (usage.verdict === 'unknown') {
    console.warn(`[browser] 警告：端口 ${PORT} 在监听但身份无法确认（${describeOccupant(inspection)}），按空闲处理。`);
  }

  // exit code 0 ＝ 子进程把手头的事交给已有实例后正常退出（Edge 单例的默认行为）；
  // 真启动失败不是 0，或者进程会一直活着。所以这个值本身就是要报给操作者的证据。
  let childExitCode = null;
  // argv 由登记表的纯函数拼（`buildBrowserLaunchArgs`）：店铺 profile 会带上 `--disable-sync`
  // 这类卫生开关，两个老浏览器的 argv 则**逐字不变** —— 那条约束由 browser-ports.test.mjs 断言。
  const launchArgs = buildBrowserLaunchArgs({ profile: PROFILE, port: PORT, startUrl: START_URL });
  const extra = extraArgsForProfile(PROFILE);
  if (extra.length > 0) console.log(`[browser] 额外开关：${extra.join(' ')}（来自登记表，不是临时加的）`);
  const child = spawn(EDGE, launchArgs, { stdio: 'ignore' });

  console.log(`[browser] msedge pid=${child.pid} profile=${PROFILE} port=${PORT}`);
  child.on('exit', (code) => {
    childExitCode = code;
    console.log(`[browser] msedge exited code=${code}`);
  });

  try {
    const v = await waitForDevTools();
    console.log(`[browser] READY ${v.Browser} on ${PORT}`);
  } catch (error) {
    console.error(`[browser] ${error.message}`);
    // 端口始终没起来时把真正的原因补上：同 profile 的另一个实例把请求接管了。
    // 那一刻的 `msedge exited code=0` 很不起眼，所以这里要主动说清。
    const lateSiblings = await findSiblingInstance();
    if (childExitCode === 0 || lateSiblings.length > 0) {
      console.error(describeSibling(lateSiblings, { handedOff: childExitCode === 0 }));
    }
    process.exitCode = 1;
  }

  const stop = () => { try { child.kill(); } catch { /* already gone */ } process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  keepAlive();
}
