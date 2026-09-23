// 突变验证：「跑前登录态结论进告警」这条修复的判据到底守没守住。
//
// 为什么必须做（本仓库的老账）：**函数级用例全绿 ≠ 接线接上了**。2026-09-21 就是这么漏的 ——
// `buildRoundFailureAlert` 自己的用例全过，而两个调用点漏传 `shopKeys`，于是
// 「另外 N 家今天一步都没跑」那一行静默消失。所以这里把每一处关键接线**逐个改坏**，
// 确认判据真的红、而且红的**正是期望的那一条**（「红了但红错了地方」等于没有判据）。
//
// 手法：改真源文件 → 跑那一条用例文件 → 收 TAP 里 `not ok` 的行 → 比对期望的用例名 →
// 立刻还原 → 用 sha256 自证还原是逐字节的。
//
// 跑法（**在仓库根**）：node evidence/login-preflight-2026-09-23/run-mutations.mjs
// 产物：mutation-report.json ＋ mutation-report.txt（同一份结论的两种形态）
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 本脚本住在 evidence/<批次>/ 下（深度 2），所以仓库根是上两级。
// ⚠️ 刻意不用 `process.cwd()`：复制进证据目录之后 cwd 会变成别的地方，
// 那条「按自身位置算路径」的坑这个仓库已经踩过一次（见 skills/evidence-copy-must-be-runnable）。
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const NODE = process.execPath;
const DRIVER = 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';
const DRIVER_TEST = 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs';
const PLAN_TEST = 'runtime/daily-job-plan.test.mjs';

