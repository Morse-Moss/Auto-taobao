// 突变验证：推广任务台账这一族判据能不能真的红、且红在期望的那一条。
//
// 为什么非验不可：这一族里一半是**源码文本扫描**型判据（「取件段不许再出现 newestTaskName」这种），
// 它红了不代表拦住了什么；只有「改坏 → 它红 → 错的还是这一条」才算数。
// 还原后必须 sha256 逐字节一致（脚本末尾自证并打印）。
//
// 后缀刻意**不是** `.test.mjs`：它是验判据的工具，不是判据本身 ——
// 进了套件就等于每次全量都改一遍源码再还原（同 runtime/content-heat-judge.mutation.mjs 的约定）。
// 手动跑：node skills/sycm-alimama-daily-report/scripts/promotion-task-ledger.mutation.mjs
//
// 2026-09-21 加的 M8/M9 来自一次**真事故**（排练实测里里可林卡在 promotion-submit）：
//   M8 打掉 waitForNewTask 里「先导航到下载任务管理」那一步 ⇒ 差集在报表页上空读；
//   M9 打掉判据里「读空 ≠ 没有新增」那一支 ⇒ 读数失败被说成「平台没接受这次提交」。
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = import.meta.dirname;
const ROOT = path.resolve(DIR, '../../..');
const REPORT = path.join(DIR, 'collect-promotion-report.mjs');
const LEDGER = path.join(DIR, 'promotion-task-ledger.mjs');
const TEST = path.join(DIR, 'promotion-task-ledger.test.mjs');

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originals = new Map([REPORT, LEDGER].map((file) => [file, fs.readFileSync(file, 'utf8')]));
const shas = new Map([...originals.keys()].map((file) => [file, sha(file)]));

/** 替换必须命中，否则当场停手 —— 「改坏没改成」会让整轮突变给出假绿。 */
function replaceIn(file, from, to) {
  const text = originals.get(file);
  const hits = text.split(from).length - 1;
  if (hits !== 1) throw new Error(`${path.basename(file)}：期望命中 1 处，实际 ${hits} 处 —— 停手，别把这次结果当成验证`);
  const next = text.split(from).join(to);
  fs.writeFileSync(file, next, 'utf8');
  if (fs.readFileSync(file, 'utf8') !== next) throw new Error(`${path.basename(file)}：写入没生效（静默丢写）`);
}

function restore() {
  for (const [file, text] of originals) fs.writeFileSync(file, text, 'utf8');
}

