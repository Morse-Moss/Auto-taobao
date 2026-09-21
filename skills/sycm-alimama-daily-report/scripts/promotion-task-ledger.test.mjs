// 推广任务台账的判据用例（2026-09-21 晚）。
//
// 这一族要防的是**静默错数据**：任务名只有导出日、没有目标日，所以「取哪一条」这件事
// 一旦允许猜（老实现猜「时间戳最大那条」），取回别人那天的报表也不会报任何错。
// 所以用例分两半：①纯判据逐条钉住决策；②源码扫描钉住「fetch 段真的不再猜」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_VERSION, describeStale, emptyLedger, judgeFetchTaskName, judgeResume, judgeSubmitOutcome,
  ledgerScope, parseLedger, pendingFor, readLedger, recordConsumed, recordSubmitted, staleFor, writeLedger,
} from './promotion-task-ledger.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATE = '2026-09-20';
const SHOP = '里可林家居';
const T1 = '营销场景报表_20260921_112258';
const T2 = '营销场景报表_20260921_113102';
const T3 = '营销场景报表_20260922_090000';

const ledgerWith = (...records) => ({ version: LEDGER_VERSION, records });
const pendingRecord = (taskName, over = {}) => ({ date: DATE, shop: SHOP, taskName, proxy: null, submittedAt: '2026-09-21T03:41:00.000Z', consumedAt: null, ...over });

test('台账解析：坏掉的台账一律抛，绝不当成空台账', () => {
  // 全部价值就是「我确定它记了什么」。把「读不懂」当成「没记录」⇒ 下一轮再提交一次副作用，
  // 而我们恰恰不知道第一条是什么。
  assert.throws(() => parseLedger('{'), /不是合法 JSON/u);
  assert.throws(() => parseLedger('[]'), /顶层应当是对象/u);
  assert.throws(() => parseLedger('null'), /顶层应当是对象/u);
  assert.throws(() => parseLedger(JSON.stringify({ version: 0, records: [] })), /版本是 0/u);
  assert.throws(() => parseLedger(JSON.stringify({ version: 1 })), /records 应当是数组/u);
  assert.throws(() => parseLedger(JSON.stringify({ version: 1, records: [{ date: '2026/09/20', shop: SHOP, taskName: T1 }] })), /date 不是 YYYY-MM-DD/u);
  assert.throws(() => parseLedger(JSON.stringify({ version: 1, records: [{ date: DATE, shop: '', taskName: T1 }] })), /缺 shop/u);
  assert.throws(() => parseLedger(JSON.stringify({ version: 1, records: [{ date: DATE, shop: SHOP, taskName: '日报_20260921_112258' }] })), /taskName 不是任务名形状/u);
  const ok = parseLedger(JSON.stringify(ledgerWith(pendingRecord(T1))));
  assert.equal(ok.records.length, 1);
  assert.equal(ok.records[0].taskName, T1);
});

test('读台账：文件不存在＝还没记过；文件在但读坏了＝抛', () => {
  assert.deepEqual(readLedger('x.json', { read: () => { const error = new Error('nope'); error.code = 'ENOENT'; throw error; } }), emptyLedger());
  assert.throws(() => readLedger('x.json', { read: () => '{ 坏' }), /不是合法 JSON/u);
});

test('写台账：先写 .tmp 再改名（半截文件能把这条链停住）', () => {
  const calls = [];
  const ledger = ledgerWith(pendingRecord(T1));
  writeLedger('D:/repo/runtime/promotion-task-ledger.json', ledger, {
    writeFile: (target, body) => calls.push(['write', target, body]),
    mkdirSync: (target) => calls.push(['mkdir', target]),
    renameSync: (from, to) => calls.push(['rename', from, to]),
  });
  assert.deepEqual(calls[0], ['mkdir', 'D:/repo/runtime']);
  assert.equal(calls[1][1], 'D:/repo/runtime/promotion-task-ledger.json.tmp', '必须先落到临时文件');
  assert.equal(calls[1][2], `${JSON.stringify(ledger, null, 2)}\n`);
  assert.deepEqual(calls[2], ['rename', 'D:/repo/runtime/promotion-task-ledger.json.tmp', 'D:/repo/runtime/promotion-task-ledger.json']);
});

