// 补掉补跑残留：带 --recalculate-existing-snapshots --apply，只修历史表批次 8 的 5 格「是否重点词」。
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const SCRIPT = `${REPO}/skills/sycm-to-feishu-base/scripts/sync-decision-history.mjs`;
const OUTDIR = `${REPO}/evidence/keyword-weekly-columns-audit-2026-09-21`;

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
  '--receipt-file', `${OUTDIR}/sync-decision-history-recalc-receipt.json`,
  '--apply',
  '--confirm-base', 'HdBhbttB5aScbasWJAMc0gGXnpe',
  '--confirm-current-table', 'tblZsUns9353w3nl',
  '--confirm-history-table', 'tbl7HbH11JsQx6FL',
];

const res = spawnSync(process.execPath, args, {
  encoding: 'utf8', cwd: REPO, maxBuffer: 64 * 1024 * 1024, timeout: 600000,
});
writeFileSync(`${OUTDIR}/sync-decision-history-recalc-apply.txt`, [
  `# 1.6 apply（--recalculate-existing-snapshots，修残留快照）  时间=${new Date().toISOString()}`,
  `# exitCode=${res.status}  signal=${res.signal ?? ''}`,
  '', '=== STDOUT ===', res.stdout ?? '', '=== STDERR ===', res.stderr ?? '',
].join('\n'), 'utf8');
console.log(`exitCode=${res.status}`);
