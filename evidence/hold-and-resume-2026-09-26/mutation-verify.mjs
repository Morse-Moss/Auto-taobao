// 突变验证（2026-09-26）：把源码逐条改坏，确认**点名的那条用例真的红**，再逐字节还原。
//
// 为什么必须做这一步：上面那些用例全绿只能证明「代码没坏」，不能证明「它们真的在守这件事」。
// 判据是：每条突变必须让**期望的那条用例**失败，而且失败清单里必须出现期望的名字
//（只报「有失败」是不够的 —— 一条把整个文件带崩的语法错误也会让用例全红）。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根**自己找**，不写死绝对路径、也不按「自身位置 + 固定层数」算：
// 本脚本的正式留档在 `evidence/hold-and-resume-2026-09-26/`（比编写时的 `tmp/` 深一层），
// 写死路径在这台机器上碰巧还能跑、换个 checkout 就指到别人家；按层数算则**复制后就静默指错**。
const ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'VERSION'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('找不到仓库根：从本文件向上 6 层都没看见 VERSION');
})();
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const MUTATIONS = [
  {
    name: '判据「空集不算好了」被拿掉（没东西可探时立刻续跑）',
    file: 'runtime/hold-and-resume-plan.mjs',
    from: '    ready: list.length > 0 && waiting.length === 0 && unknown.length === 0,',
    to: '    ready: waiting.length === 0 && unknown.length === 0,',
    test: 'runtime/hold-and-resume-plan.test.mjs',
    expect: '判据转正',
  },
  {
    name: '起点下探的方向写反（floor 变成「只许往后」⇒ 漏跑失败那一步）',
    file: 'runtime/hold-and-resume-plan.mjs',
    from: '  const from = Math.min(...indexes, ...(floorIndex >= 0 ? [floorIndex] : []));',
    to: '  const from = Math.max(...indexes, ...(floorIndex >= 0 ? [floorIndex] : []));',
    test: 'runtime/hold-and-resume-plan.test.mjs',
    expect: '起点下探',
  },
  {
    name: '续跑成功/失败共用同一个告警编号（失败会被上一轮的成功去重挡掉）',
    file: 'runtime/hold-and-resume-plan.mjs',
    from: '    alertId: ok ? `daily-hold-resumed-${stamp}` : `daily-hold-resume-failed-${stamp}`,',
    to: '    alertId: `daily-hold-resumed-${stamp}`,',
    test: 'runtime/hold-and-resume-plan.test.mjs',
    expect: '三条各有各的编号',
  },
  {
    name: '驻留那一步不再「只在链失败时」执行（链成功的那天也去驻留）',
    file: 'runtime/daily-job-plan.mjs',
    from: '      onlyWhenChainFailed: true,',
    to: '      onlyWhenChainFailed: false,',
    test: 'runtime/hold-and-resume-plan.test.mjs',
    expect: '只在链失败时才执行',
  },
  {
    name: '不告诉链「这一轮会驻留」（告警叫人去重跑，而窗口其实留着）',
    file: 'runtime/daily-job-plan.mjs',
    from: '  if (willHold) chainArgs.push(CHAIN_FLAGS.willResume);',
    to: '',
    test: 'runtime/hold-and-resume-plan.test.mjs',
    expect: 'will-resume',
  },
  {
    name: '压根不加驻留那一步（默认关掉）',
    file: 'runtime/daily-job-plan.mjs',
    from: '  const willHold = !batchMode && hold && Boolean(resolvedDate) && Boolean(artifactsDir);',
    to: '  const willHold = false;',
    test: 'runtime/hold-and-resume-plan.test.mjs',
    expect: '驻留',
  },
  {
    name: '「该不该执行」的判据写反（链失败时不驻留、链成功时反而驻留）',
    file: 'runtime/daily-job-plan.mjs',
    from: '  return chainStatus !== 0;',
    to: '  return chainStatus === 0;',
    test: 'runtime/hold-and-resume-plan.test.mjs',
    expect: '该不该执行',
  },
  {
    name: '告警出口缺 off 分支（「没让发」的调用会真发一条飞书）',
    file: 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs',
    from: `  if (dispatch.action === 'off') {
    log(\`[驱动] （没有打开告警：\${dispatch.why ?? '--notify 未给'} —— 只打印，不投递）\`);
    return { delivered: false, printed: false, suppressed: false, off: true };
  }
`,
    to: '',
    test: 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs',
    expect: 'action=off',
  },
  {
    name: 'PAGE_OBSTRUCTED 的分类分支被删（关不掉的弹窗退回兜底话术）',
    file: 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs',
    from: "  if (String(record.failureOutput ?? '').includes(OVERLAY_NOT_DISMISSED_TOKEN)) return 'PAGE_OBSTRUCTED';",
    to: '',
    test: 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs',
    expect: 'PAGE_OBSTRUCTED 的判据',
  },
];

const results = [];
for (const mutation of MUTATIONS) {
  const before = read(mutation.file);
  const beforeHash = sha256(before);
  if (!before.includes(mutation.from)) {
    results.push({ ...mutation, outcome: 'MUTATION_TARGET_NOT_FOUND' });
    continue;
  }
  writeFileSync(path.join(ROOT, mutation.file), before.replace(mutation.from, mutation.to), 'utf8');
  const after = read(mutation.file);
  if (after === before) {
    results.push({ ...mutation, outcome: 'WRITE_DROPPED' });
    continue;
  }

  const run = spawnSync(process.execPath, ['--test', mutation.test], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const failedNames = [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((m) => m[1].trim());
  const named = failedNames.some((name) => name.includes(mutation.expect));

  // 还原并**自证**（用 sha256 逐字节比，不是「我看它改回来了」）。
  writeFileSync(path.join(ROOT, mutation.file), before, 'utf8');
  const restoredHash = sha256(read(mutation.file));

  results.push({
    ...mutation,
    outcome: run.status === 0
      ? 'NOT_CAUGHT'
      : (named ? 'CAUGHT' : 'CAUGHT_BUT_WRONG_CASE'),
    failedCount: failedNames.length,
    failedNames: failedNames.slice(0, 8),
    restored: restoredHash === beforeHash && restoredHash === sha256(before),
  });
}

for (const r of results) {
  const mark = r.outcome === 'CAUGHT' && r.restored ? 'OK  ' : 'FAIL';
  console.log(`${mark} [${r.outcome}] ${r.name}`);
  console.log(`       文件 ${r.file}｜用例 ${path.basename(r.test)}｜期望命中「${r.expect}」`);
  if (r.failedNames) console.log(`       实际失败 ${r.failedCount} 条：${r.failedNames.join(' | ') || '（无）'}`);
  console.log(`       还原自证：${r.restored === undefined ? '未改动' : r.restored ? 'sha256 逐字节一致' : '**不一致**'}`);
}
const bad = results.filter((r) => r.outcome !== 'CAUGHT' || r.restored !== true);
console.log(`\n突变 ${results.length} 条：抓住 ${results.filter((r) => r.outcome === 'CAUGHT').length}，异常 ${bad.length}`);
process.exit(bad.length === 0 ? 0 : 1);