test('记账是纯函数：不改入参，且用 --task 直取时也要落一笔（否则下一轮又会提交一次）', () => {
  const before = ledgerWith();
  const after = recordSubmitted(before, { date: DATE, shop: SHOP, taskName: T1, at: '2026-09-21T03:41:00.000Z' });
  assert.equal(before.records.length, 0, '入参不许被改');
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].consumedAt, null);

  const consumed = recordConsumed(after, { date: DATE, shop: SHOP, taskName: T1, at: '2026-09-21T04:10:00.000Z' });
  assert.equal(after.records[0].consumedAt, null, '入参不许被改');
  assert.equal(consumed.records[0].consumedAt, '2026-09-21T04:10:00.000Z');
  assert.equal(pendingFor(consumed, { date: DATE, shop: SHOP }).length, 0);

  const upserted = recordConsumed(ledgerWith(), { date: DATE, shop: SHOP, taskName: T2, at: '2026-09-21T04:11:00.000Z' });
  assert.equal(upserted.records.length, 1, '没有提交记录时也要落一笔');
  assert.equal(upserted.records[0].taskName, T2);
  assert.equal(upserted.records[0].submittedAt, null);
});

test('台账按店定位：优先 --expect-shop，退化到 --proxy，都没有就抛', () => {
  assert.equal(ledgerScope({ expectShop: SHOP, proxy: 'http://127.0.0.1:19041' }), SHOP);
  assert.equal(ledgerScope({ proxy: 'http://127.0.0.1:19041' }), 'http://127.0.0.1:19041');
  assert.throws(() => ledgerScope({}), /需要一个店铺标识/u);
  assert.throws(() => ledgerScope({ expectShop: '   ' }), /需要一个店铺标识/u);
});

test('提交前决策：有未取任务且核得到就复用；核不到就阻断；没有才提交', () => {
  const reuse = judgeResume({ ledger: ledgerWith(pendingRecord(T1)), date: DATE, shop: SHOP, list: [T1, T3] });
  assert.equal(reuse.action, 'reuse');
  assert.equal(reuse.taskName, T1);
  assert.match(reuse.reason, /跳过提交/u);

  const block = judgeResume({ ledger: ledgerWith(pendingRecord(T1)), date: DATE, shop: SHOP, list: [T3] });
  assert.equal(block.action, 'block', '台账记着、列表里没有 ⇒ 核不清，不许直接再提交一次');
  assert.match(block.reason, new RegExp(T1, 'u'));

  const submit = judgeResume({ ledger: ledgerWith(), date: DATE, shop: SHOP, list: [T3] });
  assert.equal(submit.action, 'submit');

  const two = judgeResume({ ledger: ledgerWith(pendingRecord(T1), pendingRecord(T2)), date: DATE, shop: SHOP, list: [T1, T2] });
  assert.equal(two.action, 'block', '同目标日两笔未取 ⇒ 分不清该用哪一笔');
  assert.match(two.reason, /2 笔/u);
});

test('别的目标日挂着的未取任务只报不拦（拦住一条无人值守的链比残留更糟）', () => {
  const ledger = ledgerWith(pendingRecord(T3, { date: '2026-09-19' }));
  const decision = judgeResume({ ledger, date: DATE, shop: SHOP, list: [T3] });
  assert.equal(decision.action, 'submit', '别的日子的残留不该把本轮拦住');
  assert.equal(decision.stale.length, 1);
  assert.match(describeStale(decision.stale), /还挂着 1 笔别的目标日的未取任务/u);
  assert.equal(staleFor(ledger, { date: DATE, shop: SHOP }).length, 1);
  assert.equal(describeStale([]), null);
  // 同一笔在「本目标日」的视角下不算残留
  assert.equal(staleFor(ledgerWith(pendingRecord(T1)), { date: DATE, shop: SHOP }).length, 0);
});

