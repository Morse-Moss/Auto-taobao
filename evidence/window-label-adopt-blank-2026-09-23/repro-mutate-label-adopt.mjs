// 突变验证：「标志页接管空白页」这组新判据到底会不会红。
//
// 为什么必须做：新增判据全绿有两种可能 —— ①它真的在守着；②它守着的东西坏了也不会红（假绿）。
// 区分这两者的唯一办法是**把源码改坏**，看它红不红、且红在你期望的那一条上。
// 数字本身永远说服不了人，被点名的那条用例才能。
//
// 纪律（见技能 mutation-verification-harness）：
//   · 每个突变都必须**先确认替换真的发生了**（`includes` 为假 ⇒ 报「突变没生效」，那也是一种假绿）；
//   · 跑完一律还原，并用 sha256 自证与原始逐字节一致；
//   · 断言「红了哪几条」，而**不是**只看「有没有红」—— 红错地方等于没守住。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'D:/Retire/sycm-automation';
const SRC = path.join(REPO, 'runtime', 'shop-window-label.mjs');
const TEST = 'runtime/shop-window-label.test.mjs';
const NODE = process.execPath;

const MUTATIONS = [
  {
    name: 'M1 接管分支变成死代码（等价于回到「总是新建」）',
    find: '  if (blanks.length > 0) {',
    replace: '  if (false) {',
    // 期望：接管那两条红（不再新建 / 不再接管）
    expectRed: ['没有标签页但有空白页时', '接管空白页时只取第一个'],
  },
  {
    name: 'M2 接管时不钉住（空白页照样会被代理 15 分钟收走）',
    find: '    const pinned = await pinLabelTab(proxyUrl, adopted.targetId, fetchImpl);',
    replace: '    const pinned = { pinned: false, reason: "mutation" };',
    expectRed: ['没有标签页但有空白页时'],
  },
  {
    name: 'M3 接管时取最后一个空白页而不是第一个（前后轮次对不上）',
    find: '    const adopted = blanks[0];',
    replace: '    const adopted = blanks[blanks.length - 1];',
    expectRed: ['接管空白页时只取第一个'],
  },
  {
    name: 'M4 报告里把「接管」写成 false（页面上看不出空白页去哪了）',
    find: '      ok: true, shop, reused: false, adoptedBlank: true,',
    replace: '      ok: true, shop, reused: false, adoptedBlank: false,',
    expectRed: ['没有标签页但有空白页时', '接管空白页时只取第一个'],
  },
];

const original = readFileSync(SRC, 'utf8');
const originalSha = createHash('sha256').update(original, 'utf8').digest('hex');
console.log(`原始 sha256 = ${originalSha}\n`);

/** 跑一次用例，返回 { failed: string[], total, pass }。 */
function runTests() {
  const res = spawnSync(NODE, ['--test', TEST], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gmu)].map((m) => m[1].trim());
  const pass = Number(out.match(/^# pass (\d+)$/mu)?.[1] ?? -1);
  const total = Number(out.match(/^# tests (\d+)$/mu)?.[1] ?? -1);
  return { failed, pass, total, out };
}

const verdicts = [];
try {
  for (const mutation of MUTATIONS) {
    if (!original.includes(mutation.find)) {
      verdicts.push({ name: mutation.name, verdict: 'MUTATION_NOT_APPLIED', failed: [] });
      console.log(`[!] ${mutation.name}\n    替换目标在源码里找不到 —— 突变没生效（这本身也是一种假绿）\n`);
      continue;
    }
    const mutated = original.replace(mutation.find, mutation.replace);
    if (mutated === original) {
      verdicts.push({ name: mutation.name, verdict: 'MUTATION_NOT_APPLIED', failed: [] });
      console.log(`[!] ${mutation.name}\n    替换后内容没变 —— 突变没生效\n`);
      continue;
    }
    writeFileSync(SRC, mutated, 'utf8');
    const result = runTests();
    console.log(`[突变] ${mutation.name}`);
    console.log(`  用例 ${result.pass}/${result.total} 通过，红了 ${result.failed.length} 条：`);
    for (const name of result.failed) console.log(`    not ok - ${name}`);
    const hitExpected = mutation.expectRed.every((keyword) => result.failed.some((name) => name.includes(keyword)));
    const verdict = result.failed.length > 0 && hitExpected ? 'CAUGHT' : 'NOT_CAUGHT';
    if (verdict === 'NOT_CAUGHT') {
      console.log(`  [!!] 期望红的是「${mutation.expectRed.join(' / ')}」—— 没红到位，判据是假的`);
    }
    console.log(`  判定：${verdict}\n`);
    verdicts.push({ name: mutation.name, verdict, failed: result.failed });
  }
} finally {
  writeFileSync(SRC, original, 'utf8');
}

const restored = readFileSync(SRC, 'utf8');
const restoredSha = createHash('sha256').update(restored, 'utf8').digest('hex');
console.log(`还原后 sha256 = ${restoredSha}`);
console.log(restoredSha === originalSha ? '还原：逐字节一致 ✓' : '还原：不一致 ✗（源码被改动了，必须人工处理）');

const caught = verdicts.filter((v) => v.verdict === 'CAUGHT').length;
console.log(`\n汇总：${caught}/${verdicts.length} 个突变被抓住`);
for (const v of verdicts) console.log(`  ${v.verdict === 'CAUGHT' ? 'CAUGHT    ' : 'NOT_CAUGHT'}  ${v.name}`);
process.exit(caught === verdicts.length && restoredSha === originalSha ? 0 : 1);
