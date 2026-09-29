// 突变验证（修复回环）：把 09-29 那两处接线错误改回原样，确认新用例真的红。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 证据副本自重定位仓库根：复制进 evidence/ 后 CWD 相对路径会指错（旧坑）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');


const SRC = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs');
const TEST = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs');
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const original = readFileSync(SRC, 'utf8');
const before = sha(SRC);

const run = () => {
  try {
    execFileSync(process.execPath, ['--test', TEST], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const mutations = [
  {
    name: 'M1 对象当动作名直接传（复原 09-29 的原始缺陷）',
    from: `  const action = actionNameOf(list[0]);`,
    to: `  const action = list[0];`,
    expect: /收到的必须是动作名|不是动作名也不是候选对象/u,
  },
  {
    name: 'M2 摘候选时用字符串 indexOf（复原 splice(-1) 缺陷）',
    from: `        const index = remaining.findIndex((item) => actionNameOf(item) === attempt.action);`,
    to: `        const index = remaining.indexOf(attempt.action);`,
    expect: /同一个动作不试第二遍|摘除按错了下标/u,
  },
  {
    name: 'M3 gaveUp 文案直接 join 对象',
    from: `      const names = remaining.map((item) => {
        try { return actionNameOf(item); } catch { return JSON.stringify(item); }
      });`,
    to: `      const names = remaining;`,
    expect: /不许印 \[object Object\]/u,
  },
];

let allGood = true;
for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`✗ ${m.name}: 找不到锚点`);
    allGood = false;
    continue;
  }
  writeFileSync(SRC, original.replace(m.from, m.to), 'utf8');
  const r = run();
  const named = m.expect.test(r.out);
  const status = (!r.ok && named) ? '✓' : '✗';
  if (status === '✗') allGood = false;
  const failing = [...r.out.matchAll(/^not ok \d+ - (.+)$/gmu)].map((x) => x[1]);
  console.log(`${status} ${m.name}: exitOk=${r.ok} 点名=${named} 红用例=${JSON.stringify(failing)}`);
  writeFileSync(SRC, original, 'utf8');
}

const after = sha(SRC);
console.log(`\n还原核对: ${before === after ? '✓ 逐字节一致' : '✗ 不一致'}`);
console.log(allGood && before === after ? '结论：3/3 突变全红且点名到期望用例' : '结论：有问题，见上');
