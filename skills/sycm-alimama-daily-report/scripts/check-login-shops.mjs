#!/usr/bin/env node

// 逐店登录态体检 / 跑前登录守卫 —— 五家店 × 两个后台，一家店一个隔离实例。
//
// 两种模式，**同一份判定逻辑、同一份登记表**，差别只在子进程带哪个开关：
//   （默认，不带 `--login`）**只读体检**：子进程走 `--check-only`，一个页面都不碰。
//   （带 `--login`）**跑前登录守卫**：子进程走 `--commit` —— 掉登录的当场自己登一次，
//     没成才把「要人做什么」报出来（2026-09-23 按用户明确授权加，原话「可以自动登录把项目规则改了」）。
//   ⚠️ 带 `--login` 时这一条**不再是只读**：它会开登录页、补一次可信手势、提交表单。
//      所以它只在「确实想让机器去登」的调用点带这个开关（定时链与分批驱动），
//      人工排查时想只看一眼就不要带。
//
// 为什么需要它（2026-09-23 建）：整条日报链没有一步看登录态（见 check-login-shops-core.mjs
// 的头部）。掉登录不会被提前发现，只会在采集阶段炸成一句「没跑完，但记录里没写停在哪一步」。
// 这一条命令把「哪家店的哪一个后台掉登录了、该用哪个账号登」在**开跑之前**说清楚。
//
// 它自己**不做探测**：探测全在 `login-merchant.mjs --check-only` 里（那一条已经实测过，
// 见 evidence/cold-start-rehearsal-2026-09-23/07）。本脚本只负责按登记表逐店调用它、
// 把回执翻成人话。所以这一条链上**没有第二份**「未登录 URL 长什么样」的判据。
//
// 三条纪律：
//   1. **切实例只能靠 `--proxy`**。`--shop` 只影响回执里的店名，不切浏览器；
//      2026-09-22 的一版探针把两者搞反了，五次体检其实都打在同一个实例上
//      （证据：全仓唯一那份「四份输出逐字相同」的假测）。端口从 runtime/browser-ports.mjs 取。
//   2. **不带 `--login` 时一个页面都不碰**：`--check-only` 让 login-merchant 在读完登录态之后
//      就返回，不会去 `/new` 那个淘宝登录页（不带这个开关时它会 —— 那是自动登录的第一步）。
//      带上 `--login` 就是**故意要它去登**，那时上面这句不成立，别拿它当只读用。
//   3. 这一层**不投递任何告警**（`--notify off`）。它只把结论落进跑它的那份日志/终端。
//      同一次故障再发一条飞书，只会让那条通道更不可信；真正的告警仍由链失败时那一条负责。
//
// 刻意**不查**商家浏览器（dailyReport，19022/19023）：它用的是同一批账号，
// 而它的两个页面（生意参谋 + 飞书底单页）与五家店的采集无关 —— 它掉了登录会在
// 日报那一侧的失败里直接露出来。这一层只覆盖「一店一实例」那五个。
//
// 用法：
//   node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs
//   node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --shops 盖文淘宝,科塔淘宝
//   node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --json
//   node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs --login     # 掉了就自己登（会碰页面）
// 退出码：0＝全部确认在登录态；2＝有后台明确掉登录（带 `--login` 时＝自动登录也试过了、没成）；
//        3＝这一层没有结论（读不到/子进程失败）；
//        4＝参数或用法错（**刻意与上面三个分开**，免得把「打错字」读成「掉登录」）。
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SHOP_BROWSERS, shopBrowserKeys } from '../../../runtime/browser-ports.mjs';
import {
  exitCodeForPreflight, judgePreflight, judgeShopReceipt, parseCheckShopsArgs, renderReport,
} from './check-login-shops-core.mjs';

const LOGIN_CLI = fileURLToPath(new URL('./login-merchant.mjs', import.meta.url));
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// 带 `--login` 时两店之间的静默期。20 秒是**工程选择，不是实测出来的最优值**：
// 它唯一要保证的是「同一个出口 IP 上不会出现同一秒的连续登录提交」。
// 要改小它之前先想清楚：那是在拿账号安全换轮次时间（见 main 里那段理由）。
const LOGIN_GAP_MS = 20000;

/**
 * 跑一家店。**不抛错**：任何失败都翻成「这条回执读不出来」，
 * 由 core 判成 `UNREADABLE` —— 五家店里坏一家，不该让另外四家的结论一起消失。
 */
