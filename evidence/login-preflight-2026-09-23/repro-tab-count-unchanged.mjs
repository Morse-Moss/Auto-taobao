// 「跑前登录态体检**没有新增也没有关闭任何页签**」这条声明的可复核证据。
//
// 为什么需要它：这条能力的卖点是「只读」。而「只读」在这台机器上不是一眼能看出来的 ——
// 体检唯一的写动作是「把该站点那一页导航到探针地址去读最终 URL」，它**看起来**也像在动页面。
// 所以判据要落在页签账上：跑之前与跑之后，每个窗口的页签条数必须**逐个相同**。
//
// 会变的只有 URL（而且应当变成链本来就期望的那两个地址）—— 那一条由
// runtime/shop-pages.mjs 单独判（期望页面恰好各一个）。本脚本只回答「有没有多/少页签」。
//
// 用法（只读；它对两个时刻各读一次 /targets，然后调一次体检）：
//   node evidence/login-preflight-2026-09-23/repro-tab-count-unchanged.mjs
// 退出码：0＝每个窗口的页签条数都没变；1＝有窗口变了（把 before/after 并排打出来）。
//
// 2026-09-23 第一次跑时 `after` 那一次的第一家店报 `fetch failed / ECONNRESET`
// （原文留在 `01-tab-count-unchanged.txt`）。四条互相独立的证据把它定为**瞬断**而不是故障：
//   ① 它发生在 `before` 全部读完、体检自己报 5/5 全绿之后；
//   ② 紧接着 `runtime/browser-inventory.mjs` 报 7/7 就位（代理都在听）；
//   ③ 报的是 ECONNRESET —— **一个 HTTP 应答都没拿到**（拿到应答就不许重发了）；
//   ④ 成因是 keep-alive：`before` 那 5 个连接挂在连接池里，体检跑了十几秒，
//      代理那边先把空闲连接关掉，`after` 复用了那条已经死掉的 socket。
// 所以 `fetchTabs` 加了**一次**重发，且只在「没拿到任何 HTTP 应答」时才重发。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { SHOP_BROWSERS, shopBrowserKeys } from '../../runtime/browser-ports.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PREFLIGHT = 'skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs';

async function fetchTabs(proxyPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/targets`);
    if (!response.ok) throw new Error(`/targets → HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    // 只在「一个应答都没拿到」时重发。拿到 4xx/5xx 就说明对端活着且明确拒绝了 ⇒ 不重发。
    if (error instanceof Error && /HTTP \d/u.test(error.message)) throw error;
    const response = await fetch(`http://127.0.0.1:${proxyPort}/targets`);
    if (!response.ok) throw new Error(`/targets → HTTP ${response.status}（重发后）`);
    return await response.json();
  }
}

async function tabsOf(proxyPort) {
  const payload = await fetchTabs(proxyPort);
  const list = Array.isArray(payload) ? payload : (payload.targets ?? []);
  return list.filter((t) => t.type === 'page').map((t) => String(t.url));
}

async function snapshot() {
  const out = {};
  for (const shop of shopBrowserKeys()) {
    const urls = await tabsOf(SHOP_BROWSERS[shop].proxyPort);
    out[shop] = { count: urls.length, urls };
  }
  return out;
}

const before = await snapshot();
console.log(`=== 体检之前 ===`);
for (const [shop, entry] of Object.entries(before)) console.log(`  ${shop}: ${entry.count} 个页签  ${JSON.stringify(entry.urls)}`);

console.log(`\n=== 跑一次体检（${PREFLIGHT}）===`);
const run = spawnSync(process.execPath, [PREFLIGHT], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 300000 });
console.log(run.stdout ?? '');
if (run.stderr) console.log(`stderr: ${run.stderr}`);
console.log(`体检退出码=${run.status}`);

const after = await snapshot();
console.log(`\n=== 体检之后 ===`);
let changed = 0;
for (const [shop, entry] of Object.entries(after)) {
  const was = before[shop].count;
  const same = was === entry.count;
  if (!same) changed += 1;
  console.log(`  ${shop}: ${entry.count} 个页签（之前 ${was}）${same ? '—— 没变' : '—— **变了**'}  ${JSON.stringify(entry.urls)}`);
}
console.log(`\n[判据] ${changed === 0 ? '每个窗口的页签条数都没变' : `有 ${changed} 个窗口的页签条数变了`}`
  + `；体检退出码=${run.status}（0＝十项全在登录态）`);
process.exitCode = changed === 0 ? 0 : 1;
