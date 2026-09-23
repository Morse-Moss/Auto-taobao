// 突变验证（本轮：**每批跑完一律释放** ＋ **店铺首屏＝标识页** ＋ **登录守卫排到每批 start 之后**）：
// 把源码改坏，确认判据真的会红、并且红在**期望的那一条**上，然后还原并自证逐字节一致。
//
// 为什么必须做（本仓库反复吃过的亏）：函数级用例全绿 ≠ 那件事被守住了。
// 一条永远绿的判据与没有判据是一样的，而它更贵 —— 它让人以为有人在看守。
//
// ⚠️ 路径按**自身位置**算（`../..` = 仓库根）。从 tmp/ 收进 evidence/<批次>/ 时深度会变，
//    照抄 `..` 会把 REPO 解析成 evidence/ 然后静默跑不动（这条坑本仓库吃过一次）。
//
// 用法（任意目录均可）：
//   node evidence/batches-release-and-label-2026-09-23/mutate-2026-09-23.mjs
// 产物：同目录 mutation-report-2026-09-23.json ＋ stdout（另存为 mutation-report-2026-09-23.txt）
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// 每一条：改哪个文件、把什么换成什么、跑哪个用例文件、期望哪句标题变红。
const MUTATIONS = [
  // ---- 本轮新增的三条：各对应一个用户要求 ----
  {
    name: '把「一律释放」改回「失败不释放」（用户 2026-09-23：每一轮跑完都要释放）',
    file: 'runtime/batch-plan.mjs',
    from: '    release: true,\n    why: `这一批没跑成',
    to: '    release: false,\n    why: `这一批没跑成',
    spec: 'runtime/batch-plan.test.mjs',
    expectTitle: '该不该释放：一律释放',
  },
  {
    name: '把店铺首屏改回 about:blank（用户：不要空页）',
    file: 'runtime/launch-plan.mjs',
    from: '          PROJECT_BROWSER_URL: labelPageUrlFor({ shop: entry.key, port: entry.browserPort }),',
    to: "          PROJECT_BROWSER_URL: 'about:blank',",
    spec: 'runtime/launch-plan.test.mjs',
    expectTitle: '店铺实例的首屏是它自己的标识页',
  },
  {
    name: '把登录守卫从批次里摘掉（它会退回「实例没起就查」→ 五家全 HTTP 500）',
    file: 'runtime/batch-plan.mjs',
    from: '    ...(loginStep ? [loginStep] : []),',
    to: '    ...(null ? [loginStep] : []),',
    spec: 'runtime/batch-plan.test.mjs',
    expectTitle: '登录守卫**排在每一批的 start 之后**',
  },
  {
    name: '把逐批产物名改成一个共用名字（后一批会盖掉前一批）',
    file: 'runtime/batch-plan.mjs',
    from: '  return `login-preflight-b${index}.json`;',
    to: "  return 'login-preflight.json';",
    spec: 'runtime/batch-plan.test.mjs',
    expectTitle: '登录结论的文件名逐批不同',
  },
  // ---- 既有四条（仍然必须活着；标题若有改动要一起改）----
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
    name: '把版本号三处一致改坏（package.json 漂一格）',
    file: 'package.json',
    from: '"version": "1.2.0",',
    to: '"version": "1.2.1",',
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
  {
    name: '把「分批宿主逐批读本批结论」改坏（三批读同一份）',
    file: 'scripts/run-batches.mjs',
    from: '  const loginArtifactFor = (batch) => path.join(evidenceRoot, batchLoginArtifactName(batch.index));',
    to: "  const loginArtifactFor = () => path.join(evidenceRoot, 'login-preflight.json');",
    spec: 'runtime/daily-job-plan.test.mjs',
    expectTitle: '宿主（分批链）也接上了',
  },
];

const results = [];
for (const mutation of MUTATIONS) {
  const full = path.join(REPO, mutation.file);
  const before = sha(full);
  const original = fs.readFileSync(full, 'utf8');
  if (!original.includes(mutation.from)) {
    results.push({ name: mutation.name, verdict: '无法执行', detail: `源码里找不到要替换的片段：${mutation.from.slice(0, 70)}` });
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
  if (row.detail) console.log(`      ${row.detail}`);
}
console.log(`\n明细：${path.relative(REPO, outPath)}`);
