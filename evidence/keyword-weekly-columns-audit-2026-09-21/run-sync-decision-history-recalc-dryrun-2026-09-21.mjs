// dry-run（零写入）：带 --recalculate-existing-snapshots，看能否修正历史表批次 8 里那 5 行
// 「是否重点词=待数据」的快照（apply 时源表公式还没重算完，快照采到了旧值）。
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const SCRIPT = `${REPO}/skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs`;
const OUTDIR = `${REPO}/evidence/keyword-weekly-columns-audit-2026-09-21`;
const OUT = `${OUTDIR}/sync-decision-history-recalc-dryrun.txt`;

const args = [
  SCRIPT,
  '--base-url', 'https://kcne618basvj.feishu.cn/base/HdBhbttB5aScbasWJAMc0gGXnpe',
  '--current-table-id', 'tblZsUns9353w3nl', '--current-table-name', '关键词分析 V1（2026-09-19）',
  '--previous-table-id', 'tblrX0GM7HkVhF85', '--previous-table-name', '关键词分析 V1（2026-09-12）',
  '--history-table-id', 'tbl7HbH11JsQx6FL', '--history-table-name', '关键词历史总表 V1',
  '--current-batch-number', '8',
  '--expected-current-rows', '300',
  '--expected-history-rows', '2367',
  '--recalculate-existing-snapshots',
];

const res = spawnSync(process.execPath, args, {
  encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024, timeout: 600000,
});
writeFileSync(OUT, [
  `# 1.6 dry-run（--recalculate-existing-snapshots，零写入）  时间=${new Date().toISOString()}`,
  `# exitCode=${res.status}`,
  '', '=== STDOUT ===', res.stdout ?? '', '=== STDERR ===', res.stderr ?? '',
].join('\n'), 'utf8');
console.log(`exitCode=${res.status}`);
console.log(`written: ${OUT}`);
