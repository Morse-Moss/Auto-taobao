// 守卫：采集失败原因 ⇒ 缺口文案 ⇒ 失败分类 这条接线（2026-10-12 加）。
//
// 为什么单独一份：2026-10-11 里可林天猫那次，采集子进程抛的明明是 `下载超时`
// （job.log 第 29 行：「[底单] 里可林天猫 失败：采集失败：下载超时（exit 1）」），
// 但收尾那句缺口文案只写「里可林天猫/底单 未采集」⇒ `classifyWorkflowError` 认不出「超时／下载」，
// 整轮被记成 `FAILED/UNCLASSIFIED`。这不是「少了一句日志」：它让一个**可重试的外部故障**
// 和「脚本坏了」在收据上长得一模一样，看告警的人无从判断该重跑还是该叫人。
//
// 三个下游消费点全都只认文案里的字，改错一个字不会报错、只会把结论指到反方向：
//   ① `failedStage` 归因认「底单／询单／推广」（run-product-data-job.mjs 收尾处）
//   ② `classifyWorkflowError` 认「超时／下载…」，据此归 TRANSIENT_EXTERNAL 而不是 FAILED/UNCLASSIFIED
//   ③ 收据里的阶段状态认同一个字（「底单」）
// 所以这里除了纯函数，还把「文案 → 分类」这条跨模块接线真跑一遍，并钉住「入口真把 error 传了进来」
// —— 函数写了却没人把 `item.error` 递进去，是本仓发作过三次的同一种假绿（函数级用例全绿、接线没接上）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { collectFailureNote, collectGapOf } from '../scripts/run-product-data-job.mjs';
import { classifyWorkflowError } from './workflow-receipt.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = 'scripts/run-product-data-job.mjs';
// 2026-10-11 里可林天猫那次的**原话**（采集子进程 stderr，被入口整段存进 item.error）。
const REAL_TIMEOUT_ERROR = '采集失败：下载超时（点击返回值=已记录；共试 3 次，其中 0 次点击时锚点不在）';

function readSource(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replaceAll('\r\n', '\n');
}

test('原因压成一行并截断（它还要进告警载荷的 reason 字段）', () => {
  assert.equal(collectFailureNote('a\n  b  \n\nc'), 'a b c');
  assert.equal(collectFailureNote(''), '');
  assert.equal(collectFailureNote(undefined), '');
  const long = collectFailureNote('x'.repeat(300));
  assert.equal(long.length, 161, '截断后应当是 160 字 + 一个省略号（不许把整段 stderr 塞进告警）');
  assert.ok(long.endsWith('…'));
});

test('没有原因时逐字退回老文案（归因与收据都锚在这几个字上）', () => {
  assert.equal(collectGapOf('里可林天猫', '底单', ''), '里可林天猫/底单 未采集');
  assert.equal(collectGapOf('里可林天猫', '底单', undefined), '里可林天猫/底单 未采集');
});

test('有原因时缺口同时带阶段名与原因', () => {
  const gap = collectGapOf('里可林天猫', '底单', REAL_TIMEOUT_ERROR);
  assert.match(gap, /^里可林天猫\/底单 未采集：/u, '缺了阶段名 ⇒ failedStage 会掉到 unknown，把人指到错的地方');
  assert.match(gap, /下载超时/u, '缺了原因 ⇒ 分类会退化成 FAILED/UNCLASSIFIED（2026-10-11 的形态）');
});

test('接线：下载超时的缺口，经整轮那句 throw 之后归 TRANSIENT_EXTERNAL', () => {
  const gap = collectGapOf('里可林天猫', '底单', REAL_TIMEOUT_ERROR);
  // 与 run-product-data-job.mjs 收尾处同形：缺口被拼进 `本轮不完整（N 处）：…` 的 message
  const classified = classifyWorkflowError(new Error(`本轮不完整（1 处）：${gap}`));
  assert.equal(classified.class, 'TRANSIENT_EXTERNAL');
  assert.equal(classified.reason, 'EXTERNAL_RETRYABLE');
});

test('反例：老文案（只有「未采集」）必然退化成 FAILED/UNCLASSIFIED —— 这正是要修的东西', () => {
  const classified = classifyWorkflowError(new Error('本轮不完整（1 处）：里可林天猫/底单 未采集'));
  assert.equal(classified.class, 'FAILED');
  assert.equal(classified.reason, 'UNCLASSIFIED');
});

test('接线：六条缺口真把采集原因传进来了（函数写了不接等于没写）', () => {
  const source = readSource(ENTRY);
  for (const stage of ['底单', '询单', '推广']) {
    assert.ok(source.includes(`collectGapOf(item.shop, '${stage}', item.error)`),
      `${stage} 的缺口没有把 item.error 递进来 ⇒ 缺口又会退回没有原因的四个字`);
  }
  // 采集段三条 + catch 补记段三条 = 六条。数目变了说明有人加了新缺口而没想清楚归因与分类。
  const wired = [...source.matchAll(/collectGapOf\(item\.shop,/gu)].length;
  assert.equal(wired, 6, `缺口拼接处应当恰好 6 处（采集段 3 + catch 补记段 3），实际 ${wired} 处`);
  // 归因与收据的状态判定锚在「底单」两个字上：带上原因后这两个字必须还在。
  assert.ok(source.includes("gaps.some((gap) => gap.includes('底单')) ? 'FAILED' : 'COMPLETED'"),
    '归因锚点「底单」不见了 —— 改文案改掉了判据');
});

test('结构：采集调用必须把 --evidence 指到本轮证据目录', () => {
  const source = readSource(ENTRY);
  const call = source.slice(source.indexOf('PRODUCT_JOB_FILES.productCollect'));
  const end = call.indexOf('capture: true');
  assert.ok(end > 0, '找不到采集调用 —— 结构变了就要连这份守卫一起改');
  assert.match(call.slice(0, end), /'--evidence', path\.join\(evidence, shop, 'product-collect'\)/u,
    '采集失败现场会落到跨轮共用的默认目录 ⇒ 两轮同店同日互相覆盖，等于没留现场');
});
