// 突变验证（⑨b 告警闸门）：把三处关键判据逐个改坏，确认 run-multi-shop-day.test.mjs
// 真的红、且红在期望的那条用例上；逐条还原并比对 sha256 逐字节一致。
//
// 为什么必须做：本项目已三次吃「函数级全绿 ≠ 接线接上了」。
// 闸门的正确性全在「谁拦、谁不拦」的边界上 —— 边界写错时用例不红，就等于没写。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 证据副本自重定位仓库根：复制进 evidence/ 后 CWD 相对路径会指错（旧坑）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');


const SRC = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs');
const TEST = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const original = readFileSync(SRC, 'utf8');
const before = sha(SRC);

const run = () => {
  try {
    execFileSync(process.execPath, ['--test', TEST], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const mutations = [
  {
    name: 'M1 开关默认当开（不回 off 分支）',
    from: `  if (!enabled || !view.any) return { defer: false, targets: [], humanOnly: [] };`,
    to: `  if (!view.any) return { defer: false, targets: [], humanOnly: [] };`,
    expect: /默认（不给开关）一个字都不改/u,
  },
  {
    name: 'M2 忽略「只能人上」的那一家（半批能救也拦）',
    from: `  const defer = targets.length > 0 && humanOnly.length === 0;`,
    to: `  const defer = targets.length > 0;`,
    expect: /只要有一家「只能人上」/u,
  },
  {
    name: 'M3 一家都不够格时也算 defer（整轮没跑也拦下来）',
    from: `  const defer = targets.length > 0 && humanOnly.length === 0;`,
    to: `  const defer = humanOnly.length === 0;`,
    expect: /整轮被体检拦住/u,
  },
];

let allGood = true;
for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`✗ ${m.name}: 找不到锚点，突变没生效`);
    allGood = false;
    continue;
  }
  writeFileSync(SRC, original.replace(m.from, m.to), 'utf8');
  const r = run();
  const named = m.expect.test(r.out);
  const status = (!r.ok && named) ? '✓' : '✗';
  if (status === '✗') allGood = false;
  const failing = [...r.out.matchAll(/^not ok \d+ - (.+)$/gmu)].map((x) => x[1]);
  console.log(`${status} ${m.name}: exitOk=${r.ok} 点名=${named} 红用例=${JSON.stringify(failing)}`);
  writeFileSync(SRC, original, 'utf8');
}

const after = sha(SRC);
console.log(`\n还原核对: ${before} == ${after} ${before === after ? '✓ 逐字节一致' : '✗ 不一致！'}`);
console.log(`\n结论：${allGood ? '3/3 突变全红且点名到期望用例' : '有突变没被用例抓住 —— 用例没咬住代码'}，源文件已还原`);
