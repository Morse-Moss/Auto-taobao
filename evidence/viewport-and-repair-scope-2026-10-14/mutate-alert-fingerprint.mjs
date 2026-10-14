// 告警指纹改判的突变验证（批次 1.9.0，Task 5 的证据）。
//
// 指纹要回答的问题只有一个：同一天这一条告警**要不要再发**。判据从「停的位置（店@阶段）」
// 改成「根因集合」—— 因为这条告警的下一步是按成因给的（`ACTION_BY_CAUSE`），
// 所以「要做的事有没有变」只能由成因集合回答。4 处突变分别改坏它的四个半边：
// 轮级成因被抹平、店级退回位置、去重没了、排序没了。
//
// 纪律：源文件必须逐字节还原（断言之前就还原）；位置无关（向上找 `VERSION` 哨兵）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let ROOT = path.dirname(fileURLToPath(import.meta.url));
while (!existsSync(path.join(ROOT, 'VERSION')) && ROOT !== path.dirname(ROOT)) ROOT = path.dirname(ROOT);
if (!existsSync(path.join(ROOT, 'VERSION'))) {
  console.error(`找不到仓库根（从 ${import.meta.url} 向上没有 VERSION）`);
  process.exit(2);
}

const FILE = 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.mjs';
const TEST = 'skills/sycm-alimama-daily-report/scripts/run-multi-shop-day.test.mjs';
const NODE = process.execPath;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function mutate(text, from, to) {
  const crlf = text.includes('\r\n');
  const norm = text.replace(/\r\n/gu, '\n');
  const count = norm.split(from).length - 1;
  const next = count === 1 ? norm.replace(from, to) : norm;
  return { count, text: crlf ? next.replace(/\n/gu, '\r\n') : next };
}

function runTests() {
  const r = spawnSync(NODE, ['--test', TEST], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    failed: [...out.matchAll(/^\s*not ok \d+ - (.+)$/gmu)].map((m) => m[1].trim()),
    fail: Number((out.match(/^# fail (\d+)$/mu) ?? [])[1] ?? -1),
    pass: Number((out.match(/^# pass (\d+)$/mu) ?? [])[1] ?? -1),
    error: r.error ? r.error.message : null,
  };
}

const MUTATIONS = [
  {
    id: 'N1',
    why: '轮级前缀退回笼统的 ROUND_BLOCKED（丢成因）',
    find: "      view.roundBlocked ? `ROUND_BLOCKED:${blockedCause ?? 'UNKNOWN'}` : 'SHOP_LEVEL',",
    replace: "      view.roundBlocked ? 'ROUND_BLOCKED' : 'SHOP_LEVEL',",
    expect: ['轮级两种不同成因', '轮级成因不同时，窗口内也要发第二条'],
  },
  {
    id: 'N2',
    why: '店级那一段退回「店@阶段」位置指纹',
    find: '      ...causeSet,',
    replace: "      ...view.failed.map((item) => `${item.key}@${item.record?.failedStage ?? '?'}`),",
    expect: ['同一个根因换了店'],
  },
  {
    id: 'N3',
    why: '去掉成因集合的去重（两家店同一个成因就成两条）',
    find: '  const causeSet = [...new Set(view.failed.map(causeOf))].sort();',
    replace: '  const causeSet = view.failed.map(causeOf).sort();',
    expect: ['成因集合与店铺出现顺序无关'],
  },
  {
    id: 'N4',
    why: '去掉排序（店序一变指纹就变）',
    find: '  const causeSet = [...new Set(view.failed.map(causeOf))].sort();',
    replace: '  const causeSet = [...new Set(view.failed.map(causeOf))];',
    expect: ['成因集合与店铺出现顺序无关'],
  },
];

const file = path.join(ROOT, FILE);
const baseline = runTests();
console.log(`基线：pass=${baseline.pass} fail=${baseline.fail}`
  + `${baseline.error ? ` spawnError=${baseline.error}` : ''}`);

let bad = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(file);
  const before = sha(original);
  const applied = mutate(original.toString('utf8'), m.find, m.replace);
  if (applied.count !== 1) {
    console.log(`${m.id}  BAD   锚点命中 ${applied.count} 次（必须是 1） —— ${m.why}`);
    bad += 1;
    continue;
  }
  writeFileSync(file, applied.text);
  let res;
  try { res = runTests(); } finally { writeFileSync(file, original); }
  const restored = sha(readFileSync(file)) === before;
  const missed = m.expect.filter((e) => !res.failed.some((f) => f.includes(e)));
  const survived = res.fail === 0;
  const ok = restored && !survived && missed.length === 0;
  if (!ok) bad += 1;
  console.log(`${m.id}  ${ok ? 'RED  ' : 'BAD  '} ${m.why}`);
  console.log(`      还原=${restored ? '逐字节相同' : '!! 不一致 !!'}  pass=${res.pass} fail=${res.fail}`
    + `${survived ? '  !! 突变存活（用例全绿）!!' : ''}`);
  const observed = m.expect.filter((e) => res.failed.some((f) => f.includes(e)));
  if (observed.length) console.log(`      按预期变红：${observed.join(' ｜ ')}`);
  if (missed.length) console.log(`      !! 期望变红却没红：${missed.join(' ｜ ')}`);
}
console.log(bad === 0
  ? '结论：全部突变按预期变红，且源文件已逐字节还原。'
  : `结论：有 ${bad} 处不符合预期。`);
process.exitCode = bad === 0 ? 0 : 1;