test('提交结果：差集必须恰好 1 条；0 条不许当成功，多条算核不清', () => {
  assert.deepEqual(judgeSubmitOutcome({ before: [T3], after: [T1, T3] }), {
    ok: true, taskName: T1, added: [T1], reason: `列表里恰好多出 1 条：${T1}`,
  });
  const zero = judgeSubmitOutcome({ before: [T1, T3], after: [T1, T3] });
  assert.equal(zero.ok, false, '差集为 0 不许当成功（平台没接受这次提交）');
  assert.match(zero.reason, /没有多出任何任务/u);
  const many = judgeSubmitOutcome({ before: [], after: [T1, T2] });
  assert.equal(many.ok, false, '一次提交多出多条 ⇒ 核不清，不许当成功');
  assert.match(many.reason, /多出了 2 条/u);

  // 「一条都没读到」不是「没有新增」：两者在差集上完全同形（都是空集），必须分开报。
  // 现场代价见 2026-09-21 排练：readTaskNames 读的是报表页（没有任何任务名），
  // 于是 9 次读数全是空集，被这条判据说成「平台没接受这次提交」，而平台侧其实已经建好任务了。
  const unread = judgeSubmitOutcome({ before: [T1, T3], after: [] });
  assert.equal(unread.ok, false);
  assert.equal(unread.unreadable, true, '读空要单独标出来，不许混进「平台没接受」');
  assert.match(unread.reason, /这不是「没有新增」/u);
  assert.doesNotMatch(unread.reason, /平台可能没接受/u, '读空不许说成「平台没接受这次提交」');

  // 基线本来就读空是另一回事（不是读数失败，而是基线本身可疑），不能借用上面那一支。
  const bothEmpty = judgeSubmitOutcome({ before: [], after: [] });
  assert.equal(bothEmpty.unreadable, undefined);
  assert.match(bothEmpty.reason, /基线读数本身就可疑/u);
});

test('差集只认任务名形状：页面上的别的叶子文本不许混进来把差集算错', () => {
  const outcome = judgeSubmitOutcome({ before: [], after: [T1, '营销场景报表', '下载任务管理', '2026-09-21 11:22:58'] });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.taskName, T1);
});

test('取件段：台账里没有这一笔就不许猜「最新那条」——哪怕列表里有更新的任务', () => {
  // 这一条正是老实现的现场：列表里有 T3（更新），台账里没有本目标日的记录。
  // 猜 T3 ⇒ 把别的日子/别的批次的数据当成这一天的，而且没有任何下游检查能发现。
  const decision = judgeFetchTaskName({ ledger: ledgerWith(), date: DATE, shop: SHOP, list: [T1, T3] });
  assert.equal(decision.ok, false, '台账里没有这一笔时不许 ok —— 不许回退到「列表里最新那条」');
  assert.match(decision.reason, /不拿「列表里最新那条」去猜/u);
  assert.match(decision.reason, /--task/u, '要把「怎么修」写进理由：先跑 submit 或显式指定');
});

test('取件段：台账里那一笔核得到才取；核不到、或多笔，一律不取', () => {
  const good = judgeFetchTaskName({ ledger: ledgerWith(pendingRecord(T1)), date: DATE, shop: SHOP, list: [T1, T3] });
  assert.equal(good.ok, true);
  assert.equal(good.taskName, T1);

  const gone = judgeFetchTaskName({ ledger: ledgerWith(pendingRecord(T1)), date: DATE, shop: SHOP, list: [T3] });
  assert.equal(gone.ok, false, '台账那一笔核不到时不许 ok');
  assert.match(gone.reason, /核不清，不取/u);

  const two = judgeFetchTaskName({ ledger: ledgerWith(pendingRecord(T1), pendingRecord(T2)), date: DATE, shop: SHOP, list: [T1, T2] });
  assert.equal(two.ok, false, '同目标日两笔未取时不许 ok');
  assert.match(two.reason, /2 笔未取任务/u);
});

test('取件段：--task 显式指定时以它为准（人愿意负责的那条路），但仍要在列表里', () => {
  const explicit = judgeFetchTaskName({ ledger: ledgerWith(), date: DATE, shop: SHOP, list: [T1], explicit: T3 });
  assert.equal(explicit.ok, false, '--task 指定的不在列表里时不许 ok');
  assert.match(explicit.reason, /不在列表里/u);
  const ok = judgeFetchTaskName({ ledger: ledgerWith(), date: DATE, shop: SHOP, list: [T3], explicit: T3 });
  assert.equal(ok.ok, true);
  assert.equal(ok.taskName, T3);
});

