#!/usr/bin/env node

/**
 * 突变验证（2026-10-06 批次：㉔ 协议闸门 + ㉕ 源表无日期行分类）。
 *
 * 为什么必须跑这一步：本仓反复吃过的亏是「判据写完了、用例全绿，但那一条判据根本没接上」
 * （改坏源码却不红 ⇒ 那条用例是摆设）。所以对**每一处**改动都做一次「改坏 → 看它是否
 * 点名地红 → 原样还原（sha256 逐字节核对）」。
 *
 * 用法（仓库根）：node evidence/fix-agreement-inquiry-2026-10-06/mutation-verify.mjs
 * 退出码：0＝每一处都如期红且都还原成功；1＝有没如期红或没还原干净的。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL_DIR = path.join(REPO, 'skills', 'sycm-alimama-daily-report');
const SKILL_SCRIPTS = path.join(SKILL_DIR, 'scripts');

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * 每一条：把 `from` 换成 `to`（必须命中**恰好一次**），跑 `tester`，
 * 期望 `expect` 出现在 TAP 的某条 `not ok` 里。
 */
const MUTATIONS = [
  {
    id: 'M1 · ㉔ 协议闸门被摘掉（协议没勾上照样提交）',
    file: path.join(SKILL_SCRIPTS, 'login-merchant.mjs'),
    from: "if (agreementVerdict === 'CLICKED_BUT_STILL_UNCHECKED' || agreementVerdict === 'NOT_CLICKABLE') {",
    to: 'if (false) {',
    tester: path.join(SKILL_SCRIPTS, 'login-merchant-core.test.mjs'),
    cwd: SKILL_DIR,
    expect: '协议没勾上时**不许提交**',
  },
  {
    id: '㉔ 回执又写死 autoAccepted:true（假凭据）',
    file: path.join(SKILL_SCRIPTS, 'login-merchant.mjs'),
    from: 'autoAccepted: agreementOk,',
    to: 'autoAccepted: true,',
    tester: path.join(SKILL_SCRIPTS, 'login-merchant-core.test.mjs'),
    cwd: SKILL_DIR,
    expect: '协议没勾上时**不许提交**',
  },
  {
    id: '㉔ 主脚本不再问 core「协议勾上了没有」',
    file: path.join(SKILL_SCRIPTS, 'login-merchant.mjs'),
    from: 'const agreementOk = agreementSatisfied(agreementVerdict);',
    to: 'const agreementOk = true;',
    tester: path.join(SKILL_SCRIPTS, 'login-merchant-core.test.mjs'),
    cwd: SKILL_DIR,
    expect: '协议没勾上时**不许提交**',
  },
  {
    id: '㉔ 删除 AGREEMENT_REQUIRED 的「下一步」文案',
    file: path.join(SKILL_SCRIPTS, 'login-merchant-core.mjs'),
    from: "  AGREEMENT_REQUIRED: '登录页已经开在{窗口}了，账号密码也替你已经填好。'",
    to: "  AGREEMENT_REQUIRED_X: '登录页已经开在{窗口}了，账号密码也替你已经填好。'",
    tester: path.join(SKILL_SCRIPTS, 'login-merchant-core.test.mjs'),
    cwd: SKILL_DIR,
    expect: '「下一步」必须能定位到哪一个窗口',
  },
  {
    id: '㉔ 删除 AGREEMENT_REQUIRED 的「原因」文案',
    file: path.join(SKILL_SCRIPTS, 'login-merchant-core.mjs'),
    from: "  AGREEMENT_REQUIRED: '登录页上「已阅读并同意以下协议」那一行没有被勾上，系统就没有替你提交。',",
    to: '',
    tester: path.join(SKILL_SCRIPTS, 'login-merchant-core.test.mjs'),
    cwd: SKILL_DIR,
    expect: '每个「要叫人」的结论都必须有自己的原因和下一步',
  },
  {
    id: '㉕ 分类器不再认「源表无日期行」标记',
    file: path.join(SKILL_SCRIPTS, 'run-multi-shop-day.mjs'),
    from: "  if (String(r.failureOutput ?? '').includes(SOURCE_NO_ROW_FOR_DATE_TOKEN)) return 'SOURCE_NO_ROW_FOR_DATE';",
    to: '',
    tester: path.join(SKILL_SCRIPTS, 'run-multi-shop-day.test.mjs'),
    cwd: SKILL_DIR,
    expect: 'SOURCE_NO_ROW_FOR_DATE 的判据是那个**机器标记**',
  },
  {
    id: '㉕ 修复请求单不再标「不用任何人处理」',
    file: path.join(SKILL_SCRIPTS, 'run-multi-shop-day.mjs'),
    from: "    noActionRequired: lookupRemediation(cause).notifyLevel === 'silent',",
    to: '    noActionRequired: false,',
    tester: path.join(SKILL_SCRIPTS, 'run-multi-shop-day.test.mjs'),
    cwd: SKILL_DIR,
    expect: '不需任何人处理的成因必须自己说出来',
  },
  {
    id: '㉕ 驻留判据不再跳过「谁都不用动」的失败',
    file: path.join(REPO, 'runtime', 'hold-and-resume-plan.mjs'),
    from: '    if (record.repairRequest?.noActionRequired === true) continue;\n',
    to: '',
    tester: path.join(REPO, 'runtime', 'hold-and-resume-plan.test.mjs'),
    cwd: REPO,
    expect: '谁都不用动」的失败不进这一路',
  },
  {
    id: '㉕ 分诊表把「平台无此行」改成要人处理',
    file: path.join(SKILL_SCRIPTS, 'remediation-table.mjs'),
    from: "    notifyLevel: 'silent',\n    why: '平台这一天就没有出这一行",
    to: "    notifyLevel: 'human',\n    why: '平台这一天就没有出这一行",
    tester: path.join(SKILL_SCRIPTS, 'remediation-table.test.mjs'),
    cwd: SKILL_DIR,
    expect: '平台无此行那条也是 silent',
  },
  {
    id: '㉕ 空态与结构异常又共用一句话',
    file: path.join(SKILL_SCRIPTS, 'inquiry-core.mjs'),
    from: `  if (count === 0) {
    return \`\${SOURCE_NO_ROW_FOR_DATE_TOKEN} 这一天的源表里没有日期行\`
      + \`（生意参谋「询单到付款」对该店该日返回的是空态，不是读不到）｜\${facts}\`;
  }
`,
    to: '',
    tester: path.join(SKILL_SCRIPTS, 'inquiry-core.test.mjs'),
    cwd: SKILL_DIR,
    expect: '空态（0 个日期行）单列一类',
  },
  {
    id: '㉕ 错误里不再带现场值（日期列原值/行数）',
    file: path.join(SKILL_SCRIPTS, 'inquiry-core.mjs'),
    from: '  const facts = `日期列原值=${JSON.stringify(observed)}｜日期行数=${count}｜期望=${reportDate}`;',
    to: '  const facts = `日期行数=${count}`;',
    tester: path.join(SKILL_SCRIPTS, 'inquiry-core.test.mjs'),
    cwd: SKILL_DIR,
    expect: '空态（0 个日期行）单列一类',
  },
];