function probeShop(shop, timeoutMs, { login = false } = {}) {
  return new Promise((resolve) => {
    const conf = SHOP_BROWSERS[shop];
    if (!conf) { resolve({ receipt: null, error: `未登记的店铺实例「${shop}」`, exitCode: null }); return; }
    let child;
    try {
      child = spawn(process.execPath, [
        LOGIN_CLI,
        // 两种模式**只在这里分叉**，其余参数完全相同 —— 免得两份调用各自漂移，
        // 而漂移的症状是「自动登录打到了另一个实例上」这种看不出来的事。
        login ? '--commit' : '--check-only',
        '--proxy', `http://127.0.0.1:${conf.proxyPort}`,
        '--shop', shop,
        // 两种模式都 `--notify off`：自动登录失败**也不在这里发飞书**。
        // 理由与只读模式同源（见头部第 3 条）：真正的告警由链失败时那一条负责，
        // 这一层只把结论落进跑它的那份日志。否则同一次故障会在群里出现两条，
        // 而且第二条（本层这条）说不出「整条链停在哪」。
        '--notify', 'off',
      ], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ receipt: null, error: `spawn 失败：${String(error?.message ?? error)}`, exitCode: null });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      done({ receipt: null, error: `超时（${timeoutMs}ms），已终止这家店的体检`, exitCode: null });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); done({ receipt: null, error: String(error?.message ?? error), exitCode: null }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 回执是 JSON.stringify(receipt, null, 1) —— 从**最后一处行首的 `{`** 起就是它。
      const marker = out.indexOf('\n{');
      const raw = marker === -1
        ? (out.trimStart().startsWith('{') ? out.trimStart() : null)
        : out.slice(marker + 1);
      let receipt = null;
      try { receipt = raw === null ? null : JSON.parse(raw); } catch { receipt = null; }
      done({
        receipt,
        exitCode: code,
        error: receipt ? null : `${err.trim() || out.trim()}`.slice(-400) || '没有可解析的回执',
      });
    });
  });
}

async function main(argv) {
  const valid = shopBrowserKeys();
  let opts;
  try {
    opts = parseCheckShopsArgs(argv, { shops: valid });
  } catch (error) {
    console.error(`${error.message}`);
    return 4;
  }
  if (opts.help) {
    console.log('node skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs'
      + ' [--shops a,b] [--json] [--timeout 180000] [--login]');
    console.log('  --login：掉了就自己登一次（会打开登录页、提交表单；默认关＝只读体检）');
    console.log(`  店名取登记表（runtime/browser-ports.mjs）：${valid.join(' / ')}`);
    return 0;
  }

  const shops = opts.shops ?? valid;
  let probed;
  if (!opts.login) {
    // 只读模式下**并行**：一家店一个浏览器实例、一个代理，互不相干。串行的话五家店要等 5 倍的长。
    probed = await Promise.all(shops.map(async (shop) => ({ shop, ...(await probeShop(shop, opts.timeoutMs)) })));
  } else {
    // 带 `--login` 时**必须串行 + 留间隔**，这是本次改动里唯一一处「为了不惹风控而放慢」。
    // 理由（不是保守，是实测口径，见 docs/ops/LOGIN-RECOVERY-OPTIONS.md §3.5）：
    //   五家店同时提交登录＝在同一个出口 IP 上短时间内五次登录，正是风控最敏感的形态；
    //   最坏结果不是「跑失败」，而是**一批账号被保护性锁定**——那比掉登录贵得多。
    //   串行 + 固定间隔把这件事的形态改掉：同一时刻只有一个登录在途，且两次之间有静默期。
    probed = [];
    for (const shop of shops) {
      probed.push({ shop, ...(await probeShop(shop, opts.timeoutMs, { login: true })) });
      if (shop !== shops[shops.length - 1]) await new Promise((r) => setTimeout(r, LOGIN_GAP_MS));
    }
  }
  const rows = probed.map((item) => ({
    ...judgeShopReceipt({ shop: item.shop, receipt: item.receipt }),
    // 子进程自己的退出码与「没有回执」时的原因也留着：只报结论不报凭据，复核时无从下手。
    childExitCode: item.exitCode,
    probeError: item.error,
  }));
  const judged = judgePreflight(rows);

  if (opts.json) {
    console.log(JSON.stringify({
      machine: os.hostname(), verdict: judged.verdict, autoLogin: opts.login, ...judged, rows,
    }, null, 1));
  } else {
    console.log(renderReport({ rows, machine: os.hostname(), autoLogin: opts.login }));
    for (const row of rows) {
      if (row.probeError) console.log(`    （${row.shop} 的这次体检没拿到回执：${row.probeError}）`);
    }
  }
  return exitCodeForPreflight(judged.verdict);
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exit(await main(process.argv.slice(2)));
