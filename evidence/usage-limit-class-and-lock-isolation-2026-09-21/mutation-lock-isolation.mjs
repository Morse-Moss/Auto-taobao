// 突变验证：证明「锁隔离」那两条守卫真的拦得住退化。
// 规矩同仓库其它 *.mutation.mjs：基线先绿 → 每次只改一处 → 断言**点名**到期望的用例
// → 立即还原并逐字节复核 sha256 → 全部还原后再复核一遍。
// 后缀刻意不是 .test.mjs：套件按后缀发现（scripts/test-suite-discovery.mjs 的 listTestFiles），
// 叫 .test.mjs 会让「跑一次测试」顺手改源码。
// 用法：在仓库根跑 `node evidence/usage-limit-class-and-lock-isolation-2026-09-21/mutation-lock-isolation.mjs`
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const target = path.join(repo, 'skills', 'xws-export-market-analysis', 'tests', 'prepare-flow.test.mjs');
const guard = path.join(repo, 'skills', 'xws-export-market-analysis', 'tests', 'spawn-lock-isolation.test.mjs');

const original = readFileSync(target, 'utf8');
const digest = createHash('sha256').update(original, 'utf8').digest('hex');

function runGuard() {
  const result = spawnSync(process.execPath, ['--test', guard], { cwd: repo, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => match[1].trim());
  return { status: result.status, failures, output };
}

const MUTATIONS = [
  {
    name: 'L1 某一处 spawn 退回裸 env（那把锁又落回机器级）',
    find: '], { env: cliEnv(runtime) });',
    replace: '], { env: { ...process.env, XWS_RUNTIME_DIR: runtime } });',
    expect: '每个 CLI 子进程都拿到用例私有的市场分析锁（漏一处只会在并行跑套件时炸）',
  },
  {
    name: 'L2 cliEnv() 不再设锁（退化成「只改了个名字」）',
    find: '    XWS_MARKET_ANALYSIS_LOCK: path.join(runtime, ".market-analysis.lock"),\n',
    replace: '',
    expect: '每个 CLI 子进程都拿到用例私有的市场分析锁（漏一处只会在并行跑套件时炸）',
  },
];

const lines = [];
lines.push('=== 基线（改动前必须先绿，否则「突变后变红」无法归因）===');
const baseline = runGuard();
lines.push(`守卫用例：status=${baseline.status}，失败 ${baseline.failures.length} 条`);
if (baseline.status !== 0 || baseline.failures.length) {
  lines.push('基线不是绿的 —— 停手，不进入突变。');
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(1);
}

let caught = 0;
let missed = 0;
for (const mutation of MUTATIONS) {
  if (!original.includes(mutation.find)) {
    lines.push(`\n${mutation.name}\n  突变点找不到（源码已变）⇒ 记为 MISSED，不猜。`);
    missed += 1;
    continue;
  }
  writeFileSync(target, original.replace(mutation.find, mutation.replace), 'utf8');
  const result = runGuard();
  writeFileSync(target, original, 'utf8');
  const restored = createHash('sha256').update(readFileSync(target, 'utf8'), 'utf8').digest('hex') === digest;
  const hit = result.failures.some((name) => name === mutation.expect);
  lines.push(`\n${mutation.name}`);
  lines.push(`  status=${result.status}，失败 ${result.failures.length} 条`);
  for (const name of result.failures) lines.push(`    not ok - ${name}`);
  lines.push(`  期望点名：${mutation.expect}`);
  lines.push(`  ⇒ ${hit ? 'CAUGHT' : 'MISSED'}　还原逐字节一致：${restored ? '是' : '否'}`);
  if (hit && restored) caught += 1;
  else missed += 1;
  if (!restored) {
    lines.push('  还原失败 —— 立即停手，源码可能已脏。');
    break;
  }
}

lines.push('');
lines.push('=== 收尾：全量复核 ===');
const now = createHash('sha256').update(readFileSync(target, 'utf8'), 'utf8').digest('hex');
const allRestored = now === digest;
lines.push(`  prepare-flow.test.mjs  ${allRestored ? '一致' : '不一致'}  ${now.slice(0, 12)}`);
lines.push('');
lines.push(`结果：CAUGHT ${caught} / MISSED ${missed} / 共 ${MUTATIONS.length}${caught === MUTATIONS.length && missed === 0 && allRestored ? '　MUTATION_ALL_CAUGHT_AND_RESTORED' : '　MUTATION_NOT_CLEAN'}`);

process.stdout.write(lines.join('\n') + '\n');
process.exit(caught === MUTATIONS.length && missed === 0 && allRestored ? 0 : 1);
