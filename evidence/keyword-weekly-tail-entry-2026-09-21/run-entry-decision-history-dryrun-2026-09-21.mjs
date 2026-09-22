// 真机只读验证：入口 `run-keyword-weekly-local-analysis.mjs` 的第三段（决策历史同步）接线到底通没通。
//
// 为什么必须真跑一次而不是只看用例：用例全绿只证明「函数被调用了」，
// 证明不了「表名解析到的是真表」「1.6 的真 stdout 解析得动」「spawn 的参数它真的收」。
// 这里不给 `--apply` ⇒ 整条命令只读（读表 + 1.6 的 dry-run 子进程，零写入）。
//
// 中文表名过不了 shell，所以只能用 spawn 数组。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const RUNNER = `${REPO}/runtime/run-keyword-weekly-local-analysis.mjs`;
const OUTDIR = `${REPO}/evidence/keyword-weekly-tail-entry-2026-09-21`;
mkdirSync(OUTDIR, { recursive: true });
const OUT = `${OUTDIR}/entry-dryrun-2026-09-19.txt`;

const args = [
  RUNNER,
  '--table-name', '关键词分析 V1（2026-09-19）',
  '--collection-date', '2026-09-19',
  '--batch-number', '8',
  '--expected-rows', '300',
  '--history-table-name', '关键词历史总表 V1',
  '--previous-table-name', '关键词分析 V1（2026-09-12）',
  '--expected-history-rows', '2367',
  '--output-dir', 'runtime/keyword-weekly-runs',
];

const res = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: REPO, maxBuffer: 128 * 1024 * 1024 });
const body = [
  '# 关键词链入口第三段（决策历史同步）真机只读验证 —— 不带 --apply，零写入',
  `# 生成时间=${new Date().toISOString()}`,
  `# 命令：node runtime/run-keyword-weekly-local-analysis.mjs ${args.slice(1).join(' ')}`,
  `# exitCode=${res.status}`,
  '',
  '=== STDOUT ===',
  res.stdout ?? '',
  '=== STDERR ===',
  res.stderr ?? '',
].join('\n');
writeFileSync(OUT, body, 'utf8');
console.log(`exitCode=${res.status}`);
console.log(`written: ${OUT}`);
