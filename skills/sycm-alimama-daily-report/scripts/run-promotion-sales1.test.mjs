import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  promotionSales1Plan, parsePromotionSales1Args,
  buildPromotionRoundAlert, deliverPromotionAlert, buildPromotionSummary,
} from './run-promotion-sales1.mjs';
import { READABLE_SOURCE_KEYS } from '../../../runtime/notify-feishu-core.mjs';
import { unfixableShopsOf } from '../../../runtime/hold-and-resume-plan.mjs';
import { failedShopsOf } from '../../../scripts/hold-and-resume.mjs';

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
  assert.match(alert.title, /推广日报没收完（业务日 2026-10-10）/u);
  assert.match(alert.reason, /网林天猫：采集失败/u);
  // 告警纪律：source 只许白名单键，且不带机器名/盘符/内部路径。
  for (const key of Object.keys(alert.source)) {
    assert.ok(READABLE_SOURCE_KEYS.some(([allowed]) => allowed === key), `source 键 ${key} 不在渲染白名单`);
  }
  assert.equal(alert.source.machine, undefined);
  assert.equal(JSON.stringify(alert).includes('D:\\'), false);
  assert.match(alert.action, /下载任务管理/u);
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
test('buildPromotionSummary：失败店被释放/驻留两侧判据同时点名（跨模块对接）', () => {
  const results = [
    { batch: 1, shop: '里可林淘宝', status: 'ok', stages: ['keyword-submit', 'import'] },
    { batch: 1, shop: '网林天猫', status: 'failed', stages: ['keyword-submit'], error: '采集失败：关键词报表提交任务无法唯一确认' },
  ];
  const summary = buildPromotionSummary({ date: '2026-10-10', results });
  assert.equal(summary.version, 'promotion-sales1-summary-v1');
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
  const allOk = buildPromotionSummary({ date: '2026-10-10', results: [results[0]] });
  assert.deepEqual(unfixableShopsOf(allOk), []);
  assert.deepEqual(failedShopsOf(allOk), []);
});
