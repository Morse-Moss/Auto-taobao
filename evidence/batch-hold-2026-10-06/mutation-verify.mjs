// 突变验证（B 项：分批形态整轮被挡时挂住等人）：把源码改坏，确认新判据真的会红、且点名到期望的
// 那条断言，然后逐字节还原。
//
// 四条突变，各针对一个「会被静默改回去」的点：
//   M1 分批驱动读到整轮被挡却**不停手**（删掉 break）——「剩下的批次白起白停 + 重复告警」回潮；
//   M2 `--no-hold` 不再转发到分批驱动 —— 命令行写了关掉、分批那一档照旧挂住（静默失效）；
//   M3 驻留截止退回**绝对钟点** —— 15:30 的排期下当场过期，「挂住等人」一次都不会发生；
//   M4 分批续跑不带 `--no-hold` —— 驻留套驻留（第二层等的是另一份结论，第一层已过期）。
//
// 本脚本**会改写源码**，所以：不要与别的测试/采集同时跑；每条跑完用 sha256 自证还原。
// 自己向上找仓库根（VERSION + package.json 同时在哪就是哪）。
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
const FILES = {
  batches: 'scripts/run-batches.mjs',
  jobPlan: 'runtime/daily-job-plan.mjs',
  holdPlan: 'runtime/hold-and-resume-plan.mjs',
};
const TESTS = ['runtime/hold-and-resume-plan.test.mjs', 'runtime/daily-job-plan.test.mjs'];

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const originals = Object.fromEntries(Object.entries(FILES)
  .map(([key, rel]) => [key, fs.readFileSync(path.join(ROOT, rel), 'utf8')]));
const originalShas = Object.fromEntries(Object.entries(originals).map(([k, v]) => [k, sha(v)]));

const MUTATIONS = [
  {
    id: 'M1 分批驱动读到整轮被挡却不停手',
    file: 'batches',
    from: '      blocked = { batch: batch.index, summaryPath: batchSummary, cause: roundBlock.cause };\n      break;',
    to: '      blocked = { batch: batch.index, summaryPath: batchSummary, cause: roundBlock.cause };',
    expect: '必须**停止后面的批次**',
  },
  {
    id: 'M2 --no-hold 不再转发到分批驱动',
    file: 'jobPlan',
    from: "  if (!hold) args.push('--no-hold');",
    to: '',
    expect: '分批那一档照旧挂住',
  },
  {
    id: 'M3 驻留截止退回「立刻到点」（绝对钟点失效时的形态）',
    file: 'holdPlan',
    from: '  const at = new Date(now.getTime() + Math.round(value * 3_600_000));',
    to: '  const at = new Date(now.getTime());',
    expect: '截止时刻必须是「现在 + 4 小时」',
  },
  {
    id: 'M4 分批续跑不带 --no-hold',
    file: 'holdPlan',
    from: "  if (noHold) argv.push('--no-hold');",
    to: '',
    expect: '防「驻留套驻留」',
  },
];

// 注意：stdio 必须显式写成 ['ignore','pipe','pipe']。
// 写成 'pipe'（= ['pipe','pipe','pipe']）会让 stdin 也成为管道，本机沙箱下 spawnSync 必抛 EBUSY
// —— 后果是测试根本没启动，catch 把「没跑起来」当成「测试红了」，突变验证会变成空转假绿。
// （本仓 `run-multi-shop-day.test.mjs` 自己就有守卫在断言这条 stdio 形状。）
const runTests = () => {
  try {
    const out = execFileSync(process.execPath, ['--test', ...TESTS], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

const restoreAll = () => {
  for (const [key, rel] of Object.entries(FILES)) fs.writeFileSync(path.join(ROOT, rel), originals[key], 'utf8');
};

let allCaught = true;
for (const m of MUTATIONS) {
  const rel = FILES[m.file];
  const target = path.join(ROOT, rel);
  if (!originals[m.file].includes(m.from)) {
    console.log(`[${m.id}] 找不到锚点 ⇒ 判据没建立：${JSON.stringify(m.from)}`);
    allCaught = false;
    continue;
  }
  let mutated = originals[m.file].replace(m.from, m.to);
  for (const extra of m.also ?? []) {
    if (!mutated.includes(extra.from)) {
      console.log(`[${m.id}] 附加锚点找不到 ⇒ 判据没建立：${JSON.stringify(extra.from)}`);
      allCaught = false;
    }
    mutated = mutated.replace(extra.from, extra.to);
  }
  if (sha(mutated) === sha(originals[m.file])) {
    console.log(`[${m.id}] 改完与原文逐字节相同 ⇒ 这条突变是空的，验证无效`);
    allCaught = false;
    continue;
  }
  fs.writeFileSync(target, mutated, 'utf8');
  const result = runTests();
  const named = result.out.includes(m.expect);
  // 红＝TAP 汇总里真的出现失败计数，而不是「子进程没启动」。
  const red = !result.ok && /# fail [1-9]/.test(result.out);
  const launched = /# tests \d+/.test(result.out);
  console.log(`[${m.id}] 红=${red} 点名期望串=${named} 期望串=${JSON.stringify(m.expect)}`);
  if (!launched) {
    allCaught = false;
    console.log('    ！！测试进程没跑起来（输出里没有 TAP 汇总）—— 本次验证无效：'
      + JSON.stringify(result.out.slice(0, 200)));
  } else if (!red || !named) {
    allCaught = false;
    const lines = result.out.split('\n').filter((l) => /^not ok|error:/.test(l)).slice(0, 8);
    console.log('    未达标，输出片段：\n      ' + lines.join('\n      '));
  }
  restoreAll();
}

restoreAll();
const restoredOk = Object.entries(FILES).every(([key, rel]) => sha(fs.readFileSync(path.join(ROOT, rel), 'utf8')) === originalShas[key]);
const finalRun = runTests();
console.log(`还原：sha256 ${restoredOk ? '全部一致' : '不一致！！'}`);
console.log(`突变 ${allCaught ? '全部被抓住' : '有漏网'}；最终 `
  + `${finalRun.ok && /# fail 0/.test(finalRun.out) ? '测试复绿' : `测试仍红！！（${finalRun.out.slice(0, 160)}）`}`);
process.exitCode = allCaught && restoredOk && finalRun.ok ? 0 : 1;
