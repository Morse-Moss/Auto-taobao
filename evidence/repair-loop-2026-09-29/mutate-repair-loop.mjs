/**
 * 突变验证：agent 修复回环的四条新守卫**真的会咬人**吗？
 *
 * 为什么必须做（本项目的既有纪律）：判据写完、绿灯了，但它可能根本没被触发
 * ——「函数级用例全绿 ≠ 接线接上了」。做法是把源码**改坏**，确认对应的用例
 * **真的红**、且**点名到期望的那一条**，再还原。
 *
 * 四条被验证的守卫：
 *   ① 默认关闭：把 `if (args.autoRepair && …)` 改成无条件 ⇒ 「默认关闭」那条必须红；
 *   ② 重试的是失败那一步（不是整条链）：把 runNamedStage 换成「按 index 0 跑第一步」⇒ 必须红；
 *   ③ 动作没落地就不重试阶段：把 `attempt.applied !== true` 的分支删掉 ⇒ 必须红；
 *   ④ 阶段表只建一次：再插一次 buildShopStages ⇒ 必须红。
 *
 * 用法（仓库根）：
 *   node evidence/repair-loop-2026-09-29/mutate-repair-loop.mjs
 *
 * 退出码：0 = 四条突变都如期变红；1 = 有突变**没有**让用例变红（＝守卫是假的）。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const TARGET = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs');
const TEST = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs');
const BACKUP = `${TARGET}.mutate-backup`;

/** 每条突变：怎么改坏 + 期望哪条用例红（名字片段）。 */
const MUTATIONS = [
  {
    name: '默认关闭被拿掉（auto-repair 变成无条件执行）',
    expect: 'main 里 autoRepairAndRetry 真的被调用',
    apply: (src) => src.replace(
      'if (args.autoRepair && args.autoRepairMaxRounds > 0) {',
      'if (true) { // MUTATED: 默认关闭被拿掉',
    ),
  },
  {
    name: '重试改成「跑第一步」而不是「重跑失败那一步」',
    expect: '修复后的重试用的是「按名字重跑」',
    apply: (src) => src.replace(
      'const stage = stages.find((s) => s.stage === name);',
      'const stage = stages[0]; void name; // MUTATED: 不按名字找',
    ),
  },
  {
    name: '动作没落地也照样重试阶段（原样再来一遍）',
    expect: '动作没落地',
    apply: (src) => src.replace(
      'if (attempt.attempted && attempt.applied !== true) {',
      'if (false) { // MUTATED: 没落地也重试',
    ),
  },
  {
    name: '阶段表被建了两次（重试用的 argv 可能与首跑不同）',
    expect: '修复后的重试用的是「按名字重跑」',
    apply: (src) => src.replace(
      /(const stages = buildShopStages\(key,[\s\S]*?\);\n)/u,
      '$1    const stagesAgain = buildShopStages(key, { date: args.date, mode }); void stagesAgain; // MUTATED\n',
    ),
  },
];

const runTests = () => {
  const out = spawnSync(process.execPath, ['--test', TEST], {
    cwd: REPO_ROOT, encoding: 'utf8',
    // 与链上一致：stdin=ignore（宿主沙箱对管道 stdin 的同步 spawn 会回 EBUSY）。
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
};

let failures = 0;
const original = readFileSync(TARGET, 'utf8');
copyFileSync(TARGET, BACKUP);
try {
  for (const m of MUTATIONS) {
    const mutated = m.apply(original);
    if (mutated === original) {
      console.error(`✗ ${m.name}：突变没生效（源码形态变了？）—— 这条验证无效`);
      failures += 1;
      continue;
    }
    writeFileSync(TARGET, mutated, 'utf8');
    const text = runTests();
    const redLines = text.split(/\r?\n/u).filter((l) => l.startsWith('not ok '));
    const hit = redLines.some((l) => l.includes(m.expect));
    const status = hit ? '✓ 如期变红' : '✗ 没有如期变红（守卫是假的）';
    if (!hit) failures += 1;
    console.log(`${status} —— ${m.name}`);
    console.log(`    期望点名：${m.expect}`);
    console.log(`    实际红：${redLines.length} 条${redLines.length ? `（${redLines.map((l) => l.replace(/^not ok \d+ - /u, '')).join(' | ')}）` : ''}`);
    // 还原，跑到下一条
    writeFileSync(TARGET, original, 'utf8');
  }
} finally {
  writeFileSync(TARGET, original, 'utf8');
  try { unlinkSync(BACKUP); } catch { /* 备份删不掉不该改变结论 */ }
}

// 还原自证：文件必须回到原样（否则这一次验证本身把仓库改坏了）。
const restored = readFileSync(TARGET, 'utf8');
if (restored !== original) {
  console.error('✗ 还原失败：被测文件与原文不一致 —— 这是比验证本身更严重的问题');
  failures += 1;
} else {
  console.log('✓ 已还原：被测文件逐字节回到原样');
}

console.log(failures === 0
  ? `\n结论：${MUTATIONS.length} 条突变全部如期变红 ⇒ 四条守卫都真的在咬人。`
  : `\n结论：${failures} 条突变没有如期变红 ⇒ 守卫是假的，必须修。`);
process.exitCode = failures === 0 ? 0 : 1;
