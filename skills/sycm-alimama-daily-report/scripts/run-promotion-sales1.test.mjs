import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  promotionSales1Plan, parsePromotionSales1Args,
  buildPromotionRoundAlert, deliverPromotionAlert, buildPromotionSummary, runStageWithRetry,
} from './run-promotion-sales1.mjs';
import { READABLE_SOURCE_KEYS } from '../../../runtime/notify-feishu-core.mjs';
import { unfixableShopsOf } from '../../../runtime/hold-and-resume-plan.mjs';
import { failedShopsOf } from '../../../scripts/hold-and-resume.mjs';
import { validateSummary } from '../../../runtime/unified-summary-schema.mjs';

test('推广入口保留公共批次顺序，不在入口内切批', () => {
  assert.deepEqual(promotionSales1Plan({ shops: ['里可林淘宝', '网林天猫', '盖文淘宝'] }), [
    ['里可林淘宝', '网林天猫', '盖文淘宝'],
  ]);
});


test('推广日报拒绝销售二部或未登记店铺', () => {
  assert.throws(() => promotionSales1Plan({ shops: ['保拉淘宝'] }), /不在销售一部采集范围/u);
});

test('推广入口接受公共批次的 yesterday 日期并解析为目标日期', () => {
  const args = parsePromotionSales1Args(['--date', 'yesterday', '--plan']);
  assert.match(args.date, /^\d{4}-\d{2}-\d{2}$/u);
});

test('推广入口解析 --notify 开关', () => {
  assert.equal(parsePromotionSales1Args(['--date', 'yesterday', '--notify']).notify, true);
  assert.equal(parsePromotionSales1Args(['--date', 'yesterday']).notify, false);
});

test('buildPromotionRoundAlert：全成功不告警，有失败才构造', () => {
  const ok = [{ batch: 1, shop: '里可林淘宝', status: 'ok', stages: ['keyword-submit'] }];
  assert.equal(buildPromotionRoundAlert({ date: '2026-10-10', results: ok }), null);
  const failed = [
    ok[0],
    { batch: 1, shop: '网林天猫', status: 'failed', stages: ['keyword-submit'], error: '采集失败：关键词报表提交任务无法唯一确认' },
  ];
  const alert = buildPromotionRoundAlert({ date: '2026-10-10', results: failed, now: () => new Date('2026-10-11T07:25:00+08:00') });
  assert.equal(alert.type, 'PROMOTION_ROUND_FAILED');
  assert.equal(alert.alertId, 'promotion-round-20261010');
  assert.match(alert.fingerprint, /网林天猫@keyword-submit/u);
  assert.match(alert.title, /【推广日报】网林天猫没收完（业务日 2026-10-10）/u, '标题第一段是流程名，再点名哪家店、哪一天');
  // 业务第一段不再裸塞 `record.error`（2026-10-13）：那往往是半句英文栈或内部代号，
  // 只有写它的人看得懂。现在正文＝「哪几家没跑完 + 一句人话」，原始错误进技术定位块。
  assert.match(alert.reason, /没跑完 1 家：网林天猫/u);
  assert.match(alert.reason, /推广报表没采到或没写进飞书/u);
  assert.equal(alert.reason.includes('采集失败'), false, '原始错误串不该进业务第一段');
  // 告警纪律：source 只许白名单键，且不带机器名/盘符/内部路径。
  for (const key of Object.keys(alert.source)) {
    assert.ok(READABLE_SOURCE_KEYS.some(([allowed]) => allowed === key), `source 键 ${key} 不在渲染白名单`);
  }
  assert.equal(alert.source.machine, undefined);
  assert.equal(JSON.stringify(alert).includes('D:\\'), false);
  // 下一步不再写 `start-all --only <店>` 这类命令（2026-10-13）：收信人是运营，不是技术同学。
  // 命令与机读阶段名只出现在技术定位块与 job.log 里。
  assert.match(alert.action, /转给技术同学/u);
  assert.equal(alert.action.includes('start-all'), false, '技术命令不该进业务第一段');
});

