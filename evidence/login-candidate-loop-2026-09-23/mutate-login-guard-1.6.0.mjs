// 突变验证（2026-09-23 晚，随 1.6.0 一起交付）：把本轮新增的每条判据改坏，
// 确认用例真的红、而且**点到期望的那一条**，然后逐字节还原并用 sha256 自证。
//
// 为什么必须做：函数级用例全绿只说明「判据本身对」，不说明「外面真的照它做了」——
// 本轮最大的一个风险正是那种「守卫装了、也调了，就是没人照它改道」的空转。
// 所以这里连**接线**（IO 层 login-merchant.mjs）也一起突变。
//
// 跑法（必须在仓库根跑，因为 FILES/TEST 是仓库根相对路径）：
//   node evidence/login-candidate-loop-2026-09-23/mutate-login-guard-1.6.0.mjs
// 产物：本目录下的 mutation-report.txt（**写在脚本自己旁边**，不写进仓库根的 tmp/）。
//
// 2026-09-23 晚从 `tmp/` 搬进来时改了两处，两处都是「复制进证据目录就会失效」的经典坑：
//   ① 原版把报告写到 `tmp/mutate-login-guard-0923.txt`（依赖仓库根有个 tmp/ 目录，
//      而 `tmp/` 不在交付物里）⇒ 改成相对**脚本自身位置**算路径。
//   ② 原版有一条 M7 被标 `skip`（想验「候选表只剩一条」，但改法只改了 id、改不坏任何判据，
//      等于一条没有判据的突变）⇒ 换成真能改坏的那种：把第二条候选整段删掉。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');            // evidence/<批次>/ → 仓库根
const REPORT = path.join(HERE, 'mutation-report.txt');

const TEST = 'skills/sycm-alimama-daily-report/scripts/login-merchant-core.test.mjs';
const FILES = {
  io: 'skills/sycm-alimama-daily-report/scripts/login-merchant.mjs',
  core: 'skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs',
};

const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pristine = {};
for (const [key, p] of Object.entries(FILES)) {
  pristine[key] = { path: path.join(ROOT, p), sha: sha(path.join(ROOT, p)), text: fs.readFileSync(path.join(ROOT, p), 'utf8') };
}

function runTest() {
  const r = spawnSync(process.execPath, ['--test', TEST], { encoding: 'utf8', cwd: ROOT, timeout: 180000 });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const names = [...out.matchAll(/^not ok \d+ - (.+)$/gmu)].map((m) => m[1]);
  const counts = /# pass (\d+)\n# fail (\d+)/u.exec(out);
  return { pass: Number(counts?.[1] ?? -1), fail: Number(counts?.[2] ?? -1), names, raw: out };
}