test('接线判据：fetch 段真的不再自己挑任务（函数级用例全绿也拦不住「没说出口的回退」）', () => {
  const source = readFileSync(path.join(SCRIPTS_DIR, 'collect-promotion-report.mjs'), 'utf8');
  const fetchAt = source.indexOf('async function phaseFetch(');
  const submitAt = source.indexOf('async function phaseSubmit(');
  assert.ok(fetchAt > 0 && submitAt > 0 && fetchAt > submitAt, '两个阶段的顺序变了，这条判据要先跟着改');
  const submitBody = source.slice(submitAt, fetchAt);
  const fetchBody = source.slice(fetchAt);

  // 核心：把「猜最新那条」这个回退从取件段里删掉，并把这件事钉住。
  assert.equal(/newestTaskName\s*\(/u.test(fetchBody), false,
    '取件段不许再出现 newestTaskName —— 它就是「猜最新那条」，会取回别天的报表');
  assert.match(fetchBody, /judgeFetchTaskName\(\{/u, '取件段要经判据拿任务名');
  assert.equal(/const wanted = args\.task \?\?/u.test(fetchBody), false, '不许再有「没给 --task 就自己挑一条」的写法');
  assert.match(fetchBody, /recordConsumed\(/u, '取到了要把台账标成已取，否则下一轮又会提交一次');
  assert.match(fetchBody, /writeLedger\(/u, '标已取要落盘');
  // 顺序：先确认 zip 落盘、再标已取。反了的话「取件失败」会留下一笔已取的假记录，
  // 下一轮就不再提交、也不去取 ⇒ 这一天静默地什么都没有。
  const consumedAt = fetchBody.indexOf('recordConsumed(');
  const landedAt = fetchBody.indexOf('promotionZipPath =');
  assert.ok(landedAt > 0 && consumedAt > landedAt, 'recordConsumed 要写在「zip 落盘」那一段之后');

  // 提交段：先判「已经提交过没取」，再谈点击；顺序反了就成了「先产生第二次副作用，再发现不该产生」。
  assert.match(submitBody, /judgeResume\(\{/u, '提交段要先判复用/阻断');
  assert.match(submitBody, /recordSubmitted\(/u, '提交成功要把观察到的那一条记进台账');
  // 差集判定住在 waitForNewTask 里（它的职责就是「等列表多出一条」），所以钉两段：
  // 提交段用了它、它自己判的是差集且真的重载。
  assert.match(submitBody, /await waitForNewTask\(/u, '提交段要等列表差集给出结论，不是看提示语');
  const helperAt = source.indexOf('async function waitForNewTask(');
  assert.ok(helperAt > 0 && helperAt < submitAt, 'waitForNewTask 应当在 phaseSubmit 之前定义');
  const helperBody = source.slice(helperAt, submitAt);
  assert.match(helperBody, /judgeSubmitOutcome\(\{/u, '提交成功与否要看列表差集，不是看提示语');
  assert.match(helperBody, /readTaskNames\(args, targetId\)/u, '要真的重读列表，不是只读一次');
  assert.match(helperBody, /window\.location\.reload\(\)/u,
    '重载必须走 reload：列表页还是同一个 URL，navigate 到同一 URL 是同文档导航（浏览器什么都不做）');
  // 差集要在**列表页**上算：点完「确定」页面还停在报表页，那一屏没有任何任务名。
  // 不先导航过去，读到的恒是空集 —— 而空集与「没有新增」的差集一模一样（2026-09-21 排练的现场）。
  const openAt = helperBody.indexOf('openTaskList(args, targetId)');
  const firstReadAt = helperBody.indexOf('readTaskNames(args, targetId)');
  assert.ok(openAt > 0, 'waitForNewTask 必须先导航到「下载任务管理」再读列表');
  assert.ok(openAt < firstReadAt, '导航要排在第一次读之前（否则是在报表页上读任务名，恒得空集）');
  const resumeAt = submitBody.indexOf('judgeResume({');
  const clickAt = submitBody.indexOf('click(args, targetId, \'[data-collect-alimama-download="1"]\')');
  assert.ok(clickAt > resumeAt && resumeAt > 0,
    '复用判定必须在真正点「下载报表」之前 —— 反了就白产生一次副作用');
});
