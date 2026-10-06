// 突变验证（C 项：共用窗口标识页 + 告警去掉机器名与盘符路径）：把源码改坏，确认新判据真的会红、
// 且点名到期望的那条断言，然后逐字节还原。
//
// C 项由两半组成，两个半都有「会被静默改回去」的点：
//
// 一半是**共用窗口也要有名字**（用户原话：「那个标识页我就特意设计了，让用户知道是哪个窗口」）：
//   M1 共用窗口的标题写成某家店的名字 —— 正是「把标签贴错窗口」，窗口上看起来完全正常；
//   M2 共用窗口的 URL 不再带 `shared=1` —— 页面仍按「某家店」渲染（那一档整段失效）；
//   M3 `--only` 与 `--subject` 不再互斥 —— 同时给必然有一个被静默忽略，只会挂错窗口；
//   M4 页面不认 `shared` —— 标识页从此分不出「共用窗口」与「店窗口」；
//   M8 计划里那一步丢掉 `--subject merchant` —— 步骤还在（日志里看不出少了什么），但没有目标。
//
// 另一半是**告警只给业务人员看**（用户原话：「一堆专业术语，你让业务人员怎么处理」）：
//   M5 形状判据（assertBusinessReadable）被短路 —— 「以后又有人把技术串加回来」无人拦；
//   M6 `buildLoginAlert` 的 source 又带上机器名 —— 渲染出来就是「机器：DESKTOP-…」；
//   M7 `resolveAction` 回落到「那台电脑」—— 那句话在告警里没有落点，收信人还得自己猜。
//
// 「点名期望串」的取法有两类，按被测断言的形状选：
//   · `assert.match` / `assert.equal` 的红：期望串取**断言消息**里的原话（最精确）；
//   · `assert.throws` 的红：Node 对「没抛出」给的默认消息里不含断言消息，
//     所以取**用例名**（它一定出现在 TAP 的 `not ok N - <名>` 行）。M3/M5 属于这一类。
//
// 本脚本**会改写源码**，所以：不要与别的测试/采集同时跑；每条跑完用 sha256 自证还原。
// 自己向上找仓库根（VERSION + package.json 同时在哪就是哪）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function findRepoRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('找不到仓库根：一路向上都没有 VERSION + package.json');
    dir = parent;
  }
}

const ROOT = findRepoRoot(import.meta.dirname);
const FILES = {
  label: 'runtime/shop-window-label.mjs',
  html: 'runtime/shop-window-label.html',
  jobPlan: 'runtime/daily-job-plan.mjs',
  core: 'skills/sycm-alimama-daily-report/scripts/login-merchant-core.mjs',
};
const TESTS = [
  'runtime/shop-window-label.test.mjs',
  'runtime/daily-job-plan.test.mjs',
  'skills/sycm-alimama-daily-report/scripts/login-merchant-core.test.mjs',
];

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const originals = Object.fromEntries(Object.entries(FILES)
  .map(([key, rel]) => [key, fs.readFileSync(path.join(ROOT, rel), 'utf8')]));
const originalShas = Object.fromEntries(Object.entries(originals).map(([k, v]) => [k, sha(v)]));

const MUTATIONS = [
  {
    id: 'M1 共用窗口的标题写成某家店的名字',
    file: 'label',
    from: "    displayName: '商家浏览器（日报共用）',",
    to: "    displayName: '里可林淘宝',",
    expect: '共用窗口的标题里出现了店名',
  },
  {
    id: 'M2 共用窗口的 URL 不再带 shared=1',
    file: 'label',
    from: "  if (shared === true) query.set('shared', '1');\n",
    to: '',
    expect: '页面里读了 ?shared= 但脚本从不写它',
  },
  {
    id: 'M3 --only 与 --subject 不再互斥（同时给就静默忽略一个）',
    file: 'label',
    from: `  if (opts.subject !== null && opts.only !== null) {
    throw new Error('--only 与 --subject 互斥：一个命令只挂一个窗口（店铺实例用 --only，共用实例用 --subject）');
  }
`,
    to: '',
    expect: '--subject 与 --only 互斥',
  },
  {
    id: 'M4 标识页不认 shared（共用窗口被渲染成「某家店」）',
    file: 'html',
    from: "  const shared = q.get('shared') === '1';",
    to: '  const shared = false;',
    expect: '页面没有读 shared',
  },
  {
    id: 'M5 形状判据被短路（技术串加回来也无人拦）',
    file: 'core',
    from: '  if (seen.length) {',
    to: '  if (false) {',
    expect: '形状判据：技术串一旦被加回告警',
  },
  {
    id: 'M6 告警的 source 又带上机器名',
    file: 'core',
    from: `      targetLabel: labels.join(' / ') || null,
      shopName,`,
    to: `      targetLabel: labels.join(' / ') || null,
      shopName,
      machine: 'DESKTOP-KJP4RA5',`,
    expect: '给技术同学看的字段',
  },
  {
    id: 'M7 resolveAction 回落到「那台电脑」（告警里没有落点）',
    file: 'core',
    from: '  const where = `标题写着「${shopName ?? SHARED_WINDOW_NAME}」的那个浏览器窗口（任务栏里就能看到）`;',
    to: "  const where = '那台电脑的浏览器窗口';",
    expect: '没承诺「登录页已经开好」',
  },
  {
    id: 'M8 计划里那一步丢掉 --subject merchant（还在，但没有目标）',
    file: 'jobPlan',
    from: "      args: ['--commit', '--front', '--subject', 'merchant'],",
    to: "      args: ['--commit', '--front'],",
    expect: '共用窗口标识页',
  },
];

