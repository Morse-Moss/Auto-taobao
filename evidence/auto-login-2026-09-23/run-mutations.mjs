// 突变验证：把「自动登录接线」这条改动各处分别改坏一次，确认判据真的会红、且红在点名的那一条上。
//
// 为什么必须做：本仓库吃过三次「函数级用例全绿，但调用点根本没接上」的亏。
// 这一批改动里最危险的形态是**默认值**（`autoLogin` 开/关）与**两个宿主的接线** ——
// 它们错了都不会抛错，只会静默地少做一件事。
//
// 路径按脚本自身位置推导（`evidence/<批次>/` 上两级＝仓库根），不写死盘符：
// 复制到别的机器照样能跑。这是 `evidence-copy-must-be-runnable` 那条技能要求的。
//
// 用法：node evidence/auto-login-2026-09-23/run-mutations.mjs
// 产出：同目录 mutation-report.json / mutation-report.txt
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '..', '..');

const CORE = 'skills/sycm-alimama-daily-report/scripts/check-login-shops-core.mjs';
const CLI = 'skills/sycm-alimama-daily-report/scripts/check-login-shops.mjs';
const PLAN = 'runtime/daily-job-plan.mjs';
const HOST_JOB = 'scripts/run-daily-job.mjs';
const HOST_BATCH = 'scripts/run-batches.mjs';
const T_CORE = 'skills/sycm-alimama-daily-report/scripts/check-login-shops-core.test.mjs';
const T_PLAN = 'runtime/daily-job-plan.test.mjs';