const MUTATIONS = [
  {
    id: 'M1',
    what: '链的两个告警调用点漏传 loginPreflight（＝这条修复整个不生效）',
    file: DRIVER,
    from: ', shopKeys: shops, loginPreflight }),',
    to: ', shopKeys: shops }),',
    all: true,
    test: DRIVER_TEST,
    expect: '每个生成告警的调用点都真的把 shopKeys 与登录态结论接上了',
  },
  {
    id: 'M2',
    what: '把 `null`（没查）当成一个普通入参 —— 返回对象多出一个 login 键',
    file: DRIVER,
    from: '  if (loginPreflight === null || loginPreflight === undefined) return view;',
    to: '  if (false) return view; // mutated',
    test: DRIVER_TEST,
    expect: '不给登录态结论时，roundFailureSummary 的输出**逐字不变**',
  },
  {
    id: 'M3',
    what: '掉登录的店没有被改判成 NEEDS_LOGIN（店里那一层的告警又回到「去补页面」）',
    file: DRIVER,
    from: "  const causeOf = (item) => (loginShops.has(item.key) ? 'NEEDS_LOGIN' : item.cause);",
    to: '  const causeOf = (item) => item.cause; // mutated',
    test: DRIVER_TEST,
    // 两层的判据都写进来：M3 只影响「店里」那一层，但整轮那一层的判据也不该因此变红。
    expect: [
      '告警：这一家是「页面不齐」判下来的、而它的登录掉了',
      '告警：查过登录态、有店掉了 ⇒ 改成「去登录」，不再叫人去开页面',
    ],
  },
  {
    id: 'M4',
    what: '结论文件里的 `null`/数组被折成「没查」（「本来要查、结论丢了」就此消失）',
    file: DRIVER,
    from: "    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('结论不是一个对象');",
    to: '    // mutated: 不再把「不是对象」算成读不到',
    test: DRIVER_TEST,
    expect: '跑前登录态结论的读取：不给＝没查、读不到＝没结论、读到＝只留业务能用的字段',
  },
  {
    id: 'M5',
    what: '登录态结论没有按本轮的店筛（分批时会点名跟这次无关的店）',
    file: DRIVER,
    from: '  const needLogin = (view.login?.needHuman ?? []).filter(inRound);',
    to: '  const needLogin = (view.login?.needHuman ?? []); // mutated',
    test: DRIVER_TEST,
    expect: '登录态结论只留本轮要跑的那几家',
  },
  {
    id: 'M6',
    what: '定时宿主没把本轮证据目录交给计划（链永远读不到结论）',
    file: 'scripts/run-daily-job.mjs',
    from: '      artifactsDir: jobDir,',
    to: '      artifactsDir: null, // mutated',
    test: PLAN_TEST,
    expect: '宿主（定时链）真的把结论接上了',
  },
  {
    id: 'M7',
    what: '体检那一步不再出 JSON（没有结论可以交，链读一个永远不存在的路径）',
    file: 'runtime/daily-job-plan.mjs',
    from: '        args: buildLoginPreflightArgs({ shops, json: Boolean(loginPreflightFile) }),',
    to: '        args: buildLoginPreflightArgs({ shops, json: false }), // mutated',
    test: PLAN_TEST,
    expect: '跑前登录态结论真的交给链了',
  },
  {
    id: 'M8',
    what: '分批宿主没把结论转给每一批的链',
    file: 'scripts/run-batches.mjs',
    from: '  const chainArgs = [...chainArgsFor(options), LOGIN_PREFLIGHT_FLAG, loginPreflightPath];',
    to: '  const chainArgs = [...chainArgsFor(options)]; // mutated',
    test: PLAN_TEST,
    expect: '宿主（分批链）也接上了',
  },
  {
    id: 'M9',
    what: '「这一轮没有先查登录态」那句不承诺的话被删掉（没查过时装作无话可说）',
    file: DRIVER,
    from: '（这一轮没有先查登录态：',
    to: '（',
    test: DRIVER_TEST,
    expect: '没查过登录态 ⇒ 如实说「没查过」',
  },
];

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const runTest = (relFile) => {
  const result = spawnSync(NODE, ['--test', path.join(REPO_ROOT, relFile)],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { status: result.status ?? -1, out };
};

const rows = [];
let bad = 0;

for (const m of MUTATIONS) {
  const abs = path.join(REPO_ROOT, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  const occurrences = original.split(m.from).length - 1;
  if (occurrences === 0) {
    rows.push({ id: m.id, what: m.what, verdict: '找不到要改的那一行（脚本与源码漂了）', occurrences: 0 });
    bad += 1;
    continue;
  }
  if (!m.all && occurrences > 1) {
    rows.push({ id: m.id, what: m.what, verdict: `要改的那一行出现了 ${occurrences} 次，改不唯一`, occurrences });
    bad += 1;
    continue;
  }
  const mutated = m.all ? original.split(m.from).join(m.to) : original.replace(m.from, m.to);
  fs.writeFileSync(abs, mutated, 'utf8');
  let verdict;
  try {
    const { status, out } = runTest(m.test);
    const failed = out.split('\n').filter((line) => line.startsWith('not ok ')).map((line) => line.trim());
    const expects = Array.isArray(m.expect) ? m.expect : [m.expect];
    const hit = failed.find((line) => expects.some((name) => line.includes(name)));
    if (failed.length === 0) {
      verdict = `**红了没红**（退出码 ${status}，却一条失败用例都没有）—— 判据形同虚设`;
      bad += 1;
    } else if (!hit) {
      verdict = `红了但**红错了地方**：${failed.join(' / ')}`;
      bad += 1;
    } else {
      verdict = `红在期望的那一条：${hit}`;
    }
  } finally {
    fs.writeFileSync(abs, original, 'utf8');
  }
  const restored = fs.readFileSync(abs, 'utf8');
  if (sha256(restored) !== sha256(original)) {
    verdict = `${verdict}；⚠️ 还原后 sha256 不一致（源码没回到原样！）`;
    bad += 1;
  }
  rows.push({ id: m.id, what: m.what, file: m.file, occurrences, verdict, sha256: sha256(original).slice(0, 16) });
  console.log(`${m.id} ${verdict}`);
}

const summary = {
  at: new Date().toISOString(),
  repoRoot: REPO_ROOT,
  node: process.version,
  total: rows.length,
  unexpected: bad,
  rows,
};
fs.writeFileSync(path.join(import.meta.dirname, 'mutation-report.json'), `${JSON.stringify(summary, null, 1)}\n`, 'utf8');
const text = [
  '突变验证：跑前登录态结论 → 告警（2026-09-23）',
  '',
  '每一行的意思：把那一处接线改坏之后，期望的那条用例**真的红了**吗。',
  '全部「红在期望的那一条」才算判据有效；「红了没红」与「红错地方」都算失败。',
  '',
  ...rows.map((r) => `${r.id}  ${r.verdict}\n     改动：${r.what}${r.file ? `\n     文件：${r.file}` : ''}`),
  '',
  `合计 ${rows.length} 处突变，异常 ${bad} 处。`,
].join('\n');
fs.writeFileSync(path.join(import.meta.dirname, 'mutation-report.txt'), `${text}\n`, 'utf8');
console.log(text);
process.exitCode = bad === 0 ? 0 : 1;