// 注意：stdio 必须显式写成 ['ignore','pipe','pipe']。
// 写成 'pipe'（= ['pipe','pipe','pipe']）会让 stdin 也成为管道，本机沙箱下 spawnSync 必抛 EBUSY
// —— 后果是测试根本没启动，catch 把「没跑起来」当成「测试红了」，突变验证会变成空转假绿。
// （本仓 `run-multi-shop-day.test.mjs` 自己就有守卫在断言这条 stdio 形状。）
const runTests = () => {
  try {
    const out = execFileSync(process.execPath, ['--test', ...TESTS], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

const restoreAll = () => {
  for (const [key, rel] of Object.entries(FILES)) fs.writeFileSync(path.join(ROOT, rel), originals[key], 'utf8');
};

let allCaught = true;
for (const m of MUTATIONS) {
  const rel = FILES[m.file];
  const target = path.join(ROOT, rel);
  if (!originals[m.file].includes(m.from)) {
    console.log(`[${m.id}] 找不到锚点 ⇒ 判据没建立：${JSON.stringify(m.from)}`);
    allCaught = false;
    continue;
  }
  let mutated = originals[m.file].replace(m.from, m.to);
  for (const extra of m.also ?? []) {
    if (!mutated.includes(extra.from)) {
      console.log(`[${m.id}] 附加锚点找不到 ⇒ 判据没建立：${JSON.stringify(extra.from)}`);
      allCaught = false;
    }
    mutated = mutated.replace(extra.from, extra.to);
  }
  if (sha(mutated) === sha(originals[m.file])) {
    console.log(`[${m.id}] 改完与原文逐字节相同 ⇒ 这条突变是空的，验证无效`);
    allCaught = false;
    continue;
  }
  fs.writeFileSync(target, mutated, 'utf8');
  const result = runTests();
  const named = result.out.includes(m.expect);
  // 红＝TAP 汇总里真的出现失败计数，而不是「子进程没启动」。
  const red = !result.ok && /# fail [1-9]/.test(result.out);
  const launched = /# tests \d+/.test(result.out);
  console.log(`[${m.id}] 红=${red} 点名期望串=${named} 期望串=${JSON.stringify(m.expect)}`);
  if (!launched) {
    allCaught = false;
    console.log('    ！！测试进程没跑起来（输出里没有 TAP 汇总）—— 本次验证无效：'
      + JSON.stringify(result.out.slice(0, 200)));
  } else if (!red || !named) {
    allCaught = false;
    const lines = result.out.split('\n').filter((l) => /^not ok|error:/.test(l)).slice(0, 8);
    console.log('    未达标，输出片段：\n      ' + lines.join('\n      '));
  } else {
    // 抓到之后顺手记下「红了几条」，方便判断是不是**只有**期望的那条在红
    // （全红往往意味着我把源码改到语法都坏了，那种红没有证明力）。
    const fails = (result.out.match(/^not ok /gmu) ?? []).length;
    console.log(`    命中；本次红 ${fails} 条（期望串出现在其中一条里）`);
  }
  restoreAll();
}

restoreAll();
const restoredOk = Object.entries(FILES).every(([key, rel]) => sha(fs.readFileSync(path.join(ROOT, rel), 'utf8')) === originalShas[key]);
const finalRun = runTests();
console.log(`还原：sha256 ${restoredOk ? '全部一致' : '不一致！！'}`);
console.log(`突变 ${allCaught ? '全部被抓住' : '有漏网'}；最终 `
  + `${finalRun.ok && /# fail 0/.test(finalRun.out) ? '测试复绿' : `测试仍红！！（${finalRun.out.slice(0, 160)}）`}`);
process.exitCode = allCaught && restoredOk && finalRun.ok ? 0 : 1;
