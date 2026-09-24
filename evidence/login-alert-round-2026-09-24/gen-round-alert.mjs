// 本轮（1.7.0）的证据脚本之一：构造一条**整轮登录告警**并写盘。
//
// 它证明的事：改完之后的整轮告警**长什么样**（字段、编号、指纹），以及 source 里的键名
// 都在渲染器的白名单里（写错时渲染器会**静默丢掉**那一行 —— 告警照发、收信人看不到
// 「哪几家、哪个后台」）。与 `round-alert-dry-run.json` 配套：那个是同一条告警
// 过 `runtime/notify-feishu.mjs --dry-run` 之后**真渲染器**给出的正文（一个字节都没发）。
//
// 复现（在仓库根跑；本脚本只写文件、不起子进程）：
//   node evidence/login-alert-round-2026-09-24/gen-round-alert.mjs
//   node runtime/notify-feishu.mjs --dry-run --alert-file evidence/login-alert-round-2026-09-24/round-alert-input.json
//
// 为什么拆成两步：本机某些会话**禁止一切同步起子进程**（`spawnSync`/`execFileSync` 对
// node.exe、cmd.exe、where.exe 全部 `EBUSY`，异步 `spawn` 正常）⇒ 别在一个脚本里「起 CLI 子进程」，
// 让脚本只写文件、由顶层命令去跑 CLI。详见技能 `verified-edit-and-wiring-guard` §6。
//
// ⚠️ 路径按**自身位置**算（`import.meta.dirname`），不按 cwd —— 这条脚本从 tmp/ 搬进本目录时
// 就是靠它才没静默指向别处（见技能 `evidence-copy-must-be-runnable`）。
import fs from 'node:fs';
import path from 'node:path';
import {
  judgePreflight,
  judgeShopReceipt,
  buildRoundLoginAlert,
} from '../../skills/sycm-alimama-daily-report/scripts/check-login-shops-core.mjs';

const OUT_DIR = import.meta.dirname;
const rows = [
  // 里可林淘宝：生意参谋在、阿里妈妈掉了（→ 下一步与「两个都掉了」不同，正是要验的点）
  judgeShopReceipt({
    shop: '里可林淘宝',
    receipt: { sites: { sycm: { loggedIn: true }, alimama: { loggedIn: false } }, verdict: 'NO_SAVED_CREDENTIAL' },
  }),
  // 盖文天猫：两个后台都掉了
  judgeShopReceipt({
    shop: '盖文天猫',
    receipt: { sites: { sycm: { loggedIn: false }, alimama: { loggedIn: false } }, verdict: 'NEEDS_LOGIN' },
  }),
];
const judged = judgePreflight(rows);
if (judged.verdict !== 'NEEDS_LOGIN') throw new Error(`排练前提不成立：verdict=${judged.verdict}`);

const alert = buildRoundLoginAlert({ rows, judged, now: () => new Date('2026-09-24T09:40:00+08:00') });
const target = path.join(OUT_DIR, 'round-alert-input.json');
fs.writeFileSync(target, `${JSON.stringify(alert, null, 2)}\n`, 'utf8');
process.stdout.write(`已写 ${target}\n`);
process.stdout.write(`${JSON.stringify({ alertId: alert.alertId, fingerprint: alert.fingerprint, type: alert.type, source: alert.source }, null, 1)}\n`);