const reds = (stdout) => [...stdout.matchAll(/^not ok \d+ - (.+)$/gmu)].map((m) => m[1].trim());

let failures = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  const before = sha(original);
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(`✗ ${m.id}\n    突变锚点在源码里命中 ${hits} 次（要求恰好 1 次）—— 判据没接上源码，本次突变无效`);
    failures += 1;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to), 'utf8');
  // `stdio` 第 0 位必须是 `ignore`：本机宿主沙箱下给子进程接 stdin 管道会 EBUSY。
  const run = spawnSync(process.execPath, ['--test', path.relative(m.cwd, m.tester)], {
    cwd: m.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const list = reds(run.stdout ?? '');
  writeFileSync(m.file, original, 'utf8');
  const after = sha(readFileSync(m.file, 'utf8'));
  const restored = after === before;
  const hit = list.some((name) => name.includes(m.expect));
  const verdict = hit && restored ? '✓' : '✗';
  if (verdict === '✗') failures += 1;
  console.log(`${verdict} ${m.id}`);
  console.log(`    期望红：${m.expect}`);
  console.log(`    实际红：${list.length ? list.join(' ｜ ') : '(一条都没红 —— 这条判据是摆设)'}`);
  console.log(`    还原：${restored ? `sha256 一致（${before}）` : `**不一致** ${before} → ${after}`}`);
}

console.log(`\n${failures === 0 ? '全部如期变红且全部还原' : `有 ${failures} 处没达到要求`}`);
process.exitCode = failures === 0 ? 0 : 1;
