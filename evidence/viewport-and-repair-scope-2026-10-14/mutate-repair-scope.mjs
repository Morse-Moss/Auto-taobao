// 修复层作用域对齐的突变验证（批次 1.9.0，Task 4 的证据）。
//
// 这一批修的是「修复动作落到了错的那一页上」：`push` / `readback` 跑在共用商家浏览器上，
// 而链外的三处（派单单子的 execHint / instancePrecondition、自动修复的 execRepair）
// 原先按「店名 ⇒ 这家店的代理」取实例。9 处突变分别改坏「按阶段选实例」「共用页提示」
// 「页签归属判据」「互锁」「认不出成因时的阶段提示」这五件事的每一半。
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

const S = 'skills/sycm-alimama-daily-report/scripts/';
const TESTS = [
  S + 'stage-browsers.test.mjs',
  S + 'repair-shop-stage.test.mjs',
  S + 'repair-actions.test.mjs',
  S + 'run-multi-shop-day.test.mjs',
  'runtime/arch-boundary.test.mjs',
];
const NODE = process.execPath;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// EOL 健壮：锚点写 LF 形态，落到 CRLF checkout 上也能命中；写回时保留原文件的 EOL。
function mutate(text, from, to) {
  const crlf = text.includes('\r\n');
  const norm = text.replace(/\r\n/gu, '\n');
  const count = norm.split(from).length - 1;
  const next = count === 1 ? norm.replace(from, to) : norm;
  return { count, text: crlf ? next.replace(/\n/gu, '\r\n') : next };
}

