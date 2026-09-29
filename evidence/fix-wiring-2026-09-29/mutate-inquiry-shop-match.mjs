// 突变验证：把修复改回原样，确认 inquiry-core.test.mjs 真的红、且红在对应用例上。
// 三个突变各自对应修复的一处；逐条应用、跑测试、还原、比对 sha256。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 证据副本自重定位仓库根：复制进 evidence/ 后 CWD 相对路径会指错（旧坑）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');


const SRC = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/inquiry-core.mjs');
const TEST = path.join(REPO_ROOT, 'skills/sycm-alimama-daily-report/scripts/inquiry-core.test.mjs');
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
    name: 'M1 退回「只认店名」',
    from: `  const accepted = optionId ? [shop, optionId] : [shop];`,
    to: `  const accepted = [shop];`,
    expect: /选项 id 形态/u,
  },
  {
    name: 'M2 认 id 但不建 accepted（id 被当店名比）',
    from: `    && accepted.includes(cell(record.fields?.['店铺'])));`,
    to: `    && cell(record.fields?.['店铺']) === optionId);`,
    expect: /选项 id 形态/u,
  },
  {
    name: 'M3 不唯一也返回第一行（挑一行写）',
    from: `  const only = matches.length === 1 ? matches[0] : null;`,
    to: `  const only = matches[0] ?? null;`,
    expect: /两行时报 2 个候选/u,
  },
];

let allGood = true;
for (const m of mutations) {
  if (!original.includes(m.from)) {
    console.log(`✗ ${m.name}: 找不到锚点，突变没生效`);
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
console.log(`\n还原核对: ${before} ${before === after ? '==' : '!='} ${after} ${before === after ? '✓ 逐字节一致' : '✗ 不一致'}`);
console.log(allGood && before === after ? '\n结论：3/3 突变全红且点名到期望用例，源文件已还原' : '\n结论：有问题，见上');
