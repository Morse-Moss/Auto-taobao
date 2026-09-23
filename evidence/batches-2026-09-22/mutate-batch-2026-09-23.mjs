// 突变验证：把源码改坏，确认判据真的会红、并且红在**期望的那一条**上，然后还原并自证逐字节一致。
//
// 为什么必须做（本仓库反复吃过的亏）：函数级用例全绿 ≠ 那件事被守住了。
// 一条永远绿的判据与没有判据是一样的，而它更贵 —— 它让人以为有人在看守。
//
// ⚠️ 这份是从 tmp/ 收进证据目录的副本，路径按**自身位置**算（`../..` = 仓库根）。
//    tmp/ 那份写的是 `..`（它在仓库根下一层），收进 evidence/<批次>/ 后深度变两层，
//    照抄会把 REPO 解析成 evidence/ 然后静默跑不动 —— 所以这里显式改成两层并**在证据目录里实跑过**。
//
// 用法（任意目录均可）：
//   node evidence/batches-2026-09-22/mutate-batch-2026-09-23.mjs
// 产物：同目录 mutation-report-2026-09-23.json ＋ stdout（stdout 另存为 mutation-report-2026-09-23.txt）
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// 每一条：改哪个文件、把什么换成什么、跑哪个用例文件、期望哪句标题变红。
const MUTATIONS = [
  {
    name: '把「默认不启用分批」改坏（默认每批 2 家）',
    file: 'runtime/daily-job-plan.mjs',
    from: '    batches = null,',
    to: '    batches = 2,',
    spec: 'runtime/daily-job-plan.test.mjs',
    expectTitle: '不启用分批时，三步与从前**逐字相同**',
  },
  {
    name: '把「起与停同一组目标」改坏（停只停第一家）',
    file: 'runtime/batch-plan.mjs',
    from: "      args: ['--yes', ...batchOnlyArgs(batch)],",
    to: "      args: ['--yes', '--only', batch.shops.slice(0, 1).join(',')],",
    spec: 'runtime/batch-plan.test.mjs',
    expectTitle: '起与停作用在同一组目标上',
  },
  {
    name: '把「失败不释放」改坏（链失败也释放）',
    file: 'runtime/batch-plan.mjs',
    from: '    release: false,\n    why: `这一批没跑成',
    to: '    release: true,\n    why: `这一批没跑成',
    spec: 'runtime/batch-plan.test.mjs',
    expectTitle: '该不该释放：成功放行、失败不主动释放、没跑到链就收掉',
  },
  {
    name: '把版本号三处一致改坏（package.json 漂一格）',
    file: 'package.json',
    from: '"version": "1.0.0",',
    to: '"version": "1.0.1",',
    spec: 'runtime/version-consistency.test.mjs',
    expectTitle: 'package.json 的 version 与 VERSION 逐字一致',
  },
  {
    name: '把「分批也要 --commit」改坏（静默降级成排练）',
    file: 'runtime/daily-job-plan.mjs',
    from: "  if (commit) args.push('--commit');",
    to: "  if (false) args.push('--commit');",
    spec: 'runtime/daily-job-plan.test.mjs',
    expectTitle: '启用分批时 `--commit` 必须显式传下去',
  },
];

const results = [];
for (const mutation of MUTATIONS) {
  const full = path.join(REPO, mutation.file);
  const before = sha(full);
  const original = fs.readFileSync(full, 'utf8');
  if (!original.includes(mutation.from)) {
    results.push({ name: mutation.name, verdict: '无法执行', detail: `源码里找不到要替换的片段：${mutation.from.slice(0, 60)}` });
    continue;
  }
  try {
    fs.writeFileSync(full, original.replace(mutation.from, mutation.to), 'utf8');
    const run = spawnSync(NODE, ['--test', mutation.spec], { cwd: REPO, encoding: 'utf8' });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const redLines = out.split(/\r?\n/u).filter((l) => l.startsWith('not ok '));
    const hitExpected = redLines.some((l) => l.includes(mutation.expectTitle));
    results.push({
      name: mutation.name,
      verdict: hitExpected ? '如期望变红' : (redLines.length > 0 ? '红了但不是期望的那条' : '**没有变红**'),
      red: redLines.length,
      failing: redLines.slice(0, 3),
      exit: run.status,
    });
  } finally {
    fs.writeFileSync(full, original, 'utf8');
    results.push({ name: `${mutation.name} —— 还原后校验`, verdict: sha(full) === before ? '逐字节一致' : '**不一致**', file: mutation.file, sha: before.slice(0, 16) });
  }
}

const outPath = path.join(import.meta.dirname, 'mutation-report-2026-09-23.json');
fs.writeFileSync(outPath, `${JSON.stringify(results, null, 1)}\n`, 'utf8');
for (const row of results) {
  console.log(`${row.verdict.padEnd(22)} ${row.name}`);
  for (const line of row.failing ?? []) console.log(`      ${line}`);
}
console.log(`\n明细：${path.relative(REPO, outPath)}`);