const MUTANTS = [
  {
    name: 'M1 IO：身份守卫判出「填的是别人」却没人照它改道',
    file: 'io',
    from: "    if (guard === 'WRONG_ACCOUNT') { attempt.outcome = 'WRONG_ACCOUNT'; continue; }\n",
    to: '',
    expect: /主脚本真的接了候选循环与身份守卫/u,
  },
  {
    name: 'M2 IO：候选都没成时，不把页签导回承诺的那一页',
    file: 'io',
    from: '    const parked = await parkTabOn(args, targetId, final.stoppedAt.url, state?.href ?? null);',
    to: '    const parked = { navigated: false, href: state?.href ?? null };',
    expect: /主脚本真的接了候选循环与身份守卫/u,
  },
  {
    name: 'M2b IO：不受 core 的判定管，一律导页面（连不该导的那两条也导）',
    file: 'io',
    from: '  if (final.parkOnLoginPage && final.stoppedAt?.url) {',
    to: '  if (final.stoppedAt?.url) {',
    expect: /主脚本真的接了候选循环与身份守卫/u,
  },
  {
    name: 'M2c IO：导的不是判定选中的那一页（回到「循环结束时碰巧停的那页」）',
    file: 'io',
    from: '    const parked = await parkTabOn(args, targetId, final.stoppedAt.url, state?.href ?? null);',
    to: '    const parked = await parkTabOn(args, targetId, state?.href ?? null, state?.href ?? null);',
    expect: /主脚本真的接了候选循环与身份守卫/u,
  },
  {
    name: 'M3 IO：主脚本又拿单条固定地址当流程',
    file: 'io',
    from: '  for (const candidate of LOGIN_URL_CANDIDATES) {',
    to: "  for (const candidate of [{ id: 'x', url: TAOBAO_LOGIN_URL }]) {",
    expect: /主脚本真的接了候选循环与身份守卫/u,
  },
  {
    name: 'M4 core：优先级表把 NO_FORM 排到最前（人会被引到最贵的那个动作上）',
    file: 'core',
    from: "  'WRONG_ACCOUNT', 'DETOUR', 'NO_VALUE_LANDED', 'NO_AUTOFILL', 'NO_FORM',",
    to: "  'NO_FORM', 'DETOUR', 'NO_VALUE_LANDED', 'NO_AUTOFILL', 'WRONG_ACCOUNT',",
    expect: /finalLoginVerdict：五选一的优先级/u,
  },
  {
    name: 'M5 core：身份守卫一律放行',
    file: 'core',
    from: "  return text === expected ? 'ACCEPT' : 'WRONG_ACCOUNT';",
    to: "  return 'ACCEPT';",
    expect: /身份守卫：填进来的账号必须与这家店登记的会员名逐字相同/u,
  },
  {
    name: 'M6 core：isTaobaoLoginUrl 退回子串判据（旧写法，靠巧合才对）',
    file: 'core',
    from: '  if (!TAOBAO_LOGIN_HOSTS.includes(url.host)) return false;',
    to: '  if (!/login\\.taobao\\.com\\/.*login/u.test(text)) return false;',
    expect: /isTaobaoLoginUrl：按 URL 结构判/u,
  },
  {
    name: 'M7 core：候选表只剩一条（就回到「必然有机器填不上」的形态）',
    file: 'core',
    from: "  Object.freeze({\n    id: 'member-login',\n    url: 'https://login.taobao.com/member/login.jhtml',\n  }),\n",
    to: '',
    expect: /候选地址表：第一条必须是实测命中率最高的那条/u,
  },
];

const lines = [];
lines.push(`原始 sha256：io=${pristine.io.sha.slice(0, 12)} core=${pristine.core.sha.slice(0, 12)}`);
const baseline = runTest();
lines.push(`基线（未突变）：pass=${baseline.pass} fail=${baseline.fail}`);
if (baseline.fail !== 0) {
  lines.push('!! 基线就是红的 —— 突变验证没有意义，先修基线');
  fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8');
  process.exit(1);
}

let allGood = true;
for (const m of MUTANTS) {
  const target = pristine[m.file];
  if (!target.text.includes(m.from)) {
    lines.push(`\n${m.name}\n  !! 找不到要改的那段文本 ⇒ 这条突变没有真的发生（判据无效）`);
    allGood = false;
    continue;
  }
  fs.writeFileSync(target.path, target.text.replace(m.from, m.to), 'utf8');
  const r = runTest();
  fs.writeFileSync(target.path, target.text, 'utf8');   // 立刻还原
  const restored = sha(target.path) === target.sha;
  const named = m.expect ? r.names.some((n) => m.expect.test(n)) : null;
  const ok = r.fail > 0 && named === true && restored;
  if (!ok) allGood = false;
  lines.push(`\n${m.name}`);
  lines.push(`  结果：pass=${r.pass} fail=${r.fail} 红的是：${r.names.join(' | ') || '（无）'}`);
  lines.push(`  期望点到：${m.expect} ⇒ ${named === null ? '未指定' : (named ? '命中' : '**没命中**')}`);
  lines.push(`  还原逐字节一致：${restored ? '是' : '**否**'}`);
  lines.push(`  判定：${ok ? 'OK' : '**不合格**'}`);
}

lines.push('\n── 全部还原后的 sha256 ──');
for (const [key, p] of Object.entries(FILES)) {
  const now = sha(path.join(ROOT, p));
  lines.push(`${key}: ${now === pristine[key].sha ? '逐字节一致' : '**变了**'} (${now.slice(0, 12)})`);
}
lines.push(allGood
  ? `\n总结论：${MUTANTS.length} 条突变全部被点到名的用例抓住，且全部逐字节还原。`
  : '\n总结论：**有突变没被抓住** —— 见上面标 ** 的行。');
fs.writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8');
console.log(lines.join('\n'));