const MUTATIONS = [
  {
    id: 'M1',
    file: CORE,
    what: '权威字段退回只看 `loggedIn`（丢掉 `loggedInAfter` 这一截）',
    find: 'receipt?.sites?.[key]?.loggedInAfter ?? receipt?.sites?.[key]?.loggedIn',
    repl: 'receipt?.sites?.[key]?.loggedIn',
    test: T_CORE,
    expect: /带 --login 时结论看的是/u,
  },
  {
    id: 'M2',
    file: CORE,
    what: '「自动登录没成的原因」不再受 autoLogin 约束（只读也印）',
    find: 'const why = autoLogin ? loginFailReason(rowOf(item.shop)?.scriptVerdict) : null;',
    repl: 'const why = loginFailReason(rowOf(item.shop)?.scriptVerdict);',
    test: T_CORE,
    expect: /autoLogin 只改措辞、不改判定/u,
  },
  {
    id: 'M3',
    file: CORE,
    what: '「这次自己登进去的」不再受 autoLogin 约束（成立条件被拿掉）',
    find: "    const autoFixed = autoLogin\n      ? rows.filter((row) => row.scriptVerdict === 'LOGGED_IN').map((row) => row.shop)\n      : [];",
    repl: "    const autoFixed = rows.filter((row) => row.scriptVerdict === 'LOGGED_IN').map((row) => row.shop);",
    test: T_CORE,
    expect: /成功那一轮要说清/u,
  },
  {
    id: 'M4',
    file: CORE,
    what: '`parseCheckShopsArgs` 不再认 `--login`（入口开关消失）',
    find: "    if (token === '--login') { opts.login = true; continue; }\n",
    repl: '',
    test: T_CORE,
    expect: /--login 默认关，给了才开/u,
  },
  {
    id: 'M5',
    file: CLI,
    what: '两种模式不再分叉（永远只读）——自动登录变成一次静默的空转',
    find: "        login ? '--commit' : '--check-only',",
    repl: "        '--check-only',",
    test: T_CORE,
    expect: /主脚本真的按/u,
  },
  {
    id: 'M6',
    file: CLI,
    what: '两店之间的静默期被改名（风控兜底那条消失）',
    find: 'LOGIN_GAP_MS',
    repl: 'LOGIN_GAP',
    replaceAll: true,
    test: T_CORE,
    expect: /主脚本真的按/u,
  },
  {
    id: 'M7',
    file: CLI,
    what: '带 `--login` 也走并行（并行登录＝风控加速器）',
    find: 'if (!opts.login) {',
    repl: 'if (true) {',
    test: T_CORE,
    expect: /主脚本真的按/u,
  },
  {
    id: 'M8',
    file: PLAN,
    what: '计划里那一步永远不带 `--login`（宿主打开、计划却关掉）',
    find: 'login: autoLogin }),',
    repl: 'login: false }),',
    test: T_PLAN,
    expect: /宿主（定时链）真的把结论接上了/u,
  },
  {
    id: 'M9',
    file: HOST_JOB,
    what: '`--no-auto-login` 不再生效（退回只读的开关变成一句空话）',
    find: 'options.autoLogin = false;',
    repl: 'options.autoLogin = true;',
    test: T_PLAN,
    expect: /--no-auto-login 退回只读体检/u,
  },
  {
    id: 'M10',
    file: HOST_BATCH,
    what: '分批驱动那一路不再自动登录（两个宿主口径分叉）',
    find: 'json: true, login: true })',
    repl: 'json: true, login: false })',
    test: T_PLAN,
    expect: /宿主（分批链）也接上了/u,
  },
];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const runTest = (rel) => {
  const r = spawnSync(process.execPath, ['--test', rel], { encoding: 'utf8', cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const failing = text
    .split('\n')
    .filter((line) => /^not ok \d+ - /u.test(line))
    .map((line) => line.replace(/^not ok \d+ - /u, '').trim());
  const pass = Number((text.match(/^# pass (\d+)/mu) || [])[1] ?? NaN);
  const fail = Number((text.match(/^# fail (\d+)/mu) || [])[1] ?? NaN);
  return { failing, pass, fail, exit: r.status, text };
};

const results = [];
let allOk = true;

for (const m of MUTATIONS) {
  const abs = path.join(REPO_ROOT, m.file);
  const before = fs.readFileSync(abs, 'utf8');
  const beforeSha = sha256(abs);
  const occurrences = before.split(m.find).length - 1;
  const wanted = m.replaceAll ? occurrences : 1;

  const record = {
    id: m.id, file: m.file, what: m.what, test: m.test,
    expect: String(m.expect), occurrences, applied: false,
  };

  if (occurrences !== wanted || occurrences === 0) {
    record.error = `目标片段出现 ${occurrences} 次（期望 ${wanted} 次）—— 未施加突变，判据与源码可能已经漂移`;
    allOk = false;
    results.push(record);
    continue;
  }

  fs.writeFileSync(abs, m.replaceAll ? before.split(m.find).join(m.repl) : before.replace(m.find, m.repl));
  record.applied = true;
  const mutatedSha = sha256(abs);
  record.mutationChangedBytes = mutatedSha !== beforeSha;

  const res = runTest(m.test);
  record.exit = res.exit;
  record.pass = res.pass;
  record.fail = res.fail;
  record.failing = res.failing;
  record.redOnExpected = res.failing.some((name) => m.expect.test(name));

  fs.writeFileSync(abs, before);
  record.restoredShaMatches = sha256(abs) === beforeSha;
  if (!record.restoredShaMatches) allOk = false;
  if (!record.redOnExpected) allOk = false;
  if (!record.mutationChangedBytes) allOk = false;

  results.push(record);
  const verdict = record.redOnExpected ? 'OK 红在点名的那条' : '!! 没红在点名的那条';
  console.log(`${m.id} ${verdict}  fail=${record.fail}  ${m.what}`);
  if (!record.redOnExpected) console.log('     实际红：' + JSON.stringify(record.failing, null, 0));
}

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot: REPO_ROOT,
  total: MUTATIONS.length,
  redOnExpected: results.filter((r) => r.redOnExpected).length,
  allRestoredByteIdentical: results.every((r) => r.restoredShaMatches !== false),
  allOk,
  results,
};
fs.writeFileSync(path.join(HERE, 'mutation-report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(HERE, 'mutation-report.txt'),
  results.map((r) => [
    `${r.id} ${r.redOnExpected ? 'OK' : 'FAIL'} ${r.file}`,
    `  what      : ${r.what}`,
    `  expect    : ${r.expect}`,
    `  test      : ${r.test}`,
    `  fail      : ${r.fail}  exit=${r.exit}`,
    `  实际红    : ${JSON.stringify(r.failing)}`,
    `  还原逐字节: ${r.restoredShaMatches}`,
    r.error ? `  ERROR     : ${r.error}` : null,
  ].filter(Boolean).join('\n')).join('\n\n')
  + `\n\n合计：${report.redOnExpected}/${report.total} 红在点名的那一条；全部还原后 sha256 逐字节一致＝${report.allRestoredByteIdentical}\n`);

console.log(`\n合计 ${report.redOnExpected}/${report.total}；还原一致=${report.allRestoredByteIdentical}；allOk=${allOk}`);
process.exit(allOk ? 0 : 1);
