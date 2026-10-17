// 收集完成提醒的**接线守卫**（2026-10-13 统一预警机制，用户定稿第 1/5 条）。
//
// 为什么必须有这道源码级判据：三条链的完成提醒都是「在收尾多调一个函数」——
// 这种接线的错法全是**静默**的：调用点被删掉/改坏时，`alert-copy` / `flow-ok-facts` /
// `deliver-alert` 三个模块自己的用例**全绿**（它们测的是模块，不是接线），
// 而表现只是「成功的那一天飞书里什么都不来」。本仓已经为同一形态发作过三次
// （AGENTS.md「用例全绿＋突变过了 ≠ 接线接上了」）。
//
// 判据形态：读源码，确认调用侧真的传了该传的东西 ——
//   ① 三条链各自 import 并调用了 buildFlowOkAlert 与 dispatchAlert；
//   ② 数字来自独立回读工件（dailyOkFacts / promotionOkFacts / productOkFacts），
//      不是链的自报成功计数（这是用户定稿第 5 条的核心，删了它整条提醒就失去意义）；
//   ③ 只在成功分支里调（finalStatus === 0 / batchesOk / status === 0）；
//   ④ 排练档不投（mode === 'apply' / options.commit）。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const DAILY_JOB = 'scripts/run-daily-job.mjs';
const BATCHES = 'scripts/run-batches.mjs';
const PRODUCT_JOB = 'scripts/run-product-data-job.mjs';

