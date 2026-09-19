#!/usr/bin/env node

// 把 start-all 起的实例「托住」：起完不退出，直到这个进程被停掉。
//
// 为什么需要它（2026-09-19 实测，与沙箱无关的一条本机事实）：
//   命令结束时被回收的是**整棵进程树** —— 只要一个进程还挂在「发起它的那条命令」的祖先链上，
//   就会跟着一起没。start-all 的设计是「起完就退」（定时任务要它这样：它退了链才继续），
//   于是它的子进程在命令结束的那一刻全部消失。实测：同一条命令里，
//   一个已被父进程抛弃的 node 心跳进程活得好好的，而 start-all 起的 7 个浏览器与 7 个代理全没了。
//   （对照见 evidence/browser-restart-2026-09-19/ 与 probe-live/spawn-diag.mjs。）
//
// 什么时候用它：**在 agent 会话里起，而且希望起完还活着**（人工排查、补页、跑一次链）。
// 什么时候不要用它：定时任务路径 —— 那条路由 `scripts/run-daily-job.mjs` 驱动，
//   start-all 必须能自己退出，否则链走不到下一步。所以这个行为**不做成 start-all 的默认值**，
//   也不加开关藏在里面，而是单独一个脚本，名字就说清楚它在干什么。
//
// 用法（把它放在后台任务里跑）：
//   node scripts/start-all-hold.mjs                 # 起齐后一直托着
//   node scripts/start-all-hold.mjs --only 科塔淘宝  # 参数原样透传给 start-all
// 退出：收到 SIGINT/SIGTERM 时退出（子进程不受影响，要停它们请用 scripts/stop-all.mjs --yes）。
import { spawn } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/start-all.mjs'), ...process.argv.slice(2)], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

child.on('exit', (code) => {
  if (code !== 0) {
    // 起不齐就不托：托着一个空壳会让人以为实例在跑（那正是本项目一直在治的假绿灯）。
    console.error(`[hold] start-all 退出码 ${code} —— 不进入托住状态，免得托着一个空的。`);
    process.exit(code ?? 1);
  }
  console.log('[hold] start-all 已就位，开始托住（停这个进程不会停浏览器；要停浏览器用 scripts/stop-all.mjs --yes）');
  // 空转保活：父进程在，子进程才不会被「命令结束时的整树回收」带走。
  setInterval(() => {}, 3_600_000);
});

const bye = () => process.exit(0);
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