function runTests() {
  const r = spawnSync(NODE, ['--test', ...TESTS], {
    cwd: ROOT,
    encoding: 'utf8',
    // ⚠️ `stdio` 必须显式给 `[ignore, pipe, pipe]`：默认值会让 stdin 走管道，
    //    而本机宿主沙箱对「给子进程管道 stdin 的同步 spawn」直接回 EBUSY（实测过）。
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
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
    id: 'M1',
    file: S + 'stage-browsers.mjs',
    why: '共用阶段闭集少一个词（readback 掉出共用组）',
    find: "export const SHARED_PAGE_STAGES = Object.freeze(['push', 'readback']);",
    replace: "export const SHARED_PAGE_STAGES = Object.freeze(['push']);",
    expect: ['闭集逐字为 push / readback'],
  },
  {
    id: 'M2',
    file: S + 'stage-browsers.mjs',
    why: '把共用端口抄成字面量（今天恰好等于登记表 ⇒ 行为断言抓不住，只有源码层断言抓得住）',
    find: 'const shared = `http://127.0.0.1:${PROJECT_PORTS.dailyReportProxy}`;',
    replace: "const shared = 'http://127.0.0.1:19023';",
    expect: ['共用端口来自 browser-ports'],
  },
  {
    id: 'M3',
    file: S + 'repair-shop-stage.mjs',
    why: 'resolveProxy 忽略阶段（退回「--shop X ⇒ 这家店自己的代理」）',
    find: 'const expected = proxyForStage({ stage: args.stage, shopKey: named ? args.shop : null });',
    replace: 'const expected = proxyForStage({ stage: null, shopKey: named ? args.shop : null });',
    expect: ['共用阶段（readback）允许'],
  },
  {
    id: 'M4',
    file: S + 'repair-shop-stage.mjs',
    why: 'feishu 提示降级成主机级（丢掉 baseToken 那一节）',
    find: "  if (hint === 'feishu') return feishuDailyPageFragment();",
    replace: "  if (hint === 'feishu') return 'feishu.cn';",
    expect: ['飞书地址躺在查询串里', '接线：归属判据走全仓唯一那一份'],
  },
  {
    id: 'M5',
    file: S + 'repair-shop-stage.mjs',
    why: '页签归属退回自己写的整串 includes',
    find: 'const matches = pagesMatching(pages, fragment);',
    replace: 'const matches = pages.filter((t) => String(t.url).includes(fragment));',
    expect: ['接线：归属判据走全仓唯一那一份', '飞书地址躺在查询串里'],
  },
  {
    id: 'M6',
    file: S + 'run-multi-shop-day.mjs',
    why: 'buildInstancePrecondition 忽略阶段',
    find: '  const proxy = proxyForStage({ stage, shopKey });\n  const shared = stageUsesSharedPage(stage);',
    replace: '  const proxy = proxyForStage({ stage: null, shopKey });\n  const shared = stageUsesSharedPage(stage);',
    expect: ['共用阶段（readback）的单子指向共用商家浏览器'],
  },
  {
    id: 'M7',
    file: S + 'run-multi-shop-day.mjs',
    why: '把「阶段表 vs 声明」的互锁条件掐掉（漂移不再抛错）',
    find: '    if (stageUsesSharedPage(item.stage) !== onSharedProxy) {',
    replace: '    if (false) {',
    expect: ['互锁（漂了当场抛'],
  },
  {
    id: 'M8',
    file: S + 'run-multi-shop-day.mjs',
    why: '把 readback 的实例改回店铺实例（互锁应当场炸）',
    find: "  add('readback', 'readback-daily-report.mjs',\n    ['--date', date, '--proxy', dailyProxy, '--shop-key', shopKey], dailyEnv,",
    replace: "  add('readback', 'readback-daily-report.mjs',\n    ['--date', date, '--proxy', dailyProxy, '--shop-key', shopKey], shopEnv,",
    expect: ['阶段表里 push/readback 真挂在共用实例上'],
  },
  {
    id: 'M9',
    file: S + 'repair-actions.mjs',
    why: '把「认不出成因 ⇒ 连带丢掉阶段页提示」这个缺陷装回去',
    find: 'cause: cause ?? null, stage: stage ?? null, stageHint: STAGE_PAGE_HINT[stage] ?? null,\n      candidates: [], known: false,',
    replace: 'cause: cause ?? null, stage: stage ?? null, stageHint: null,\n      candidates: [], known: false,',
    expect: ['未知成因：返回空候选且 known=false', 'readback 一轮自己找得到飞书底单页'],
  },
];

const baseline = runTests();
console.log(`基线：pass=${baseline.pass} fail=${baseline.fail}`
  + `${baseline.error ? ` spawnError=${baseline.error}` : ''} 失败名单=${JSON.stringify(baseline.failed)}`);

let bad = 0;
for (const m of MUTATIONS) {
  const file = path.join(ROOT, m.file);
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
  const observed = m.expect.filter((e) => res.failed.some((f) => f.includes(e)));
  const missed = m.expect.filter((e) => !res.failed.some((f) => f.includes(e)));
  const survived = res.fail === 0;
  const ok = restored && !survived && missed.length === 0;
  if (!ok) bad += 1;
  console.log(`${m.id}  ${ok ? 'RED  ' : 'BAD  '} ${m.why}`);
  console.log(`      还原=${restored ? '逐字节相同' : '!! 不一致 !!'}  pass=${res.pass} fail=${res.fail}`
    + `${survived ? '  !! 突变存活（用例全绿）!!' : ''}`);
  if (observed.length) console.log(`      按预期变红：${observed.join(' ｜ ')}`);
  if (missed.length) console.log(`      !! 期望变红却没红：${missed.join(' ｜ ')}`);
  const others = res.failed.filter((f) => !m.expect.some((e) => f.includes(e)));
  if (others.length) console.log(`      连带变红（${others.length}）：${others.slice(0, 4).join(' ｜ ')}${others.length > 4 ? ' …' : ''}`);
}
console.log(bad === 0
  ? '结论：全部突变按预期变红，且源文件已逐字节还原。'
  : `结论：有 ${bad} 处不符合预期，见上面 BAD 行。`);
process.exitCode = bad === 0 ? 0 : 1;
