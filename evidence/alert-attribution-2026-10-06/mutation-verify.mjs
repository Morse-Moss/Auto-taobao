// 突变验证（A 项：告警归因）：把源码改坏，确认新判据真的会红、且点名到期望的那条断言，然后逐字节还原。
//
// 三条突变各针对一个「会被静默改回去」的点：
//   M1 结论改判退回旧形态（共用窗口掉登录又被判成「页面不齐」）—— 这次事故的原始缺陷；
//   M2 体检明细不再按真因过滤（内部片段与「页面不齐」重新回到业务消息里）；
//   M3 loginPreflightLines 的登录墙优先分支被删（又出现「问题不在登录上」）。
//
// 本脚本**会改写源码**，所以：
//   · 不要与别的测试/采集同时跑；
//   · 每条突变跑完自己用 sha256 自证还原，最后一行「还原：sha256 一致」必须成立；
//   · 自己向上找仓库根（VERSION 与 package.json 同时在哪就是哪），在本目录或在 tmp/ 跑都一样。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('找不到仓库根：一路向上都没有 VERSION + package.json');
    dir = parent;
  }
}

const ROOT = findRepoRoot(import.meta.dirname);
const SRC = path.join(ROOT, 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs');
const TEST_FILE = 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs';
const original = fs.readFileSync(SRC, 'utf8');
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const originalSha = sha(original);

const MUTATIONS = [
  {
    id: 'M1 结论改判退回旧形态',
    from: "    ? (loginShops.size > 0 ? 'NEEDS_LOGIN' : (roundLoginWall ? 'ROUND_LOGIN_WALL' : 'ROUND_BLOCKED'))",
    to: "    ? (loginShops.size > 0 ? 'NEEDS_LOGIN' : 'ROUND_BLOCKED')",
    // 命中原因：这条突变让正文出现「问题不在登录上」。命中的断言是 assert.match
    // （node 对 assert.match 失败会把整段 Input 打出来），所以内容级串也能被看见。
    expect: '问题不在登录上',
  },
  {
    id: 'M2 体检明细不再按真因过滤',
    from: '    ...(view.roundBlocked && !roundLoginWall\n',
    to: '    ...(view.roundBlocked\n',
    // 这条突变把内部片段（「按片段 … 找到 0 个」）与「页面不齐」一起回灌进业务消息。
    // 命中的是那条 assert.equal 的**消息文本**：node 对 assert.equal 只打消息 + `true !== false`，
    // 不打原串 —— 两种断言在 TAP 里的可见性不一样，期望串必须按断言类型来选。
    expect: '内部片段不许进业务消息',
  },
  {
    id: 'M3 删掉登录墙优先分支',
    from: '  if (roundLoginWall) {\n',
    to: '  if (false) {\n',
    expect: '问题不在登录上',
  },
];

// 注意：stdio 必须显式写成 ['ignore','pipe','pipe']。
// 写成 'pipe'（= ['pipe','pipe','pipe']）会让 stdin 也成为管道，本机沙箱下 spawnSync 必抛 EBUSY
// —— 后果是测试根本没启动，catch 把「没跑起来」当成「测试红了」，突变验证会变成空转假绿。
// （本仓 `run-multi-shop-day.test.mjs` 自己就有守卫在断言这条 stdio 形状。）
const runTests = () => {
  try {
    const out = execFileSync(process.execPath, ['--test', TEST_FILE], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

let allCaught = true;
for (const m of MUTATIONS) {
  if (!original.includes(m.from)) {
    console.log(`[${m.id}] 找不到锚点 ⇒ 判据没建立：${JSON.stringify(m.from)}`);
    allCaught = false;
    continue;
  }
  fs.writeFileSync(SRC, original.replace(m.from, m.to), 'utf8');
  const result = runTests();
  const named = result.out.includes(m.expect);
  // 红＝TAP 汇总里真的出现失败计数，而不是「子进程没启动」。后者必须单独判死，
  // 否则沙箱 EBUSY 会被伪装成「突变被抓住」。
  const red = !result.ok && /# fail [1-9]/.test(result.out);
  const launched = /# tests \d+/.test(result.out);
  console.log(`[${m.id}] 红=${red} 点名期望串=${named} 期望串=${JSON.stringify(m.expect)}`);
  if (!launched) {
    allCaught = false;
    console.log('    ！！测试进程没跑起来（输出里没有 TAP 汇总）—— 本次验证无效：'
      + JSON.stringify(result.out.slice(0, 200)));
    fs.writeFileSync(SRC, original, 'utf8');
    continue;
  }
  if (!red || !named) {
    allCaught = false;
    const lines = result.out.split('\n').filter((l) => /^not ok|error:/.test(l)).slice(0, 8);
    console.log('    未达标，输出片段：\n      ' + lines.join('\n      '));
  }
  fs.writeFileSync(SRC, original, 'utf8');
}

const restoredSha = sha(fs.readFileSync(SRC, 'utf8'));
const finalRun = runTests();
console.log(`还原：sha256 ${restoredSha === originalSha ? '一致' : '不一致！！'}`);
console.log(`突变 ${allCaught ? '全部被抓住' : '有漏网'}；最终 `
  + `${finalRun.ok && /# fail 0/.test(finalRun.out) ? '测试复绿' : `测试仍红！！（${finalRun.out.slice(0, 160)}）`}`);
process.exitCode = allCaught && restoredSha === originalSha && finalRun.ok ? 0 : 1;