function run() {
  try {
    const out = execFileSync(process.execPath, [TEST], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { exit: 0, out };
  } catch (error) {
    return { exit: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const results = [];
function mutate(name, apply, expectation) {
  try {
    apply();
    const { exit, out } = run();
    // 断言消息有两种打印形态：单行 `error: '...'`，以及多行 `error: |-` 块；
    // 而且同一个测试块里 `duration_ms` 排在 `error` **之前** —— 所以别按 duration_ms 截断
    // （那样会把 error 一起切掉，把真被抓住的突变误报成「漏掉」）。
    // 按「每个测试一段」切：ok/not ok 行是天然的段首。
    const blocks = out.split(/^(?=(?:ok|not ok) \d+ - )/mu).filter((part) => part.startsWith('not ok '));
    const failedTests = blocks.map((block) => block.split('\n')[0].replace(/^not ok \d+ - /u, '').trim());
    const caught = exit !== 0 && blocks.some((block) => expectation.test(block));
    results.push({ name, caught, exit, failedTests, blockHead: blocks[0]?.slice(0, 260) ?? null });
  } catch (error) {
    results.push({ name, caught: false, error: error.message });
  } finally {
    restore();
  }
}

const FETCH_DECISION = '  const decision = judgeFetchCandidates({ ledger: readLedger(ledgerFile), date: args.date, shop, rows, explicit: args.task });';

mutate('M1 取件段回退到「猜列表里最新那条」',
  () => replaceIn(REPORT, FETCH_DECISION,
    '  const fallback = newestTaskName(rows.map((row) => row.name));\n' + FETCH_DECISION),
  /取件段不许再出现 newestTaskName/u);

// M2 拦的是「主路径绕过判据、但补提交那条路还留着旧判据」这个**只改一半**的形态：
// 判据如果只写「取件段出现过 judgeFetchCandidates」，就拦不住它 —— 第二处调用会让它继续绿。
// 所以期望串必须指向「主路径有且只有一次」那条断言，别退回「出现过就行」那版文案。
mutate('M2 取件段绕过判据，自己挑一条',
  () => replaceIn(REPORT, FETCH_DECISION,
    '  const decision = { ok: true, taskNames: rows.map((row) => row.name), reason: "自己挑的" };'),
  /主路径（补提交之前那一段）要有且只有一次「经判据拿候选」/u);

mutate('M3 提交段真重排：先点「下载报表」，再判复用',
  () => replaceIn(REPORT,
    '  const listBefore = await openTaskList(args, targetId);',
    '  await submitDownloadTask(args, targetId);\n  const listBefore = await openTaskList(args, targetId);'),
  /复用判定必须在真正点「下载报表」之前/u);

mutate('M4 提交结果不看列表差集',
  () => replaceIn(REPORT,
    '    const outcome = judgeSubmitOutcome({ before, after });',
    '    const outcome = { ok: true, added: [], reason: "" };'),
  /提交成功与否要看列表差集/u);

mutate('M5 没有「日期范围＝目标日」的候选时回退到列表最新那条（纯判据）',
  () => replaceIn(LEDGER,
    '  if (!candidates.length) {\n',
    '  const fallback = withRange.at(-1);\n'
    + '  if (fallback) return { ok: true, taskNames: [fallback.name], reason: "回退到列表最新一条" };\n'
    + '  if (!candidates.length) {\n'),
  /不许回退到「列表里最新那条」/u);

mutate('M6 有未取任务时不复用、反而阻断（纯判据）',
  () => replaceIn(LEDGER,
    "    return { action: 'reuse', taskName: pending[0].taskName, stale,",
    "    return { action: 'block', taskName: pending[0].taskName, stale,"),
  /复用/u);

mutate('M7 「标已取」挪到 zip 落盘之前',
  () => replaceIn(REPORT,
    '    const deadline = Date.now() + args.timeoutMs;',
    '    writeLedger(ledgerFile, recordConsumedAll(readLedger(ledgerFile), '
    + '{ date: args.date, shop, taskName: wanted, at: new Date().toISOString() }));\n'
    + '    const deadline = Date.now() + args.timeoutMs;'),
  /recordConsumedAll 要写在「zip 落盘」那一段之后/u);

// 2026-09-21 现场事故的两个成因，各锁一条判据。
mutate('M8 差集不在列表页上算（去掉「先导航到下载任务管理」）',
  () => replaceIn(REPORT,
    '  let after = await openTaskList(args, targetId);\n',
    '  let after = [];\n'),
  /必须先导航到「下载任务管理」/u);

mutate('M9 判据里「读空」与「没有新增」不分开（读空被说成平台没接受）',
  () => {
    const text = originals.get(LEDGER);
    const from = text.indexOf('  if (beforeNames.length > 0 && afterNames.length === 0) {');
    const to = '  }\n';
    const end = text.indexOf(to, from);
    if (from < 0 || end < 0) throw new Error('没抓到读空那一支');
    replaceIn(LEDGER, text.slice(from, end + to.length), '');
  },
  /读空要单独标出来|读空必须自报/u);

// 还原自证：逐字节一致
const restored = [...originals.keys()].every((file) => sha(file) === shas.get(file));
const summary = {
  restored,
  shas: Object.fromEntries([...shas].map(([file, hash]) => [path.basename(file), hash])),
  caught: results.filter((r) => r.caught).length,
  total: results.length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (results.some((r) => !r.caught) || !restored) process.exitCode = 1;
