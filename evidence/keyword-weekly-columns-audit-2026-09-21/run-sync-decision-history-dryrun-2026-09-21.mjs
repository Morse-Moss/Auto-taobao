// 用 spawn 传数组跑 1.6 决策历史同步的 DRY-RUN（脚本里 !apply 就直接 return，零写入）。
// 目的：量化「补跑 1.6 会给 09-19 期补回多少行」。
// 中文表名不过 shell，所以必须 spawn 数组。
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const SCRIPT = `${REPO}/skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs`;
const OUTDIR = `${REPO}/evidence/keyword-weekly-columns-audit-2026-09-21`;
mkdirSync(OUTDIR, { recursive: true });
const OUT = `${OUTDIR}/sync-decision-history-dryrun.txt`;

const args = [
  SCRIPT,
  '--base-url', 'https://kcne618basvj.feishu.cn/base/HdBhbttB5aScbasWJAMc0gGXnpe',
  '--current-table-id', 'tblZsUns9353w3nl', '--current-table-name', '关键词分析 V1（2026-09-19）',
  '--previous-table-id', 'tblrX0GM7HkVhF85', '--previous-table-name', '关键词分析 V1（2026-09-12）',
  '--history-table-id', 'tbl7HbH11JsQx6FL', '--history-table-name', '关键词历史总表 V1',
  '--current-batch-number', '8',
  '--expected-current-rows', '300',
  '--expected-history-rows', '2367',
];

const res = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
const body = [
  `# 1.6 决策历史同步 DRY-RUN（零写入）`,
  `# 生成时间=${new Date().toISOString()}`,
  `# 命令：node skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs ${args.slice(1).join(' ')}`,
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