test('日报链：run-daily-job 收尾调了完成提醒，且数字来自独立回读工件', () => {
  const source = read(DAILY_JOB);
  assert.match(source, /import \{ buildFlowOkAlert \} from '\.\.\/runtime\/alert-copy\.mjs'/u,
    '日报驱动没有 import buildFlowOkAlert');
  assert.match(source, /import \{ dailyOkFacts \} from '\.\.\/runtime\/flow-ok-facts\.mjs'/u,
    '日报驱动没有 import dailyOkFacts —— 完成通知的数字必须来自独立回读工件');
  assert.match(source, /import \{ dispatchAlert \} from '\.\.\/runtime\/deliver-alert\.mjs'/u,
    '日报驱动没有 import dispatchAlert');
  assert.match(source, /buildFlowOkAlert\(\{[\s\S]{0,400}?flow: 'daily-report'/u,
    '日报驱动没有以 daily-report 流程调 buildFlowOkAlert');
  assert.match(source, /dailyOkFacts\(\{ root: REPO_ROOT, date, shops \}\)/u,
    '日报驱动没有按「根目录 + 日期 + 店铺」读回读工件');
  assert.match(source, /dispatchAlert\(\{[\s\S]{0,300}?alert,/u, '日报驱动没有把构造好的告警交给投递出口');
  // 只在成功分支里调：这一条是「成功才提醒、失败由告警说」的接线本身。
  assert.match(source, /if \(finalStatus === 0 && mode === 'apply'\) \{[\s\S]{0,900}?buildFlowOkAlert\(/u,
    '完成提醒没有挂在「整轮成功且 apply」这个分支里 —— 挂错分支的症状是排练也发、失败也发');
});

test('日报链：读不到回读工件时整条不发（fail-closed 的接线）', () => {
  const source = read(DAILY_JOB);
  assert.match(source, /if \(facts\.missing\.length === 0\) \{/u,
    '没有 missing 判据 —— 一家读不到也会发「收齐了」');
  assert.match(source, /不把「没核对」说成「收齐了」/u,
    '缺了那句日志：静默跳过 vs 明说不发，事后读日志是两种结论');
});

test('推广/日报分批链：run-batches 收尾调了完成提醒，且按流程取事实', () => {
  const source = read(BATCHES);
  assert.match(source, /import \{ buildFlowOkAlert \} from '\.\.\/runtime\/alert-copy\.mjs'/u, '缺 buildFlowOkAlert import');
  assert.match(source, /import \{ dailyOkFacts, promotionOkFacts, readSummaries \} from '\.\.\/runtime\/flow-ok-facts\.mjs'/u,
    '缺 flow-ok-facts import');
  assert.match(source, /import \{ dispatchAlert \} from '\.\.\/runtime\/deliver-alert\.mjs'/u, '缺 dispatchAlert import');
  // 推广链的数字从各批 summary 里的导入器收据来；日报链从各店回读工件来。
  assert.match(source, /options\.workflow === 'promotion-daily'\s*\n\s*\? promotionOkFacts\(\{/u,
    '没有按 workflow 分流 —— 推广流程会拿到日报口径的数字（或反过来）');
  assert.match(source, /dailyOkFacts\(\{ root: REPO_ROOT, date, shops \}\)/u, '日报口径没有读回读工件');
  assert.match(source, /buildFlowOkAlert\(\{[\s\S]{0,400}?flow: options\.workflow/u,
    '没有把 options.workflow 当流程键传进去 —— 传错的症状是推广完成通知标题写【店铺日报】');
  assert.match(source, /if \(batchesOk && options\.notify && mode === 'apply'\) \{/u,
    '完成提醒没有挂在「整轮成功 + notify + apply」这个分支里');
});

test('商品链：run-product-data-job 收尾调了完成提醒，且数字来自两个导入器收据', () => {
  const source = read(PRODUCT_JOB);
  assert.match(source, /import \{ buildFlowOkAlert, buildTechBlock, flowFallbackCopy \} from '\.\.\/runtime\/alert-copy\.mjs'/u,
    '商品驱动没有 import buildFlowOkAlert');
  assert.match(source, /import \{ productOkFacts \} from '\.\.\/runtime\/flow-ok-facts\.mjs'/u,
    '商品驱动没有 import productOkFacts');
  assert.match(source, /import \{ dispatchAlert \} from '\.\.\/runtime\/deliver-alert\.mjs'/u, '商品驱动没有 import dispatchAlert');
  assert.match(source, /productOkFacts\(\{ evidence, shops: plan\.shops \}\)/u, '商品驱动没有读两个导入器的收据');
  assert.match(source, /flow: 'product-daily'/u, '商品驱动没有以 product-daily 流程构造完成通知');
  assert.match(source, /if \(options\.notify && options\.commit && status === 0\) \{/u,
    '完成提醒没有挂在「成功 + notify + commit」这个分支里');
  // 与失败告警的关系：失败走两段式（notifyFailure），成功走纯业务完成通知。
  assert.match(source, /if \(options\.notify && status !== 0\) \{[\s\S]{0,200}?notifyFailure\(/u, '失败告警的调用点被改了');
});

test('周报链：run-weekly-collection 已接统一词表与编号域', () => {
  const source = read('runtime/run-weekly-collection.mjs');
  assert.match(source, /import \{ buildFlowOkAlert, buildTechBlock, flowFallbackCopy \} from '\.\/alert-copy\.mjs'/u,
    '周报链没有 import 统一词表');
  assert.match(source, /flow: 'weekly-report'/u, '周报链没有以 weekly-report 流程构造完成通知');
  assert.match(source, /weekly-round-\$\{businessDay/u, '周报失败告警的编号域不对');
  // 旧的 `weekly-collect-${Date.now()}` 永不节流、不写 throttle —— 那正是要修的东西。
  assert.equal(source.includes('weekly-collect-${Date.now()}'), false,
    '又出现了 weekly-collect-<时间戳> 编号：同一业务日会重复发、且不进 throttle');
});

test('完成通知一律不带技术定位块（用户定稿第 1 条：成功只提醒业务查收）', () => {
  const okSource = read('runtime/alert-copy.mjs');
  assert.match(okSource, /故意不带 tech/u, 'alert-copy 里没有「故意不带 tech」的说明');
  for (const file of [DAILY_JOB, BATCHES, PRODUCT_JOB, 'runtime/run-weekly-collection.mjs']) {
    const source = read(file);
    // 完成通知的调用点附近不许出现 tech: —— 技术块只属于失败告警。
    const calls = [...source.matchAll(/buildFlowOkAlert\(\{[\s\S]{0,600}?\}\)/gu)];
    assert.ok(calls.length >= 1, `${file} 里找不到 buildFlowOkAlert 调用`);
    for (const call of calls) {
      assert.equal(call[0].includes('tech'), false, `${file} 的完成通知带了 tech 块`);
    }
  }
});

// 2026-10-17 加：失败告警在**同一业务日**只报一次（用户反馈「能修好的也提前报一遍，后来又报一遍」）。
//
// 真机形态：10-16 这天先停 product-import 发一条失败告警（02:24）、补跑那轮停 promotion-import
// 又发一条（03:31），随后补齐再发一条「已恢复」—— 三条消息讲同一件事。
// 判据分两端：
//   ① 「同一业务日只报一次」的口径真的被传下去了（ignoreFingerprintChange）；
//   ② 「已经恢复过、之后又坏了」仍要能发出去 —— 否则昨天好了今天坏会被自己的历史记录永久挡住。
test('商品链：失败告警传了「同一业务日只报一次」，并区分「恢复过又重新坏」', () => {
  const source = read(PRODUCT_JOB);
  assert.match(source, /ignoreFingerprintChange/u,
    '商品链没有把「同一业务日只报一次」传下去 ⇒ 停在另一段就会再发一条');
  assert.match(source, /readAlertThrottleEntry\(\{ alertId: `product-ok-\$\{String\(date\)\.replace\(\/-\/gu, ''\)\}` \}\)/u,
    '没有读「已恢复」那条记录 ⇒ 分不清「一直没好」和「好了又坏」');
  const recovered = source.indexOf('recoveredSinceLastFailure');
  assert.ok(recovered > 0, '找不到 recoveredSinceLastFailure 判据');
  assert.match(source, /ignoreFingerprintChange: !recoveredSinceLastFailure/u,
    '「恢复过又重新坏」时必须恢复正常判据（允许发），否则新故障会被历史记录挡住');
});
