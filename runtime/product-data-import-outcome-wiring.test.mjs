// 守卫：导入退出码 ⇒ 缺口文案 ⇒ 失败分类 这条接线（2026-10-06 加 `exit 2 = UNKNOWN_WRITE`）。
//
// 为什么单独一份：`importOutcomeOf` 是个纯函数，好测；真会**静默**出错的是三个下游消费点，
// 它们全都只认文案里的两个字，改错一个字不会报错、只会把结论指到反方向：
//   ① `failedStage` 归因认「底单／询单」两个字（run-product-data-job.mjs 收尾处）
//   ② `classifyWorkflowError` 认「未知」两个字，据此归到 UNKNOWN_WRITE 而不是 FAILED/UNCLASSIFIED
//   ③ 收据里的阶段状态认同一个词
// 所以这里除了纯函数，还把「文案 → 分类」这条跨模块接线真跑一遍。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { importOutcomeOf, collectFailureNote } from '../scripts/run-product-data-job.mjs';
import { classifyWorkflowError } from './workflow-receipt.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

test('exit 0 ⇒ 不记缺口', () => {
  const outcome = importOutcomeOf('盖文淘宝', '底单', 0);
  assert.equal(outcome.gap, null);
  assert.match(outcome.line, /底单已写入/u);
});

test('exit 2 ⇒ 缺口同时带阶段名与「未知」', () => {
  const { gap } = importOutcomeOf('盖文淘宝', '底单', 2);
  assert.match(gap, /^盖文淘宝\/底单 /u, '缺了阶段名 ⇒ failedStage 会掉到 unknown，把人指到错的地方');
  assert.match(gap, /未知/u, '缺了「未知」⇒ classifyWorkflowError 会归到 FAILED/UNCLASSIFIED');
  assert.match(gap, /UNKNOWN_WRITE/u);
});

test('exit 1 与 exit 2 必须说成两件事', () => {
  const failed = importOutcomeOf('盖文淘宝', '底单', 1);
  const unknown = importOutcomeOf('盖文淘宝', '底单', 2);
  assert.match(failed.gap, /导入失败/u);
  assert.doesNotMatch(failed.gap, /未知|UNKNOWN_WRITE/u,
    '「真的没写成」不许被说成「结果未知」——两者的下一步动作相反（重跑 vs 先回读）');
  assert.notEqual(failed.gap, unknown.gap);
});

test('接线：exit 2 的缺口，经整轮那句 throw 之后归 UNKNOWN_WRITE', () => {
  const { gap } = importOutcomeOf('盖文淘宝', '底单', 2);
  // 与 run-product-data-job.mjs 收尾处同形：缺口被拼进 `本轮不完整（N 处）：…` 的 message
  const classified = classifyWorkflowError(new Error(`本轮不完整（1 处）：${gap}`));
  assert.equal(classified.class, 'UNKNOWN_WRITE');
  assert.equal(classified.reason, 'WRITE_OUTCOME_UNKNOWN');
});

test('接线：exit 1 的缺口仍归 FAILED，不被 UNKNOWN_WRITE 吞掉', () => {
  const { gap } = importOutcomeOf('盖文淘宝', '底单', 1);
  const classified = classifyWorkflowError(new Error(`本轮不完整（1 处）：${gap}`));
  assert.equal(classified.class, 'FAILED');
});