test('deliverPromotionAlert：投递成功才记账，送失败不记账（防自挡）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-alert-'));
  const throttleFile = path.join(dir, 'throttle.json');
  const alert = buildPromotionRoundAlert({
    date: '2026-10-10',
    results: [{ batch: 1, shop: '网林天猫', status: 'failed', stages: [], error: 'x' }],
  });
  try {
    const okExec = () => ({ status: 0, stdout: 'DELIVERED', stderr: '' });
    const first = deliverPromotionAlert({ alert, throttleFile, exec: okExec, node: 'node' });
    assert.equal(first.delivered, true);
    assert.equal(fs.existsSync(throttleFile), true);

    // 同指纹重投 ⇒ 被 throttle 压掉（suppressed），不再执行投递。
    let spawned = 0;
    const countingExec = () => { spawned += 1; return { status: 0, stdout: '', stderr: '' }; };
    const second = deliverPromotionAlert({ alert, throttleFile, exec: countingExec, node: 'node' });
    assert.equal(second.delivered, false);
    assert.equal(second.suppressed, true);
    assert.equal(spawned, 0);

    // 送失败（status!=0）⇒ 不记账：换一个指纹（停的店变了）再投时 exec 报 1，
    // throttle 文件里不应留下这条的「已送」记录。
    const changedAlert = { ...alert, fingerprint: '另一家@crowd-submit' };
    const failExec = () => ({ status: 1, stdout: '', stderr: 'boom' });
    const third = deliverPromotionAlert({ alert: changedAlert, throttleFile, exec: failExec, node: 'node' });
    assert.equal(third.delivered, false);
    const ledger = fs.readFileSync(throttleFile, 'utf8');
    assert.ok(!ledger.includes('另一家@crowd-submit'), '送失败却记了账，会让重跑被自己的记录挡掉');

    // 无失败 ⇒ 不投。
    const none = deliverPromotionAlert({ alert: null, throttleFile, exec: okExec, node: 'node' });
    assert.deepEqual(none, { delivered: false, suppressed: false, reason: 'no-failure' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// P0-3：链级 summary 的判据对接——「我们构造的字段，对面的判据真的认」。这条用例防的正是
// 07:00 那种「链说失败了、下游判据全瞎 ⇒ 恒判没有要人看的失败 ⇒ 照旧释放」的断裂：
// 推广链 summary 的失败店必须被 unfixableShopsOf / failedShopsOf 同时点名。
// 迁移第 3 步（2026-10-11）起：buildPromotionSummary 并写统一字段，evidenceRoot 必传，
// version/workflow 断言随拍板换成统一串。
const PROMOTION_EVIDENCE_ROOT = path.resolve('evidence/promotion-sales1-2026-10-10');

test('buildPromotionSummary：失败店被释放/驻留两侧判据同时点名（跨模块对接）', () => {
  const results = [
    { batch: 1, shop: '里可林淘宝', status: 'ok', stages: ['keyword-submit', 'import'] },
    { batch: 1, shop: '网林天猫', status: 'failed', stages: ['keyword-submit'], error: '采集失败：关键词报表提交任务无法唯一确认' },
  ];
  const summary = buildPromotionSummary({ date: '2026-10-10', results, evidenceRoot: PROMOTION_EVIDENCE_ROOT });
  assert.equal(summary.version, 'unified-summary-v1'); // 拍板 6.4-A：三链同串（旧串 promotion-sales1-summary-v1 已随第 3 步废弃）
  assert.equal(summary.workflow, 'promotion-daily'); // 迁移第 3 步：哪条链写的，驻留续跑与统一回执都读它
  // 成功店不带 repairRequest（不是失败，不进「要人看」名单）。
  assert.equal(summary.shops['里可林淘宝'].repairRequest, undefined);
  // 失败店带空候选（推广链无脚本自修能力 ⇒ 「脚本修不动」是现状事实）。
  assert.deepEqual(summary.shops['网林天猫'].repairRequest, { candidates: [] });
  // 释放/驻留两侧的判据（unfixableShopsOf）必须把失败店点出来——07:00 轮它恒空。
  assert.deepEqual(unfixableShopsOf(summary), ['网林天猫']);
  // 驻留那侧的逐店失败名单也要认（holdDecision 的 failed 输入）。
  const failed = failedShopsOf(summary);
  assert.deepEqual(failed.map((item) => item.shop), ['网林天猫']);
  // 全成功 ⇒ 两边都空（不误驻留、不误拦释放）。
  const allOk = buildPromotionSummary({ date: '2026-10-10', results: [results[0]], evidenceRoot: PROMOTION_EVIDENCE_ROOT });
  assert.deepEqual(unfixableShopsOf(allOk), []);
  assert.deepEqual(failedShopsOf(allOk), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 统一 summary schema 并写（三链对齐 P1 迁移第 3 步，2026-10-11）：离线用例先钉，
// 真机验证窗口＝2026-10-12 07:00 定时轮（07:00 事故轮的同位窗口）。
// ─────────────────────────────────────────────────────────────────────────────

// a. 并写后的构建输出必须过统一校验器全绿（ok 店走完五阶段＋失败店空菜单，真实参数形状）。
test('buildPromotionSummary 并写后形状过 validateSummary 全绿（ok 店五阶段＋失败店空菜单）', () => {
  const results = [
    { batch: 1, shop: '里可林淘宝', status: 'ok', stages: ['keyword-submit', 'audience-submit', 'keyword-fetch', 'audience-fetch', 'import'] },
    { batch: 1, shop: '网林天猫', status: 'failed', stages: [], error: '采集失败：关键词报表提交任务无法唯一确认' },
  ];
  const summary = buildPromotionSummary({ date: '2026-10-10', results, evidenceRoot: PROMOTION_EVIDENCE_ROOT });
  assert.deepEqual(validateSummary(summary), { ok: true, errors: [] });
});

// b. 并写自洽：失败店 failureClass 按确定性标记分类、noActionRequired 恒 false、autoRepair 恒显式 null、
//    evidence 与 :208 现有拼法（`<--evidence 根>/<店>` 相对仓库根）一致；ok 店只补 evidence。
test('buildPromotionSummary 并写自洽：失败店分类走 promotionFailureClass，evidence 与现有拼法一致', () => {
  const results = [
    { batch: 1, shop: '里可林淘宝', status: 'ok', stages: ['keyword-submit', 'import'] },
    { batch: 1, shop: '网林天猫', status: 'failed', stages: ['keyword-submit'], error: '采集失败：人群报表提交任务无法唯一确认' },
    { batch: 1, shop: '盖文淘宝', status: 'failed', stages: [], error: 'PROMOTION_ALIMAMA_LOGIN_WALL：阿里妈妈页停在登录墙上（expected one alimama page, got 0）' },
  ];
  const { shops } = buildPromotionSummary({ date: '2026-10-10', results, evidenceRoot: PROMOTION_EVIDENCE_ROOT });
  const failed = shops['网林天猫'];
  assert.equal(failed.failureClass, 'STAGE_FAILED'); // 无标记的失败仍落 STAGE_FAILED（不猜措辞）
  assert.equal(shops['盖文淘宝'].failureClass, 'NEEDS_LOGIN'); // 登录墙确定性标记 ⇒ NEEDS_LOGIN（2026-10-15）
  assert.equal(failed.noActionRequired, false); // 空菜单＝需要人看现场，失败店恒要人看
  assert.ok(failed.autoRepair === null, 'autoRepair 必须显式 null（不许 {} 也不许缺——gaveUp 判据靠 typeof 区分「没跑」与「跑过」）');
  assert.deepEqual(failed.repairRequest, { candidates: [] }); // P0-3 空菜单形态一个不动
  // evidence 与 run() 侧 shopEvidence 同款拼法（path.join(args.evidence, shop)），相对仓库根。
  assert.equal(failed.evidence, path.join('evidence', 'promotion-sales1-2026-10-10', '网林天猫'));
  assert.equal(shops['里可林淘宝'].evidence, path.join('evidence', 'promotion-sales1-2026-10-10', '里可林淘宝'));
  // ok 店：evidence 补上，失败信号三件套不落（与日报链第 2 步实现口径一致）。
  const okShop = shops['里可林淘宝'];
  assert.equal('failureClass' in okShop, false);
  assert.equal('noActionRequired' in okShop, false);
  assert.equal('autoRepair' in okShop, false);
  // 旧字段一个不动：batch/shop/status/stages 原样。
  assert.equal(okShop.batch, 1);
  assert.equal(okShop.shop, '里可林淘宝');
  assert.deepEqual(okShop.stages, ['keyword-submit', 'import']);
});

// c. 源码级接线守卫（照 1.8.4 日报链 run-multi-shop-day.test.mjs 的做法）：1.8.2 式
//    「纯函数全绿但 main() 接线断掉」的漏网对策——落盘点个数与实际一致，且每一处前
//    必含「构造（并写）→ 校验」两步、顺序固定。
test('统一 schema 并写接线（源码级）：唯一 summary 落盘点前「先构造并写、再校验、再落盘」', () => {
  const src = fs.readFileSync(new URL('./run-promotion-sales1.mjs', import.meta.url), 'utf8');
  // 并写构造与写入时校验都必须是函数声明（hoisted），不许改成 const 箭头——main 里调用无 TDZ 面。
  assert.match(src, /export function buildPromotionSummary\(/u, '并写构造必须是函数声明（hoisted）');
  assert.match(src, /function warnSummarySchemaViolations\(/u, '写入时校验必须是函数声明（hoisted）');
  // summary.json 有且只有 1 个落盘点（fs.writeFileSync(alertPath…) 是告警临时文件，不算）。
  const writes = [...src.matchAll(/fs\.writeFileSync\(summaryPath/gu)];
  assert.equal(writes.length, 1, `summary.json 的落盘点应有且只有 1 处（收到 ${writes.length}）`);
  for (const [i, match] of writes.entries()) {
    const before = src.slice(Math.max(0, match.index - 800), match.index);
    const buildAt = before.indexOf('buildPromotionSummary({ date: args.date, results, evidenceRoot: args.evidence })');
    const warnAt = before.indexOf('warnSummarySchemaViolations(summary,');
    assert.ok(buildAt !== -1, `第 ${i + 1} 个落盘点前没有调 buildPromotionSummary（并写没接上）`);
    assert.ok(warnAt !== -1, `第 ${i + 1} 个落盘点前没有调 warnSummarySchemaViolations（写入时校验没接上）`);
    assert.ok(buildAt < warnAt, `第 ${i + 1} 个落盘点：并写必须在校验之前（校验的是并写后的形状）`);
  }
});

// ── 店级有界重试（2026-10-15，用户拍板「加」）──────────────────────────────────
test('runStageWithRetry：第 2 次成功 ⇒ 返回输出、退避恰一次、日志点名阶段', () => {
  const sleeps = []; const logs = []; let calls = 0;
  const out = runStageWithRetry({
    stage: 'keyword-submit',
    run: () => { calls += 1; if (calls === 1) throw new Error('expected one alimama page, got 0'); return 'TASK_NAME=x'; },
    sleep: (ms) => sleeps.push(ms),
    log: (line) => logs.push(line),
  });
  assert.equal(out, 'TASK_NAME=x');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [30_000], '默认退避 30s、且只在两次尝试之间睡一次');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /keyword-submit 第 1\/3 次尝试失败/u);
  assert.match(logs[0], /expected one alimama page/u);
});

test('runStageWithRetry：3 次全失败 ⇒ 抛最后一次的错，退避恰两次', () => {
  const sleeps = []; let calls = 0;
  assert.throws(() => runStageWithRetry({
    stage: 'import',
    run: () => { calls += 1; throw new Error(`失败${calls}`); },
    sleep: (ms) => sleeps.push(ms),
  }), /失败3$/u, '抛的必须是最后一次的错');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [30_000, 30_000]);
});

test('runStageWithRetry：一次成功不睡不记日志；参数非法当场抛', () => {
  const sleeps = []; const logs = [];
  runStageWithRetry({ stage: 'x', run: () => 'ok', sleep: (ms) => sleeps.push(ms), log: (l) => logs.push(l) });
  assert.deepEqual(sleeps, []); assert.deepEqual(logs, []);
  assert.throws(() => runStageWithRetry({ stage: 'x', run: () => 'ok', sleep: () => {}, maxAttempts: 0 }), /maxAttempts 要 ≥1/u);
  assert.throws(() => runStageWithRetry({ stage: 'x', run: () => 'ok', sleep: () => {}, backoffMs: -1 }), /backoffMs 要 ≥0/u);
});

// 接线守卫（源码级，照 2d 教训「判据必须被真实调用」）：真机的五个阶段调用点必须全走重试包装，
// 且重试包装必须把 attempts 写进 record.retries——「函数全绿但 main() 没接上」是本仓已发作过的病。
test('重试接线（源码级）：五个阶段调用点全走 runWithRetry，attempts>1 落 record.retries', () => {
  const src = fs.readFileSync(new URL('./run-promotion-sales1.mjs', import.meta.url), 'utf8');
  const wired = [...src.matchAll(/runWithRetry\('([a-z-]+)'/gu)].map((m) => m[1]);
  assert.deepEqual([...wired].sort(), ['audience-fetch', 'audience-submit', 'import', 'keyword-fetch', 'keyword-submit'].sort(),
    `五个阶段调用点必须全部走 runWithRetry（收到 ${wired.join(',')}）`);
  const retryAt = src.indexOf('const runWithRetry = (stage, invoke) =>');
  const recordAt = src.indexOf("const record = { batch: batchIndex + 1, shop, status: 'failed', stages: [] };");
  const callAt = src.indexOf("const keywordSubmit = runWithRetry('keyword-submit'");
  assert.ok(recordAt !== -1 && retryAt > recordAt, 'runWithRetry 必须定义在 record 之后（闭包要记 attempts 进这份 record）');
  assert.ok(callAt > retryAt, '阶段调用必须在包装定义之后');
  assert.match(src, /record\.retries = \[\.\.\.\(record\.retries \?\? \[\]\), \{ stage, attempts \}\];/u,
    'attempts>1 必须落 record.retries（否则重试发生过但 summary 里无痕）');
  // 退避不许起子进程、不许异步化：Atomics.wait 是本链同步形态下唯一的无副作用同步睡。
  assert.match(src, /Atomics\.wait\(new Int32Array\(new SharedArrayBuffer\(4\)\), 0, 0, ms\);/u);
});
