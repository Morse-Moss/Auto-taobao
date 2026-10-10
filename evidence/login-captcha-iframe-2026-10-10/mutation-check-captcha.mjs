// 突变验证（1.7.17 · 滑块判据能不能被测试抓住）—— 从**任意目录**都能跑。
//
// 它做的事：把 `login-merchant-core.mjs` 里那两处修复分别改坏一次，跑该 skill 的离线用例，
// 确认①退出码非 0、②红的正是**期望的那条**用例；跑完按 sha256 还原原文件。
// 为什么必须做：判据写完就报「绿灯」时，「这条用例真的能红吗」是没有证据的 ——
// 而这条判据静默失效的症状，恰恰是「平台明明要滑块，脚本说是密码不对」。
//
// 用法（在仓库根）：node evidence/login-captcha-iframe-2026-10-10/mutation-check-captcha.mjs
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 本文件在 evidence/<批次>/ 下 ⇒ 仓库根是上两级。**不写死盘符路径**（换机器/换目录都要能跑）。
const REPO = path.resolve(import.meta.dirname, '..', '..');
const SKILL = path.join(REPO, 'skills', 'sycm-alimama-daily-report');
const CORE = path.join(SKILL, 'scripts', 'login-merchant-core.mjs');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const original = fs.readFileSync(CORE, 'utf8');
const before = sha(original);
console.log(`仓库根：${REPO}`);
console.log(`原文件 sha=${before}  ${Buffer.byteLength(original, 'utf8')} B`);

const MUTATIONS = [
  {
    name: 'M1 把 iframe 滑块信号去掉（sliderVisible 只认顶层）',
    from: 'sliderVisible: top.slider || sliderInFrame,',
    to: 'sliderVisible: top.slider,',
    expect: ['同源 iframe 内部的滑块必须被认出来'],
  },
  {
    name: 'M2 把「读不到的验证类 iframe」线索去掉',
    from: '        captchaFrame = { src: src.slice(0, 160), title: title.slice(0, 60) };',
    to: '        // mutated: 线索被删',
    expect: ['读不到内容的 iframe，地址/标题像风控页'],
  },
];

let allOk = true;
let restored = false;
try {
  for (const m of MUTATIONS) {
    if (!original.includes(m.from)) { console.error(`[突变 ${m.name}] 找不到锚点 —— 判据/源码已漂移，需更新本脚本`); allOk = false; continue; }
    fs.writeFileSync(CORE, original.replace(m.from, m.to), 'utf8');
    // 从仓库根跑：这个 skill 的用例里有 `fs.readFile('./skills/…')` 的相对路径读法。
    const r = spawnSync(process.execPath, ['--test', 'skills/sycm-alimama-daily-report/scripts/login-merchant-core.test.mjs'], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gmu)].map((x) => x[1].trim());
    const named = m.expect.every((e) => failed.some((f) => f.includes(e)));
    const isRed = r.status !== 0;
    console.log(`\n[${m.name}] 退出码=${r.status} 判红=${isRed} 挂掉 ${failed.length} 条：`);
    for (const f of failed) console.log('   ✗ ' + f);
    console.log(`   期望用例被点名：${named ? 'YES ✅' : 'NO ❌'}`);
    if (!isRed || !named) allOk = false;
  }
} finally {
  fs.writeFileSync(CORE, original, 'utf8');
  const after = sha(fs.readFileSync(CORE, 'utf8'));
  restored = after === before;
  console.log(`\n还原后 sha=${after}  ${restored ? '与原来一致 ✅' : '不一致 ❌ 请立刻 git checkout 该文件'}`);
  if (!restored) process.exitCode = 2;
}

console.log(`\n突变验证结论：${allOk && restored ? '两条突变都被测试抓住 ✅' : '有突变没被抓住 ❌'}`);
