// 真机只读前检：确认第三段接入前后，①② 两个写入器在已同步的 09-19 期上**都已经没有要写的格**。
//
// 为什么先做这一步：下一步要带 `--apply` 真跑一次入口（拿真收据，证明「已同步 ⇒ 整轮幂等」）。
// 但 `--apply` 会连带重跑 ①②。如果它们还有要写的格，那一次就不只是「验证」，而是一次真写入 ——
// 必须先证明它们是空转，再谈跑不跑。两个写入器的默认模式都是 dry-run（不给 --apply）。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const REPO = 'D:/Retire/sycm-automation';
const OUTDIR = `${REPO}/evidence/keyword-weekly-tail-entry-2026-09-21`;
mkdirSync(OUTDIR, { recursive: true });

const jobs = [
  {
    out: `${OUTDIR}/writer-rule-dryrun.txt`,
    label: '规则段（apply-local-keyword-analysis.mjs）dry-run',
    args: [
      `${REPO}/runtime/apply-local-keyword-analysis.mjs`,
      '--app-token', 'HdBhbttB5aScbasWJAMc0gGXnpe',
      '--table-id', 'tblZsUns9353w3nl',
      '--table-name', '关键词分析 V1（2026-09-19）',
      '--expected-rows', '300',
      // 这个写入器的 envFile 没有默认值（入口必须显式传，它就是这么调它的）——
      // 不传会以 "Missing required options: envFile" 直接退 1，看着像「脚本坏了」。
      '--env-file', 'E:/小红书/.env.feishu-kcne.local',
    ],
  },
  {
    out: `${OUTDIR}/writer-content-heat-dryrun.txt`,
    label: '内容热度（apply-content-heat.mjs）dry-run',
    args: [
      `${REPO}/runtime/apply-content-heat.mjs`,
      '--artifact', `${REPO}/runtime/keyword-weekly-runs/2026-09-19-batch-8-tblZsUns9353w3nl/content-heat-artifact.json`,
      '--table-id', 'tblZsUns9353w3nl',
      '--table-name', '关键词分析 V1（2026-09-19）',
      '--expected-rows', '300',
    ],
  },
];

for (const job of jobs) {
  const res = spawnSync(process.execPath, job.args, { encoding: 'utf8', cwd: REPO, maxBuffer: 128 * 1024 * 1024 });
  writeFileSync(job.out, [
    `# ${job.label} —— 只读 dry-run（不带 --apply）`,
    `# 生成时间=${new Date().toISOString()}`,
    `# exitCode=${res.status}`,
    '',
    '=== STDOUT ===',
    res.stdout ?? '',
    '=== STDERR ===',
    res.stderr ?? '',
  ].join('\n'), 'utf8');
  console.log(`${job.label}: exit=${res.status} -> ${job.out}`);
}