test('结构：底单导入器不许自己攒 ids，回读必须排在写入之后', () => {
  // 2026-10-06 那次的根因是「写成功 → 回读炸 → 收据那行根本没跑到」。
  // 2026-10-17 发现同一条纪律还有下半截：**自己攒 ids**（`const ids=[]` + 循环 push）等于把
  // 「已写」的证据押在「后面不再出错」上 —— 第二批一抛错，第一批的行连同收据一起消失
  // （推广段当天就是这么丢掉 46 行的证据，`promotion-import/sales1/` 是空目录）。
  const source = fs
    .readFileSync(path.join(ROOT, 'skills/sycm-product-data/scripts/import-product-data.mjs'), 'utf8')
    .replaceAll('\r\n', '\n');
  assert.doesNotMatch(source, /const ids=\[\]/u,
    '导入器又在自己攒 ids 了 ⇒ 写入中途抛错会把「已确认写入的行」一起丢掉，改用 runtime/import-write-ledger.mjs');
  const ledgerCall = source.indexOf('batchCreateWithLedger(');
  const readback = source.indexOf('receipt.afterRows=');
  assert.ok(ledgerCall > 0 && readback > 0, '找不到写入/回读那两个锚点 —— 结构变了就要连这份守卫一起改');
  assert.ok(ledgerCall < readback, '写后回读排在了逐批写入之前 —— 顺序反了');
  assert.match(source, /process\.exitCode=2/u,
    '「写入已发生、写后回读失败」必须以 exit 2 收场，否则调用方分不清它与「真的没写成」');
  assert.match(source, /writeFailureIsCertain/u,
    '写入阶段的失败也要分类：4xx＝确定没写成(1)，5xx/网络＝可能已写入(2)');
});

// 2026-10-17 加：同一份纪律在**推广**导入器上原样复发（3 家 46 行写进去了、随后批量接口抛错、
// 收据没落盘 ⇒ 主链报「批量导入失败、exit 1」⇒ 逐店重试 ⇒ 收据反而显示 plannedRows=0）。
test('结构：推广导入器同样「逐批落盘、再回读」，且写入失败按 1/2 分类', () => {
  const source = fs
    .readFileSync(path.join(ROOT, 'skills/sycm-promotion-data/scripts/import-promotion-data.mjs'), 'utf8')
    .replaceAll('\r\n', '\n');
  assert.doesNotMatch(source, /const ids=\[\]/u,
    '推广导入器又在自己攒 ids 了 ⇒ 中途抛错会把 46 行这种「已写入」的证据一起丢掉');
  const ledgerCall = source.indexOf('batchCreateWithLedger(');
  const readback = source.indexOf('receipt.afterRows={}');
  assert.ok(ledgerCall > 0 && readback > 0, '找不到写入/回读那两个锚点 —— 结构变了就要连这份守卫一起改');
  assert.ok(ledgerCall < readback, '推广的写后回读排在了逐批写入之前');
  assert.match(source, /process\.exitCode=certain\?1:2/u,
    '写入阶段的失败没分类：4xx 与 5xx 混成一个退出码，调用方要么漏写要么重复写');
});

test('结构：询单与推广日报导入器也不许自己攒 ids（同病根第三、四例）', () => {
  for (const rel of [
    'skills/sycm-inquiry-data/scripts/import-inquiry-data.mjs',
    'skills/sycm-alimama-daily-report/scripts/import-promotion-daily-report.mjs',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8').replaceAll('\r\n', '\n');
    assert.doesNotMatch(source, /const ids = \[\]|const ids=\[\]/u, `${rel} 仍在自己攒 ids`);
    assert.match(source, /batchCreateWithLedger\(/u, `${rel} 没有接逐批落盘的写入账本`);
    assert.match(source, /writeFailureIsCertain/u, `${rel} 没有区分「确定没写成」与「可能已写入」`);
  }
});

test('原因提取要跳过源码回显，取到真正的 Error 那行（含状态码）', () => {
  const stderr = [
    'file:///D:/Retire/sycm-automation/skills/xws-to-feishu-base/scripts/feishu-client.mjs:54',
    '      throw new Error(`Feishu API failed: ${response.status} ${payload ? `${payload.code ?? ""}` : describeBody(text)}`.trim());',
    '      ^',
    '',
    'Error: Feishu API failed: 500 1254290 Too Many Requests',
    '    at FeishuClient.#request (file:///D:/Retire/sycm-automation/skills/xws-to-feishu-base/scripts/feishu-client.mjs:54:13)',
  ].join('\n');
  const note = collectFailureNote(stderr);
  assert.doesNotMatch(note, /\$\{response\.status\}/u,
    '截断预算全花在模板源码上 ⇒ 收据里看不到状态码，判据就没了（2026-10-17 实测形态）');
  assert.match(note, /Feishu API failed: 500/u);
});
